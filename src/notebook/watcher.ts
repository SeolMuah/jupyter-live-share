import * as vscode from 'vscode';
import { broadcast, sendTo, setOnNewViewer, getCurrentPollState } from '../server/wsServer';
import { serializeCell, serializeOutputs, serializeNotebook, serializeTextDocument } from './serializer';
import { Logger } from '../utils/logger';
import WebSocket from 'ws';

const CELL_DEBOUNCE_MS = 150;
const TEXT_DEBOUNCE_MS = 100;
const THROTTLE_MS = 200;
const CURSOR_THROTTLE_MS = 50; // Cursor updates need faster response
const VIEWPORT_THROTTLE_MS = 100; // Viewport sync needs fast but not excessive updates

let disposables: vscode.Disposable[] = [];
let debounceTimers: Map<number, NodeJS.Timeout> = new Map();
let textDebounceTimer: NodeJS.Timeout | null = null;
let lastFocusTime = 0;
let lastCursorTime = 0;
let lastViewportTime = 0;
let currentNotebook: vscode.NotebookDocument | null = null;
let currentTextDocument: vscode.TextDocument | null = null;
let watchMode: 'notebook' | 'plaintext' | null = null;

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
      const serialized = serializeNotebook(currentNotebook, activeCellIndex);
      sendTo(ws, 'notebook:full', serialized);

      // 새 뷰어에게 현재 뷰포트 정보 전송
      if (editor && editor.visibleRanges.length > 0) {
        const firstVisibleCell = editor.visibleRanges[0].start;
        const lastVisibleCell = editor.visibleRanges[0].end - 1;
        sendTo(ws, 'viewport:sync', {
          mode: 'notebook',
          firstVisibleCell,
          lastVisibleCell,
          focusedCell: activeCellIndex,
        });
      }
    } else if (watchMode === 'plaintext' && currentTextDocument) {
      const serialized = serializeTextDocument(currentTextDocument);
      sendTo(ws, 'document:full', serialized);

      // 새 뷰어에게 현재 뷰포트 정보 전송
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.visibleRanges.length > 0) {
        const totalLines = currentTextDocument.lineCount;
        const firstVisibleLine = editor.visibleRanges[0].start.line;
        const lastVisibleLine = editor.visibleRanges[0].end.line;
        const scrollRatio = totalLines > 1 ? firstVisibleLine / (totalLines - 1) : 0;

        sendTo(ws, 'viewport:sync', {
          mode: 'plaintext',
          firstVisibleLine,
          lastVisibleLine,
          totalLines,
          scrollRatio: Math.min(1, Math.max(0, scrollRatio)),
        });
      }
    }

    // 활성 설문이 있으면 새 접속자에게 전송
    const poll = getCurrentPollState();
    if (poll) {
      sendTo(ws, 'poll:start', {
        pollId: poll.pollId,
        question: poll.question,
        optionCount: poll.optionCount,
      });
      sendTo(ws, 'poll:results', {
        pollId: poll.pollId,
        votes: poll.votes,
        totalVoters: poll.totalVoters,
      });
    }
  });
}

export function startWatching() {
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
  if (activeTextEditor) {
    startWatchingTextDocument(activeTextEditor.document);
    return;
  }

  Logger.warn('No active editor found for watching');
}

