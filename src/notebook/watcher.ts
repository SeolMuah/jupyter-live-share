import * as vscode from 'vscode';
import * as path from 'path';
import { broadcast, sendTo, setOnNewViewer, getCurrentPollState, getDrawStrokes, clearDrawStrokes, getLastScrollSync, clearLastScrollSync, setLastScrollSync } from '../server/wsServer';
import { serializeCell, serializeOutputs, serializeNotebook, serializeTextDocument, SerializedNotebook, SerializedCell } from './serializer';
import { Logger } from '../utils/logger';
import { resolveLocalImages, resolveLocalImagesCacheOnly, preOptimizeImages, clearImageCache, hasImagePatterns, setProjectRoot } from '../utils/imageResolver';
import WebSocket from 'ws';

const TEXT_DEBOUNCE_MS = 100;
const THROTTLE_MS = 100; // 셀 포커스 추적 반응성 개선 (200→100)
const CURSOR_THROTTLE_MS = 30; // Cursor updates need fastest response (50→30)
const VIEWPORT_THROTTLE_MS = 100; // Viewport sync needs fast but not excessive updates
// Trailing-edge debounce per cell for cell:update (keystroke coalescing). A burst of
// keystrokes within this window collapses to a single broadcast carrying the LATEST
// source — the flush always re-reads the live cell document at fire time, so no
// intermediate OR final keystroke is ever lost, only the intermediate broadcasts are
// coalesced. Cell-switch/blur/stop paths flush any pending timer immediately.
const CELL_UPDATE_DEBOUNCE_MS = 40;

// 타이핑/커서 등 초당 다회 발생하는 이벤트의 상세 로그는 기본적으로 끈다 (필요 시 true로 전환)
const SYNC_DEBUG = false;

// languageIds where image resolution is relevant
const IMAGE_RELEVANT_LANGUAGES = new Set(['markdown', 'html', 'jupyter']);

let disposables: vscode.Disposable[] = [];
let debounceTimers: Map<number, NodeJS.Timeout> = new Map();
let textDebounceTimer: NodeJS.Timeout | null = null;
let lastFocusTime = 0;
let lastCursorTime = 0;
let cursorTrailingTimer: NodeJS.Timeout | null = null;
let viewportTrailingTimer: NodeJS.Timeout | null = null;
let syncBackupTimer: NodeJS.Timeout | null = null;
let lastViewportTime = 0;
let lastActiveCellIndex = -1;
let lastSentSources: Map<number, string> = new Map(); // 셀별 마지막 전송 소스 (중복 전송 방지)
let currentNotebook: vscode.NotebookDocument | null = null;
let currentTextDocument: vscode.TextDocument | null = null;
let watchMode: 'notebook' | 'plaintext' | null = null;
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
    viewportTrailingTimer = setTimeout(() => { viewportTrailingTimer = null; send(); }, VIEWPORT_THROTTLE_MS - since);
    return;
  }
  send();
}

/**
 * Flush a single cell's pending debounced cell:update immediately, sending the
 * LATEST live source (re-read from the notebook at call time, not whatever was
 * captured when the timer was scheduled). Safe to call redundantly — it always
 * clears/deletes the timer entry first. Used by the debounce trailing edge, the
 * cell-switch flush, and stopWatching's final flush so no keystroke is ever lost.
 */
