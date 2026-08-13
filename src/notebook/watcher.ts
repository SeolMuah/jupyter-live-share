import * as vscode from 'vscode';
import * as path from 'path';
import { broadcast, sendTo, addNewViewerListener, getCurrentPollState, getDrawStrokes, clearDrawStrokes, getLastScrollSync, clearLastScrollSync, setLastScrollSync } from '../server/wsServer';
import { serializeCell, serializeOutputs, serializeNotebook, serializeTextDocument, SerializedNotebook, SerializedCell } from './serializer';
import { Logger } from '../utils/logger';
import { getConfig } from '../utils/config';
import { startExplorerWatch, stopExplorerWatch, getExplorerTree, setExplorerActivePath } from './explorerTree';
import { buildImagePayload, IMAGE_EXTS, ImageFullPayload } from './imageShare';
import { resolveLocalImages, resolveLocalImagesCacheOnly, preOptimizeImages, clearImageCache, hasImagePatterns, setProjectRoot, setOnImagesOptimized } from '../utils/imageResolver';
import WebSocket from 'ws';

// document:update 스로틀 (leading+trailing): 전체 문서 텍스트를 실어 나르므로 셀보다
// 간격을 넉넉히 잡되, 연타 중에도 이 간격마다 중간 상태가 전송돼 글자가 실시간으로 보인다.
const TEXT_THROTTLE_MS = 150;
const THROTTLE_MS = 100; // 셀 포커스 추적 반응성 개선 (200→100)
const CURSOR_THROTTLE_MS = 30; // Cursor updates need fastest response (50→30)
const VIEWPORT_THROTTLE_MS = 100; // Viewport sync needs fast but not excessive updates
// cell:update 스로틀 (leading+trailing, cell:output과 동일 패턴). 과거 trailing 디바운스는
// 키를 누르고 있는 동안(키 반복 간격 < 창) 타이머가 계속 리셋되어 전송이 0회 → 학생 화면에
// 커서만 움직이고 글자는 키를 떼야 반영됐다. 스로틀은 연타/지우기 홀드 중에도 이 간격마다
// 중간 상태를 브로드캐스트해 글자가 커서처럼 따라온다. flush가 fire 시점에 라이브 셀
// 텍스트를 다시 읽으므로 중간·최종 키 입력은 유실되지 않고(중간 '브로드캐스트'만 합쳐짐),
// trailing 타이머가 마지막 상태를 반드시 한 번 더 보낸다. 셀 전환/블러/정지 경로는 즉시 flush.
const CELL_UPDATE_THROTTLE_MS = 100;
// cell:output 스로틀: tqdm/진행바처럼 초당 수십~수백 회 갱신되는 스트리밍 출력이 100명에게
// 매 프레임 폭주하는 것을 억제한다. leading+trailing 방식이라 최종 출력은 반드시 전달된다
// (trailing fire 시 currentNotebook에서 셀 출력을 다시 읽어 그 순간의 최신 상태를 보냄).
const OUTPUT_THROTTLE_MS = 100;

// 타이핑/커서 등 초당 다회 발생하는 이벤트의 상세 로그는 기본적으로 끈다 (필요 시 true로 전환)
const SYNC_DEBUG = false;

// languageIds where image resolution is relevant
const IMAGE_RELEVANT_LANGUAGES = new Set(['markdown', 'html', 'jupyter']);

let disposables: vscode.Disposable[] = [];
const cellUpdateTrailingTimers: Map<number, NodeJS.Timeout> = new Map(); // cell:update 스로틀용 셀별 trailing 타이머
const lastCellUpdateTimes: Map<number, number> = new Map();          // 셀별 마지막 cell:update 전송 시각
const outputTrailingTimers: Map<number, NodeJS.Timeout> = new Map(); // cell:output 스로틀용 셀별 trailing 타이머
const lastOutputTimes: Map<number, number> = new Map();              // 셀별 마지막 cell:output 전송 시각
let textTrailingTimer: NodeJS.Timeout | null = null;
let lastTextUpdateTime = 0;
let lastTextSentLength = 0; // 마지막 전송 문서 길이 — 대용량 파일 스로틀 간격 확대 판정용
let lastFocusTime = 0;
let lastCursorTime = 0;
let cursorTrailingTimer: NodeJS.Timeout | null = null;
let viewportTrailingTimer: NodeJS.Timeout | null = null;
let syncBackupTimer: NodeJS.Timeout | null = null;
let lastViewportTime = 0;
let lastActiveCellIndex = -1;
const lastSentSources: Map<number, string> = new Map(); // 셀별 마지막 전송 소스 (중복 전송 방지)
let currentNotebook: vscode.NotebookDocument | null = null;
let currentTextDocument: vscode.TextDocument | null = null;
let watchMode: 'notebook' | 'plaintext' | 'image' | null = null;
// 단일 이미지 공유 모드 상태 — 이미지 탭(jpg/png 등) 활성화 시 image:full로 학생에게 공유
let currentImageUri: vscode.Uri | null = null;
let cachedImageFull: ImageFullPayload | null = null;
let imageTabListeners: vscode.Disposable[] = []; // 모드 전환(disposables 초기화)에도 살아남는 전역 탭 감시
let imageShareEnabled = true;

// Cache of the fully serialized + image-resolved notebook payload, reused for every
// joining viewer instead of re-running serializeNotebook/resolveNotebookImages per join.
// MUST be invalidated on ANY notebook content change (cell text/outputs/structure) and on
// notebook switch, so a joining student can never receive stale content. activeCellIndex
// is overwritten per-join (see setupNewViewerHandler) since it's cheap and per-viewer.
let cachedNotebookFull: SerializedNotebook | null = null;

function invalidateNotebookFullCache(): void {
  cachedNotebookFull = null;
}

/**
 * setTimeout/스로틀 콜백 전용 안전 실행기. VS Code는 자신의 이벤트 리스너에서 나는 예외는
 * 감싸주지만, 그 리스너가 예약한 setTimeout 콜백은 감싸주지 않는다 → 여기서 throw가 새면
 * 프로세스 uncaughtException이 되어 (확장의 핸들러를 통해) 세션 전체가 내려갈 수 있다.
 * 직렬화/이미지 해석/브로드캐스트 중 한 번의 실패가 세션을 죽이지 않도록 격리·로깅한다.
 */
function runSafely(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    Logger.error(`[watcher] ${label} failed`, err);
  }
}

export function setImageShareEnabled(enabled: boolean) {
  imageShareEnabled = enabled;
}

/**
 * Get the base directory for the current file (for resolving relative image paths)
 */
function getBaseDir(): string {
  if (currentNotebook) {
    return path.dirname(currentNotebook.uri.fsPath);
  }
  if (currentTextDocument) {
    return path.dirname(currentTextDocument.uri.fsPath);
  }
  return '';
}

/**
 * Check if the current plaintext document's language supports image references.
 */
function isImageRelevantTextDocument(): boolean {
  if (!currentTextDocument) return false;
  return IMAGE_RELEVANT_LANGUAGES.has(currentTextDocument.languageId);
}

/**
 * Resolve local images in a serialized notebook's markup cells and HTML outputs.
 * Modifies the serialized object in place.
 * Uses full resolution (cache + disk I/O) for initial sync events.
 */
