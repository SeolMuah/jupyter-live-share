import * as vscode from 'vscode';
import * as crypto from 'crypto';

/**
 * VS Code 하단 패널 (터미널 영역)에 표시되는 Viewer Chat WebviewView.
 * - 학생: Open Viewer로 세션에 참여할 때 채팅/투표를 전용 패널에서 처리 (chatOnly 연결, 접속자 수 미포함)
 * - 교사: 세션 시작 시 자동으로 teacherPanel 연결 — 학생과 동일한 UI로 채팅 (접속자 수 미포함)
 */
export class ViewerChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codeClassLive.viewerChatPanel';

  private _view?: vscode.WebviewView;
  private _wsUrl: string | null = null;
  private _pin: string | null = null;
  private _nickname: string | null = null;
  private _teacherToken: string | null = null;
  private _mode: 'student' | 'teacher' | null = null;
  private _isConnected = false;
  private _unreadCount = 0;

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

    // Webview dispose 시 참조 정리
    webviewView.onDidDispose(() => {
      this._view = undefined;
    });

    // 패널이 보이게 되면 안읽은 메시지 뱃지 초기화
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._unreadCount = 0;
        this._updateBadge();
      }
    });

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'ready') {
        if (this._isConnected && this._wsUrl) {
          this._view?.webview.postMessage({
            type: 'connect',
            wsUrl: this._wsUrl,
            pin: this._pin,
            nickname: this._nickname,
            teacherToken: this._teacherToken,
          });
        }
      } else if (msg.type === 'newMessage') {
        // 패널이 보이지 않을 때만 안읽은 메시지 카운트 증가
        if (this._view && !this._view.visible) {
          this._unreadCount++;
          this._updateBadge();
        }
      } else if (msg.type === 'pollStarted') {
        // 투표 시작 시 패널을 강제로 표시
        this._view?.show?.(true);
      }
    });

    webviewView.webview.html = this._getHtml(webviewView.webview);
  }

  /** ViewerPanel 인증 성공 시 호출 — WebSocket 연결 지시 (학생 모드) */
  connect(wsUrl: string, pin?: string): void {
    // 교사 세션 채팅이 활성인 동안 학생 연결이 이를 덮어쓰지 않게 한다
    if (this._mode === 'teacher') return;
    this._mode = 'student';
    this._wsUrl = wsUrl;
    this._pin = pin || null;
    this._teacherToken = null;
    this._isConnected = true;
    this._view?.webview.postMessage({
      type: 'connect',
      wsUrl,
      pin: this._pin,
      nickname: this._nickname,
      teacherToken: null,
    });
  }

  /** 세션 시작 시 호출 — 교사 모드로 WebSocket 연결 지시 (학생과 동일 UI로 채팅) */
  connectAsTeacher(wsUrl: string, teacherToken: string): void {
    this._mode = 'teacher';
    this._wsUrl = wsUrl;
    this._pin = null;
    this._teacherToken = teacherToken;
    this._isConnected = true;
    if (this._view) {
      // 이미 열려 있으면 포커스를 뺏지 않고 보이기만 한다
      this._view.webview.postMessage({
        type: 'connect',
        wsUrl,
        pin: null,
        nickname: this._nickname,
        teacherToken,
      });
      this._view.show?.(true);
    } else {
      // 아직 resolve 전이면 focus로 열어 webview의 ready → connect 경로를 태운다
      vscode.commands.executeCommand('codeClassLive.viewerChatPanel.focus').then(undefined, () => { /* 무시 */ });
    }
  }

  /** 학생 이름 설정 시 호출 */
  setName(nickname: string): void {
    // 교사 모드에서는 서버가 teacherName을 사용 — 학생 닉네임으로 덮어쓰지 않는다
    if (this._mode === 'teacher') return;
    this._nickname = nickname;
    this._view?.webview.postMessage({ type: 'setName', nickname });
  }

  /** ViewerPanel 닫힐 때 호출 — WebSocket 해제 (학생 모드에서만 동작) */
  disconnect(): void {
    // 교사 세션 채팅은 ViewerPanel 생명주기와 무관 — 세션 종료(disconnectTeacher)로만 해제
    if (this._mode === 'teacher') return;
    this._doDisconnect();
  }

  /** 세션 종료 시 호출 — 교사 모드 연결 해제 */
  disconnectTeacher(): void {
    if (this._mode !== 'teacher') return;
    this._doDisconnect();
  }

  private _doDisconnect(): void {
    this._mode = null;
    this._wsUrl = null;
    this._pin = null;
    this._nickname = null;
    this._teacherToken = null;
    this._isConnected = false;
    this._unreadCount = 0;
    this._updateBadge();
    this._view?.webview.postMessage({ type: 'disconnect' });
  }

  /** 안읽은 메시지 뱃지 업데이트 */
  private _updateBadge(): void {
    if (!this._view) return;
    // VS Code bug: badge = undefined 시 Activity Bar에서 뱃지가 안 사라짐
    // (microsoft/vscode#162900, microsoft/vscode#210645)
    this._view.badge = this._unreadCount > 0
      ? { tooltip: `${this._unreadCount}개의 새 메시지`, value: this._unreadCount }
      : { value: 0, tooltip: '' };
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    return /*html*/ `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ws: wss:;">
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
    .msg.teacher-msg .msg-text {
      background: color-mix(in srgb, #2ea043 12%, var(--vscode-editor-background));
      border-color: color-mix(in srgb, #2ea043 25%, var(--vscode-panel-border, var(--vscode-widget-border, transparent)));
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
      margin: 8px 0 8px 36px;
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

    /* 투표 버튼 */
    .poll-buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 6px;
    }
    .poll-buttons button {
      padding: 4px 12px;
      font-size: 12px;
      border: 1px solid var(--vscode-button-background);
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-button-background);
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .poll-buttons button:hover:not(:disabled) {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .poll-buttons button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .poll-buttons button.voted {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      opacity: 1;
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
    <span>Start a session or open Viewer to chat</span>
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
      let nickname = null;
      let isTeacherMode = false;
      const MAX_MESSAGES = 300;

      // 자동 재접속: 일시적 네트워크 단절로 교사/학생 채팅이 세션 내내 끊긴 채
      // 남지 않도록, 비정상 close에 한해 제한 횟수만큼 재시도한다.
      let lastConn = null; // { wsUrl, pin, teacherToken }
      let reconnectTimer = null;
      let reconnectAttempts = 0;
      const MAX_RECONNECT = 10;
      const RECONNECT_DELAY_MS = 2000;
      // 재접속 제외 코드: 정상 종료(1000), PIN 오류(4001), 정원 초과(4002),
      // 토큰 무효(4003), join 타임아웃(4008) — 재시도해도 같은 결과
      const NO_RECONNECT_CODES = [1000, 4001, 4002, 4003, 4008];

      // 준비 완료 알림
      vscodeApi.postMessage({ type: 'ready' });

      // === WebSocket 관리 ===

      function connectWs(wsUrl, pin, nick, teacherToken) {
        disconnectWs();
        isTeacherMode = !!teacherToken;
        nickname = nick || nickname;
        lastConn = { wsUrl: wsUrl, pin: pin || null, teacherToken: teacherToken || null };
        try {
          ws = new WebSocket(wsUrl);

          ws.onopen = () => {
            if (isTeacherMode) {
              // 교사 모드: 서버가 teacherName으로 닉네임을 자동 설정하고 접속자 수에 미집계
              ws.send(JSON.stringify({ type: 'join', data: { teacherPanel: true, teacherToken: teacherToken } }));
            } else {
              ws.send(JSON.stringify({ type: 'join', data: { chatOnly: true, pin: pin || undefined } }));
            }
            connected = true;
            showChat();
            addSystem('Chat connected');
          };

          ws.onmessage = (event) => {
            try {
              const msg = JSON.parse(event.data);
              handleMessage(msg);
            } catch (e) { /* ignore */ }
          };

          ws.onclose = (event) => {
            connected = false;
            ws = null;
            addSystem('Chat disconnected');
            maybeReconnect(event && event.code);
          };

          ws.onerror = () => { /* onclose handles cleanup */ };
        } catch (e) { /* ignore */ }
      }

      function maybeReconnect(code) {
        if (!lastConn) return;
        if (NO_RECONNECT_CODES.indexOf(code) !== -1) return;
        if (reconnectAttempts >= MAX_RECONNECT) return;
        reconnectAttempts++;
        addSystem('Reconnecting... (' + reconnectAttempts + '/' + MAX_RECONNECT + ')');
        reconnectTimer = setTimeout(() => {
          if (!lastConn) return;
          connectWs(lastConn.wsUrl, lastConn.pin, nickname, lastConn.teacherToken);
        }, RECONNECT_DELAY_MS);
      }

      function disconnectWs() {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
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
          case 'join:result':
            if (msg.data.success) {
              reconnectAttempts = 0; // 성공 시 재접속 카운터 리셋
            }
            // 교사 모드는 서버가 닉네임(teacherName)을 이미 설정하므로 join:name 불필요
            if (msg.data.success && nickname && !isTeacherMode) {
              ws.send(JSON.stringify({ type: 'join:name', data: { nickname: nickname } }));
            }
            break;
          case 'chat:broadcast':
            addChatMsg(msg.data);
            vscodeApi.postMessage({ type: 'newMessage' });
            break;
          case 'chat:error':
            addSystem(msg.data.error);
            break;
          case 'poll:start':
            addPollCard(msg.data);
            vscodeApi.postMessage({ type: 'pollStarted' });
            break;
          case 'poll:results':
            updatePollResults(msg.data);
            break;
          case 'poll:end':
            endPollCard(msg.data);
            break;
          case 'session:end':
            addSystem('Session ended');
            lastConn = null; // 세션 종료 — 재접속하지 않는다
            disconnectWs();
            break;
        }
      }

      // === 채팅 메시지 렌더 ===

      function addChatMsg(data) {
        const initial = (data.nickname || '?')[0];

        const div = document.createElement('div');
        div.className = 'msg' + (data.isTeacher ? ' teacher-msg' : '');

        const avatar = document.createElement('div');
        avatar.className = 'avatar ' + (data.isTeacher ? 'teacher' : 'student');
        avatar.textContent = initial;

        const body = document.createElement('div');
        body.className = 'msg-body';

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

      let currentPollId = null;

      function addPollCard(data) {
        currentPollId = data.pollId;
        if (data.pollId && document.getElementById('poll-' + data.pollId)) return;

        // Check localStorage for previous vote
        const savedVote = localStorage.getItem('jls-poll-' + data.pollId);
        const hasVoted = savedVote !== null;

        const card = document.createElement('div');
        card.className = 'poll-card';
        card.id = 'poll-' + data.pollId;
        if (data.options) card.dataset.options = JSON.stringify(data.options);

        const q = document.createElement('div');
        q.className = 'poll-question';
        q.textContent = '\u{1F4CA} ' + data.question;
        card.appendChild(q);

        // Vote buttons
        const buttonsEl = document.createElement('div');
        buttonsEl.className = 'poll-buttons';
        for (let i = 0; i < data.optionCount; i++) {
          const btn = document.createElement('button');
          btn.textContent = (data.options && data.options[i]) ? data.options[i] : (i + 1).toString();
          btn.dataset.option = i;
          btn.addEventListener('click', () => votePoll(data.pollId, i));
          // 교사는 자기 투표에 참여하지 않는다 (결과만 관찰)
          if (isTeacherMode) {
            btn.disabled = true;
          } else if (hasVoted) {
            btn.disabled = true;
            if (parseInt(savedVote) === i) btn.classList.add('voted');
          }
          buttonsEl.appendChild(btn);
        }
        card.appendChild(buttonsEl);

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

      function votePoll(pollId, option) {
        if (isTeacherMode) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (pollId !== currentPollId) return;
        const savedVote = localStorage.getItem('jls-poll-' + pollId);
        if (savedVote !== null) return;
        localStorage.setItem('jls-poll-' + pollId, option.toString());
        ws.send(JSON.stringify({ type: 'poll:vote', data: { pollId, option } }));

        const card = document.getElementById('poll-' + pollId);
        if (card) {
          const buttons = card.querySelectorAll('.poll-buttons button');
          buttons.forEach((btn, i) => {
            if (i === option) btn.classList.add('voted');
            btn.disabled = true;
          });
        }
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
        const cardId = data.pollId || currentPollId;
        const card = cardId ? document.getElementById('poll-' + cardId) : null;
        currentPollId = null;
        if (!card) return;
        const opts = data.options || (card.dataset.options ? JSON.parse(card.dataset.options) : null);
        const resultsEl = card.querySelector('.poll-results');
        const statusEl = card.querySelector('.poll-status');
        if (resultsEl) renderBars(resultsEl, data.finalVotes || [], data.totalVoters || 0, opts);
        if (statusEl) statusEl.textContent = '투표 종료 — 총 ' + (data.totalVoters || 0) + '명';
        card.classList.add('ended');
        // Disable buttons
        const buttons = card.querySelectorAll('.poll-buttons button');
        buttons.forEach(btn => { btn.disabled = true; });
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
        // IME(한글) 조합 확정 Enter가 제출 Enter와 겹쳐 이중 전송되는 것 방지
        if (e.isComposing || e.keyCode === 229) return;
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
        if (msg.type === 'connect' && msg.wsUrl) {
          connectWs(msg.wsUrl, msg.pin, msg.nickname, msg.teacherToken);
        } else if (msg.type === 'setName' && msg.nickname) {
          nickname = msg.nickname;
          if (!isTeacherMode && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'join:name', data: { nickname: msg.nickname } }));
          }
        } else if (msg.type === 'disconnect') {
          lastConn = null;
          isTeacherMode = false;
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
  return crypto.randomBytes(16).toString('hex');
}
