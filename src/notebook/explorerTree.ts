import * as vscode from 'vscode';
import * as fsp from 'node:fs/promises';
import * as nodePath from 'node:path';
import { broadcast, setExplorerExpandHandler } from '../server/wsServer';
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
  /** 아직 보내지 않은 자식이 있으면 1. 뷰어가 '더 보기' 행을 그린다 */
  m?: 1;
}

export interface ExplorerTreePayload {
  root: string;
  tree: ExplorerNode[];
  truncated: boolean;
  /** 최상위 목록이 잘렸을 때만 true. 뷰어가 하단 안내를 띄운다 */
  rootMore?: boolean;
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
const EXCLUDED_DIRS_LC = new Set([...EXCLUDED_DIRS].map((d) => d.toLowerCase()));

/**
 * 제외 디렉터리 판정. 대소문자를 구분하지 않는 파일시스템(macOS APFS, Windows)에서는
 * `.GIT`으로도 `.git`이 열리므로 정확히 일치 검사만으로는 우회된다.
 * Windows는 후행 점·공백도 무시하므로 함께 제거한 뒤 비교한다.
 */
function isExcludedDirName(name: string): boolean {
  const norm = name.normalize('NFC').replace(/[. ]+$/, '').toLowerCase();
  if (norm.length === 0) return true;
  return EXCLUDED_DIRS_LC.has(norm);
}

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
// 현재 공유 중인 파일의 워크스페이스 상대경로. watcher가 알려준다(순환 import 방지).
// 예산이 바닥나도 이 경로만은 트리에 반드시 포함한다.
let activeRelPath: string | null = null;
/**
 * 클라이언트가 확장을 요청할 수 있는 경로 집합.
 *
 * 서버가 '더 보기'로 실제 광고한 디렉터리만 담는다. 문법 검증만으로는 부족하다.
 * 트리에 실린 적 없는 이름(`.GIT` 같은 대소문자 변형 포함)이나 광고하지 않은 깊이를
 * 클라이언트가 임의로 요청할 수 있기 때문이다. 인가는 이 집합이 담당한다.
 */
const expandablePaths = new Set<string>();

/** 공유 중인 파일 경로를 알린다. 트리에서 이 경로는 절대 생략하지 않는다. */
export function setExplorerActivePath(rel: string | null): void {
  activeRelPath = rel && typeof rel === 'string' ? rel : null;
}

/** 트리 순회 중 공유되는 카운터/절단 상태 */
interface BuildState {
  count: number;
  truncated: boolean;
  /** 최상위 목록 자체가 잘렸는지 (여기는 '더 보기'를 걸 부모 노드가 없다) */
  rootTruncated?: boolean;
}

/** 깊이 상한 디렉터리에 공유 대상 하위 항목이 실제로 존재하는지 확인 (truncated 오탐 방지) */
async function hasIncludableChildren(uri: vscode.Uri): Promise<boolean> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    return entries.some(([name, type]) => {
      if (type & vscode.FileType.SymbolicLink) return false;
      if (type & vscode.FileType.Directory) return !isExcludedDirName(name);
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
  const tree = await buildBreadthFirst(folder.uri, state);
  await ensureActivePathIncluded(folder.uri, tree);
  return { root: folder.name, tree, truncated: state.truncated, rootMore: state.rootTruncated };
}

/**
 * 너비 우선으로 트리를 만든다.
 *
 * 깊이 우선으로 예산(MAX_ENTRIES)을 쓰면 앞쪽의 깊은 디렉터리 하나가 예산을 전부
 * 먹어치워 '뒤쪽 최상위 폴더가 통째로 사라지는' 결과가 난다. 학생 입장에서는 강사의
 * 프로젝트에 그런 폴더가 없는 것처럼 보인다. 너비 우선이면 얕은 층부터 채워지므로
 * 최상위는 항상 온전하고, 잘림은 가장 깊은 곳에서만 생긴다.
 */
async function buildBreadthFirst(rootUri: vscode.Uri, state: BuildState): Promise<ExplorerNode[]> {
  const root: ExplorerNode[] = [];
  // [부모 uri, 자식을 담을 배열, 깊이]
  expandablePaths.clear();
  let level: LevelItem[] = [{ uri: rootUri, out: root, depth: 1, path: '' }];

  while (level.length > 0) {
    const next: LevelItem[] = [];
    for (const item of level) {
      const listing = await readDirNames(item.uri);
      if (!listing) continue;
      const { dirNames, fileNames } = listing;
      const budgetLeft = MAX_ENTRIES - state.count;
      const total = dirNames.length + fileNames.length;
      if (budgetLeft <= 0) {
        // 이 디렉터리는 한 칸도 못 담는다. 부모 노드에 '더 있음'만 남긴다.
        markMore(item, state);
        continue;
      }
      let taken = 0;
      for (const name of dirNames) {
        if (taken >= budgetLeft) break;
        state.count++; taken++;
        const node: ExplorerNode = { n: name, t: 'd', c: [] };
        item.out.push(node);
        const childUri = vscode.Uri.joinPath(item.uri, name);
        const childPath = item.path ? item.path + '/' + name : name;
        if (item.depth < MAX_DEPTH) {
          next.push({
            uri: childUri,
            out: node.c as ExplorerNode[],
            depth: item.depth + 1,
            owner: node,
            path: childPath,
          });
        } else if (await hasIncludableChildren(childUri)) {
          node.m = 1;
          expandablePaths.add(childPath);
          state.truncated = true;
        }
      }
      for (const name of fileNames) {
        if (taken >= budgetLeft) break;
        state.count++; taken++;
        item.out.push({ n: name, t: 'f' });
      }
      if (taken < total) {
        markMore(item, state);
      }
    }
    level = next;
  }
  return root;
}

/** 너비 우선 순회의 한 항목 */
interface LevelItem {
  uri: vscode.Uri;
  out: ExplorerNode[];
  depth: number;
  /** 워크스페이스 루트 기준 상대경로 ('' = 루트) */
  path: string;
  /** 이 목록을 자식으로 갖는 디렉터리 노드 (최상위는 없음) */
  owner?: ExplorerNode;
}

/** 이 디렉터리에 아직 안 보낸 자식이 있음을 부모 노드에 표시한다 */
function markMore(item: LevelItem, state: BuildState): void {
  state.truncated = true;
  if (item.owner) {
    item.owner.m = 1;
    expandablePaths.add(item.path);
  } else {
    state.rootTruncated = true;
  }
  // 최상위(root)에는 owner가 없다. 그 경우 전역 truncated 표시만 남는다.
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

/** 디렉터리의 이름 목록을 정렬해 돌려준다 (읽기 실패는 null) */
async function readDirNames(
  uri: vscode.Uri
): Promise<{ dirNames: string[]; fileNames: string[] } | null> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(uri);
  } catch {
    return null;
  }
  const dirNames: string[] = [];
  const fileNames: string[] = [];
  for (const [name, type] of entries) {
    // 심볼릭 링크는 따라가지 않는다 (무한루프·워크스페이스 밖 노출 방지)
    if (type & vscode.FileType.SymbolicLink) continue;
    if (type & vscode.FileType.Directory) {
      if (!isExcludedDirName(name)) dirNames.push(name);
    } else if (type & vscode.FileType.File) {
      if (!EXCLUDED_FILES.has(name)) fileNames.push(name);
    }
  }
  dirNames.sort(compareNames);
  fileNames.sort(compareNames);
  return { dirNames, fileNames };
}

/**
 * 공유 중인 파일과 그 상위 폴더는 예산과 무관하게 트리에 넣는다.
 * 학생이 지금 보고 있는 파일이 탐색기에서 사라지는 일은 없어야 한다.
 */
async function ensureActivePathIncluded(rootUri: vscode.Uri, tree: ExplorerNode[]): Promise<void> {
  const rel = activeRelPath;
  if (!rel) return;
  const parts = rel.split('/').filter((x) => x && x !== '.' && x !== '..');
  if (parts.length === 0) return;

  let level = tree;
  let here = '';
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i];
    const isLast = i === parts.length - 1;
    // 강사가 node_modules 안의 파일을 열어도 그 폴더를 학생 트리에 만들지 않는다
    if (!isLast && isExcludedDirName(name)) return;
    here = here ? here + '/' + name : name;
    let node = level.find((x) => x.n === name);
    if (!node) {
      node = isLast ? { n: name, t: 'f' } : { n: name, t: 'd', c: [], m: 1 };
      // 광고했으면 인가도 같이 준다. 안 그러면 '더 보기'가 그려지지만 서버가 영구 거부한다
      if (!isLast) expandablePaths.add(here);
      // 정렬 위치를 지키며 삽입 (디렉터리 먼저, 그다음 파일)
      insertSorted(level, node);
    }
    if (isLast) return;
    if (node.t !== 'd') return;
    if (!node.c) node.c = [];
    level = node.c;
  }
}

