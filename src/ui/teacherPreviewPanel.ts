import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { getConfig } from '../utils/config';
import { getTeacherToken } from '../server/wsServer';
import { Logger } from '../utils/logger';
import { openDownloadUrl } from './viewerPanel';

export class TeacherPreviewPanel {
  public static currentPanel: TeacherPreviewPanel | undefined;
  private static readonly viewType = 'codeClassLive.teacherPreview';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.refreshHtml();

    // 웹뷰(Teacher Preview)가 현재 세션 토큰을 물어오면 라이브 값으로 응답한다.
    // 이 핸들러는 '전역' 세션 상태(getTeacherToken)를 읽으므로, 이 패널이 reload로
    // 재생성되지 못한 상태(고아)여도 세션이 뜨는 즉시 웹뷰가 스스로 연결된다(자기 치유).
    this.panel.webview.onDidReceiveMessage((msg: { type?: string; url?: string }) => {
      if (msg && msg.type === 'requestTeacherToken') {
        const token = getTeacherToken();
        this.panel.webview.postMessage({
          type: 'teacherToken',
          token: token || '',
          wsUrl: `ws://localhost:${getConfig().port}`,
          hasSession: !!token,
        });
      } else if (msg && msg.type === 'download') {
        // Webview에서는 상대경로 다운로드가 불가 — 기본 브라우저로 절대 URL을 연다
        openDownloadUrl(msg.url);
      }
    }, null, this.disposables);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /**
   * 항상 라이브 뷰어를 로드한다. 세션 유무는 뷰어가 확장에 토큰을 물어 판단하며,
   * 세션이 없으면 '세션 대기 중' 상태로 폴링하다가 세션이 뜨는 즉시 연결한다.
   * (과거: 세션이 없을 때 정적 대기 HTML을 띄웠으나, 그 화면은 WS 연결·재연결이
   *  전혀 없어 reload가 패널을 재생성하지 못하면 영영 멈추는 막다른 골목이었다.)
   */
  private refreshHtml(): void {
    const port = getConfig().port;
    this.panel.webview.html = this.getHtmlContent(`ws://localhost:${port}`);
  }

  public static createOrShow(context: vscode.ExtensionContext, viewColumn?: vscode.ViewColumn, preserveFocus = false) {
    // Reuse existing panel
    if (TeacherPreviewPanel.currentPanel) {
      TeacherPreviewPanel.currentPanel.panel.reveal(viewColumn || vscode.ViewColumn.Beside, preserveFocus);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      TeacherPreviewPanel.viewType,
      'Teacher Preview',
      { viewColumn: viewColumn || vscode.ViewColumn.Beside, preserveFocus },
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

  /**
   * 확장호스트 재시작(확장 업데이트 후 'Restart Extensions', 윈도우 리로드 등)을
   * 시각적으로 살아넘어온 웹뷰 탭을 재입양한다. Serializer가 없으면 이런 탭은
   * currentPanel 추적이 끊긴 '고아'가 되어 reload()가 no-op → 새 세션을 시작해도
   * "Session has ended."인 채 영영 갱신되지 않는 버그의 근본 원인이었다.
   */
  public static registerSerializer(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(TeacherPreviewPanel.viewType, {
      deserializeWebviewPanel: async (panel: vscode.WebviewPanel) => {
        if (TeacherPreviewPanel.currentPanel) {
          // 이미 추적 중인 패널이 있으면 복원된 쪽은 중복 — 정리한다.
          panel.dispose();
          return;
        }
        panel.webview.options = {
          enableScripts: true,
          localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, 'viewer'),
            vscode.Uri.joinPath(context.extensionUri, 'dist', 'viewer'),
          ],
        };
        TeacherPreviewPanel.currentPanel = new TeacherPreviewPanel(panel, context.extensionUri);
        Logger.info('Teacher preview panel revived after extension host restart');
      },
    });
  }