function resolveNotebookImages(serialized: SerializedNotebook, baseDir: string): void {
  if (!imageShareEnabled || !baseDir) return;
  for (const cell of serialized.cells) {
    if (cell.kind === 'markup') {
      cell.source = resolveLocalImages(cell.source, baseDir);
    }
    for (const output of cell.outputs) {
      for (const item of output.items) {
        if (item.mime === 'text/html') {
          item.data = resolveLocalImages(item.data, baseDir);
        }
      }
    }
  }
}

/**
 * Resolve local images in serialized cells (for cells:structure addedCells).
 * Modifies the cells array in place.
 */
function resolveAddedCellImages(cells: SerializedCell[], baseDir: string): void {
  if (!imageShareEnabled || !baseDir) return;
  for (const cell of cells) {
    if (cell.kind === 'markup') {
      cell.source = resolveLocalImages(cell.source, baseDir);
    }
    for (const output of cell.outputs) {
      for (const item of output.items) {
        if (item.mime === 'text/html') {
          item.data = resolveLocalImages(item.data, baseDir);
        }
      }
    }
  }
}

/**
 * Resolve local images in text content for full-sync events (document:full).
 * Uses full resolution (cache + disk I/O).
 */
function resolveTextImagesFull(content: string, baseDir: string): string {
  if (!imageShareEnabled || !baseDir) return content;
  return resolveLocalImages(content, baseDir);
}

/**
 * Resolve local images in text content for real-time typing events.
 * Uses cache-only mode to avoid blocking disk I/O during typing.
 */
function resolveTextImagesRealtime(content: string, baseDir: string): string {
  if (!imageShareEnabled || !baseDir) return content;
  return resolveLocalImagesCacheOnly(content, baseDir);
}

/**
 * Collect raw source texts from a notebook for preOptimizeImages.
 * Must be called BEFORE resolveNotebookImages (needs original local paths).
 */
function collectNotebookRawText(notebook: vscode.NotebookDocument): string {
  const parts: string[] = [];
  for (let i = 0; i < notebook.cellCount; i++) {
    const cell = notebook.cellAt(i);
    if (cell.kind === vscode.NotebookCellKind.Markup) {
      parts.push(cell.document.getText());
    }
    // Also scan HTML outputs for local image references
    for (const output of cell.outputs) {
      for (const item of output.items) {
        if (item.mime === 'text/html') {
          const html = new TextDecoder().decode(item.data);
          if (hasImagePatterns(html)) {
            parts.push(html);
          }
        }
      }
    }
  }
  return parts.join('\n');
}

/**
 * 에디터 스크롤 변경을 학생에게 throttle 적용하여 브로드캐스트.
 * cursorTrailingTimer 패턴과 동일한 leading+trailing 방식 사용.
 */
function broadcastViewportScroll(data: unknown) {
  const now = Date.now();
  const since = now - lastViewportTime;
  const send = () => { lastViewportTime = Date.now(); setLastScrollSync(data); broadcast('scroll:sync', data); };
  if (since < VIEWPORT_THROTTLE_MS) {
    if (viewportTrailingTimer) clearTimeout(viewportTrailingTimer);
    viewportTrailingTimer = setTimeout(() => { viewportTrailingTimer = null; runSafely('viewport scroll trailing', send); }, VIEWPORT_THROTTLE_MS - since);
    return;
  }
  send();
}

/**
 * Flush a single cell's pending throttled cell:update immediately, sending the
 * LATEST live source (re-read from the notebook at call time, not whatever was
 * captured when the timer was scheduled). Safe to call redundantly — it always
 * clears/deletes the timer entry first. Used by the throttle leading/trailing edges,
 * the cell-switch flush, and stopWatching's final flush so no keystroke is ever lost.
 */
function flushCellUpdate(cellIndex: number) {
  const timer = cellUpdateTrailingTimers.get(cellIndex);
  if (timer) clearTimeout(timer);
  cellUpdateTrailingTimers.delete(cellIndex);

  if (!currentNotebook) return;
  if (cellIndex < 0 || cellIndex >= currentNotebook.cellCount) return;

  const cell = currentNotebook.cellAt(cellIndex);
  const text = cell.document.getText();
  lastSentSources.set(cellIndex, text);
  lastCellUpdateTimes.set(cellIndex, Date.now());
  const isMarkup = cell.kind === vscode.NotebookCellKind.Markup;
  const resolvedText = (imageShareEnabled && isMarkup)
    ? resolveLocalImagesCacheOnly(text, getBaseDir())
    : text;
  if (SYNC_DEBUG) Logger.info(`[SYNC] cell:update idx=${cellIndex} len=${resolvedText.length} (throttle flush)`);
  broadcast('cell:update', { index: cellIndex, source: resolvedText });
}

/**
 * 백그라운드 이미지 최적화가 끝나 캐시가 채워진 뒤 호출된다. 실시간 타이핑 경로는
 * cache-only라 세션 중 처음 삽입한 이미지가 캐시 미스로 원본 로컬 경로인 채 전송돼
 * 학생 화면에서 깨진다. 최적화 완료 시점에 현재 활성 셀(또는 현재 텍스트 문서)을
 * full-resolve로 한 번 재전송해 그 이미지를 정상 임베드한다.
 * (한계: 활성 셀 기준이라 비활성 셀에 삽입한 이미지는 다음 편집/새 접속 시 보정된다.)
 */
function reBroadcastOptimizedImages(): void {
  if (!imageShareEnabled) return;
  // 새 접속자도 최신 이미지를 받도록 full 캐시를 무효화한다.
  invalidateNotebookFullCache();
  const baseDir = getBaseDir();
  if (!baseDir) return;

  if (watchMode === 'notebook' && currentNotebook) {
    const idx = lastActiveCellIndex;
    if (idx < 0 || idx >= currentNotebook.cellCount) return;
    const cell = currentNotebook.cellAt(idx);
    if (cell.kind !== vscode.NotebookCellKind.Markup) return;
    const text = cell.document.getText();
    if (!hasImagePatterns(text)) return;
    broadcast('cell:update', { index: idx, source: resolveLocalImages(text, baseDir) });
  } else if (watchMode === 'plaintext' && currentTextDocument) {
    const text = currentTextDocument.getText();
    if (!hasImagePatterns(text)) return;
    broadcast('document:update', { content: resolveLocalImages(text, baseDir) });
  }
}

/**
 * 셀 출력을 지금 즉시 직렬화·전송한다. currentNotebook에서 셀 출력을 다시 읽으므로
 * (이벤트 시점 스냅샷이 아니라) 호출 순간의 최신 출력을 보낸다 — trailing 타이머가
 * fire될 때도 마지막 출력이 정확히 반영된다.
 */
function sendCellOutput(cellIndex: number) {
  if (!currentNotebook) return;
  if (cellIndex < 0 || cellIndex >= currentNotebook.cellCount) return;
  const cell = currentNotebook.cellAt(cellIndex);
  const outputs = serializeOutputs(cell.outputs);
  // Resolve images in HTML output items (full resolution — 스로틀로 호출 빈도가 제한됨)
  if (imageShareEnabled) {
    const bd = getBaseDir();
    for (const output of outputs) {
      for (const item of output.items) {
        if (item.mime === 'text/html') {
          item.data = resolveLocalImages(item.data, bd);
        }
      }
    }
  }
  lastOutputTimes.set(cellIndex, Date.now());
  broadcast('cell:output', {
    index: cellIndex,
    outputs,
    executionOrder: cell.executionSummary?.executionOrder,
  });
  if (SYNC_DEBUG) Logger.info(`Cell ${cellIndex} output updated`);
}