/** VS Code 탐색기 정렬(디렉터리 먼저, 이름순)을 지키며 삽입 */
function insertSorted(list: ExplorerNode[], node: ExplorerNode): void {
  const isDir = node.t === 'd';
  let idx = list.length;
  for (let i = 0; i < list.length; i++) {
    const cur = list[i];
    const curIsDir = cur.t === 'd';
    if (isDir && !curIsDir) { idx = i; break; }
    if (isDir === curIsDir && compareNames(node.n, cur.n) < 0) { idx = i; break; }
  }
  list.splice(idx, 0, node);
}

/** 한 요청에 돌려줄 자식 수 상한 */
const EXPAND_MAX_CHILDREN = 400;
/** 클라이언트가 요청할 수 있는 최대 경로 깊이 */
const EXPAND_MAX_DEPTH = 24;

export interface ExplorerChildrenPayload {
  path: string;
  nodes: ExplorerNode[];
  /** 상한에 걸려 일부만 돌려줬으면 true */
  more: boolean;
}

/**
 * 학생이 '더 보기'를 누른 디렉터리 하나의 자식 목록을 돌려준다.
 *
 * 보안: 경로는 신뢰할 수 없는 입력이다. 워크스페이스 루트 밖을 절대 읽지 않도록
 * 세그먼트 단위로 검증한다. 트리 빌드와 동일한 제외 규칙·심링크 차단을 적용하며,
 * 여기서도 파일 '이름'만 나간다(내용·절대경로는 포함하지 않는다).
 */