  public static reload(context: vscode.ExtensionContext): void {
    const existing = TeacherPreviewPanel.currentPanel;
    if (!existing) {
      Logger.info('Teacher preview reload skipped: no tracked panel');
      return;
    }
    // Dispose and recreate: the only reliable way to reset a webview
    // with retainContextWhenHidden (postMessage and HTML replacement are unreliable)
    const viewColumn = existing.panel.viewColumn;
    // onDidDispose 콜백의 발화 타이밍에 의존하지 않도록 추적을 먼저 명시적으로 끊는다
    // (늦게 발화하면 createOrShow가 disposed 패널을 reveal하려다 no-op이 되는 경합 방지).
    TeacherPreviewPanel.currentPanel = undefined;
    try {
      existing.panel.dispose();
    } catch {
      // 이미 dispose된 패널이어도 재생성은 계속한다
    }
    TeacherPreviewPanel.createOrShow(context, viewColumn, true);
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
    connect-src ws: wss:;
    worker-src 'self' blob:;
  ">
  <title>Teacher Preview</title>
  <link rel="stylesheet" href="${styleUri}">
  <!-- highlight.js -->
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/vs.min.css" integrity="sha384-Ao8ogxjh8YOpD0QuD98ftM0JgunR9NBRo18vvW76DgMR3Ek/XScY5KdUdV1Ams5S" crossorigin="anonymous" id="hljs-light">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/vs2015.min.css" integrity="sha384-BE+nmfgoK1j3fBxbLI64Jzf52Mx/QAyw+4O7GyPYevJnAyrljCoRtQkYNfCfuWPF" crossorigin="anonymous" id="hljs-dark" disabled>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js" integrity="sha384-F/bZzf7p3Joyp5psL90p/p89AZJsndkSoGwRpXcZhleCWhd8SnRuoYo4d0yirjJp" crossorigin="anonymous"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/python.min.js" integrity="sha384-FWJTgPmIGm1+zpNhubuHRC/ulS1UK7hAZ7qiUUmKD8yGfPcn5ZXYBd2qRgi6L8Tu" crossorigin="anonymous"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/javascript.min.js" integrity="sha384-44q2s9jxk8W5N9gAB0yn7UYLi9E2oVw8eHyaTZLkDS3WuZM/AttkAiVj6JoZuGS4" crossorigin="anonymous"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/typescript.min.js" integrity="sha384-ORwtVEfrCZ0gzGacgmfv1wOtxcPIaVfHKwq8dKQjObRwx3qpKjsSg1ldTu1PEgXd" crossorigin="anonymous"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/java.min.js" integrity="sha384-uUg+ux8epe42611RSvEkMX2gvEkMdw+l6xG5Z/aQriABp38RLyF9MjDZtlTlMuQY" crossorigin="anonymous"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/r.min.js" integrity="sha384-+z7INDMj7HMs67TuLfoyKa6TUHdTweahANtJ1Spg6uCa8/f1jFUf238jj53TDxmP" crossorigin="anonymous"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/sql.min.js" integrity="sha384-8q00eP+tyV9451aJYD5ML3ftuHKsGnDcezp7EXMEclDg1fZVSoj8O+3VyJTkXmWp" crossorigin="anonymous"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/bash.min.js" integrity="sha384-OqfnIfpOmAlErKRs2a525ZcwLuZ8Z1x8hPdIwBcMtHkJBbHnpJ6wX5/LVzASHkD5" crossorigin="anonymous"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/json.min.js" integrity="sha384-RbRhXcXx5VHUdUaC5R0oV+XBXA5GhkaVCUzK8xN19K3FmtWSHyGVgulK92XnhBsI" crossorigin="anonymous"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/yaml.min.js" integrity="sha384-7YspHobypEnqY8ZOz2b0dwjM3LBhK18ogJfebE+C5BoXfIOO46DczczxY9GHUK0k" crossorigin="anonymous"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/css.min.js" integrity="sha384-EO/jSdjpPTVnKfaKudbmOTZBYv471ACLOeLdy0zhCEJrQAtjgUSCbn/Cc+9QWjIx" crossorigin="anonymous"></script>
  <!-- marked.js -->
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.0/marked.min.js" integrity="sha384-NNQgBjjuhtXzPmmy4gurS5X7P4uTt1DThyevz4Ua0IVK5+kazYQI1W27JHjbbxQz" crossorigin="anonymous"></script>
  <!-- KaTeX -->
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css" integrity="sha384-n8MVd4RsNIU0tAv4ct0nTaAbDJwPJzDEaqSD1odI+WdtXRGWt2kTvGFasHpSy3SV" crossorigin="anonymous">
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js" integrity="sha384-XjKyOOlGwcjNTAIQHIpgOno0Hl1YQqzUOEleOLALmuqehneUG+vnGctmUb0ZY0l8" crossorigin="anonymous"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/contrib/auto-render.min.js" integrity="sha384-+VBxd3r6XgURycqtZ117nYw44OOcIax56Z4dCRWbxyPt0Koah1uHoK0o4+/RRE05" crossorigin="anonymous"></script>
  <!-- DOMPurify -->
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.4.8/purify.min.js" integrity="sha384-jrsBdrv4eDpEYIq32u13DPbvB6tRmqIDnA6UlgFBoexpetaiWi7g/VbfMEL1WVen" crossorigin="anonymous"></script>
  <!-- Mermaid - 다이어그램 렌더링 -->
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.1/mermaid.min.js" integrity="sha384-WmdflGW9aGfoBdHc4rRyWzYuAjEmDwMdGdiPNacbwfGKxBW/SO6guzuQ76qjnSlr" crossorigin="anonymous"></script>
  <!-- Flags: VS Code Webview + Teacher Preview + WS URL + Teacher Token -->
  <script nonce="${nonce}">
    window.__VSCODE_WEBVIEW__ = true;
    window.__TEACHER_PREVIEW__ = true;
    window.__WS_URL__ = ${JSON.stringify(wsUrl)};
    window.__TEACHER_TOKEN__ = ${JSON.stringify(getTeacherToken() || '')};
  </script>
  <style nonce="${nonce}">
    /* Teacher Preview: disable text selection to prevent interference with drawing */
    body {
      -webkit-user-select: none;
      user-select: none;
      cursor: default;
    }
    /* Prevent text cursor on code/markup areas */
    pre, code, .cell-source, .cell-markup, .cell-outputs, #notebook-cells {
      cursor: default;
    }
  </style>
</head>
<body>
  <!-- PIN/Name screens hidden for teacher preview -->
  <div id="pin-screen" class="pin-screen" style="display:none;">
    <div class="pin-box">
      <h2>Code Class Live Sharing</h2>
      <p>Enter the session PIN to join:</p>
      <input type="text" id="pin-input" maxlength="6" pattern="\\d*" placeholder="PIN" autofocus>
      <button id="pin-submit">Join</button>
      <p id="pin-error" class="error" style="display:none;"></p>
    </div>
  </div>