/**
 * cell:output을 셀별 leading+trailing 스로틀로 전송한다. 스트리밍 출력(tqdm 등)이
 * 초당 수백 회 갱신돼도 브로드캐스트는 OUTPUT_THROTTLE_MS 간격으로 합쳐지며,
 * 마지막 출력은 trailing 타이머로 반드시 한 번 더 전송된다.
 */
function throttleCellOutput(cellIndex: number) {
  const now = Date.now();
  const since = now - (lastOutputTimes.get(cellIndex) || 0);
  if (since < OUTPUT_THROTTLE_MS) {
    const existing = outputTrailingTimers.get(cellIndex);
    if (existing) clearTimeout(existing);
    outputTrailingTimers.set(cellIndex, setTimeout(() => {
      outputTrailingTimers.delete(cellIndex);
      runSafely('cell:output trailing', () => sendCellOutput(cellIndex));
    }, OUTPUT_THROTTLE_MS - since));
    return;
  }
  sendCellOutput(cellIndex);
}

/**
 * Clear all pending timers and reset state on file switch.
 * Prevents stale events (cursor, cell updates) from the previous file
 * from leaking into the new file context.
 */
function flushAndResetState() {
  if (cursorTrailingTimer) {
    clearTimeout(cursorTrailingTimer);
    cursorTrailingTimer = null;
  }
  if (viewportTrailingTimer) {
    clearTimeout(viewportTrailingTimer);
    viewportTrailingTimer = null;
  }
  for (const timer of cellUpdateTrailingTimers.values()) {
    clearTimeout(timer);
  }
  cellUpdateTrailingTimers.clear();
  lastCellUpdateTimes.clear();
  // cell:output 스로틀 타이머도 정리 — 이전 파일에서 예약된 trailing이 전환 후 발화해
  // 새 파일에 엉뚱한 셀 출력을 보내는 것을 막는다.
  for (const timer of outputTrailingTimers.values()) {
    clearTimeout(timer);
  }
  outputTrailingTimers.clear();
  lastOutputTimes.clear();
  // 파일 전환용 백업 동기 타이머도 정리 (stopWatching과 동일하게). 정리하지 않으면 이전
  // 파일에서 예약된 백업이 전환 후 발화해 중복 cell:update를 유발할 수 있다.
  if (syncBackupTimer) {
    clearTimeout(syncBackupTimer);
    syncBackupTimer = null;
  }
  invalidateNotebookFullCache();
  if (textTrailingTimer) {
    clearTimeout(textTrailingTimer);
    textTrailingTimer = null;
  }
  // Reset throttle timestamps → first event for new file passes immediately
  lastFocusTime = 0;
  lastCursorTime = 0;
  lastViewportTime = 0;
  lastTextUpdateTime = 0;
  lastTextSentLength = 0;
  lastActiveCellIndex = -1;
  lastSentSources.clear();
}

/**
 * Switch to notebook mode: full cleanup → re-register ALL handlers → broadcast.
 * Solves the critical bug where text→notebook switch left notebook handlers unregistered.
 */
function switchToNotebook(notebook: vscode.NotebookDocument) {
  flushAndResetState();
  for (const d of disposables) { d.dispose(); }
  disposables = [];
  startWatchingNotebook(notebook);
  const editor = vscode.window.activeNotebookEditor;
  const activeCellIndex = editor?.selections?.length ? editor.selections[0].start : 0;

  // Collect raw text BEFORE image resolution for background pre-optimization
  const baseDir = getBaseDir();
  const rawText = imageShareEnabled ? collectNotebookRawText(notebook) : '';

  const serialized = serializeNotebook(notebook, activeCellIndex);
  // 탐색기에서 이 파일은 예산과 무관하게 항상 보이게 한다
  setExplorerActivePath(serialized.filePath);
  resolveNotebookImages(serialized, baseDir);
  broadcast('notebook:full', serialized);
  // Seed the join cache with the payload we just built (activeCellIndex gets overwritten
  // per-join anyway) so the next viewer to join doesn't pay for a redundant rebuild.
  cachedNotebookFull = serialized;

  // 파일 전환 시 판서 및 스크롤 위치 초기화
  clearDrawStrokes();
  broadcast('draw:clear', {});
  clearLastScrollSync();

  // Pre-optimize images in background using ORIGINAL text (not resolved data URIs)
  if (rawText) {
    preOptimizeImages(rawText, baseDir).catch((err) => {
      Logger.warn(`Background image pre-optimization failed: ${err}`);
    });
  }
  Logger.info(`Switched to notebook: ${notebook.uri.path}`);
}

/**
 * 활성 탭이 이미지 파일이면 그 Uri를 반환 (이미지 뷰어는 TextEditor가 아니라 커스텀 탭이라
 * onDidChangeActiveTextEditor로는 감지 불가 — tabGroups API로 판별).
 */
function getActiveImageUri(): vscode.Uri | null {
  try {
    const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    const input = tab?.input as { uri?: vscode.Uri } | undefined;
    const uri = input?.uri;
    if (!uri || uri.scheme !== 'file') return null;
    const ext = path.extname(uri.fsPath).toLowerCase();
    return IMAGE_EXTS.has(ext) ? uri : null;
  } catch {
    return null; // tabGroups 미지원 구버전 등 — 이미지 공유만 비활성, 세션은 무해
  }
}

/**
 * Switch to single image mode: 이미지 탭 활성화 시 최적화된 이미지를 image:full로 공유.
 * 다른 스위치들과 동일하게 full cleanup 후 복귀용 에디터 리스너만 재등록한다.
 */
function switchToImage(uri: vscode.Uri) {
  flushAndResetState();
  for (const d of disposables) { d.dispose(); }
  disposables = [];
  currentNotebook = null;
  currentTextDocument = null;
  currentImageUri = uri;
  cachedImageFull = null;
  watchMode = 'image';

  // 이미지 → 텍스트/노트북 복귀 감지
  disposables.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      if (editor.document.uri.scheme === 'vscode-notebook-cell') return;
      if (editor.document.uri.scheme !== 'file') return;
      switchToTextDocument(editor.document);
    })
  );
  disposables.push(
    vscode.window.onDidChangeActiveNotebookEditor((editor) => {
      if (!editor || editor.notebook.notebookType !== 'jupyter-notebook') return;
      switchToNotebook(editor.notebook);
    })
  );

  // 파일 전환 시 판서 및 스크롤 위치 초기화 (기존 switch들과 동일)
  clearDrawStrokes();
  broadcast('draw:clear', {});
  clearLastScrollSync();

  void broadcastImageFull(uri);
  Logger.info(`Switched to image: ${uri.path}`);
}

async function broadcastImageFull(uri: vscode.Uri): Promise<void> {
  try {
    const payload = await buildImagePayload(uri);
    // 인코딩 중 다른 파일로 전환됐으면 stale 페이로드를 보내지 않는다
    if (watchMode !== 'image' || !currentImageUri || currentImageUri.toString() !== uri.toString()) return;
    cachedImageFull = payload;
    broadcast('image:full', payload);
  } catch (err) {
    // 이미지 공유는 부가 기능 — 실패가 세션을 위협하지 않게 로그만 남긴다
    Logger.warn(`[imageShare] broadcast failed: ${String(err)}`);
  }
}

