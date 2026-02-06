import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { Logger } from '../utils/logger';
import { ViewerChatPanelProvider } from './viewerChatPanel';

export class ViewerPanel {
  public static currentPanel: ViewerPanel | undefined;
  private static readonly viewType = 'jupyterLiveShare.viewer';
  private static chatPanel: ViewerChatPanelProvider | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private wsUrl: string;

  /** ViewerChatPanelProvider 참조 설정 (extension.ts에서 호출) */
  public static setChatPanel(provider: ViewerChatPanelProvider): void {
    ViewerPanel.chatPanel = provider;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, serverUrl: string) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.wsUrl = serverUrl;

    // 메시지 핸들러를 HTML 설정 전에 등록
    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleWebviewMessage(msg),
      null,
      this.disposables
    );

    this.panel.webview.html = this.getHtmlContent(serverUrl);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Viewer Chat 패널을 하단 패널에서 포커스
    setTimeout(() => {
      vscode.commands.executeCommand('jupyterLiveShare.viewerChatPanel.focus');
    }, 300);
  }

  private handleWebviewMessage(msg: { type: string; wsUrl?: string; nickname?: string; pin?: string }): void {
    switch (msg.type) {
      case 'authenticated':
        // Viewer successfully authenticated — connect chat panel
        if (ViewerPanel.chatPanel && msg.wsUrl) {
          ViewerPanel.chatPanel.connect(msg.wsUrl, msg.pin);
        }
        break;
      case 'nameSet':
        // Student entered name — relay to chat panel
        if (ViewerPanel.chatPanel && msg.nickname) {
          ViewerPanel.chatPanel.setName(msg.nickname);
        }
        break;
    }
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
      ViewerPanel.currentPanel.wsUrl = wsUrl;
      ViewerPanel.currentPanel.panel.webview.html =
        ViewerPanel.currentPanel.getHtmlContent(wsUrl);
      // Disconnect old chat panel connection for fresh reconnect
      ViewerPanel.chatPanel?.disconnect();
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
  <!-- VS Code Webview flag + WebSocket URL 주입 -->
  <script nonce="${nonce}">
    window.__VSCODE_WEBVIEW__ = true;
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

  <!-- 이름 입력 화면 -->
  <div id="name-screen" class="pin-screen" style="display:none;">
    <div class="pin-box">
      <h2>Jupyter Live Share</h2>
      <p>Enter your name to join:</p>
      <input type="text" id="name-input" maxlength="30" placeholder="Your name" autofocus>
      <button id="name-submit">Join</button>
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
    <!-- 설문 배너 -->
    <div id="poll-banner" style="display:none;">
      <div class="poll-question" id="poll-question"></div>
      <div class="poll-buttons" id="poll-buttons"></div>
      <div class="poll-results" id="poll-results"></div>
      <div class="poll-status" id="poll-status"></div>
    </div>
    <div id="notebook-cells"></div>
  </main>

  <!-- 채팅 패널 -->
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

  <!-- 설문 생성 모달 (선생님 전용) -->
  <div id="poll-modal" class="poll-modal-overlay" style="display:none;">
    <div class="poll-modal-box">
      <h3>Create Poll</h3>
      <label for="poll-question-input">Question:</label>
      <input type="text" id="poll-question-input" maxlength="200" placeholder="Enter your question">
      <label for="poll-option-count">Number of options (2~5):</label>
      <select id="poll-option-count">
        <option value="2">2</option>
        <option value="3">3</option>
        <option value="4">4</option>
        <option value="5" selected>5</option>
      </select>
      <div class="poll-modal-actions">
        <button id="poll-modal-cancel">Cancel</button>
        <button id="poll-modal-start">Start Poll</button>
      </div>
    </div>
  </div>

  <!-- 하단 툴바 -->
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
  <script nonce="${nonce}" src="${websocketUri}"></script>
  <script nonce="${nonce}" src="${viewerUri}"></script>
</body>
</html>`;
  }

  public dispose() {
    ViewerPanel.currentPanel = undefined;

    // Disconnect chat panel
    ViewerPanel.chatPanel?.disconnect();

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
