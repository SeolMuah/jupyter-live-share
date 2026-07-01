import * as vscode from 'vscode';

export interface SerializedOutput {
  items: Array<{
    mime: string;
    data: string;
  }>;
}

export interface SerializedCell {
  kind: 'code' | 'markup';
  source: string;
  languageId: string;
  outputs: SerializedOutput[];
  executionOrder?: number;
}

export interface SerializedNotebook {
  fileName: string;
  filePath: string;
  cells: SerializedCell[];
  activeCellIndex: number;
}

export interface SerializedTextDocument {
  fileName: string;
  filePath: string;
  content: string;
  languageId: string;
}

/**
 * 워크스페이스(프로젝트) 루트 기준 상대경로를 반환한다.
 * 워크스페이스가 없거나 파일이 그 밖에 있으면 파일명만 반환한다.
 */
export function getRelativePath(uri: vscode.Uri): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    // includeWorkspaceFolder=false: 단일 루트에서는 폴더명 없이 상대경로만
    const rel = vscode.workspace.asRelativePath(uri, false);
    // asRelativePath는 워크스페이스 밖이면 원본(절대) 경로를 그대로 반환 → 파일명으로 폴백
    if (rel && rel !== uri.fsPath && !rel.startsWith('/')) {
      return rel.replace(/\\/g, '/'); // Windows 구분자 정규화
    }
  }
  return uri.path.split('/').pop() || uri.fsPath;
}

const MAX_OUTPUT_SIZE = 5 * 1024 * 1024; // 5MB per cell

export function serializeCell(cell: vscode.NotebookCell): SerializedCell {
  return {
    kind: cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markup',
    source: cell.document.getText(),
    languageId: cell.document.languageId,
    outputs: serializeOutputs(cell.outputs),
    executionOrder: cell.executionSummary?.executionOrder,
  };
}

export function serializeOutputs(
  outputs: readonly vscode.NotebookCellOutput[]
): SerializedOutput[] {
  return outputs.map((output) => ({
    items: output.items
      .map((item) => {
        const mime = item.mime;
        let data: string;

        if (mime.startsWith('image/')) {
          // 이미지: base64 인코딩
          data = Buffer.from(item.data).toString('base64');
        } else {
          // 텍스트 계열: UTF-8 디코딩
          data = new TextDecoder().decode(item.data);
        }

        // 대용량 출력 제한
        if (data.length > MAX_OUTPUT_SIZE) {
          if (mime === 'text/html') {
            data = '<div style="color:orange;">Output too large to display (>5MB). Run locally to view.</div>';
          } else if (mime === 'text/plain') {
            data = data.substring(0, 10000) + '\n\n... [truncated: output exceeds 5MB] ...';
          }
        }

        return { mime, data };
      }),
  }));
}

export function serializeNotebook(
  document: vscode.NotebookDocument,
  activeCellIndex: number = 0
): SerializedNotebook {
  const cells: SerializedCell[] = [];

  for (let i = 0; i < document.cellCount; i++) {
    cells.push(serializeCell(document.cellAt(i)));
  }

  return {
    fileName: document.uri.path.split('/').pop() || 'notebook.ipynb',
    filePath: getRelativePath(document.uri),
    cells,
    activeCellIndex,
  };
}

export function serializeTextDocument(
  document: vscode.TextDocument
): SerializedTextDocument {
  return {
    fileName: document.uri.path.split('/').pop() || 'untitled.txt',
    filePath: getRelativePath(document.uri),
    content: document.getText(),
    languageId: document.languageId,
  };
}