/**
 * 전역 이미지 탭 감시 등록 — 모드 전환 시 disposables가 통째로 정리되므로
 * 별도 배열(imageTabListeners)로 관리해 세션 내내 유지한다. startWatching에서 1회 등록.
 */
function startImageTabWatch(): void {
  stopImageTabWatch();
  const check = () => {
    try {
      const uri = getActiveImageUri();
      if (!uri) return;
      if (watchMode === 'image' && currentImageUri && currentImageUri.toString() === uri.toString()) return;
      switchToImage(uri);
    } catch (err) {
      Logger.warn(`[imageShare] tab check failed: ${String(err)}`);
    }
  };
  imageTabListeners.push(vscode.window.tabGroups.onDidChangeTabs(check));
  imageTabListeners.push(vscode.window.tabGroups.onDidChangeTabGroups(check));
}

function stopImageTabWatch(): void {
  for (const d of imageTabListeners) { try { d.dispose(); } catch { /* 무시 */ } }
  imageTabListeners = [];
}

/**
 * Switch to text document mode: full cleanup → re-register ALL handlers → broadcast.
 */
function switchToTextDocument(document: vscode.TextDocument) {
  flushAndResetState();
  for (const d of disposables) { d.dispose(); }
  disposables = [];
  startWatchingTextDocument(document);

  const serialized = serializeTextDocument(document);
  setExplorerActivePath(serialized.filePath);
  const baseDir = getBaseDir();

  // Pre-optimize using original content, then resolve for broadcast
  const originalContent = serialized.content;
  if (isImageRelevantTextDocument()) {
    serialized.content = resolveTextImagesFull(serialized.content, baseDir);
    preOptimizeImages(originalContent, baseDir).catch((err) => {
      Logger.warn(`Background image pre-optimization failed: ${err}`);
    });
  }

  broadcast('document:full', serialized);

  // 파일 전환 시 판서 및 스크롤 위치 초기화
  clearDrawStrokes();
  broadcast('draw:clear', {});
  clearLastScrollSync();

  Logger.info(`Switched to text document: ${document.uri.path}`);
}

export function getWatchMode(): 'notebook' | 'plaintext' | 'image' | null {
  return watchMode;
}

export function getCurrentFileUri(): import('vscode').Uri | null {
  if (watchMode === 'notebook' && currentNotebook) {
    return currentNotebook.uri;
  }
  if (watchMode === 'plaintext' && currentTextDocument) {
    return currentTextDocument.uri;
  }
  if (watchMode === 'image' && currentImageUri) {
    return currentImageUri;
  }
  return null;
}

export function getCurrentFileName(): string | null {
  const uri = getCurrentFileUri();
  if (!uri) return null;
  return uri.path.split('/').pop() || null;
}

/**
 * Extract cell index from notebook cell URI
 * Cell URIs have format: vscode-notebook-cell:/path/to/notebook.ipynb#X...
 * where X is related to the cell
 */
function getCellIndexFromUri(cellUri: vscode.Uri, notebook: vscode.NotebookDocument): number {
  // Find the cell by matching document URI
  for (let i = 0; i < notebook.cellCount; i++) {
    const cell = notebook.cellAt(i);
    if (cell.document.uri.toString() === cellUri.toString()) {
      return i;
    }
  }
  return -1;
}

// 현재 등록된 신규 접속자 리스너. 재등록 시 먼저 해제하는 용도.
let newViewerSub: { dispose(): void } | null = null;

/**
 * Setup new viewer handler once - handles both notebook and plaintext modes
 * This prevents duplicate handler registration when switching between modes
 */
function setupNewViewerHandler() {
  // 세션을 다시 시작하면 이 함수도 다시 불린다. 기존 등록을 먼저 해제해서
  // 리스너가 중복으로 쌓이지 않게 하고, 항상 정확히 하나만 남게 한다.
  newViewerSub?.dispose();
  newViewerSub = addNewViewerListener((ws: WebSocket) => {
    if (watchMode === 'notebook' && currentNotebook) {
      const editor = vscode.window.activeNotebookEditor;
      const activeCellIndex = editor?.selections?.length ? editor.selections[0].start : 0;

      // H4: reuse the cached serialized+image-resolved payload across joins instead of
      // re-running serializeNotebook/resolveNotebookImages for every viewer. The cache is
      // invalidated on ANY notebook change (see invalidateNotebookFullCache callers), so a
      // cache hit here is always current content. activeCellIndex is per-viewer and cheap,
      // so it's overwritten on a shallow copy — the cached object itself is never mutated.
      if (!cachedNotebookFull) {
        cachedNotebookFull = serializeNotebook(currentNotebook, activeCellIndex);
        resolveNotebookImages(cachedNotebookFull, getBaseDir());
      }
      sendTo(ws, 'notebook:full', { ...cachedNotebookFull, activeCellIndex });
      // 노트북 스크롤 위치는 아래 getLastScrollSync() 재생으로 새 접속자에게 전달됨
    } else if (watchMode === 'plaintext' && currentTextDocument) {
      const serialized = serializeTextDocument(currentTextDocument);
      if (isImageRelevantTextDocument()) {
        serialized.content = resolveTextImagesFull(serialized.content, getBaseDir());
      }
      sendTo(ws, 'document:full', serialized);
      // plaintext 스크롤 위치는 아래 getLastScrollSync() 재생으로 새 접속자에게 전달됨
    }

    // 활성 설문이 있으면 새 접속자에게 전송
    const poll = getCurrentPollState();
    if (poll) {
      sendTo(ws, 'poll:start', {
        pollId: poll.pollId,
        question: poll.question,
        optionCount: poll.optionCount,
        ...(poll.options ? { options: poll.options } : {}),
      });
      sendTo(ws, 'poll:results', {
        pollId: poll.pollId,
        votes: poll.votes,
        totalVoters: poll.totalVoters,
        ...(poll.options ? { options: poll.options } : {}),
      });
    }

    // 기존 판서 데이터가 있으면 새 접속자에게 전송
    const strokes = getDrawStrokes();
    if (strokes.length > 0) {
      sendTo(ws, 'draw:full', { strokes });
    }

    // 마지막 스크롤 위치가 있으면 새 접속자에게 전송
    const scrollState = getLastScrollSync();
    if (scrollState) {
      sendTo(ws, 'scroll:sync', scrollState);
    }

    // 이미지 모드: 캐시된 image:full을 새 접속자에게 전송
    // (캐시가 아직 없으면 = 인코딩 중이면, 완료 시 broadcast가 전 클라이언트를 커버)
    if (watchMode === 'image' && cachedImageFull) {
      sendTo(ws, 'image:full', cachedImageFull);
    }

    // 탐색기 트리 공유가 켜져 있고 캐시가 준비됐으면 새 접속자에게 전송
    // (재빌드 없이 캐시 재사용 — 뷰어는 이 이벤트를 못 받으면 트리 UI를 노출하지 않음)
    if (getConfig().shareExplorer) {
      const explorerTree = getExplorerTree();
      if (explorerTree) {
        sendTo(ws, 'explorer:tree', explorerTree);
      }
    }
  });
}

