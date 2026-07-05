import * as vscode from 'vscode';
import { broadcast } from '../server/wsServer';
import { Logger } from '../utils/logger';
import { getConfig } from '../utils/config';

/**
 * 워크스페이스 파일 트리(이름만)를 학생 뷰어에 공유하기 위한 수집·전송 모듈.
 * 보안 원칙: 파일 '이름'만 내보낸다 — 내용/절대경로는 절대 포함하지 않는다.
 * (root는 워크스페이스 폴더명만, 경로는 트리 중첩으로만 표현.)
 */

export interface ExplorerNode {
  /** 이름 */
  n: string;
  /** 타입: 'd'=디렉터리, 'f'=파일 */
  t: 'd' | 'f';
  /** 자식 (디렉터리에만 존재, 빈 디렉터리는 []) */
  c?: ExplorerNode[];
}

export interface ExplorerTreePayload {
  root: string;
  tree: ExplorerNode[];
  truncated: boolean;
}

// 뷰어에 노출할 가치가 없고 엔트리 폭주의 주범인 디렉터리들 (이름 일치로 제외)
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'out',
  '.next',
  '.cache',
  '.idea',
  '.pytest_cache',
  '.mypy_cache',
]);
const EXCLUDED_FILES = new Set(['.DS_Store']);

// 깊이 상한 8, 총 엔트리 상한 1500 — 대형 워크스페이스에서 페이로드 폭주 방지
const MAX_DEPTH = 8;
const MAX_ENTRIES = 1500;
const REBUILD_DEBOUNCE_MS = 2000;

let fsWatcher: vscode.FileSystemWatcher | null = null;
let rebuildTimer: NodeJS.Timeout | null = null;
let cachedTree: ExplorerTreePayload | null = null;
let cachedJson: string | null = null; // 동일 트리 재broadcast 생략용 (제외 디렉터리 내부 churn 등)
let configListener: vscode.Disposable | null = null;
// 비동기 빌드가 stop 이후에 완료되어 죽은 세션으로 broadcast 되는 것을 막는 플래그
let watchActive = false;

/** 트리 순회 중 공유되는 카운터/절단 상태 */
interface BuildState {
  count: number;
  truncated: boolean;
}

/**
 * VS Code 탐색기와 동일한 정렬: 디렉터리 먼저, 그다음 파일,
 * 각각 대소문자 무시 알파벳순.
 */
function compareNames(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return 0;
}

async function readDirTree(
  uri: vscode.Uri,
  depth: number,
  state: BuildState
): Promise<ExplorerNode[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(uri);
  } catch {
    // 개별 디렉터리 읽기 실패(권한 등)는 그 가지만 비우고 전체 빌드는 계속한다
    return [];
  }

  const dirNames: string[] = [];
  const fileNames: string[] = [];
  for (const [name, type] of entries) {
    // 심볼릭 링크는 따라가지 않는다 (무한루프·워크스페이스 밖 노출 방지).
    // FileType은 비트 플래그라 심링크 디렉터리는 Directory|SymbolicLink 로 온다.
    if (type & vscode.FileType.SymbolicLink) {
      continue;
    }
    if (type & vscode.FileType.Directory) {
      if (!EXCLUDED_DIRS.has(name)) {
        dirNames.push(name);
      }
    } else if (type & vscode.FileType.File) {
      if (!EXCLUDED_FILES.has(name)) {
        fileNames.push(name);
      }
    }
    // Unknown 타입(소켓 등)은 뷰어에 의미 없으므로 무시
  }
  dirNames.sort(compareNames);
  fileNames.sort(compareNames);

  const result: ExplorerNode[] = [];
  for (const name of dirNames) {
    if (state.count >= MAX_ENTRIES) {
      state.truncated = true;
      return result;
    }
    state.count++;
    const node: ExplorerNode = { n: name, t: 'd', c: [] };
    if (depth < MAX_DEPTH) {
      node.c = await readDirTree(vscode.Uri.joinPath(uri, name), depth + 1, state);
    } else if (await hasIncludableChildren(vscode.Uri.joinPath(uri, name))) {
      // 깊이 상한 도달: 실제로 하위 항목이 있을 때만 '잘림'으로 표시 (빈 디렉터리 오탐 방지)
      state.truncated = true;
    }
    result.push(node);
  }
  for (const name of fileNames) {
    if (state.count >= MAX_ENTRIES) {
      state.truncated = true;
      return result;
    }
    state.count++;
    result.push({ n: name, t: 'f' });
  }
  return result;
}

/** 깊이 상한 디렉터리에 공유 대상 하위 항목이 실제로 존재하는지 확인 (truncated 오탐 방지) */
async function hasIncludableChildren(uri: vscode.Uri): Promise<boolean> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    return entries.some(([name, type]) => {
      if (type & vscode.FileType.SymbolicLink) return false;
      if (type & vscode.FileType.Directory) return !EXCLUDED_DIRS.has(name);
      if (type & vscode.FileType.File) return !EXCLUDED_FILES.has(name);
      return false;
    });
  } catch {
    return false;
  }
}

/**
 * 첫 번째 워크스페이스 폴더 기준으로 {root, tree, truncated} 페이로드를 생성.
 * 워크스페이스가 없으면 null. (멀티루트 워크스페이스는 첫 폴더만 공유 —
 * 교실 시나리오는 단일 루트가 지배적이라 의도적으로 단순화한 제약이다.)
 */
