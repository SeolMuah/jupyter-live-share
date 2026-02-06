import * as vscode from 'vscode';

/**
 * VS Code 하단 패널 (터미널 영역)에 표시되는 Live Chat WebviewView.
 * 세션 시작 시 WebSocket으로 자동 연결하여 채팅/투표를 관리한다.
 */
export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'jupyterLiveShare.chatPanel';

  private _view?: vscode.WebviewView;
  private _port: number | null = null;
  private _isRunning = false;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    // WebviewView가 준비되면 현재 상태 전달
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'ready') {
        if (this._isRunning && this._port) {
          this._view?.webview.postMessage({
            type: 'connect',
            port: this._port,
          });
        }
      }
    });
  }

  /** 세션 시작 시 호출 — WebSocket 연결 지시 */
  connect(port: number): void {
    this._port = port;
    this._isRunning = true;
    this._view?.webview.postMessage({ type: 'connect', port });
  }

  /** 세션 종료 시 호출 — WebSocket 해제 지시 */
  disconnect(): void {
    this._port = null;
    this._isRunning = false;
    this._view?.webview.postMessage({ type: 'disconnect' });
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    return /*html*/ `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ws://localhost:* http://localhost:*;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    /* === Reset & Base === */
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-panel-background, var(--vscode-editor-background));
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* === 비연결 상태 === */
    .placeholder {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      gap: 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .placeholder-icon {
      font-size: 28px;
      opacity: 0.4;
    }

    /* === 메시지 영역 === */
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 8px 12px 4px;
      min-height: 0;
      scroll-behavior: smooth;
    }
    .messages::-webkit-scrollbar { width: 6px; }
    .messages::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background);
      border-radius: 3px;
    }
    .messages::-webkit-scrollbar-thumb:hover {
      background: var(--vscode-scrollbarSlider-hoverBackground);
    }

    /* === 메시지 아이템 === */
    .msg {
      display: flex;
      gap: 8px;
      margin-bottom: 10px;
      animation: msg-in 0.15s ease-out;
    }
    @keyframes msg-in {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* 아바타 (이니셜) */
    .avatar {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
      flex-shrink: 0;
      color: #fff;
      text-transform: uppercase;
    }
    .avatar.teacher {
      background: #2ea043;
    }
    .avatar.student {
      background: var(--vscode-textLink-foreground, #3794ff);
    }

    .msg-body { flex: 1; min-width: 0; }

    .msg-header {
      display: flex;
      align-items: baseline;
      gap: 6px;
      margin-bottom: 2px;
    }
    .msg-name {
      font-weight: 600;
      font-size: 12px;
      color: var(--vscode-foreground);
    }
    .msg-name.teacher { color: #2ea043; }
    .msg-time {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-left: auto;
    }

    .msg-text {
      font-size: 12.5px;
      line-height: 1.45;
      padding: 6px 10px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
      border-radius: 8px;
      border-top-left-radius: 2px;
      word-wrap: break-word;
      white-space: pre-wrap;
    }
    .msg.self .msg-text {
      background: color-mix(in srgb, var(--vscode-textLink-foreground) 12%, var(--vscode-editor-background));
      border-top-left-radius: 8px;
      border-top-right-radius: 2px;
    }

    /* 시스템 메시지 */
    .system-msg {
      text-align: center;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      padding: 4px 0;
      margin-bottom: 6px;
      font-style: italic;
    }

    /* === 투표 카드 === */
    .poll-card {
      margin: 8px 0;
      padding: 10px 12px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-textLink-foreground, #3794ff);
      border-radius: 8px;
      animation: msg-in 0.15s ease-out;
    }
    .poll-card.ended {
      border-color: var(--vscode-descriptionForeground);
      opacity: 0.75;
    }
    .poll-question {
      font-weight: 600;
      font-size: 12px;
      margin-bottom: 8px;
    }
    .poll-results { margin-top: 6px; }
    .poll-bar-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 3px;
      font-size: 11px;
    }
    .poll-bar-label {
      min-width: 18px;
      font-weight: 600;
      text-align: center;
    }
    .poll-bar-track {
      flex: 1;
      height: 16px;
      background: var(--vscode-input-background);
      border-radius: 3px;
      overflow: hidden;
    }
    .poll-bar-fill {
      height: 100%;
      background: var(--vscode-textLink-foreground, #3794ff);
      border-radius: 3px;
      transition: width 0.3s ease;
    }
    .poll-bar-value {
      min-width: 52px;
      text-align: right;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .poll-status {
      margin-top: 4px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    /* === 입력 영역 === */
    .input-area {
      display: flex;
      gap: 6px;
      padding: 8px 12px;
      border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
      background: var(--vscode-panel-background, var(--vscode-editor-background));
      flex-shrink: 0;
    }
    .input-area input {
      flex: 1;
      padding: 6px 10px;
      font-size: 12px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
      border-radius: 6px;
      font-family: var(--vscode-font-family);
      outline: none;
      transition: border-color 0.15s;
    }
    .input-area input:focus {
      border-color: var(--vscode-focusBorder);
    }
    .input-area input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    .send-btn {
      width: 32px;
      height: 32px;
      border: none;
      border-radius: 6px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s;
      flex-shrink: 0;
    }
    .send-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .send-btn:disabled {
      opacity: 0.4;
      cursor: default;
    }
    /* Send icon (SVG arrow) */
    .send-btn svg {
      width: 16px;
      height: 16px;
      fill: currentColor;
    }

    /* === Utility === */
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <!-- 비연결 상태 -->
  <div class="placeholder" id="placeholder">
    <span class="placeholder-icon">💬</span>
    <span>Start a session to chat</span>
  </div>

  <!-- 채팅 영역 -->
  <div class="messages hidden" id="messages"></div>

  <!-- 입력 영역 -->
  <div class="input-area hidden" id="inputArea">
    <input type="text" id="chatInput" placeholder="Type a message..." maxlength="500" autocomplete="off">
    <button class="send-btn" id="btnSend" title="Send">
      <svg viewBox="0 0 16 16"><path d="M1.724 1.053a.5.5 0 0 1 .545-.065l12 6a.5.5 0 0 1 0 .894l-12 6A.5.5 0 0 1 1.5 13.5v-4.379l6.854-1.027a.25.25 0 0 0 0-.494L1.5 6.574V2.5a.5.5 0 0 1 .224-.447z"/></svg>
    </button>
  </div>

  <script nonce="${nonce}">
    (function() {
      const vscodeApi = acquireVsCodeApi();

      const placeholder = document.getElementById('placeholder');
      const messagesEl = document.getElementById('messages');
      const inputArea = document.getElementById('inputArea');
      const chatInput = document.getElementById('chatInput');
      const btnSend = document.getElementById('btnSend');

      let ws = null;
      let connected = false;
      const MAX_MESSAGES = 300;

      // 준비 완료 알림
      vscodeApi.postMessage({ type: 'ready' });

      // === WebSocket 관리 ===

      function connectWs(port) {
        disconnectWs();
        try {
          ws = new WebSocket('ws://localhost:' + port);

          ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'join', data: { teacherPanel: true } }));
            connected = true;
            showChat();
            addSystem('Connected');
          };

          ws.onmessage = (event) => {
            try {
              const msg = JSON.parse(event.data);
              handleMessage(msg);
            } catch (e) { /* ignore */ }
          };

          ws.onclose = () => {
            connected = false;
            ws = null;
            addSystem('Disconnected');
          };

          ws.onerror = () => { /* onclose handles cleanup */ };
        } catch (e) { /* ignore */ }
      }

      function disconnectWs() {
        if (ws) {
          ws.onclose = null;
          ws.close();
          ws = null;
        }
        connected = false;
      }

      function showChat() {
        placeholder.classList.add('hidden');
        messagesEl.classList.remove('hidden');
        inputArea.classList.remove('hidden');
      }

      function hideChat() {
        placeholder.classList.remove('hidden');
        messagesEl.classList.add('hidden');
        inputArea.classList.add('hidden');
        messagesEl.innerHTML = '';
      }

      // === 메시지 처리 ===

      function handleMessage(msg) {
        switch (msg.type) {
          case 'chat:broadcast':
            addChatMsg(msg.data);
            break;
          case 'poll:start':
            addPollCard(msg.data);
            break;
          case 'poll:results':
            updatePollResults(msg.data);
            break;
          case 'poll:end':
            endPollCard(msg.data);
            break;
          case 'session:end':
            addSystem('Session ended');
            disconnectWs();
            break;
        }
      }

      // === 채팅 메시지 렌더 ===

      function addChatMsg(data) {
        const isSelf = data.isTeacher;
        const initial = (data.nickname || '?')[0];

        const div = document.createElement('div');
        div.className = 'msg' + (isSelf ? ' self' : '');

        // Avatar
        const avatar = document.createElement('div');
        avatar.className = 'avatar ' + (data.isTeacher ? 'teacher' : 'student');
        avatar.textContent = initial;

        // Body
        const body = document.createElement('div');
        body.className = 'msg-body';

        // Header
        const header = document.createElement('div');
        header.className = 'msg-header';

        const name = document.createElement('span');
        name.className = 'msg-name' + (data.isTeacher ? ' teacher' : '');
        name.textContent = data.nickname;

        const time = document.createElement('span');
        time.className = 'msg-time';
        const d = new Date(data.timestamp);
        time.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());

        header.appendChild(name);
        header.appendChild(time);

        // Text
        const text = document.createElement('div');
        text.className = 'msg-text';
        text.textContent = data.text;

        body.appendChild(header);
        body.appendChild(text);
        div.appendChild(avatar);
        div.appendChild(body);

        messagesEl.appendChild(div);
        trimMessages();
        scrollToBottom();
      }

      function addSystem(text) {
        const div = document.createElement('div');
        div.className = 'system-msg';
        div.textContent = text;
        messagesEl.appendChild(div);
        trimMessages();
        scrollToBottom();
      }

      // === 투표 카드 ===

      function addPollCard(data) {
        if (data.pollId && document.getElementById('poll-' + data.pollId)) return;

        const card = document.createElement('div');
        card.className = 'poll-card';
        card.id = 'poll-' + data.pollId;
        if (data.options) card.dataset.options = JSON.stringify(data.options);

        const q = document.createElement('div');
        q.className = 'poll-question';
        q.textContent = '📊 ' + data.question;
        card.appendChild(q);

        const results = document.createElement('div');
        results.className = 'poll-results';
        card.appendChild(results);

        const status = document.createElement('div');
        status.className = 'poll-status';
        status.textContent = '투표 진행 중';
        card.appendChild(status);

        messagesEl.appendChild(card);
        trimMessages();
        scrollToBottom();
      }

      function updatePollResults(data) {
        const card = data.pollId ? document.getElementById('poll-' + data.pollId) : null;
        if (!card) return;
        const opts = data.options || (card.dataset.options ? JSON.parse(card.dataset.options) : null);
        const resultsEl = card.querySelector('.poll-results');
        const statusEl = card.querySelector('.poll-status');
        if (resultsEl) renderBars(resultsEl, data.votes || [], data.totalVoters || 0, opts);
        if (statusEl) statusEl.textContent = (data.totalVoters || 0) + '명 투표';
      }

      function endPollCard(data) {
        const card = data.pollId ? document.getElementById('poll-' + data.pollId) : null;
        if (!card) return;
        const opts = data.options || (card.dataset.options ? JSON.parse(card.dataset.options) : null);
        const resultsEl = card.querySelector('.poll-results');
        const statusEl = card.querySelector('.poll-status');
        if (resultsEl) renderBars(resultsEl, data.finalVotes || [], data.totalVoters || 0, opts);
        if (statusEl) statusEl.textContent = '투표 종료 — 총 ' + (data.totalVoters || 0) + '명';
        card.classList.add('ended');
      }

      function renderBars(container, votes, total, options) {
        container.innerHTML = '';
        for (let i = 0; i < votes.length; i++) {
          const row = document.createElement('div');
          row.className = 'poll-bar-row';

          const label = document.createElement('span');
          label.className = 'poll-bar-label';
          label.textContent = (options && options[i]) ? options[i] : String(i + 1);

          const track = document.createElement('div');
          track.className = 'poll-bar-track';

          const fill = document.createElement('div');
          fill.className = 'poll-bar-fill';
          const pct = total > 0 ? (votes[i] / total) * 100 : 0;
          fill.style.width = pct + '%';
          track.appendChild(fill);

          const val = document.createElement('span');
          val.className = 'poll-bar-value';
          val.textContent = votes[i] + ' (' + Math.round(pct) + '%)';

          row.appendChild(label);
          row.appendChild(track);
          row.appendChild(val);
          container.appendChild(row);
        }
      }

      // === 입력 & 전송 ===

      function sendChat() {
        const text = chatInput.value.trim();
        if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'chat:message', data: { text } }));
        chatInput.value = '';
        chatInput.focus();
      }

      btnSend.addEventListener('click', sendChat);
      chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendChat();
      });

      // === Utilities ===

      function pad(n) { return n.toString().padStart(2, '0'); }

      function scrollToBottom() {
        requestAnimationFrame(() => {
          messagesEl.scrollTop = messagesEl.scrollHeight;
        });
      }

      function trimMessages() {
        while (messagesEl.children.length > MAX_MESSAGES) {
          messagesEl.removeChild(messagesEl.firstChild);
        }
      }

      // === Extension → Webview 메시지 수신 ===

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg.type === 'connect' && msg.port) {
          connectWs(msg.port);
        } else if (msg.type === 'disconnect') {
          disconnectWs();
          hideChat();
        }
      });
    })();
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