export function startWatching() {
  // Set workspace root as security boundary for image path resolution
  const folders = vscode.workspace.workspaceFolders;
  setProjectRoot(folders?.[0]?.uri.fsPath ?? null);

  // 백그라운드 이미지 최적화 완료 시 활성 셀/문서를 재전송하도록 훅 등록
  setOnImagesOptimized(reBroadcastOptimizedImages);

  // Register new viewer handler once (handles both notebook and plaintext modes)
  setupNewViewerHandler();

  // 탐색기 트리 공유 — 게이트는 explorerTree 내부에서 전송 시점마다 재확인한다
  // (설정이 꺼져 있으면 어떤 경로로도 전송 없음, 수업 중 켜고 끄기도 즉시 반영).
  startExplorerWatch();

  // 이미지 탭 전역 감시 — 모드와 무관하게 세션 내내 유지 (이미지 탭 활성화 → image 모드 진입)
  startImageTabWatch();

  // 0) 세션 시작 시점에 이미 이미지 탭이 활성인 경우 (아래 노트북/텍스트 검사보다 우선 —
  //    이미지 탭이 활성이면 activeNotebook/activeTextEditor는 어차피 비어 있다)
  const initialImage = getActiveImageUri();
  if (initialImage) {
    switchToImage(initialImage);
    return;
  }

  // 1) 포커스된 노트북 에디터 우선
  const activeNotebook = vscode.window.activeNotebookEditor;
  if (activeNotebook) {
    startWatchingNotebook(activeNotebook.notebook);
    return;
  }

  // 2) 포커스된 텍스트 파일 에디터
  const activeTextEditor = vscode.window.activeTextEditor;
  if (activeTextEditor && activeTextEditor.document.uri.scheme === 'file') {
    startWatchingTextDocument(activeTextEditor.document);
    return;
  }

  // 3) ★ 포커스된 파일 에디터가 없을 때(사이드바 '세션 시작' 버튼=웹뷰로 시작하면 포커스가 웹뷰로 가서
  //    activeNotebookEditor/activeTextEditor가 비게 됨) '열려있는(보이는)' 에디터로 폴백한다.
  //    이게 없으면 파일을 이미 열어둔 상태여도 idle로 빠져 학생·Teacher Preview가 초기 full-sync를
  //    못 받고 '로딩중'에서 멈춘다(새 파일을 선택해야 풀리던 증상). 노트북을 우선 검사한다.
  const visibleNotebook = vscode.window.visibleNotebookEditors.find(
    (e) => e.notebook.notebookType === 'jupyter-notebook'
  );
  if (visibleNotebook) {
    startWatchingNotebook(visibleNotebook.notebook);
    return;
  }
  const visibleTextEditor = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.scheme === 'file'
  );
  if (visibleTextEditor) {
    startWatchingTextDocument(visibleTextEditor.document);
    return;
  }

  // 파일 없이 세션 시작 — idle 모드로 대기
  startWatchingIdle();
}

/**
 * Idle mode: 파일이 아직 열리지 않은 상태에서 에디터 변경을 감시.
 * 파일이 열리면 자동으로 해당 모드(notebook/plaintext)로 전환.
 */
function startWatchingIdle() {
  watchMode = null;
  currentNotebook = null;
  currentTextDocument = null;
  Logger.info('Watching in idle mode (no active file)');

  // 노트북 에디터 활성화 감지
  disposables.push(
    vscode.window.onDidChangeActiveNotebookEditor((editor) => {
      if (editor && editor.notebook.notebookType === 'jupyter-notebook') {
        // switchToNotebook: dispose idle listeners → register notebook handlers → broadcast to existing viewers
        switchToNotebook(editor.notebook);
      }
    })
  );

  // 텍스트 에디터 활성화 감지
  disposables.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      if (editor.document.uri.scheme === 'vscode-notebook-cell') return;
      if (editor.document.uri.scheme !== 'file') return;

      // switchToTextDocument: dispose idle listeners → register text handlers → broadcast to existing viewers
      switchToTextDocument(editor.document);
    })
  );
}