export async function buildExplorerTree(): Promise<ExplorerTreePayload | null> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return null;
  }
  const state: BuildState = { count: 0, truncated: false };
  const tree = await readDirTree(folder.uri, 1, state);
  return { root: folder.name, tree, truncated: state.truncated };
}

/** join 시 재빌드 없이 전송하기 위한 캐시 접근자 */
export function getExplorerTree(): ExplorerTreePayload | null {
  return cachedTree;
}

async function rebuildAndBroadcast(reason: string): Promise<void> {
  try {
    // 설정 게이트를 '전송 시점'에 재확인 — 수업 중 shareExplorer를 꺼도 즉시 전송이 멈춘다
    if (!watchActive || !getConfig().shareExplorer) {
      return;
    }
    const tree = await buildExplorerTree();
    // 빌드 중 세션이 끝났으면 죽은 소켓으로 보내지 않는다
    if (!watchActive || !tree) {
      return;
    }
    // 보이는 변화가 없으면(예: 제외 디렉터리 내부 churn) 50명에게 동일 트리 재전송 생략
    const json = JSON.stringify(tree);
    if (json === cachedJson) {
      return;
    }
    cachedTree = tree;
    cachedJson = json;
    broadcast('explorer:tree', tree);
  } catch (err) {
    // 트리 공유는 부가 기능 — 빌드 실패가 세션을 위협하지 않도록 경고만 남기고 무시
    Logger.warn(`[explorerTree] build failed (${reason}): ${String(err)}`);
  }
}

/**
 * FS 이벤트가 공유 트리에 영향을 주는지 판정 — 제외 디렉터리(node_modules 등) 내부의
 * 파일 churn(예: 수업 중 npm install)이나 첫 워크스페이스 폴더 밖 변경은 재빌드하지 않는다.
 */
function isRelevantFsEvent(uri: vscode.Uri): boolean {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return false;
  const base = folder.uri.fsPath;
  const fsPath = uri.fsPath;
  if (!fsPath.startsWith(base)) return false;
  const segs = fsPath.slice(base.length).split(/[/\\]+/).filter(Boolean);
  if (segs.some((s) => EXCLUDED_DIRS.has(s))) return false;
  if (segs.length > 0 && EXCLUDED_FILES.has(segs[segs.length - 1])) return false;
  return true;
}

/**
 * 파일 생성/삭제(이름변경은 create+delete로 옴) 버스트를 합쳐 2초 trailing 디바운스로
 * 재빌드+재broadcast. setTimeout 콜백은 watcher.ts의 runSafely 패턴처럼 try/catch로
 * 격리한다 (콜백에서 throw가 새면 uncaughtException으로 세션 전체가 내려갈 수 있음).
 */
function scheduleRebuild(): void {
  if (!watchActive) {
    return;
  }
  if (rebuildTimer) {
    clearTimeout(rebuildTimer);
  }
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    try {
      void rebuildAndBroadcast('fs change');
    } catch (err) {
      Logger.error('[explorerTree] rebuild schedule failed', err);
    }
  }, REBUILD_DEBOUNCE_MS);
}

/** FS 감시 시작 (이미 감시 중이면 no-op) */
function ensureFsWatch(): void {
  if (fsWatcher) {
    return;
  }
  // 내용 변경(onDidChange)은 트리 모양과 무관하므로 create/delete만 구독
  fsWatcher = vscode.workspace.createFileSystemWatcher('**/*');
  fsWatcher.onDidCreate((uri) => { if (isRelevantFsEvent(uri)) scheduleRebuild(); });
  fsWatcher.onDidDelete((uri) => { if (isRelevantFsEvent(uri)) scheduleRebuild(); });
}

/** FS 감시·타이머만 해제 (세션은 유지 — 수업 중 설정 off 대응) */
function teardownFsWatch(): void {
  if (fsWatcher) {
    fsWatcher.dispose();
    fsWatcher = null;
  }
  if (rebuildTimer) {
    clearTimeout(rebuildTimer);
    rebuildTimer = null;
  }
}

/**
 * 세션 시작 시 호출: shareExplorer가 켜져 있으면 트리를 1회 빌드해 broadcast 하고
 * 파일 생성/삭제 감시를 시작한다. 설정이 꺼져 있어도 설정 변경 리스너는 등록해,
 * 수업 중 켜면 즉시 공유가 시작되고 끄면 즉시 멈춘다. 중복 호출에 안전(idempotent).
 */
export function startExplorerWatch(): void {
  watchActive = true;

  if (!configListener) {
    configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('codeClassLive.shareExplorer')) return;
      if (!watchActive) return;
      if (getConfig().shareExplorer) {
        ensureFsWatch();
        void rebuildAndBroadcast('setting enabled');
      } else {
        // 끄면 감시 해제 + 캐시 제거 — join 경로(watcher.ts)도 설정을 재확인하므로 이중 차단
        teardownFsWatch();
        cachedTree = null;
        cachedJson = null;
      }
    });
  }

  if (getConfig().shareExplorer) {
    ensureFsWatch();
    // 초기 트리 빌드 + broadcast (비동기 — 실패해도 세션은 계속)
    void rebuildAndBroadcast('session start');
  }
}

/** 세션 종료 시 호출: 감시 해제 + 리스너/타이머/캐시 정리. 중복 호출에 안전. */
export function stopExplorerWatch(): void {
  watchActive = false;
  teardownFsWatch();
  if (configListener) {
    configListener.dispose();
    configListener = null;
  }
  cachedTree = null;
  cachedJson = null;
}