export async function expandExplorerPath(rawPath: unknown): Promise<ExplorerChildrenPayload | null> {
  if (!getConfig().shareExplorer) return null;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || typeof rawPath !== 'string') return null;

  const segments = rawPath.split('/').filter((x) => x.length > 0);
  if (segments.length === 0 || segments.length > EXPAND_MAX_DEPTH) return null;
  const key = segments.join('/');

  // ★ 인가: 서버가 '더 보기'로 실제 광고한 경로만 허용한다.
  // 문법 검증만으로는 트리에 없는 이름(.GIT 같은 대소문자 변형 등)이나 광고하지 않은
  // 깊이를 요청할 수 있다. 아래 검사들은 전부 심층 방어이고, 인가는 여기서 끝난다.
  if (!expandablePaths.has(key)) return null;

  for (const seg of segments) {
    if (seg === '.' || seg === '..') return null;
    if (seg.includes('/') || seg.includes('\\') || seg.includes('\0')) return null;
    if (isExcludedDirName(seg)) return null;
  }

  const target = vscode.Uri.joinPath(folder.uri, ...segments);

  // 심링크 경유 탈출 차단: 어휘적 경로가 아니라 실제 경로(realpath)로 비교한다.
  // joinPath는 문자열 결합이라, 중간 세그먼트가 워크스페이스 밖을 가리키는 심링크면
  // 접두사 검사를 통과해 버린다. realpath는 그것을 펴서 드러내고, 덤으로 디스크상의
  // 실제 대소문자를 돌려주므로 제외 디렉터리 우회도 함께 막힌다.
  let realTarget: string;
  let realRoot: string;
  try {
    realTarget = await fsp.realpath(target.fsPath);
    realRoot = await fsp.realpath(folder.uri.fsPath);
  } catch {
    return null; // 없는 경로·권한 없음 모두 동일하게 침묵
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + nodePath.sep)) {
    Logger.warn('[explorerTree] expand rejected: resolved path escapes workspace root');
    return null;
  }
  const realSegments = realTarget.slice(realRoot.length).split(nodePath.sep).filter(Boolean);
  if (realSegments.some((seg) => isExcludedDirName(seg))) {
    Logger.warn('[explorerTree] expand rejected: excluded directory on resolved path');
    return null;
  }

  try {
    const stat = await vscode.workspace.fs.stat(target);
    if (stat.type & vscode.FileType.SymbolicLink) return null;
    if (!(stat.type & vscode.FileType.Directory)) return null;
  } catch {
    return null;
  }

  const listing = await readDirNames(target);
  if (!listing) return null;

  const nodes: ExplorerNode[] = [];
  let more = false;
  for (const name of listing.dirNames) {
    if (nodes.length >= EXPAND_MAX_CHILDREN) { more = true; break; }
    // 자식마다 hasIncludableChildren를 부르면 요청 1건이 디렉터리 읽기 수백 건으로
    // 증폭된다. 낙관적으로 m=1을 달고, 비어 있으면 펼쳤을 때 빈 목록이 오게 둔다.
    const node: ExplorerNode = { n: name, t: 'd', c: [], m: 1 };
    expandablePaths.add(key + '/' + name);
    nodes.push(node);
  }
  if (!more) {
    for (const name of listing.fileNames) {
      if (nodes.length >= EXPAND_MAX_CHILDREN) { more = true; break; }
      nodes.push({ n: name, t: 'f' });
    }
  }
  // more=true여도 같은 키를 재등록하지 않는다. 이 API에는 오프셋이 없어서
  // 다시 요청해도 똑같은 앞부분만 오기 때문이다(전진하지 않는 루프).
  // 뷰어는 이 경우 '일부만 표시됨' 안내만 띄운다.
  return { path: key, nodes, more };
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
  setExplorerExpandHandler((path) => expandExplorerPath(path));
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
  expandablePaths.clear();
  setExplorerExpandHandler(null);
  watchActive = false;
  teardownFsWatch();
  if (configListener) {
    configListener.dispose();
    configListener = null;
  }
  cachedTree = null;
  cachedJson = null;
}