function startWatchingNotebook(notebook: vscode.NotebookDocument) {
  currentNotebook = notebook;
  currentTextDocument = null;
  watchMode = 'notebook';

  // 초기 활성 셀 인덱스 설정 (race condition 방지)
  const editor = vscode.window.activeNotebookEditor;
  if (editor && editor.selections.length > 0) {
    lastActiveCellIndex = editor.selections[0].start;
  }

  Logger.info(`Watching notebook: ${currentNotebook.uri.path}`);

  // 노트북 문서 변경 감지 (셀 내용 + 출력 + 구조)
  disposables.push(
    vscode.workspace.onDidChangeNotebookDocument((event) => {
      if (!currentNotebook) return;
      if (event.notebook.uri.toString() !== currentNotebook.uri.toString()) return;

      // 어떤 변경이든(셀 내용/출력/구조) 즉시 캐시 무효화 — 다음 join은 항상 최신 상태를 받는다.
      // (cell:update 자체는 스로틀될 수 있지만, 캐시는 여기서 즉시 비우고 다음 접속 시
      // serializeNotebook이 그 시점의 live 텍스트를 다시 읽으므로 스로틀 타이밍과 무관하게 최신이다)
      invalidateNotebookFullCache();

      // 구조 변경(셀 추가/삭제)이 섞인 컴파운드 이벤트 여부 — 아래 두 곳에서 사용.
      // leading 즉시 전송이 이 가드보다 먼저 실행되면 밀린 인덱스로 다른 셀에 내용이
      // 칠해질 수 있으므로, 구조 변경 이벤트에서는 내용 전송을 아예 건너뛴다
      // (구 디바운스 시절과 동일 의미 — cells:structure와 다음 편집/백업이 내용을 나른다).
      const hasStructureChange = event.contentChanges.length > 0;

      // 셀 내용 변경 (타이핑)
      for (const change of event.cellChanges) {
        if (change.document && !hasStructureChange) {
          const cellIndex = change.cell.index;

          // ★ leading+trailing 스로틀 (cell:output과 동일 패턴). 첫 키는 즉시 전송(leading),
          // 연타 중에는 CELL_UPDATE_THROTTLE_MS마다 중간 상태가 전송되고, 마지막 상태는
          // trailing 타이머가 보장한다. flushCellUpdate가 fire 시점에 currentNotebook에서
          // 셀을 다시 조회해 항상 "그 순간의 최신 소스"를 읽으므로 키 입력이 유실되지 않는다.
          // 셀 전환/블러/정지 경로가 모두 대기 중 타이머를 즉시 flush한다.
          const now = Date.now();
          const since = now - (lastCellUpdateTimes.get(cellIndex) || 0);
          if (since < CELL_UPDATE_THROTTLE_MS) {
            const existing = cellUpdateTrailingTimers.get(cellIndex);
            if (existing) clearTimeout(existing);
            cellUpdateTrailingTimers.set(cellIndex, setTimeout(() => {
              runSafely('cell:update trailing flush', () => flushCellUpdate(cellIndex));
            }, CELL_UPDATE_THROTTLE_MS - since));
          } else {
            runSafely('cell:update leading send', () => flushCellUpdate(cellIndex));
          }
        }

        if (change.outputs) {
          // 셀 실행 결과 변경 → 셀별 leading+trailing 스로틀로 전송 (스트리밍 출력 폭주 억제).
          throttleCellOutput(change.cell.index);
        }
      }

      // 구조 변경(셀 추가/삭제)이 있는 이벤트면, 인덱스 기반 대기 타이머를 모두 취소한다.
      // 인덱스가 밀린 뒤 flush되면 다른 셀의 내용/출력을 잘못된 index로 보낼 수 있기 때문.
      // (안전 우선: 잘못된 내용 전송을 막는다. 취소된 마지막 편집분은 다음 편집/백업으로 보정됨.)
      if (hasStructureChange) {
        for (const timer of cellUpdateTrailingTimers.values()) clearTimeout(timer);
        cellUpdateTrailingTimers.clear();
        for (const timer of outputTrailingTimers.values()) clearTimeout(timer);
        outputTrailingTimers.clear();
        // 타임스탬프도 초기화 — 인덱스가 밀려 다른 셀의 시각이 되므로, 구조 변경 후
        // 각 셀의 첫 편집이 스로틀에 걸리지 않고 즉시(leading) 전송되게 한다.
        lastCellUpdateTimes.clear();
        lastOutputTimes.clear();
      }

      // 셀 구조 변경 (추가/삭제)
      for (const change of event.contentChanges) {
        const addedCells = change.addedCells.map(serializeCell);
        // Resolve images in newly added cells
        resolveAddedCellImages(addedCells, getBaseDir());
        broadcast('cells:structure', {
          type: change.removedCells.length > 0 ? 'delete' : 'insert',
          index: change.range.start,
          removedCount: change.removedCells.length,
          addedCells,
        });
        // 셀 구조 변경 시 판서 초기화
        clearDrawStrokes();
        broadcast('draw:clear', {});
        if (SYNC_DEBUG) {
          Logger.info(
            `Cells structure changed: ${change.addedCells.length} added, ${change.removedCells.length} removed`
          );
        }
      }
    })
  );

  // 활성 셀 변경 감지 (선생님 포커스)
  disposables.push(
    vscode.window.onDidChangeNotebookEditorSelection((event) => {
      const selections = event.selections;
      if (selections.length > 0 && currentNotebook) {
        const activeCellIndex = selections[0].start;

        // 셀 전환 시: 이전 셀의 pending cell:update를 즉시 flush (마지막 글자 누락 방지)
        if (activeCellIndex !== lastActiveCellIndex) {
          for (const idx of [...cellUpdateTrailingTimers.keys()]) {
            if (idx !== activeCellIndex) {
              flushCellUpdate(idx);
            }
          }
          lastActiveCellIndex = activeCellIndex;
        }

        // throttle for focus:cell broadcast
        const now = Date.now();
        if (now - lastFocusTime < THROTTLE_MS) return;
        lastFocusTime = now;

        // 셀 타입 정보 추가 (마크다운 셀 동기화 개선용)
        const cell = currentNotebook.cellAt(activeCellIndex);
        const cellKind = cell.kind === vscode.NotebookCellKind.Markup ? 'markup' : 'code';

        broadcast('focus:cell', { cellIndex: activeCellIndex, cellKind });
      }
    })
  );

  // 노트북 에디터 뷰포트(스크롤) 변경 감지 — 선생님 스크롤을 학생에게 셀 단위 앵커로 동기화
  disposables.push(
    vscode.window.onDidChangeNotebookEditorVisibleRanges((event) => {
      if (!currentNotebook) return;
      if (event.notebookEditor.notebook.uri.toString() !== currentNotebook.uri.toString()) return;
      const ranges = event.visibleRanges;
      if (!ranges || ranges.length === 0) return;
      const firstVisibleCell = ranges[0].start; // NotebookRange.start = 첫 번째 보이는 셀 인덱스
      // offsetRatio=0: VS Code Notebook API는 셀 단위 정보만 제공(셀 내부 픽셀 오프셋 없음) → 셀 단위 추종
      // source:'editor' — 실제 에디터 스크롤임을 표시 (프리뷰가 자신의 에코와 구별하기 위해 사용)
      broadcastViewportScroll({ type: 'notebook', cellIndex: firstVisibleCell, offsetRatio: 0, source: 'editor' });
    })
  );

  // 텍스트 에디터 커서 위치 감지 (셀 내부 커서)
  disposables.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      // 노트북 셀 에디터인 경우에만 처리
      if (event.textEditor.document.uri.scheme !== 'vscode-notebook-cell') return;
      if (!currentNotebook) return;

      // 셀 인덱스 추출
      const cellUri = event.textEditor.document.uri;
      const cellIndex = getCellIndexFromUri(cellUri, currentNotebook);
      if (cellIndex === -1) return;

      // 활성 셀만 처리 — background LSP/formatter가 비활성 셀에서 발생시키는
      // selection 이벤트를 무시하여 커서 점프 방지
      if (cellIndex !== lastActiveCellIndex) return;

      const selection = event.selections[0];
      if (!selection) return;

      const totalLines = event.textEditor.document.lineCount;
      const currentLine = selection.active.line;
      const lineRatio = totalLines > 1 ? currentLine / (totalLines - 1) : 0;

      // ★ 핵심 설계: cursor:position에는 절대로 source를 포함하지 않는다.
      // 이유: onDidChangeTextEditorSelection은 document가 아직 업데이트되기 전에
      // 발생할 수 있어서 document.getText()가 stale(이전) 내용을 반환한다.
      // 이 stale source가 viewer에서 cell:update의 올바른 source를 덮어쓰는 버그 발생.
      // 소스 동기화는 onDidChangeNotebookDocument → cell:update가 전담한다.
      const payload = {
        cellIndex,
        line: currentLine,
        character: selection.active.character,
        totalLines,
        lineRatio: Math.min(1, Math.max(0, lineRatio)),
        selectionStart: {
          line: selection.start.line,
          character: selection.start.character,
        },
        selectionEnd: {
          line: selection.end.line,
          character: selection.end.character,
        },
        hasSelection: !selection.isEmpty,
      };

      // ★ 백업 소스 동기화: IME 조합(한글 등) 중 onDidChangeNotebookDocument가
      // 발생하지 않는 경우를 대비. setTimeout으로 document가 완전히 업데이트된 후
      // 텍스트를 읽어 차이가 있으면 cell:update 전송.
      // - 50ms 지연: setTimeout(0)은 document 업데이트 전에 실행될 수 있음
      // - lastSent ?? '': 미등록 셀을 빈 문자열로 처리하여 false positive 방지
      const capturedCellIndex = cellIndex;
      if (syncBackupTimer) clearTimeout(syncBackupTimer);
      syncBackupTimer = setTimeout(() => {
        syncBackupTimer = null;
        runSafely('cell:update IME backup', () => {
          if (!currentNotebook) return;
          if (capturedCellIndex < 0 || capturedCellIndex >= currentNotebook.cellCount) return;
          const cell = currentNotebook.cellAt(capturedCellIndex);
          const currentText = cell.document.getText();
          const lastSent = lastSentSources.get(capturedCellIndex) ?? '';
          if (currentText !== lastSent) {
            lastSentSources.set(capturedCellIndex, currentText);
            if (SYNC_DEBUG) Logger.info(`[SYNC-BACKUP] cell:update idx=${capturedCellIndex} len=${currentText.length} (IME fallback)`);
            // Resolve images in markup cells (cache-only for real-time)
            const isMarkupCell = cell.kind === vscode.NotebookCellKind.Markup;
            const resolvedText = (imageShareEnabled && isMarkupCell)
              ? resolveLocalImagesCacheOnly(currentText, getBaseDir())
              : currentText;
            broadcast('cell:update', { index: capturedCellIndex, source: resolvedText });
          }
        });
      }, 50);

      // 커서 위치만 전송 → throttle 적용
      const now = Date.now();
      const timeSinceLast = now - lastCursorTime;

      if (timeSinceLast < CURSOR_THROTTLE_MS) {
        // Trailing edge: 마지막 커서 위치는 반드시 전송
        if (cursorTrailingTimer) clearTimeout(cursorTrailingTimer);
        cursorTrailingTimer = setTimeout(() => {
          cursorTrailingTimer = null;
          lastCursorTime = Date.now();
          runSafely('cursor:position trailing', () => broadcast('cursor:position', payload));
        }, CURSOR_THROTTLE_MS - timeSinceLast);
        return;
      }

      lastCursorTime = now;
      broadcast('cursor:position', payload);
    })
  );

  // 활성 노트북 에디터 변경 (다른 노트북으로 전환)
  disposables.push(
    vscode.window.onDidChangeActiveNotebookEditor((editor) => {
      if (!editor || editor.notebook.notebookType !== 'jupyter-notebook') return;
      if (currentNotebook && editor.notebook.uri.toString() === currentNotebook.uri.toString()) return;
      switchToNotebook(editor.notebook);
    })
  );

  // 텍스트 에디터로 전환 감지
  disposables.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      if (editor.document.uri.scheme === 'vscode-notebook-cell') return;
      if (editor.document.uri.scheme !== 'file') return;
      if (currentTextDocument && editor.document.uri.toString() === currentTextDocument.uri.toString()) return;
      switchToTextDocument(editor.document);
    })
  );
}