function startWatchingNotebook(notebook: vscode.NotebookDocument) {
  currentNotebook = notebook;
  currentTextDocument = null;
  watchMode = 'notebook';
  Logger.info(`Watching notebook: ${currentNotebook.uri.path}`);

  // 노트북 문서 변경 감지 (셀 내용 + 출력 + 구조)
  disposables.push(
    vscode.workspace.onDidChangeNotebookDocument((event) => {
      if (!currentNotebook) return;
      if (event.notebook.uri.toString() !== currentNotebook.uri.toString()) return;

      // 셀 내용 변경 (타이핑)
      for (const change of event.cellChanges) {
        if (change.document) {
          const cellIndex = change.cell.index;
          const newSource = change.document.getText();

          // debounce: 빠른 타이핑 시 마지막 변경만 전송
          const existing = debounceTimers.get(cellIndex);
          if (existing) clearTimeout(existing);

          debounceTimers.set(
            cellIndex,
            setTimeout(() => {
              broadcast('cell:update', { index: cellIndex, source: newSource });
              debounceTimers.delete(cellIndex);
            }, CELL_DEBOUNCE_MS)
          );
        }

        if (change.outputs) {
          // 셀 실행 결과 변경 → 즉시 전송 (debounce 없음)
          const cellIndex = change.cell.index;
          const outputs = serializeOutputs(change.outputs);
          broadcast('cell:output', {
            index: cellIndex,
            outputs,
            executionOrder: change.cell.executionSummary?.executionOrder,
          });
          Logger.info(`Cell ${cellIndex} output updated`);
        }
      }

      // 셀 구조 변경 (추가/삭제)
      for (const change of event.contentChanges) {
        broadcast('cells:structure', {
          type: change.removedCells.length > 0 ? 'delete' : 'insert',
          index: change.range.start,
          removedCount: change.removedCells.length,
          addedCells: change.addedCells.map(serializeCell),
        });
        Logger.info(
          `Cells structure changed: ${change.addedCells.length} added, ${change.removedCells.length} removed`
        );
      }
    })
  );

  // 활성 셀 변경 감지 (선생님 포커스) - viewport:sync와 함께 전송
  disposables.push(
    vscode.window.onDidChangeNotebookEditorSelection((event) => {
      // throttle: 200ms 간격으로만 전송
      const now = Date.now();
      if (now - lastFocusTime < THROTTLE_MS) return;
      lastFocusTime = now;

      const selections = event.selections;
      if (selections.length > 0) {
        const activeCellIndex = selections[0].start;
        broadcast('focus:cell', { cellIndex: activeCellIndex });

        // 뷰포트 정보도 함께 전송
        const editor = vscode.window.activeNotebookEditor;
        if (editor && editor.visibleRanges.length > 0) {
          const firstVisibleCell = editor.visibleRanges[0].start;
          const lastVisibleCell = editor.visibleRanges[0].end - 1;
          broadcast('viewport:sync', {
            mode: 'notebook',
            firstVisibleCell,
            lastVisibleCell,
            focusedCell: activeCellIndex,
          });
        }
      }
    })
  );

  // 노트북 뷰포트(스크롤) 변경 감지 - 선생님이 보는 화면 영역 추적
  disposables.push(
    vscode.window.onDidChangeNotebookEditorVisibleRanges((event) => {
      if (!currentNotebook) return;
      if (event.notebookEditor.notebook.uri.toString() !== currentNotebook.uri.toString()) return;

      // throttle
      const now = Date.now();
      if (now - lastViewportTime < VIEWPORT_THROTTLE_MS) return;
      lastViewportTime = now;

      if (event.visibleRanges.length > 0) {
        const firstVisibleCell = event.visibleRanges[0].start;
        const lastVisibleCell = event.visibleRanges[0].end - 1;

        // 현재 포커스된 셀 정보도 함께 전송
        const editor = vscode.window.activeNotebookEditor;
        const focusedCell = editor?.selections?.length ? editor.selections[0].start : firstVisibleCell;

        broadcast('viewport:sync', {
          mode: 'notebook',
          firstVisibleCell,
          lastVisibleCell,
          focusedCell,
        });
      }
    })
  );

  // 텍스트 에디터 커서 위치 감지 (셀 내부 커서)
  disposables.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      // 노트북 셀 에디터인 경우에만 처리
      if (event.textEditor.document.uri.scheme !== 'vscode-notebook-cell') return;
      if (!currentNotebook) return;

      // throttle: 50ms 간격으로만 전송
      const now = Date.now();
      if (now - lastCursorTime < CURSOR_THROTTLE_MS) return;
      lastCursorTime = now;

      // 셀 인덱스 추출 (URI fragment에서)
      const cellUri = event.textEditor.document.uri;
      const cellIndex = getCellIndexFromUri(cellUri, currentNotebook);
      if (cellIndex === -1) return;

      const selection = event.selections[0];
      if (!selection) return;

      broadcast('cursor:position', {
        cellIndex,
        line: selection.active.line,
        character: selection.active.character,
        // 선택 영역도 전송 (드래그 선택 시)
        selectionStart: {
          line: selection.start.line,
          character: selection.start.character,
        },
        selectionEnd: {
          line: selection.end.line,
          character: selection.end.character,
        },
        hasSelection: !selection.isEmpty,
      });
    })
  );

  // 활성 노트북 에디터 변경 (다른 파일로 전환)
  disposables.push(
    vscode.window.onDidChangeActiveNotebookEditor((editor) => {
      if (editor && editor.notebook.notebookType === 'jupyter-notebook') {
        currentNotebook = editor.notebook;
        currentTextDocument = null;
        watchMode = 'notebook';
        Logger.info(`Switched to notebook: ${currentNotebook.uri.path}`);

        // 새 노트북 전체 상태 broadcast
        const activeCellIndex = editor.selections.length > 0 ? editor.selections[0].start : 0;
        const serialized = serializeNotebook(currentNotebook, activeCellIndex);
        broadcast('notebook:full', serialized);
      }
    })
  );

  // 텍스트 에디터로 전환 감지
  disposables.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      // 노트북 셀 에디터는 무시 (scheme이 'vscode-notebook-cell')
      if (editor.document.uri.scheme === 'vscode-notebook-cell') return;

      // 텍스트 파일로 전환
      currentNotebook = null;
      currentTextDocument = editor.document;
      watchMode = 'plaintext';
      Logger.info(`Switched to text document: ${currentTextDocument.uri.path}`);

      const serialized = serializeTextDocument(currentTextDocument);
      broadcast('document:full', serialized);

      // 텍스트 문서 변경 감시 시작
      setupTextDocumentWatcher();
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

      currentTextDocument = editor.document;
      currentNotebook = null;
      watchMode = 'plaintext';
      Logger.info(`Switched to text document: ${currentTextDocument.uri.path}`);

      const serialized = serializeTextDocument(currentTextDocument);
      broadcast('document:full', serialized);
    })
  );

  // 노트북 에디터로 전환 감지
  disposables.push(
    vscode.window.onDidChangeActiveNotebookEditor((editor) => {
      if (editor && editor.notebook.notebookType === 'jupyter-notebook') {
        currentTextDocument = null;
        currentNotebook = editor.notebook;
        watchMode = 'notebook';
        Logger.info(`Switched to notebook: ${currentNotebook.uri.path}`);

        const activeCellIndex = editor.selections.length > 0 ? editor.selections[0].start : 0;
        const serialized = serializeNotebook(currentNotebook, activeCellIndex);
        broadcast('notebook:full', serialized);
      }
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
      broadcast('document:update', { content: event.document.getText() });
      textDebounceTimer = null;
    }, TEXT_DEBOUNCE_MS);
  });

  (textWatcher as any).__textDocWatcher = true;
  disposables.push(textWatcher);

  // 텍스트 에디터 뷰포트(스크롤) 변경 감지
  const viewportWatcher = vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
    if (!currentTextDocument) return;
    if (event.textEditor.document.uri.toString() !== currentTextDocument.uri.toString()) return;
    // 노트북 셀 에디터는 무시
    if (event.textEditor.document.uri.scheme === 'vscode-notebook-cell') return;

    // throttle
    const now = Date.now();
    if (now - lastViewportTime < VIEWPORT_THROTTLE_MS) return;
    lastViewportTime = now;

    if (event.visibleRanges.length > 0) {
      const totalLines = currentTextDocument.lineCount;
      const firstVisibleLine = event.visibleRanges[0].start.line;
      const lastVisibleLine = event.visibleRanges[0].end.line;

      // 스크롤 비율 계산 (0 ~ 1)
      const scrollRatio = totalLines > 1 ? firstVisibleLine / (totalLines - 1) : 0;

      broadcast('viewport:sync', {
        mode: 'plaintext',
        firstVisibleLine,
        lastVisibleLine,
        totalLines,
        scrollRatio: Math.min(1, Math.max(0, scrollRatio)),
      });
    }
  });

  (viewportWatcher as any).__textDocWatcher = true;
  disposables.push(viewportWatcher);
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
        const outputItems: any[] = [];
        for (const item of output.items) {
          if (item.mime.startsWith('image/')) {
            outputItems.push({
              output_type: 'display_data',
              data: { [item.mime]: Buffer.from(item.data).toString('base64') },
              metadata: {},
            });
          } else if (item.mime === 'application/vnd.code.notebook.stdout') {
            outputItems.push({
              output_type: 'stream',
              name: 'stdout',
              text: new TextDecoder().decode(item.data).split('\n').map((line, idx, arr) =>
                idx < arr.length - 1 ? line + '\n' : line
              ),
            });
          } else if (item.mime === 'application/vnd.code.notebook.stderr') {
            outputItems.push({
              output_type: 'stream',
              name: 'stderr',
              text: new TextDecoder().decode(item.data).split('\n').map((line, idx, arr) =>
                idx < arr.length - 1 ? line + '\n' : line
              ),
            });
          } else if (item.mime === 'application/vnd.code.notebook.error') {
            try {
              const errorData = JSON.parse(new TextDecoder().decode(item.data));
              outputItems.push({
                output_type: 'error',
                ename: errorData.ename || '',
                evalue: errorData.evalue || '',
                traceback: errorData.traceback || [],
              });
            } catch {
              outputItems.push({
                output_type: 'stream',
                name: 'stderr',
                text: [new TextDecoder().decode(item.data)],
              });
            }
          } else if (item.mime === 'text/html') {
            outputItems.push({
              output_type: 'execute_result',
              data: {
                'text/html': new TextDecoder().decode(item.data).split('\n').map((line, idx, arr) =>
                  idx < arr.length - 1 ? line + '\n' : line
                ),
              },
              metadata: {},
              execution_count: cell.executionSummary?.executionOrder ?? null,
            });
          } else if (item.mime === 'text/plain') {
            outputItems.push({
              output_type: 'execute_result',
              data: { 'text/plain': [new TextDecoder().decode(item.data)] },
              metadata: {},
              execution_count: cell.executionSummary?.executionOrder ?? null,
            });
          }
        }
        outputs.push(...outputItems);
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

  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();

  if (textDebounceTimer) {
    clearTimeout(textDebounceTimer);
    textDebounceTimer = null;
  }

  currentNotebook = null;
  currentTextDocument = null;
  watchMode = null;
  Logger.info('Stopped watching');
}
