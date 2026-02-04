import * as vscode from 'vscode';
import { broadcast, sendTo, setOnNewViewer } from '../server/wsServer';
import { serializeCell, serializeOutputs, serializeNotebook, serializeTextDocument } from './serializer';
import { Logger } from '../utils/logger';
import WebSocket from 'ws';

const CELL_DEBOUNCE_MS = 150;
const TEXT_DEBOUNCE_MS = 100;
const THROTTLE_MS = 200;

let disposables: vscode.Disposable[] = [];
let debounceTimers: Map<number, NodeJS.Timeout> = new Map();
let textDebounceTimer: NodeJS.Timeout | null = null;
let lastFocusTime = 0;
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

export function startWatching() {
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

  // 활성 셀 변경 감지 (선생님 포커스)
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
      }
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

  // 새 뷰어 접속 시 현재 상태 전송
  setOnNewViewer((ws: WebSocket) => {
    if (watchMode === 'notebook' && currentNotebook) {
      const editor = vscode.window.activeNotebookEditor;
      const activeCellIndex = editor?.selections.length ? editor.selections[0].start : 0;
      const serialized = serializeNotebook(currentNotebook, activeCellIndex);
      sendTo(ws, 'notebook:full', serialized);
    } else if (watchMode === 'plaintext' && currentTextDocument) {
      const serialized = serializeTextDocument(currentTextDocument);
      sendTo(ws, 'document:full', serialized);
    }
  });
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

  // 새 뷰어 접속 시 현재 상태 전송
  setOnNewViewer((ws: WebSocket) => {
    if (watchMode === 'plaintext' && currentTextDocument) {
      const serialized = serializeTextDocument(currentTextDocument);
      sendTo(ws, 'document:full', serialized);
    } else if (watchMode === 'notebook' && currentNotebook) {
      const editor = vscode.window.activeNotebookEditor;
      const activeCellIndex = editor?.selections.length ? editor.selections[0].start : 0;
      const serialized = serializeNotebook(currentNotebook, activeCellIndex);
      sendTo(ws, 'notebook:full', serialized);
    }
  });
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

    const ipynb = {
      cells,
      metadata: {
        kernelspec: {
          display_name: 'Python 3',
          language: 'python',
          name: 'python3',
        },
        language_info: {
          name: 'python',
          version: '3.12.0',
        },
      },
      nbformat: 4,
      nbformat_minor: 5,
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