function startWatchingTextDocument(document: vscode.TextDocument) {
  currentTextDocument = document;
  currentNotebook = null;
  watchMode = 'plaintext';
  Logger.info(`Watching text document: ${currentTextDocument.uri.path}`);

  // 텍스트 문서 변경 감시
  setupTextDocumentWatcher();

  // 텍스트 에디터 전환 감지
  disposables.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      if (editor.document.uri.scheme === 'vscode-notebook-cell') return;
      if (editor.document.uri.scheme !== 'file') return;
      if (currentTextDocument && editor.document.uri.toString() === currentTextDocument.uri.toString()) return;
      switchToTextDocument(editor.document);
    })
  );

  // 노트북 에디터로 전환 감지
  disposables.push(
    vscode.window.onDidChangeActiveNotebookEditor((editor) => {
      if (!editor || editor.notebook.notebookType !== 'jupyter-notebook') return;
      if (currentNotebook && editor.notebook.uri.toString() === currentNotebook.uri.toString()) return;
      switchToNotebook(editor.notebook);
    })
  );
}

function setupTextDocumentWatcher() {
  // 기존 텍스트 변경 리스너 제거 (중복 방지)
  disposables = disposables.filter((d) => {
    if ((d as any).__textDocWatcher) {
      d.dispose();
      return false;
    }
    return true;
  });

  // 현재 문서의 최신 텍스트를 지금 즉시 전송한다. currentTextDocument에서 다시 읽으므로
  // trailing 타이머가 fire될 때도 그 순간의 최신 내용이 나간다 (마지막 키 입력 유실 없음).
  const sendDocumentUpdate = () => {
    if (!currentTextDocument) return;
    lastTextUpdateTime = Date.now();
    let content = currentTextDocument.getText();
    lastTextSentLength = content.length;
    // Only resolve images for markdown/html documents (cache-only for real-time typing)
    if (isImageRelevantTextDocument()) {
      content = resolveTextImagesRealtime(content, getBaseDir());
    }
    broadcast('document:update', { content });
  };

  // document:update는 전체 문서 텍스트를 실어 나르므로, 문서가 클수록 간격을 늘려
  // 지속 타이핑 시 전송량을 캡한다 (예: 100KB×50명이 150ms마다 나가면 터널이 감당 불가).
  // 키 입력마다 전체 텍스트를 읽지 않도록 '마지막 전송 길이' 기준으로 판정한다.
  const textThrottleInterval = () =>
    lastTextSentLength > 200_000 ? 1500
      : lastTextSentLength > 50_000 ? 500
      : TEXT_THROTTLE_MS;

  const textWatcher = vscode.workspace.onDidChangeTextDocument((event) => {
    if (!currentTextDocument) return;
    if (event.document.uri.toString() !== currentTextDocument.uri.toString()) return;

    // leading+trailing 스로틀 — 연타 중에도 간격마다 중간 상태가 전송돼
    // 학생 화면 글자가 실시간으로 따라온다 (과거 trailing 디바운스는 키를 떼야만 반영).
    const interval = textThrottleInterval();
    const now = Date.now();
    const since = now - lastTextUpdateTime;
    if (since < interval) {
      if (textTrailingTimer) clearTimeout(textTrailingTimer);
      textTrailingTimer = setTimeout(() => {
        textTrailingTimer = null;
        runSafely('document:update trailing', sendDocumentUpdate);
      }, interval - since);
    } else {
      runSafely('document:update leading', sendDocumentUpdate);
    }
  });

  (textWatcher as any).__textDocWatcher = true;
  disposables.push(textWatcher);

  // 텍스트 에디터 뷰포트(스크롤) 변경 감지 — 선생님 스크롤을 학생에게 line 앵커로 동기화
  const viewportWatcher = vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
    if (!currentTextDocument) return;
    if (event.textEditor.document.uri.toString() !== currentTextDocument.uri.toString()) return;
    if (event.textEditor.document.uri.scheme === 'vscode-notebook-cell') return;
    const ranges = event.visibleRanges;
    if (!ranges || ranges.length === 0) return;
    const firstVisibleLine = ranges[0].start.line;
    // offsetRatio=0: 에디터 뷰포트는 줄 단위 추종(첫 보이는 줄을 학생 화면 상단에 정렬)
    // source:'editor' — 실제 에디터 스크롤임을 표시 (프리뷰가 자신의 에코와 구별하기 위해 사용)
    broadcastViewportScroll({ type: 'plaintext', line: firstVisibleLine, offsetRatio: 0, source: 'editor' });
  });

  (viewportWatcher as any).__textDocWatcher = true;
  disposables.push(viewportWatcher);

  // 텍스트 에디터 커서 위치 감지 (선생님 커서 공유)
  const cursorWatcher = vscode.window.onDidChangeTextEditorSelection((event) => {
    if (!currentTextDocument) return;
    if (event.textEditor.document.uri.toString() !== currentTextDocument.uri.toString()) return;
    if (event.textEditor.document.uri.scheme === 'vscode-notebook-cell') return;

    const selection = event.selections[0];
    if (!selection) return;

    const totalLines = event.textEditor.document.lineCount;
    const currentLine = selection.active.line;
    const lineRatio = totalLines > 1 ? currentLine / (totalLines - 1) : 0;

    const payload = {
      mode: 'plaintext' as const,
      line: currentLine,
      character: selection.active.character,
      totalLines,
      lineRatio: Math.min(1, Math.max(0, lineRatio)),
      selectionStart: {
        line: selection.start.line,
        character: selection.start.character,
      },
      selectionEnd: {
        line: selection.end.line,
        character: selection.end.character,
      },
      hasSelection: !selection.isEmpty,
    };

    // Leading + trailing edge throttle (lastCursorTime/cursorTrailingTimer 공유)
    const now = Date.now();
    const timeSinceLast = now - lastCursorTime;

    if (timeSinceLast < CURSOR_THROTTLE_MS) {
      if (cursorTrailingTimer) clearTimeout(cursorTrailingTimer);
      cursorTrailingTimer = setTimeout(() => {
        cursorTrailingTimer = null;
        lastCursorTime = Date.now();
        runSafely('cursor:position trailing', () => broadcast('cursor:position', payload));
      }, CURSOR_THROTTLE_MS - timeSinceLast);
      return;
    }

    lastCursorTime = now;
    broadcast('cursor:position', payload);
  });

  (cursorWatcher as any).__textDocWatcher = true;
  disposables.push(cursorWatcher);
}

