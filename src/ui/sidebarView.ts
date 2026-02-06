import * as vscode from 'vscode';

interface SessionState {
  isRunning: boolean;
  url?: string;
  port?: number;
  pin?: string;
  viewerCount: number;
  fileName?: string;
  pollActive?: boolean;
}

export class SessionViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'jupyterLiveShare.sessionView';

  private _view?: vscode.WebviewView;
  private _state: SessionState = {
    isRunning: false,
    viewerCount: 0,
  };

  private _onCommand?: (command: string, data?: unknown) => void;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  setOnCommand(handler: (command: string, data?: unknown) => void) {
    this._onCommand = handler;
  }

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

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'command') {
        this._onCommand?.(msg.command, msg.data);
      } else if (msg.type === 'ready') {
        this._sendState();
      }
    });
  }

  updateState(update: Partial<SessionState>) {
    Object.assign(this._state, update);
    this._sendState();
  }

  refresh() {
    this._sendState();
  }

  private _sendState() {
    this._view?.webview.postMessage({
      type: 'stateUpdate',
      state: this._state,
    });
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ws://localhost:* http://localhost:*;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* Session info section */
    .section {
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .info-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 3px 0;
      font-size: 12px;
    }
    .info-label {
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
    }
    .info-value {
      color: var(--vscode-foreground);
      text-align: right;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-left: 8px;
      cursor: default;
    }
    .info-value.clickable {
      cursor: pointer;
      color: var(--vscode-textLink-foreground);
    }
    .info-value.clickable:hover {
      text-decoration: underline;
    }

    /* Buttons */
    button {
      font-family: var(--vscode-font-family);
      font-size: 12px;
      cursor: pointer;
      border: none;
      border-radius: 3px;
      padding: 6px 12px;
      width: 100%;
      margin-top: 4px;
    }
    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn-primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .btn-danger {
      background: var(--vscode-errorForeground);
      color: #fff;
      opacity: 0.85;
    }
    .btn-danger:hover { opacity: 1; }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .btn-small {
      padding: 4px 8px;
      width: auto;
      margin-top: 0;
    }

    /* Inline poll form */
    .poll-form { display: none; padding: 8px 0 4px; }
    .poll-form.visible { display: block; }
    .poll-form label {
      display: block;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 2px;
      margin-top: 6px;
    }
    .poll-form label:first-child { margin-top: 0; }
    .poll-form input, .poll-form select {
      width: 100%;
      padding: 4px 6px;
      font-size: 12px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      font-family: var(--vscode-font-family);
    }
    .poll-form-actions {
      display: flex;
      gap: 4px;
      margin-top: 8px;
    }
    .poll-form-actions button {
      flex: 1;
      margin-top: 0;
    }

    /* Not-running state */
    .not-running {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      padding: 20px;
    }
    .not-running p {
      margin-bottom: 12px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      text-align: center;
    }

    /* Chat area */
    .chat-area {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-height: 0;
    }
    .chat-header {
      padding: 6px 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--vscode-sideBarSectionHeader-foreground);
      background: var(--vscode-sideBarSectionHeader-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 6px 10px;
      min-height: 0;
    }
    .chat-msg {
      margin-bottom: 8px;
      word-wrap: break-word;
    }
    .chat-msg-header {
      display: flex;
      align-items: baseline;
      gap: 4px;
      margin-bottom: 1px;
    }
    .chat-nickname {
      font-weight: 700;
      font-size: 11px;
      color: var(--vscode-textLink-foreground);
    }
    .chat-nickname.teacher {
      color: #2ea043;
    }
    .chat-time {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-left: auto;
    }
    .chat-text {
      font-size: 12px;
      line-height: 1.4;
      padding: 3px 6px;
      background: var(--vscode-editor-background);
      border-radius: 4px;
      border: 1px solid var(--vscode-panel-border);
    }
    .chat-system {
      text-align: center;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      margin-bottom: 6px;
      padding: 2px 0;
    }
    .chat-input-area {
      display: flex;
      gap: 4px;
      padding: 6px 10px;
      border-top: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .chat-input-area input {
      flex: 1;
      padding: 5px 8px;
      font-size: 12px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      font-family: var(--vscode-font-family);
    }
    .chat-input-area button {
      width: auto;
      padding: 5px 10px;
      margin-top: 0;
    }

    /* Running container */
    .running-container {
      display: none;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    .running-container.visible {
      display: flex;
    }

    /* Poll active info */
    .poll-active-bar {
      display: none;
      padding: 6px 12px;
      font-size: 11px;
      background: var(--vscode-editorInfo-background, rgba(0,120,212,0.1));
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .poll-active-bar.visible { display: block; }
    .poll-active-bar .poll-question-text {
      font-weight: 600;
      margin-bottom: 4px;
    }
    .poll-results-mini {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    /* Chat poll card */
    .chat-poll-card {
      margin: 6px 0;
      padding: 8px 10px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-textLink-foreground);
      border-radius: 6px;
    }
    .chat-poll-question {
      font-weight: 600;
      font-size: 12px;
      margin-bottom: 6px;
    }
    .chat-poll-results { margin-top: 4px; }
    .poll-bar-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 3px;
      font-size: 11px;
    }
    .poll-bar-label {
      min-width: 16px;
      font-weight: 600;
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
      background: var(--vscode-textLink-foreground);
      border-radius: 3px;
      transition: width 0.3s ease;
    }
    .poll-bar-value {
      min-width: 50px;
      text-align: right;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .chat-poll-status {
      margin-top: 4px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .chat-poll-card.ended {
      border-color: var(--vscode-descriptionForeground);
      opacity: 0.8;
    }

    /* Copied tooltip */
    .copied-toast {
      position: fixed;
      top: 8px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      padding: 4px 12px;
      border-radius: 4px;
      font-size: 11px;
      opacity: 0;
      transition: opacity 0.2s;
      pointer-events: none;
      z-index: 100;
    }
    .copied-toast.show { opacity: 1; }
  </style>
</head>
<body>
  <div class="copied-toast" id="copiedToast">Copied!</div>

  <!-- Not running state -->
  <div class="not-running" id="notRunning">
    <p>No active session</p>
    <div style="width:100%; margin-bottom:8px;">
      <label style="display:block; font-size:11px; color:var(--vscode-descriptionForeground); margin-bottom:2px;">Display Name</label>
      <input type="text" id="teacherName" value="Teacher" maxlength="30"
        style="width:100%; padding:5px 8px; font-size:12px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border,var(--vscode-widget-border,transparent)); border-radius:3px; font-family:var(--vscode-font-family);" />
    </div>
    <button class="btn-primary" id="btnStart">Start Session</button>
  </div>

  <!-- Running state -->
  <div class="running-container" id="runningContainer">
    <!-- Session info -->
    <div class="section" id="sessionInfo">
      <div class="info-row">
        <span class="info-label">URL</span>
        <span class="info-value clickable" id="infoUrl" title="Click to copy"></span>
      </div>
      <div class="info-row">
        <span class="info-label">File</span>
        <span class="info-value" id="infoFile">-</span>
      </div>
      <div class="info-row">
        <span class="info-label">Viewers</span>
        <span class="info-value" id="infoViewers">0</span>
      </div>
      <button class="btn-danger" id="btnStop" style="margin-top:8px;">Stop Session</button>
    </div>

    <!-- Action buttons -->
    <div class="section" id="actionSection">
      <button class="btn-primary" id="btnPoll">Create Poll</button>

      <!-- Inline poll form -->
      <div class="poll-form" id="pollForm">
        <label>Question</label>
        <input type="text" id="pollQuestion" placeholder="e.g. How well do you understand?" />
        <label>Mode</label>
        <select id="pollMode">
          <option value="number">Number (1, 2, 3...)</option>
          <option value="text">Text (custom labels)</option>
        </select>
        <div id="pollNumberMode">
          <label>Options count</label>
          <select id="pollOptionCount">
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4">4</option>
            <option value="5">5</option>
          </select>
        </div>
        <div id="pollTextMode" style="display:none;">
          <label>Options (one per line)</label>
          <textarea id="pollTextOptions" rows="4" placeholder="Yes&#10;No&#10;Maybe"
            style="width:100%;padding:4px 6px;font-size:12px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;font-family:var(--vscode-font-family);resize:vertical;"></textarea>
        </div>
        <div class="poll-form-actions">
          <button class="btn-secondary" id="btnPollCancel">Cancel</button>
          <button class="btn-primary" id="btnPollStart">Start</button>
        </div>
      </div>
    </div>

    <!-- Poll active indicator -->
    <div class="poll-active-bar" id="pollActiveBar">
      <div class="poll-question-text" id="pollActiveQuestion"></div>
      <div class="poll-results-mini" id="pollResultsMini"></div>
      <button class="btn-danger btn-small" id="btnEndPoll" style="margin-top:4px;">End Poll</button>
    </div>

    <!-- Chat -->
    <div class="chat-area">
      <div class="chat-header">Chat</div>
      <div class="chat-messages" id="chatMessages"></div>
      <div class="chat-input-area">
        <input type="text" id="chatInput" placeholder="Type a message..." />
        <button class="btn-primary" id="btnSend">Send</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();

      // Elements
      const notRunning = document.getElementById('notRunning');
      const runningContainer = document.getElementById('runningContainer');
      const btnStart = document.getElementById('btnStart');
      const btnStop = document.getElementById('btnStop');
      const btnPoll = document.getElementById('btnPoll');
      const pollForm = document.getElementById('pollForm');
      const btnPollCancel = document.getElementById('btnPollCancel');
      const btnPollStart = document.getElementById('btnPollStart');
      const pollQuestion = document.getElementById('pollQuestion');
      const pollOptionCount = document.getElementById('pollOptionCount');
      const btnEndPoll = document.getElementById('btnEndPoll');
      const pollActiveBar = document.getElementById('pollActiveBar');
      const pollActiveQuestion = document.getElementById('pollActiveQuestion');
      const pollResultsMini = document.getElementById('pollResultsMini');
      const pollMode = document.getElementById('pollMode');
      const pollNumberMode = document.getElementById('pollNumberMode');
      const pollTextMode = document.getElementById('pollTextMode');
      const pollTextOptions = document.getElementById('pollTextOptions');
      const infoUrl = document.getElementById('infoUrl');
      const infoFile = document.getElementById('infoFile');
      const infoViewers = document.getElementById('infoViewers');
      const chatMessages = document.getElementById('chatMessages');
      const chatInput = document.getElementById('chatInput');
      const btnSend = document.getElementById('btnSend');
      const copiedToast = document.getElementById('copiedToast');
      const teacherNameInput = document.getElementById('teacherName');

      let ws = null;
      let currentState = { isRunning: false, viewerCount: 0 };
      let pollActive = false;
      let currentPollOptions = null; // text labels for current poll
      const MAX_CHAT_MESSAGES = 200;

      // Notify extension that webview is ready
      vscode.postMessage({ type: 'ready' });

      // Button handlers
      btnStart.addEventListener('click', () => {
        const tName = (teacherNameInput.value || '').trim() || 'Teacher';
        vscode.postMessage({ type: 'command', command: 'startSession', data: { teacherName: tName } });
      });

      btnStop.addEventListener('click', () => {
        vscode.postMessage({ type: 'command', command: 'stopSession' });
      });

      // Poll form toggle
      btnPoll.addEventListener('click', () => {
        if (pollActive) return;
        pollForm.classList.toggle('visible');
        if (pollForm.classList.contains('visible')) {
          pollQuestion.focus();
        }
      });

      // Poll mode toggle
      pollMode.addEventListener('change', () => {
        if (pollMode.value === 'text') {
          pollNumberMode.style.display = 'none';
          pollTextMode.style.display = '';
        } else {
          pollNumberMode.style.display = '';
          pollTextMode.style.display = 'none';
        }
      });

      btnPollCancel.addEventListener('click', () => {
        pollForm.classList.remove('visible');
        pollQuestion.value = '';
        pollTextOptions.value = '';
        pollMode.value = 'number';
        pollNumberMode.style.display = '';
        pollTextMode.style.display = 'none';
      });

      btnPollStart.addEventListener('click', () => {
        const question = pollQuestion.value.trim();
        if (!question) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          addSystemMessage('WebSocket not connected. Cannot create poll.');
          return;
        }
        const pollId = Date.now().toString();
        let pollData;

        if (pollMode.value === 'text') {
          const lines = pollTextOptions.value.split('\\n').map(l => l.trim()).filter(l => l);
          if (lines.length < 2) {
            addSystemMessage('Please enter at least 2 options.');
            return;
          }
          pollData = { question, optionCount: lines.length, options: lines, pollId };
        } else {
          pollData = { question, optionCount: parseInt(pollOptionCount.value), pollId };
        }

        ws.send(JSON.stringify({ type: 'poll:start', data: pollData }));
        pollForm.classList.remove('visible');
        pollQuestion.value = '';
        pollTextOptions.value = '';
        pollMode.value = 'number';
        pollNumberMode.style.display = '';
        pollTextMode.style.display = 'none';
      });

      btnEndPoll.addEventListener('click', () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'poll:end', data: {} }));
        }
      });

      // URL copy
      infoUrl.addEventListener('click', () => {
        const url = infoUrl.textContent;
        if (url) {
          navigator.clipboard.writeText(url).then(() => {
            copiedToast.classList.add('show');
            setTimeout(() => copiedToast.classList.remove('show'), 1200);
          }).catch(() => {
            // Fallback: let extension handle it
            vscode.postMessage({ type: 'command', command: 'copyUrl', data: { url } });
          });
        }
      });

      // Chat send
      function sendChat() {
        const text = chatInput.value.trim();
        if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
          type: 'chat:message',
          data: { text }
        }));
        chatInput.value = '';
      }

      btnSend.addEventListener('click', sendChat);
      chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendChat();
      });

      // Poll question input - Enter to start
      pollQuestion.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') btnPollStart.click();
      });

      // WebSocket management
      function connectWs(port) {
        if (ws) {
          ws.close();
          ws = null;
        }
        try {
          ws = new WebSocket('ws://localhost:' + port);

          ws.onopen = () => {
            ws.send(JSON.stringify({
              type: 'join',
              data: { teacherPanel: true }
            }));
            addSystemMessage('Connected to session');
          };

          ws.onmessage = (event) => {
            try {
              const msg = JSON.parse(event.data);
              handleWsMessage(msg);
            } catch(e) { /* ignore parse errors */ }
          };

          ws.onclose = () => {
            addSystemMessage('Disconnected');
            ws = null;
          };

          ws.onerror = () => {
            // onclose will fire after this
          };
        } catch(e) {
          /* ignore connection errors */
        }
      }

      function disconnectWs() {
        if (ws) {
          ws.close();
          ws = null;
        }
      }

      function handleWsMessage(msg) {
        switch (msg.type) {
          case 'join:result':
            if (!msg.data.success) {
              addSystemMessage('Connection failed: ' + (msg.data.error || 'Unknown error'));
            }
            break;
          case 'chat:broadcast':
            addChatMessage(msg.data);
            break;
          case 'poll:start':
            showPollActive(msg.data);
            break;
          case 'poll:results':
            updatePollResults(msg.data);
            break;
          case 'poll:end':
            hidePollActive(msg.data);
            break;
          case 'viewers:count':
            infoViewers.textContent = String(msg.data.count);
            break;
          case 'session:end':
            addSystemMessage('Session ended by server');
            disconnectWs();
            break;
        }
      }

      function trimChatMessages() {
        // Count how many messages to remove (excluding active poll cards)
        const children = Array.from(chatMessages.children);
        const activePollCards = children.filter(el =>
          el.classList.contains('chat-poll-card') && !el.classList.contains('ended')
        );
        const removableCount = children.length - activePollCards.length;
        let toRemove = removableCount - MAX_CHAT_MESSAGES;

        if (toRemove <= 0) return;

        // Remove oldest removable messages (skip active poll cards)
        for (const child of children) {
          if (toRemove <= 0) break;
          const isActivePoll = child.classList.contains('chat-poll-card') && !child.classList.contains('ended');
          if (!isActivePoll) {
            chatMessages.removeChild(child);
            toRemove--;
          }
        }
      }

      function addChatMessage(data) {
        const div = document.createElement('div');
        div.className = 'chat-msg';

        const header = document.createElement('div');
        header.className = 'chat-msg-header';

        const nick = document.createElement('span');
        nick.className = 'chat-nickname' + (data.isTeacher ? ' teacher' : '');
        nick.textContent = data.nickname;

        const time = document.createElement('span');
        time.className = 'chat-time';
        const d = new Date(data.timestamp);
        time.textContent = d.getHours().toString().padStart(2,'0') + ':' +
                           d.getMinutes().toString().padStart(2,'0');

        header.appendChild(nick);
        header.appendChild(time);

        const text = document.createElement('div');
        text.className = 'chat-text';
        text.textContent = data.text;

        div.appendChild(header);
        div.appendChild(text);
        chatMessages.appendChild(div);
        trimChatMessages();
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }

      function addSystemMessage(text) {
        const div = document.createElement('div');
        div.className = 'chat-system';
        div.textContent = text;
        chatMessages.appendChild(div);
        trimChatMessages();
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }

      function showPollActive(data) {
        pollActive = true;
        currentPollOptions = data.options || null;
        btnPoll.textContent = 'Poll Active';
        btnPoll.disabled = true;
        pollActiveQuestion.textContent = data.question;
        pollResultsMini.textContent = 'Votes: 0';
        pollActiveBar.classList.add('visible');

        // Idempotency: skip if card already exists (e.g. reconnection)
        if (data.pollId && document.getElementById('poll-card-' + data.pollId)) return;

        // Create poll card in chat messages
        const card = document.createElement('div');
        card.className = 'chat-poll-card';
        card.id = 'poll-card-' + data.pollId;

        const questionEl = document.createElement('div');
        questionEl.className = 'chat-poll-question';
        questionEl.textContent = '\u{1F4CA} ' + data.question;
        card.appendChild(questionEl);

        const resultsEl = document.createElement('div');
        resultsEl.className = 'chat-poll-results';
        card.appendChild(resultsEl);

        const statusEl = document.createElement('div');
        statusEl.className = 'chat-poll-status';
        statusEl.textContent = '\uD22C\uD45C \uC9C4\uD589 \uC911';
        card.appendChild(statusEl);

        chatMessages.appendChild(card);
        trimChatMessages();
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }

      function updatePollResults(data) {
        const total = data.totalVoters || 0;
        const votes = data.votes || [];
        const opts = data.options || currentPollOptions;
        const parts = votes.map((v, i) => ((opts && opts[i]) || (i+1)) + ': ' + v).join('  ');
        pollResultsMini.textContent = 'Total: ' + total + '  |  ' + parts;

        // Update chat poll card results
        const card = data.pollId ? document.getElementById('poll-card-' + data.pollId) : null;
        if (card) {
          const resultsEl = card.querySelector('.chat-poll-results');
          const statusEl = card.querySelector('.chat-poll-status');
          if (resultsEl) renderPollBars(resultsEl, votes, total, opts);
          if (statusEl) statusEl.textContent = total + '\uBA85 \uD22C\uD45C';
        }
      }

      function renderPollBars(container, votes, totalVoters, options) {
        container.innerHTML = '';
        for (let i = 0; i < votes.length; i++) {
          const row = document.createElement('div');
          row.className = 'poll-bar-row';

          const label = document.createElement('span');
          label.className = 'poll-bar-label';
          label.textContent = (options && options[i]) ? options[i] : (i + 1).toString();
          if (options && options[i]) label.style.minWidth = 'auto';

          const track = document.createElement('div');
          track.className = 'poll-bar-track';

          const fill = document.createElement('div');
          fill.className = 'poll-bar-fill';
          const pct = totalVoters > 0 ? (votes[i] / totalVoters) * 100 : 0;
          fill.style.width = pct + '%';
          track.appendChild(fill);

          const value = document.createElement('span');
          value.className = 'poll-bar-value';
          value.textContent = votes[i] + ' (' + Math.round(pct) + '%)';

          row.appendChild(label);
          row.appendChild(track);
          row.appendChild(value);
          container.appendChild(row);
        }
      }

      function hidePollActive(data) {
        pollActive = false;
        btnPoll.textContent = 'Create Poll';
        btnPoll.disabled = false;
        pollActiveBar.classList.remove('visible');

        // Update chat poll card with final results
        if (data) {
          const cardId = data.pollId;
          const card = cardId ? document.getElementById('poll-card-' + cardId) : null;
          if (card && data.finalVotes) {
            const total = data.totalVoters || 0;
            const opts = data.options || currentPollOptions;
            const resultsEl = card.querySelector('.chat-poll-results');
            const statusEl = card.querySelector('.chat-poll-status');
            if (resultsEl) renderPollBars(resultsEl, data.finalVotes, total, opts);
            if (statusEl) statusEl.textContent = '\uD22C\uD45C \uC885\uB8CC \u2014 \uCD1D ' + total + '\uBA85';
            card.classList.add('ended');
          }
        }
        currentPollOptions = null;
      }

      // State updates from extension
      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg.type === 'stateUpdate') {
          const state = msg.state;
          currentState = state;

          if (state.isRunning) {
            notRunning.style.display = 'none';
            runningContainer.classList.add('visible');
            infoUrl.textContent = state.url || '-';
            infoUrl.title = state.url ? 'Click to copy: ' + state.url : '';
            infoFile.textContent = state.fileName || '-';
            infoViewers.textContent = String(state.viewerCount || 0);

            // Connect WebSocket if port available and not already connected
            if (state.port && (!ws || ws.readyState === WebSocket.CLOSED)) {
              connectWs(state.port);
            }

            // Poll state from extension
            if (state.pollActive && !pollActive) {
              pollActive = true;
              btnPoll.textContent = 'Poll Active';
              btnPoll.disabled = true;
            }
          } else {
            notRunning.style.display = '';
            runningContainer.classList.remove('visible');
            disconnectWs();
            // Reset poll state
            pollActive = false;
            btnPoll.textContent = 'Create Poll';
            btnPoll.disabled = false;
            pollActiveBar.classList.remove('visible');
            pollForm.classList.remove('visible');
            // Clear chat
            chatMessages.innerHTML = '';
          }
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
