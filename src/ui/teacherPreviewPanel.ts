import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { getConfig } from '../utils/config';
import { Logger } from '../utils/logger';

export class TeacherPreviewPanel {
  public static currentPanel: TeacherPreviewPanel | undefined;
  private static readonly viewType = 'jupyterLiveShare.teacherPreview';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    const port = getConfig().port;
    const wsUrl = `ws://localhost:${port}`;
    this.panel.webview.html = this.getHtmlContent(wsUrl);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public static createOrShow(context: vscode.ExtensionContext) {
    // Reuse existing panel
    if (TeacherPreviewPanel.currentPanel) {
      TeacherPreviewPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      TeacherPreviewPanel.viewType,
      'Teacher Preview',
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

    TeacherPreviewPanel.currentPanel = new TeacherPreviewPanel(panel, context.extensionUri);
    Logger.info('Teacher preview panel opened');
  }

  private getHtmlContent(wsUrl: string): string {
    const webview = this.panel.webview;
    const viewerBase = vscode.Uri.joinPath(this.extensionUri, 'dist', 'viewer');

    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(viewerBase, 'style.css'));
    const rendererUri = webview.asWebviewUri(vscode.Uri.joinPath(viewerBase, 'renderer.js'));
    const drawingUri = webview.asWebviewUri(vscode.Uri.joinPath(viewerBase, 'drawing.js'));
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
  <title>Teacher Preview</title>
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
  <!-- Flags: VS Code Webview + Teacher Preview + WS URL -->
  <script nonce="${nonce}">
    window.__VSCODE_WEBVIEW__ = true;
    window.__TEACHER_PREVIEW__ = true;
    window.__WS_URL__ = ${JSON.stringify(wsUrl)};
  </script>
</head>
<body>
  <!-- PIN/Name screens hidden for teacher preview -->
  <div id="pin-screen" class="pin-screen" style="display:none;">
    <div class="pin-box">
      <h2>Jupyter Live Share</h2>
      <p>Enter the session PIN to join:</p>
      <input type="text" id="pin-input" maxlength="6" pattern="\\d*" placeholder="PIN" autofocus>
      <button id="pin-submit">Join</button>
      <p id="pin-error" class="error" style="display:none;"></p>
    </div>
  </div>

  <div id="name-screen" class="pin-screen" style="display:none;">
    <div class="pin-box">
      <h2>Jupyter Live Share</h2>
      <p>Enter your name to join:</p>
      <input type="text" id="name-input" maxlength="30" placeholder="Your name" autofocus>
      <button id="name-submit">Join</button>
    </div>
  </div>

  <div id="connection-status" class="connection-status" style="display:none;">
    <span id="status-text">Connecting...</span>
  </div>

  <header id="header">
    <div class="header-left">
      <span id="file-name">Loading...</span>
    </div>
    <div class="header-right">
      <span id="viewer-count">0명 접속</span>
      <button id="theme-toggle" title="Toggle theme">☀️</button>
    </div>
  </header>

  <main id="notebook-container">
    <div id="poll-banner" style="display:none;">
      <div class="poll-question" id="poll-question"></div>
      <div class="poll-buttons" id="poll-buttons"></div>
      <div class="poll-results" id="poll-results"></div>
      <div class="poll-status" id="poll-status"></div>
    </div>
    <div id="notebook-cells"></div>
  </main>

  <aside id="chat-panel" class="chat-panel">
    <div class="chat-header">
      <span>Chat</span>
      <button id="chat-close" class="chat-close-btn" title="Close">&times;</button>
    </div>
    <div class="chat-messages" id="chat-messages"></div>
    <div class="chat-input-area">
      <input type="text" id="chat-input" placeholder="Type a message..." maxlength="500">
      <button id="chat-send">Send</button>
    </div>
  </aside>

  <div id="poll-modal" class="poll-modal-overlay" style="display:none;">
    <div class="poll-modal-box">
      <h3>Create Poll</h3>
      <label for="poll-question-input">Question:</label>
      <input type="text" id="poll-question-input" maxlength="200" placeholder="Enter your question">
      <label for="poll-mode-select">Mode:</label>
      <select id="poll-mode-select">
        <option value="number">Number (1, 2, 3...)</option>
        <option value="text">Text (custom labels)</option>
      </select>
      <div id="poll-number-mode">
        <label for="poll-option-count">Number of options (2~5):</label>
        <select id="poll-option-count">
          <option value="2">2</option>
          <option value="3">3</option>
          <option value="4">4</option>
          <option value="5" selected>5</option>
        </select>
      </div>
      <div id="poll-text-mode" style="display:none;">
        <label for="poll-text-options">Options (one per line):</label>
        <textarea id="poll-text-options" rows="4" maxlength="500" placeholder="Yes&#10;No&#10;Maybe"
          style="width:100%;padding:8px 10px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-cell);color:var(--text-primary);font-size:0.9rem;font-family:var(--font-sans);resize:vertical;"></textarea>
      </div>
      <div class="poll-modal-actions">
        <button id="poll-modal-cancel">Cancel</button>
        <button id="poll-modal-start">Start Poll</button>
      </div>
    </div>
  </div>

  <!-- 판서 툴바 (선생님 프리뷰 전용) -->
  <div id="draw-toolbar" style="display:none;">
    <button id="draw-toggle" title="Toggle drawing mode">Draw</button>
    <div class="draw-tools" style="display:none;">
      <button class="tool-btn active" data-tool="pen">Pen</button>
      <button class="tool-btn" data-tool="highlighter">Highlight</button>
      <button class="tool-btn" data-tool="eraser">Eraser</button>
      <span class="draw-separator"></span>
      <button class="color-btn active" data-color="#ef4444" style="--btn-color:#ef4444;" title="Red"></button>
      <button class="color-btn" data-color="#3b82f6" style="--btn-color:#3b82f6;" title="Blue"></button>
      <button class="color-btn" data-color="#22c55e" style="--btn-color:#22c55e;" title="Green"></button>
      <button class="color-btn" data-color="#eab308" style="--btn-color:#eab308;" title="Yellow"></button>
      <button class="color-btn" data-color="#111111" style="--btn-color:#111111;" title="Black"></button>
      <button class="color-btn" data-color="#ffffff" style="--btn-color:#ffffff;" title="White"></button>
      <span class="draw-separator"></span>
      <button class="width-btn" data-width="2" title="Thin">S</button>
      <button class="width-btn active" data-width="4" title="Medium">M</button>
      <button class="width-btn" data-width="8" title="Thick">L</button>
      <span class="draw-separator"></span>
      <button id="draw-undo" title="Undo last stroke">Undo</button>
      <button id="draw-clear" title="Clear all drawings">Clear</button>
    </div>
  </div>

  <footer id="toolbar" style="display:none;">
    <button id="btn-poll" class="teacher-only" style="display:none;" title="Create a poll">Poll</button>
    <button id="btn-end-poll" class="teacher-only" style="display:none;" title="End current poll">End Poll</button>
    <button id="btn-chat" title="Toggle chat">Chat</button>
    <button id="btn-download" title="Download file">Download</button>
    <label id="auto-scroll-label">
      <input type="checkbox" id="auto-scroll" checked> Auto-scroll
    </label>
  </footer>

  <script nonce="${nonce}" src="${rendererUri}"></script>
  <script nonce="${nonce}" src="${drawingUri}"></script>
  <script nonce="${nonce}" src="${websocketUri}"></script>
  <script nonce="${nonce}" src="${viewerUri}"></script>
</body>
</html>`;
  }

  public dispose() {
    TeacherPreviewPanel.currentPanel = undefined;
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