/**
 * 현재 문서의 최신 내용을 반환 (메모리 기반, 저장 여부 무관)
 */
export function getCurrentContent(): { content: string; mode: 'notebook' | 'plaintext' } | null {
  if (watchMode === 'notebook' && currentNotebook) {
    // .ipynb JSON 형식으로 직렬화
    const cells = [];
    for (let i = 0; i < currentNotebook.cellCount; i++) {
      const cell = currentNotebook.cellAt(i);
      const cellType = cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown';
      const source = cell.document.getText();
      const sourceLines = source ? source.split('\n').map((line, idx, arr) =>
        idx < arr.length - 1 ? line + '\n' : line
      ) : [''];

      const outputs: any[] = [];
      for (const output of cell.outputs) {
        // 하나의 output에 여러 MIME item이 있을 수 있음 (예: text/html + text/plain)
        // .ipynb 형식: 하나의 output.data에 여러 MIME key를 병합
        let outputType: string | null = null;
        const data: Record<string, any> = {};
        let streamName: string | null = null;
        let streamText: string[] = [];
        let errorObj: any = null;

        for (const item of output.items) {
          const decoded = () => new TextDecoder().decode(item.data);
          const toLines = (text: string) => text.split('\n').map((line, idx, arr) =>
            idx < arr.length - 1 ? line + '\n' : line
          );

          if (item.mime === 'application/vnd.code.notebook.stdout') {
            outputType = 'stream';
            streamName = 'stdout';
            streamText = toLines(decoded());
          } else if (item.mime === 'application/vnd.code.notebook.stderr') {
            outputType = 'stream';
            streamName = 'stderr';
            streamText = toLines(decoded());
          } else if (item.mime === 'application/vnd.code.notebook.error') {
            outputType = 'error';
            try {
              errorObj = JSON.parse(decoded());
            } catch {
              errorObj = { ename: 'Error', evalue: decoded(), traceback: [] };
            }
          } else if (item.mime.startsWith('image/')) {
            outputType = outputType || 'display_data';
            data[item.mime] = Buffer.from(item.data).toString('base64');
          } else if (item.mime === 'text/html') {
            outputType = outputType || 'execute_result';
            data['text/html'] = toLines(decoded());
          } else if (item.mime === 'text/plain') {
            outputType = outputType || 'execute_result';
            data['text/plain'] = [decoded()];
          }
        }

        if (outputType === 'stream' && streamName) {
          outputs.push({ output_type: 'stream', name: streamName, text: streamText });
        } else if (outputType === 'error' && errorObj) {
          outputs.push({
            output_type: 'error',
            ename: errorObj.ename || '',
            evalue: errorObj.evalue || '',
            traceback: errorObj.traceback || [],
          });
        } else if (outputType && Object.keys(data).length > 0) {
          outputs.push({
            output_type: outputType,
            data,
            metadata: {},
            execution_count: cell.executionSummary?.executionOrder ?? null,
          });
        }
      }

      const cellObj: any = {
        cell_type: cellType,
        source: sourceLines,
        metadata: {},
      };

      if (cellType === 'code') {
        cellObj.execution_count = cell.executionSummary?.executionOrder ?? null;
        cellObj.outputs = outputs;
      }

      cells.push(cellObj);
    }

    // Extract kernel metadata from NotebookDocument (fallback to defaults if not available)
    const nbMeta = (currentNotebook.metadata as Record<string, any>) || {};

    // VS Code Jupyter extension stores original metadata in various locations
    const customMeta = nbMeta.custom?.metadata || nbMeta.metadata || {};

    const kernelspec = customMeta.kernelspec || nbMeta.kernelspec || {
      display_name: 'Python 3',
      language: 'python',
      name: 'python3',
    };

    const language_info = customMeta.language_info || nbMeta.language_info || {
      name: 'python',
      version: '3.12.0',
    };

    const ipynb = {
      cells,
      metadata: {
        kernelspec,
        language_info,
      },
      nbformat: customMeta.nbformat || nbMeta.nbformat || 4,
      nbformat_minor: customMeta.nbformat_minor || nbMeta.nbformat_minor || 5,
    };

    return { content: JSON.stringify(ipynb, null, 1), mode: 'notebook' };
  }

  if (watchMode === 'plaintext' && currentTextDocument) {
    return { content: currentTextDocument.getText(), mode: 'plaintext' };
  }

  return null;
}

export function stopWatching() {
  for (const disposable of disposables) {
    disposable.dispose();
  }
  disposables = [];

  // 탐색기 트리 감시 정리 (설정과 무관하게 항상 호출 — idempotent라 안전)
  stopExplorerWatch();

  // 이미지 탭 감시·상태 정리
  stopImageTabWatch();
  currentImageUri = null;
  cachedImageFull = null;

  // Flush: send final cell state for every pending trailing timer before stopping
  // (prevent last-keystroke loss).
  for (const idx of [...cellUpdateTrailingTimers.keys()]) {
    flushCellUpdate(idx);
  }
  cellUpdateTrailingTimers.clear();
  lastCellUpdateTimes.clear();
  // cell:output 스로틀 trailing 타이머 정리 (세션 종료 후 발화 방지).
  for (const timer of outputTrailingTimers.values()) {
    clearTimeout(timer);
  }
  outputTrailingTimers.clear();
  lastOutputTimes.clear();
  invalidateNotebookFullCache();

  if (cursorTrailingTimer) {
    clearTimeout(cursorTrailingTimer);
    cursorTrailingTimer = null;
  }

  if (viewportTrailingTimer) {
    clearTimeout(viewportTrailingTimer);
    viewportTrailingTimer = null;
  }

  if (textTrailingTimer) {
    clearTimeout(textTrailingTimer);
    textTrailingTimer = null;
  }
  lastTextUpdateTime = 0;
  lastTextSentLength = 0;

  if (syncBackupTimer) {
    clearTimeout(syncBackupTimer);
    syncBackupTimer = null;
  }

  lastSentSources.clear();
  setOnImagesOptimized(null);
  clearImageCache();
  setProjectRoot(null);
  currentNotebook = null;
  currentTextDocument = null;
  watchMode = null;
  lastActiveCellIndex = -1;
  Logger.info('Stopped watching');
}