function flushCellUpdate(cellIndex: number) {
  const timer = debounceTimers.get(cellIndex);
  if (timer) clearTimeout(timer);
  debounceTimers.delete(cellIndex);

  if (!currentNotebook) return;
  if (cellIndex < 0 || cellIndex >= currentNotebook.cellCount) return;

  const cell = currentNotebook.cellAt(cellIndex);
  const text = cell.document.getText();
  lastSentSources.set(cellIndex, text);
  const isMarkup = cell.kind === vscode.NotebookCellKind.Markup;
  const resolvedText = (imageShareEnabled && isMarkup)
    ? resolveLocalImagesCacheOnly(text, getBaseDir())
    : text;
  if (SYNC_DEBUG) Logger.info(`[SYNC] cell:update idx=${cellIndex} len=${resolvedText.length} (debounce flush)`);
  broadcast('cell:update', { index: cellIndex, source: resolvedText });
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
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
  invalidateNotebookFullCache();
  if (textDebounceTimer) {
    clearTimeout(textDebounceTimer);
    textDebounceTimer = null;
  }
  // Reset throttle timestamps → first event for new file passes immediately
  lastFocusTime = 0;
  lastCursorTime = 0;
  lastViewportTime = 0;
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
 * Switch to text document mode: full cleanup → re-register ALL handlers → broadcast.
 */
function switchToTextDocument(document: vscode.TextDocument) {
  flushAndResetState();
  for (const d of disposables) { d.dispose(); }
  disposables = [];
  startWatchingTextDocument(document);

  const serialized = serializeTextDocument(document);
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

export function getWatchMode(): 'notebook' | 'plaintext' | null {
  return watchMode;
}

export function getCurrentFileUri(): import('vscode').Uri | null {
  if (watchMode === 'notebook' && currentNotebook) {
    return currentNotebook.uri;
  }
  if (watchMode === 'plaintext' && currentTextDocument) {
    return currentTextDocument.uri;
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

/**
 * Setup new viewer handler once - handles both notebook and plaintext modes
 * This prevents duplicate handler registration when switching between modes
 */
function setupNewViewerHandler() {
  setOnNewViewer((ws: WebSocket) => {
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
  });
}

export function startWatching() {
  // Set workspace root as security boundary for image path resolution
  const folders = vscode.workspace.workspaceFolders;
  setProjectRoot(folders?.[0]?.uri.fsPath ?? null);

  // Register new viewer handler once (handles both notebook and plaintext modes)
  setupNewViewerHandler();

  // 현재 활성 노트북 추적
  const activeEditor = vscode.window.activeNotebookEditor;
  if (activeEditor) {
    startWatchingNotebook(activeEditor.notebook);
    return;
  }

  // 노트북이 아니면 텍스트 에디터 확인
  const activeTextEditor = vscode.window.activeTextEditor;
  if (activeTextEditor && activeTextEditor.document.uri.scheme === 'file') {
    startWatchingTextDocument(activeTextEditor.document);
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
      // (cell:update 자체는 debounce 될 수 있지만, 캐시는 여기서 즉시 비우고 다음 접속 시
      // serializeNotebook이 그 시점의 live 텍스트를 다시 읽으므로 debounce 타이밍과 무관하게 최신이다)
      invalidateNotebookFullCache();

      // 셀 내용 변경 (타이핑)
      for (const change of event.cellChanges) {
        if (change.document) {
          const cellIndex = change.cell.index;

          // ★ 짧은 trailing debounce로 키 입력 버스트를 하나로 합친다 (H3).
          // flushCellUpdate가 fire 시점에 change.cell.document가 아니라 currentNotebook에서
          // 셀을 다시 조회해 항상 "그 순간의 최신 소스"를 읽으므로, 몇 번을 눌러도 마지막
          // 키 입력이 유실되지 않는다. 셀 전환/블러/정지 경로가 모두 이 타이머를 즉시 flush한다.
          const existing = debounceTimers.get(cellIndex);
          if (existing) clearTimeout(existing);
          const timer = setTimeout(() => {
            flushCellUpdate(cellIndex);
          }, CELL_UPDATE_DEBOUNCE_MS);
          debounceTimers.set(cellIndex, timer);
        }

        if (change.outputs) {
          // 셀 실행 결과 변경 → 즉시 전송 (debounce 없음)
          const cellIndex = change.cell.index;
          const outputs = serializeOutputs(change.outputs);
          // Resolve images in HTML output items (full resolution — outputs are infrequent)
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
          broadcast('cell:output', {
            index: cellIndex,
            outputs,
            executionOrder: change.cell.executionSummary?.executionOrder,
          });
          if (SYNC_DEBUG) Logger.info(`Cell ${cellIndex} output updated`);
        }
      }

      // 구조 변경(셀 추가/삭제)이 있는 이벤트면, 인덱스 기반 대기 디바운스를 취소한다.
      // 인덱스가 밀린 뒤 flush되면 다른 셀의 내용을 잘못된 index로 보낼 수 있기 때문.
      // (안전 우선: 잘못된 내용 전송을 막는다. 취소된 마지막 편집분은 다음 편집/백업으로 보정됨.)
      if (event.contentChanges.length > 0 && debounceTimers.size > 0) {
        for (const timer of debounceTimers.values()) clearTimeout(timer);
        debounceTimers.clear();
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
          for (const idx of [...debounceTimers.keys()]) {
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
          broadcast('cursor:position', payload);
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

  const textWatcher = vscode.workspace.onDidChangeTextDocument((event) => {
    if (!currentTextDocument) return;
    if (event.document.uri.toString() !== currentTextDocument.uri.toString()) return;

    // debounce
    if (textDebounceTimer) clearTimeout(textDebounceTimer);
    textDebounceTimer = setTimeout(() => {
      let content = event.document.getText();
      // Only resolve images for markdown/html documents (cache-only for real-time typing)
      if (isImageRelevantTextDocument()) {
        content = resolveTextImagesRealtime(content, getBaseDir());
      }
      broadcast('document:update', { content });
      textDebounceTimer = null;
    }, TEXT_DEBOUNCE_MS);
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
        broadcast('cursor:position', payload);
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

  // Flush: send final cell state for every pending debounce before stopping
  // (prevent last-keystroke loss).
  for (const idx of [...debounceTimers.keys()]) {
    flushCellUpdate(idx);
  }
  debounceTimers.clear();
  invalidateNotebookFullCache();

  if (cursorTrailingTimer) {
    clearTimeout(cursorTrailingTimer);
    cursorTrailingTimer = null;
  }

  if (viewportTrailingTimer) {
    clearTimeout(viewportTrailingTimer);
    viewportTrailingTimer = null;
  }

  if (textDebounceTimer) {
    clearTimeout(textDebounceTimer);
    textDebounceTimer = null;
  }

  if (syncBackupTimer) {
    clearTimeout(syncBackupTimer);
    syncBackupTimer = null;
  }

  lastSentSources.clear();
  clearImageCache();
  setProjectRoot(null);
  currentNotebook = null;
  currentTextDocument = null;
  watchMode = null;
  lastActiveCellIndex = -1;
  Logger.info('Stopped watching');
}