  <div id="name-screen" class="pin-screen" style="display:none;">
    <div class="pin-box">
      <h2>Code Class Live Sharing</h2>
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

  <div id="app-layout">
  <!-- 파일 탐색기 패널 (강사 워크스페이스 트리 — explorer:tree 수신 전엔 숨김) -->
  <aside id="file-tree-panel" class="file-tree-panel">
    <div class="file-tree-header">
      <span class="file-tree-title">EXPLORER</span>
      <span class="file-tree-root" id="file-tree-root"></span>
      <button id="file-tree-close" class="file-tree-close-btn" title="Close">&times;</button>
    </div>
    <div class="file-tree-body" id="file-tree-body"></div>
  </aside>
  <!-- 좁은 화면 드로어용 반투명 배경 (position:fixed라 flex 배치에 영향 없음) -->

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
    <div id="chat-edge-tab" class="chat-edge-tab">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <span class="chat-edge-label">Chat</span>
      <span class="chat-edge-badge" id="chat-edge-badge" style="display:none;"></span>
    </div>
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
  </div>

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
          <option value="2" selected>2</option>
          <option value="3">3</option>
          <option value="4">4</option>
          <option value="5">5</option>
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

  <!-- 판서 도구 패널 (선생님 프리뷰 전용, 오른쪽 세로 배치) -->
  <div id="draw-tools-panel" style="display:none;">
    <button class="tool-btn active" data-tool="pen" title="Pen">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
    </button>
    <button class="tool-btn" data-tool="highlighter" title="Highlighter">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M18 3l3 3-12 12-4 1 1-4L18 3z" fill="#fbbf24" fill-opacity="0.5" stroke="#d97706" stroke-width="1.5"/><path d="M15 6l3 3" stroke="#d97706" stroke-width="1.5"/></svg>
    </button>
    <button class="tool-btn" data-tool="eraser" title="Eraser">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.9-9.9c1-1 2.5-1 3.4 0l5.3 5.3c1 1 1 2.5 0 3.4L11.7 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>
    </button>
    <div class="dt-separator"></div>
    <button class="color-btn active" data-color="#ff6b6b" style="--btn-color:#ff6b6b;" title="Red"></button>
    <button class="color-btn" data-color="#339af0" style="--btn-color:#339af0;" title="Blue"></button>
    <button class="color-btn" data-color="#51cf66" style="--btn-color:#51cf66;" title="Green"></button>
    <button class="color-btn" data-color="#ff922b" style="--btn-color:#ff922b;" title="Orange"></button>
    <button class="color-btn" data-color="#cc5de8" style="--btn-color:#cc5de8;" title="Purple"></button>
    <button class="color-btn" data-color="#495057" style="--btn-color:#495057;" title="Dark"></button>
    <div class="dt-separator"></div>
    <button class="width-btn" data-width="2" title="Thin"><span class="dot-indicator" style="width:4px;height:4px;"></span></button>
    <button class="width-btn active" data-width="4" title="Medium"><span class="dot-indicator" style="width:8px;height:8px;"></span></button>
    <button class="width-btn" data-width="8" title="Thick"><span class="dot-indicator" style="width:14px;height:14px;"></span></button>
    <div class="dt-separator"></div>
    <button id="draw-undo" title="Undo">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
    </button>
    <button id="draw-clear" title="Clear all">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
    </button>
  </div>

  <footer id="toolbar" style="display:none;">
    <button id="draw-toggle" class="teacher-only" style="display:none;" title="Toggle drawing mode">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
      Draw
    </button>
    <button id="btn-files" style="display:none;" title="Toggle file explorer">Explorer</button>
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
    // 자신이 추적 중인 패널일 때만 추적을 해제한다 — reload()로 이미 새 패널이
    // 등록된 뒤 옛 패널의 onDidDispose가 늦게 발화해 새 패널 추적을 지우는 경합 방지.
    if (TeacherPreviewPanel.currentPanel === this) {
      TeacherPreviewPanel.currentPanel = undefined;
    }
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
