import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { Logger } from '../utils/logger';

export class ViewerPanel {
  public static currentPanel: ViewerPanel | undefined;
  private static readonly viewType = 'jupyterLiveShare.viewer';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, serverUrl: string) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.webview.html = this.getHtmlContent(serverUrl);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public static async createOrShow(context: vscode.ExtensionContext) {
    // URL 입력
    const url = await vscode.window.showInputBox({
      prompt: 'Enter the Live Share server URL',
      placeHolder: 'https://xxx.trycloudflare.com',
      validateInput: (value) => {
        if (!value) return 'URL is required';
        try {
          new URL(value);
          return undefined;
        } catch {
          return 'Invalid URL format (e.g., https://xxx.trycloudflare.com)';
        }
      },
    });

    if (!url) return; // ESC pressed

    // WebSocket URL 변환: https→wss, http→ws
    const wsUrl = url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');

    // 기존 패널이 있으면 재사용
    if (ViewerPanel.currentPanel) {
      ViewerPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
      ViewerPanel.currentPanel.panel.webview.html =
        ViewerPanel.currentPanel.getHtmlContent(wsUrl);
      return;
    }

    // 새 패널 생성
    const panel = vscode.window.createWebviewPanel(
      ViewerPanel.viewType,
      'Live Share Viewer',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'viewer'),
          vscode.Uri.joinPath(context.extensionUri, 'dist', 'viewer'),
        ],
      }
    );

    ViewerPanel.currentPanel = new ViewerPanel(panel, context.extensionUri, wsUrl);
    Logger.info(`Viewer panel opened for: ${url}`);
  }

  private getHtmlContent(wsUrl: string): string {
    const webview = this.panel.webview;

    // viewer 파일 URI 해석 (dist/viewer/)
    const viewerBase = vscode.Uri.joinPath(this.extensionUri, 'dist', 'viewer');

    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(viewerBase, 'style.css'));
    const rendererUri = webview.asWebviewUri(vscode.Uri.joinPath(viewerBase, 'renderer.js'));
    const websocketUri = webview.asWebviewUri(vscode.Uri.joinPath(viewerBase, 'websocket.js'));
    const viewerUri = webview.asWebviewUri(vscode.Uri.joinPath(viewerBase, 'viewer.js'));

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src ${webview.cspSource} https://cdnjs.cloudflare.com 'unsafe-inline';
    script-src ${webview.cspSource} https://cdnjs.cloudflare.com 'nonce-${nonce}';
    font-src https://cdnjs.cloudflare.com;
    img-src ${webview.cspSource} data: https:;
    connect-src ws: wss: https: http:;
  ">
  <title>Live Share Viewer</title>
  <link rel="stylesheet" href="${styleUri}">
  <!-- highlight.js -->
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/vs.min.css" id="hljs-light">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/vs2015.min.css" id="hljs-dark" disabled>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/python.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/javascript.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/typescript.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/java.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/r.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/sql.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/bash.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/json.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/yaml.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/css.min.js"></script>
  <!-- marked.js -->
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.0/marked.min.js"></script>
  <!-- KaTeX -->
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css">
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/contrib/auto-render.min.js"></script>
  <!-- DOMPurify -->
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.8/purify.min.js"></script>
  <!-- WebSocket URL 주입 -->
  <script nonce="${nonce}">
    window.__WS_URL__ = ${JSON.stringify(wsUrl)};
  </script>
</head>
<body>
  <!-- PIN 입력 화면 -->
  <div id="pin-screen" class="pin-screen" style="display:none;">
    <div class="pin-box">
      <h2>Jupyter Live Share</h2>
      <p>Enter the session PIN to join:</p>
      <input type="text" id="pin-input" maxlength="6" pattern="\\d*" placeholder="PIN" autofocus>
      <button id="pin-submit">Join</button>
      <p id="pin-error" class="error" style="display:none;"></p>
    </div>
  </div>

  <!-- 연결 상태 -->
  <div id="connection-status" class="connection-status" style="display:none;">
    <span id="status-text">Connecting...</span>
  </div>

  <!-- 헤더 -->
  <header id="header">
    <div class="header-left">
      <span id="file-name">Loading...</span>
    </div>
    <div class="header-right">
      <span id="viewer-count">0명 접속</span>
      <button id="theme-toggle" title="Toggle theme">☀️</button>
    </div>
  </header>

  <!-- 노트북 컨텐츠 -->
  <main id="notebook-container">
    <div id="notebook-cells"></div>
  </main>

  <!-- 하단 툴바 -->
  <footer id="toolbar" style="display:none;">
    <label id="auto-scroll-label">
      <input type="checkbox" id="auto-scroll" checked> Auto-scroll
    </label>
  </footer>

  <script nonce="${nonce}" src="${rendererUri}"></script>
  <script nonce="${nonce}" src="${websocketUri}"></script>
  <script nonce="${nonce}" src="${viewerUri}"></script>
</body>
</html>`;
  }

  public dispose() {
    ViewerPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }
}

function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}
