/* viewer.js - Main viewer application */

(function () {
  'use strict';

  // VS Code Webview detection
  const isVSCodeWebview = typeof window.__VSCODE_WEBVIEW__ !== 'undefined';
  let vscodeApi = null;
  if (isVSCodeWebview) {
    try { vscodeApi = acquireVsCodeApi(); } catch(e) { /* ignore */ }
  }

  // State
  let notebookCells = [];
  let needsPin = false;
  let documentType = 'notebook'; // 'notebook' | 'plaintext'
  let currentDocument = null;

  // Scroll priority: cursor:position이 viewport:sync보다 우선
  let lastCursorScrollTime = 0;
  const CURSOR_SCROLL_PRIORITY_MS = 300;

  // Chat/Poll state
  let myNickname = '';
  let isTeacher = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || !!window.__TEACHER_PREVIEW__;
  const isTeacherPreview = !!window.__TEACHER_PREVIEW__;
  let chatVisible = false;
  let unreadCount = 0;
  let currentPollId = null;
  let hasVoted = false;
  let lastUsedPin = null;

  const MAX_CHAT_DOM = 200;

  // DOM elements
  const pinScreen = document.getElementById('pin-screen');
  const pinInput = document.getElementById('pin-input');
  const pinSubmit = document.getElementById('pin-submit');
  const pinError = document.getElementById('pin-error');
  const nameScreen = document.getElementById('name-screen');
  const nameInput = document.getElementById('name-input');
  const nameSubmit = document.getElementById('name-submit');
  const connectionStatus = document.getElementById('connection-status');
  const statusText = document.getElementById('status-text');
  const fileName = document.getElementById('file-name');
  const viewerCount = document.getElementById('viewer-count');
  const notebookContainer = document.getElementById('notebook-cells');
  const toolbar = document.getElementById('toolbar');
  const themeToggle = document.getElementById('theme-toggle');
  const btnDownload = document.getElementById('btn-download');

  // Layout
  const appLayout = document.getElementById('app-layout');

  // Chat elements
  const chatPanel = document.getElementById('chat-panel');
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const chatSend = document.getElementById('chat-send');
  const chatClose = document.getElementById('chat-close');
  const chatCollapse = document.getElementById('chat-collapse');
  const chatResizeHandle = document.getElementById('chat-resize-handle');
  const chatFloatToggle = document.getElementById('chat-float-toggle');
  const chatFloatBadge = document.getElementById('chat-float-badge');
  const chatEmptyState = document.getElementById('chat-empty-state');
  const btnChat = document.getElementById('btn-chat');

  // Poll elements
  const pollBanner = document.getElementById('poll-banner');
  const pollModal = document.getElementById('poll-modal');
  const pollQuestionInput = document.getElementById('poll-question-input');
  const pollOptionCount = document.getElementById('poll-option-count');
  const pollModalCancel = document.getElementById('poll-modal-cancel');
  const pollModalStart = document.getElementById('poll-modal-start');
  const pollModeSelect = document.getElementById('poll-mode-select');
  const pollNumberMode = document.getElementById('poll-number-mode');
  const pollTextMode = document.getElementById('poll-text-mode');
  const pollTextOptions = document.getElementById('poll-text-options');
  const btnPoll = document.getElementById('btn-poll');
  const btnEndPoll = document.getElementById('btn-end-poll');

  // Initialize
  init();

  function init() {
    // Theme
    initTheme();

    // VS Code Webview: hide chat UI (chat handled by separate Viewer Chat panel)
    if (isVSCodeWebview) {
      if (chatPanel) chatPanel.style.display = 'none';
      if (btnChat) btnChat.style.display = 'none';
    }

    // Teacher UI (직접 브라우저 접속 시)
    if (isTeacher) {
      myNickname = 'Teacher'; // 서버에서 실제 이름으로 덮어씌움
      if (btnPoll) btnPoll.style.display = '';
    }

    // Restore saved nickname
    const savedName = localStorage.getItem('jls-nickname');
    if (savedName && nameInput) {
      nameInput.value = savedName;
    }

    // Connect WebSocket (teacher preview joins as teacherPanel to avoid viewerCount increment)
    const joinData = isTeacherPreview ? { teacherPanel: true } : undefined;
    WsClient.connect(handleMessage, handleStatus, null, joinData);

    // Event listeners
    themeToggle.addEventListener('click', toggleTheme);
    btnDownload?.addEventListener('click', downloadNotebook);

    pinSubmit?.addEventListener('click', submitPin);
    pinInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitPin();
    });

    nameSubmit?.addEventListener('click', submitName);
    nameInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitName();
    });

    // Chat events
    chatSend?.addEventListener('click', sendChatMessage);
    chatInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChatMessage();
    });
    chatClose?.addEventListener('click', () => toggleChat(false));
    chatCollapse?.addEventListener('click', () => toggleChat(false));
    chatFloatToggle?.addEventListener('click', () => toggleChat(true));
    btnChat?.addEventListener('click', () => toggleChat(!chatVisible));

    // Chat: restore saved width
    const savedChatWidth = localStorage.getItem('jls-chat-width');
    if (savedChatWidth) {
      document.documentElement.style.setProperty('--chat-width', savedChatWidth + 'px');
    }

    // Chat: default open on desktop (unless VS Code Webview)
    if (!isVSCodeWebview) {
      const isMobile = window.innerWidth <= 768;
      if (!isMobile) {
        const savedChatState = localStorage.getItem('jls-chat-open');
        const shouldOpen = savedChatState !== 'false';
        // Disable transition for initial state setup (no animation on page load)
        if (chatPanel) chatPanel.style.transition = 'none';
        if (chatResizeHandle) chatResizeHandle.style.transition = 'none';
        if (appLayout) appLayout.style.transition = 'none';
        toggleChat(shouldOpen);
        // Force reflow then re-enable transitions
        if (chatPanel) {
          chatPanel.offsetHeight;
          chatPanel.style.transition = '';
        }
        if (chatResizeHandle) chatResizeHandle.style.transition = '';
        if (appLayout) { appLayout.offsetHeight; appLayout.style.transition = ''; }
      }
    }

    // Chat resize drag
    initChatResize();

    // Responsive: handle mobile ↔ desktop transitions (debounced)
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(handleWindowResize, 100);
    });

    // Poll events (teacher only)
    btnPoll?.addEventListener('click', showNewPollModal);
    btnEndPoll?.addEventListener('click', () => {
      WsClient.send('poll:end', {});
    });
    pollModeSelect?.addEventListener('change', () => {
      if (pollModeSelect.value === 'text') {
        pollNumberMode.style.display = 'none';
        pollTextMode.style.display = '';
      } else {
        pollNumberMode.style.display = '';
        pollTextMode.style.display = 'none';
      }
    });
    pollModalCancel?.addEventListener('click', () => {
      pollModal.style.display = 'none';
    });
    pollModalStart?.addEventListener('click', submitNewPoll);
    pollQuestionInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitNewPoll();
    });

    // Drawing module initialization
    Drawing.init(isTeacherPreview);

    // Teacher scroll sync — 선생님 프리뷰에서만 활성
    if (isTeacherPreview) {
      let scrollThrottleTimer = null;
      const SCROLL_THROTTLE_MS = 150;

      let lastScrollEventTime = 0;
      const onScroll = () => {
        // window/document 이중 발화 방지 (같은 frame 내 중복 무시)
        const now = performance.now();
        if (now - lastScrollEventTime < 5) return;
        lastScrollEventTime = now;

        if (scrollThrottleTimer) clearTimeout(scrollThrottleTimer);
        scrollThrottleTimer = setTimeout(() => {
          scrollThrottleTimer = null;
          const anchor = computeScrollAnchor();
          if (anchor) WsClient.send('scroll:sync', anchor);
        }, SCROLL_THROTTLE_MS);
      };

      // VS Code Webview은 iframe 내부에서 렌더링되어
      // window scroll 이벤트가 발생하지 않을 수 있음 → document에도 등록
      window.addEventListener('scroll', onScroll, { passive: true });
      document.addEventListener('scroll', onScroll, { passive: true });
    }
  }

  /**
   * Get current scroll position (robust for VS Code Webview iframe)
   */
  function getScrollY() {
    return window.scrollY || window.pageYOffset
      || document.documentElement.scrollTop || document.body.scrollTop || 0;
  }

  function computeScrollAnchor() {
    const headerHeight = document.getElementById('header')?.offsetHeight || 48;
    const scrollY = getScrollY();
    const viewportTop = scrollY + headerHeight;

    if (documentType === 'notebook') {
      const cells = document.querySelectorAll('#notebook-cells .cell');
      let anchorCell = null;
      let anchorIndex = 0;

      for (let i = 0; i < cells.length; i++) {
        if (cells[i].offsetTop + cells[i].offsetHeight > viewportTop) {
          anchorCell = cells[i];
          anchorIndex = i;
          break;
        }
      }
      if (!anchorCell) return null;

      const offsetRatio = Math.max(0, Math.min(1,
        (viewportTop - anchorCell.offsetTop) / (anchorCell.offsetHeight || 1)
      ));
      return { type: 'notebook', cellIndex: anchorIndex, offsetRatio };
    }

    // Plaintext: 비율 기반
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    if (maxScroll <= 0) return null;
    return { type: 'plaintext', scrollRatio: scrollY / maxScroll };
  }

  // === Name Flow ===

  function submitName() {
    const name = nameInput.value.trim();
    if (!name) return;
    myNickname = name;
    localStorage.setItem('jls-nickname', name);
    WsClient.send('join:name', { nickname: name });
    if (vscodeApi) {
      vscodeApi.postMessage({ type: 'nameSet', nickname: name });
    }
    nameScreen.style.display = 'none';
    toolbar.style.display = 'flex';
  }

  function showNameScreen() {
    if (isTeacher) {
      // Teacher skips name screen
      WsClient.send('join:name', { nickname: 'Teacher' });
      if (vscodeApi) {
        vscodeApi.postMessage({ type: 'nameSet', nickname: 'Teacher' });
      }
      toolbar.style.display = 'flex';
      return;
    }

    // Reconnection: if student already has nickname, skip name screen
    if (myNickname) {
      WsClient.send('join:name', { nickname: myNickname });
      if (vscodeApi) {
        vscodeApi.postMessage({ type: 'nameSet', nickname: myNickname });
      }
      toolbar.style.display = 'flex';
      return;
    }

    nameScreen.style.display = 'flex';
    nameInput.focus();
  }

  // === WebSocket Message Handler ===

  function handleMessage(msg) {
    switch (msg.type) {
      case 'join:result':
        handleJoinResult(msg.data);
        break;

      case 'notebook:full':
        handleNotebookFull(msg.data);
        break;

      case 'cell:update':
        handleCellUpdate(msg.data);
        break;

      case 'cell:output':
        handleCellOutput(msg.data);
        break;

      case 'cells:structure':
        handleCellsStructure(msg.data);
        break;

      case 'document:full':
        handleDocumentFull(msg.data);
        break;

      case 'document:update':
        handleDocumentUpdate(msg.data);
        break;

      case 'focus:cell':
        if (documentType === 'notebook') {
          Renderer.setActiveCell(msg.data.cellIndex);
        }
        break;

      case 'cursor:position':
        // Mode-aware: plaintext cursor has mode:'plaintext', notebook cursor has no mode field
        if (msg.data.mode === 'plaintext') {
          if (documentType === 'plaintext') {
            Renderer.showDocumentCursor(msg.data);
            lastCursorScrollTime = Date.now();
          }
        } else {
          if (documentType === 'notebook') {
            Renderer.showTeacherCursor(msg.data);
            lastCursorScrollTime = Date.now();
          }
        }
        break;

      case 'viewport:sync':
        handleViewportSync(msg.data);
        break;

      case 'scroll:sync':
        handleScrollSync(msg.data);
        break;

      case 'viewers:count':
        viewerCount.textContent = `${msg.data.count}명 접속`;
        break;

      case 'session:end':
        handleSessionEnd();
        break;

      // Chat events
      case 'chat:broadcast':
        handleChatBroadcast(msg.data);
        break;

      case 'chat:error':
        handleChatError(msg.data);
        break;

      // Poll events
      case 'poll:start':
        handlePollStart(msg.data);
        break;

      case 'poll:results':
        handlePollResults(msg.data);
        break;

      case 'poll:end':
        handlePollEnd(msg.data);
        break;

      // Drawing events
      // Teacher preview skips only draw:stroke and draw:stroking (already rendered locally).
      // draw:undo/erase/clear are allowed through — they are idempotent when already
      // processed locally, but critical for server-initiated clears (file switch, cells:structure).
      // draw:full is always processed (reconnection sync).
      case 'draw:stroke':
        if (!isTeacherPreview) Drawing.receiveStroke(msg.data);
        break;
      case 'draw:stroking':
        if (!isTeacherPreview) Drawing.receiveStroking(msg.data);
        break;
      case 'draw:undo':
        Drawing.receiveUndo(msg.data);
        break;
      case 'draw:erase':
        Drawing.receiveErase(msg.data);
        break;
      case 'draw:clear':
        Drawing.receiveClear();
        break;
      case 'draw:full':
        Drawing.receiveFull(msg.data);
        break;

      default:
        console.log('Unknown message type:', msg.type);
    }
  }

  function handleJoinResult(data) {
    if (data.success) {
      pinScreen.style.display = 'none';
      needsPin = false;
      // Notify VS Code extension of successful auth (include PIN for chat panel)
      if (vscodeApi) {
        vscodeApi.postMessage({ type: 'authenticated', wsUrl: window.__WS_URL__, pin: lastUsedPin });
      }
      // Show name screen (or skip for teacher)
      showNameScreen();
    } else {
      if (data.error === 'Invalid PIN') {
        // Show PIN screen
        needsPin = true;
        pinScreen.style.display = 'flex';
        pinError.textContent = pinInput.value ? 'Wrong PIN. Try again.' : '';
        pinError.style.display = pinInput.value ? 'block' : 'none';
        pinInput.value = '';
        pinInput.focus();
      } else {
        alert(data.error || 'Failed to join session');
      }
    }
  }

  function handleNotebookFull(data) {
    documentType = 'notebook';
    currentDocument = null;
    notebookCells = data.cells || [];
    fileName.textContent = data.fileName || 'notebook.ipynb';
    Renderer.renderNotebook(data, notebookContainer);

    // 다운로드 버튼 텍스트 업데이트
    if (btnDownload) {
      btnDownload.textContent = 'Download';
      btnDownload.title = 'Download .ipynb';
    }
  }

  function handleCellUpdate(data) {
    if (documentType !== 'notebook') return;
    if (data.index >= 0 && data.index < notebookCells.length) {
      notebookCells[data.index].source = data.source;
      Renderer.updateCellSource(data.index, data.source);
    } else {
      console.error('[JLS] cell:update DROPPED — index out of bounds:', data.index, '>=', notebookCells.length);
    }
  }

  function handleCellOutput(data) {
    if (documentType !== 'notebook') return;
    if (data.index >= 0 && data.index < notebookCells.length) {
      notebookCells[data.index].outputs = data.outputs;
      if (data.executionOrder) {
        notebookCells[data.index].executionOrder = data.executionOrder;
      }
      Renderer.updateCellOutputs(data.index, data.outputs, data.executionOrder);
    }
  }

  function handleDocumentFull(data) {
    documentType = 'plaintext';
    currentDocument = data;
    notebookCells = [];
    fileName.textContent = data.fileName || 'untitled.txt';
    Renderer.renderPlaintextDocument(data, notebookContainer);

    // 다운로드 버튼 텍스트 업데이트
    if (btnDownload) {
      btnDownload.textContent = 'Download';
      btnDownload.title = `Download ${data.fileName || 'file'}`;
    }
  }

  function handleDocumentUpdate(data) {
    if (documentType !== 'plaintext') return;
    if (currentDocument) {
      currentDocument.content = data.content;
    }
    Renderer.updateDocumentContent(data.content);
  }

  function handleCellsStructure(data) {
    if (documentType !== 'notebook') return;
    if (data.type === 'insert' && data.addedCells) {
      notebookCells.splice(data.index, 0, ...data.addedCells);
    } else if (data.type === 'delete') {
      notebookCells.splice(data.index, data.removedCount || 1);
    }
    Renderer.handleStructureChange(data, notebookCells);
  }

  function handleSessionEnd() {
    WsClient.disconnect();
    Drawing.destroy();
    notebookContainer.innerHTML = '';
    const endMsg = document.createElement('div');
    endMsg.className = 'session-ended';
    endMsg.textContent = 'Session has ended.';
    notebookContainer.appendChild(endMsg);
    toolbar.style.display = 'none';
    connectionStatus.style.display = 'none';
    toggleChat(false);
    chatMessages.innerHTML = '';
    if (pollBanner) pollBanner.style.display = 'none';
    currentPollId = null;
  }

  // === Viewport Sync (plaintext 전용 — 노트북은 cursor:position이 스크롤 담당) ===

  function handleViewportSync(data) {
    if (data.mode === 'plaintext' && documentType === 'plaintext') {
      // 마크다운 문서는 viewport:sync 무시 — cursor:position으로만 스크롤
      // (마크다운은 렌더된 HTML과 소스 라인이 1:1 대응이 안 되어 viewport 라인 기반 스크롤이 부정확)
      if (currentDocument && currentDocument.languageId === 'markdown') return;

      // 커서 스크롤이 최근에 발생했으면 viewport 스크롤 무시 (커서 우선)
      if (Date.now() - lastCursorScrollTime < CURSOR_SCROLL_PRIORITY_MS) return;

      const autoScroll = document.getElementById('auto-scroll');
      if (autoScroll && autoScroll.checked && typeof data.firstVisibleLine === 'number') {
        Renderer.scrollToLine(data.firstVisibleLine);
      }
    }
  }

  // === Scroll Sync (선생님→학생 스크롤 동기화) ===

  function handleScrollSync(data) {
    // 선생님 프리뷰는 수신 무시 (자신이 발신자)
    if (isTeacherPreview) return;

    // Auto-scroll 체크
    const autoScroll = document.getElementById('auto-scroll');
    if (!autoScroll || !autoScroll.checked) return;

    // 커서 스크롤 우선 (300ms 이내 cursor:position이 있었으면 무시)
    if (Date.now() - lastCursorScrollTime < CURSOR_SCROLL_PRIORITY_MS) return;

    if (data.type === 'notebook' && documentType === 'notebook') {
      Renderer.scrollToNotebookAnchor(data.cellIndex, data.offsetRatio);
    } else if (data.type === 'plaintext' && documentType === 'plaintext') {
      Renderer.scrollToRatio(data.scrollRatio);
    }
  }

  // === Chat ===

  function hideChatEmptyState() {
    if (chatEmptyState && chatEmptyState.parentNode) {
      chatEmptyState.remove();
    }
  }

  function handleChatBroadcast(data) {
    // VS Code mode: chat handled by separate Viewer Chat panel
    if (isVSCodeWebview) return;

    hideChatEmptyState();

    const msgEl = document.createElement('div');
    msgEl.className = 'chat-msg' + (data.isTeacher ? ' teacher-msg' : '');

    const header = document.createElement('div');
    header.className = 'chat-msg-header';

    const nick = document.createElement('span');
    nick.className = 'chat-nickname' + (data.isTeacher ? ' teacher' : '');
    nick.textContent = data.nickname;
    header.appendChild(nick);

    const time = document.createElement('span');
    time.className = 'chat-time';
    const d = new Date(data.timestamp);
    time.textContent = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    header.appendChild(time);

    const text = document.createElement('div');
    text.className = 'chat-text';
    text.textContent = data.text; // XSS safe: textContent

    msgEl.appendChild(header);
    msgEl.appendChild(text);
    chatMessages.appendChild(msgEl);

    // DOM limit (preserve active poll card)
    trimChatDOM();

    // Auto scroll
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Unread badge
    if (!chatVisible) {
      unreadCount++;
      updateChatBadge();
    }
  }

  function handleChatError(data) {
    // VS Code mode: chat handled by separate Viewer Chat panel
    if (isVSCodeWebview) return;

    const errEl = document.createElement('div');
    errEl.className = 'chat-error';
    errEl.textContent = data.error;
    chatMessages.appendChild(errEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Auto-remove after 3 seconds
    setTimeout(() => {
      if (errEl.parentNode) errEl.parentNode.removeChild(errEl);
    }, 3000);
  }

  function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text) return;
    WsClient.send('chat:message', { text });
    chatInput.value = '';
    chatInput.focus();
  }

  function toggleChat(show) {
    chatVisible = typeof show === 'boolean' ? show : !chatVisible;
    const isMobile = window.innerWidth <= 768;

    if (isMobile) {
      // Mobile: fixed overlay with slide-in animation
      if (appLayout) appLayout.classList.remove('chat-open');
      if (chatVisible) {
        chatPanel.classList.add('open');
        chatPanel.classList.remove('collapsed');
      } else {
        chatPanel.classList.remove('open');
      }
    } else {
      // Desktop: fixed sidebar with collapsed class + margin on app-layout
      if (chatVisible) {
        chatPanel.classList.remove('collapsed');
        if (appLayout) appLayout.classList.add('chat-open');
        if (chatResizeHandle) chatResizeHandle.classList.add('visible');
        if (chatFloatToggle) chatFloatToggle.classList.remove('visible');
      } else {
        chatPanel.classList.add('collapsed');
        if (appLayout) appLayout.classList.remove('chat-open');
        if (chatResizeHandle) chatResizeHandle.classList.remove('visible');
        if (chatFloatToggle) chatFloatToggle.classList.add('visible');
      }
    }

    if (chatVisible) {
      unreadCount = 0;
      updateChatBadge();
      chatInput.focus();
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // Save state
    localStorage.setItem('jls-chat-open', chatVisible ? 'true' : 'false');

    // Update draw tools position
    updateDrawToolsPosition();
  }

  function updateChatBadge() {
    // Footer toolbar badge
    if (btnChat) {
      const existing = btnChat.querySelector('.chat-badge');
      if (existing) existing.remove();
      if (unreadCount > 0) {
        const badge = document.createElement('span');
        badge.className = 'chat-badge';
        badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
        btnChat.appendChild(badge);
      }
    }

    // Floating toggle badge
    if (chatFloatBadge) {
      if (unreadCount > 0) {
        chatFloatBadge.textContent = unreadCount > 99 ? '99+' : unreadCount;
        chatFloatBadge.style.display = '';
      } else {
        chatFloatBadge.style.display = 'none';
      }
    }
  }

  function trimChatDOM() {
    // Count how many messages to remove (excluding active poll cards)
    const children = Array.from(chatMessages.children);
    const activePollCards = children.filter(el =>
      el.classList.contains('chat-poll-card') && !el.classList.contains('ended')
    );
    const removableCount = children.length - activePollCards.length;
    let toRemove = removableCount - MAX_CHAT_DOM;

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

  // === Poll ===

  function handlePollStart(data) {
    currentPollId = data.pollId;

    // Check localStorage for previous vote on this poll
    const savedVote = localStorage.getItem('jls-poll-' + data.pollId);

    // VS Code mode: poll handled by separate Viewer Chat panel, only track state
    if (isVSCodeWebview) return;

    // Idempotency: skip if card already exists (e.g. reconnection)
    const existingCard = document.getElementById('poll-card-' + data.pollId);
    if (existingCard) return;

    // Create poll card in chat messages
    hideChatEmptyState();
    const card = document.createElement('div');
    card.className = 'chat-poll-card';
    card.id = 'poll-card-' + data.pollId;
    if (data.options) card.dataset.options = JSON.stringify(data.options);

    const questionEl = document.createElement('div');
    questionEl.className = 'chat-poll-question';
    questionEl.textContent = '\u{1F4CA} ' + data.question;
    card.appendChild(questionEl);

    const buttonsEl = document.createElement('div');
    buttonsEl.className = 'chat-poll-buttons';

    for (let i = 0; i < data.optionCount; i++) {
      const btn = document.createElement('button');
      btn.textContent = (data.options && data.options[i]) ? data.options[i] : (i + 1).toString();
      btn.dataset.option = i;
      if (savedVote !== null) {
        btn.disabled = true;
        if (parseInt(savedVote) === i) btn.classList.add('voted');
      }
      btn.addEventListener('click', () => votePoll(data.pollId, i));
      buttonsEl.appendChild(btn);
    }
    card.appendChild(buttonsEl);

    const resultsEl = document.createElement('div');
    resultsEl.className = 'chat-poll-results';
    card.appendChild(resultsEl);

    const statusEl = document.createElement('div');
    statusEl.className = 'chat-poll-status';
    statusEl.textContent = '\uD22C\uD45C \uC9C4\uD589 \uC911';
    card.appendChild(statusEl);

    chatMessages.appendChild(card);
    trimChatDOM();

    // Auto-scroll and open chat panel
    chatMessages.scrollTop = chatMessages.scrollHeight;
    toggleChat(true);

    // Show End Poll button for teacher
    if (isTeacher && btnEndPoll) {
      btnEndPoll.style.display = '';
    }
  }

  function votePoll(pollId, option) {
    if (pollId !== currentPollId) return;

    // 이미 투표했으면 무시
    const savedVote = localStorage.getItem('jls-poll-' + pollId);
    if (savedVote !== null) return;

    localStorage.setItem('jls-poll-' + pollId, option.toString());
    WsClient.send('poll:vote', { pollId, option });

    // 투표한 버튼 하이라이트 + 전체 버튼 비활성화
    const card = document.getElementById('poll-card-' + pollId);
    if (card) {
      const buttons = card.querySelectorAll('.chat-poll-buttons button');
      buttons.forEach((btn, i) => {
        if (i === option) btn.classList.add('voted');
        btn.disabled = true;
      });
    }
  }

  function handlePollResults(data) {
    if (isVSCodeWebview) return;
    if (data.pollId !== currentPollId) return;
    const card = document.getElementById('poll-card-' + data.pollId);
    if (card) {
      const opts = data.options || (card.dataset.options ? JSON.parse(card.dataset.options) : null);
      const resultsEl = card.querySelector('.chat-poll-results');
      const statusEl = card.querySelector('.chat-poll-status');
      if (resultsEl) renderPollBars(resultsEl, data.votes, data.totalVoters, opts);
      if (statusEl) statusEl.textContent = `${data.totalVoters}\uBA85 \uD22C\uD45C`;
    }
  }

  function handlePollEnd(data) {
    // Find the poll card (use saved pollId from data, or find the latest card)
    const cardId = data.pollId || currentPollId;
    currentPollId = null;
    if (isVSCodeWebview) return;

    const card = cardId ? document.getElementById('poll-card-' + cardId) : null;

    if (card) {
      const opts = data.options || (card.dataset.options ? JSON.parse(card.dataset.options) : null);
      const resultsEl = card.querySelector('.chat-poll-results');
      const statusEl = card.querySelector('.chat-poll-status');
      if (resultsEl) renderPollBars(resultsEl, data.finalVotes, data.totalVoters, opts);
      if (statusEl) statusEl.textContent = `\uD22C\uD45C \uC885\uB8CC \u2014 \uCD1D ${data.totalVoters}\uBA85`;
      card.classList.add('ended');

      // Disable buttons
      const buttons = card.querySelectorAll('.chat-poll-buttons button');
      buttons.forEach(btn => { btn.disabled = true; });
    }

    // Hide End Poll button
    if (btnEndPoll) btnEndPoll.style.display = 'none';
  }

  function renderPollBars(container, votes, totalVoters, options) {
    container.innerHTML = '';

    for (let i = 0; i < votes.length; i++) {
      const row = document.createElement('div');
      row.className = 'poll-bar-row';

      const label = document.createElement('span');
      label.className = 'poll-bar-label';
      label.textContent = (options && options[i]) ? options[i] : (i + 1).toString();

      const track = document.createElement('div');
      track.className = 'poll-bar-track';

      const fill = document.createElement('div');
      fill.className = 'poll-bar-fill';
      const pct = totalVoters > 0 ? (votes[i] / totalVoters) * 100 : 0;
      fill.style.width = pct + '%';

      track.appendChild(fill);

      const value = document.createElement('span');
      value.className = 'poll-bar-value';
      value.textContent = `${votes[i]} (${Math.round(pct)}%)`;

      row.appendChild(label);
      row.appendChild(track);
      row.appendChild(value);
      container.appendChild(row);
    }
  }

  // Teacher: Poll creation modal
  function showNewPollModal() {
    if (!isTeacher) return;
    pollQuestionInput.value = '';
    pollOptionCount.value = '5';
    if (pollModeSelect) pollModeSelect.value = 'number';
    if (pollNumberMode) pollNumberMode.style.display = '';
    if (pollTextMode) pollTextMode.style.display = 'none';
    if (pollTextOptions) pollTextOptions.value = '';
    pollModal.style.display = 'flex';
    pollQuestionInput.focus();
  }

  function submitNewPoll() {
    const question = pollQuestionInput.value.trim();
    if (!question) {
      pollQuestionInput.focus();
      return;
    }
    const pollId = Date.now().toString();
    let pollData;

    if (pollModeSelect && pollModeSelect.value === 'text') {
      const lines = (pollTextOptions ? pollTextOptions.value : '').split('\n').map(l => l.trim()).filter(l => l);
      if (lines.length < 2) {
        if (pollTextOptions) pollTextOptions.focus();
        return;
      }
      pollData = { question, optionCount: lines.length, options: lines, pollId };
    } else {
      const optionCount = parseInt(pollOptionCount.value) || 5;
      pollData = { question, optionCount, pollId };
    }

    WsClient.send('poll:start', pollData);
    pollModal.style.display = 'none';
  }

  // === Connection Status ===

  function handleStatus(status) {
    switch (status) {
      case 'connecting':
        connectionStatus.style.display = 'block';
        statusText.textContent = 'Connecting...';
        break;

      case 'connected':
        connectionStatus.style.display = 'none';
        break;

      case 'disconnected':
        connectionStatus.style.display = 'block';
        statusText.textContent = 'Disconnected. Reconnecting...';
        break;

      case 'reconnecting':
        connectionStatus.style.display = 'block';
        statusText.textContent = 'Reconnecting...';
        break;
    }
  }

  // === PIN ===

  function submitPin() {
    const pin = pinInput.value.trim();
    if (!pin) return;

    lastUsedPin = pin;
    pinError.style.display = 'none';
    WsClient.disconnect();
    WsClient.connect(handleMessage, handleStatus, pin);
  }

  // === Theme ===

  function initTheme() {
    const saved = localStorage.getItem('jls-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = saved || (prefersDark ? 'dark' : 'light');
    setTheme(theme);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem('jls-theme', next);
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    themeToggle.textContent = theme === 'dark' ? '🌙' : '☀️';

    // Switch highlight.js theme
    const lightCss = document.getElementById('hljs-light');
    const darkCss = document.getElementById('hljs-dark');
    if (lightCss && darkCss) {
      lightCss.disabled = theme === 'dark';
      darkCss.disabled = theme === 'light';
    }
  }

  // === Download ===

  function downloadNotebook() {
    window.open('/download', '_blank');
  }

  // === Chat Resize ===

  function initChatResize() {
    if (!chatResizeHandle) return;

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;
    let minW = 240;
    let maxW = 600;

    chatResizeHandle.addEventListener('mousedown', (e) => {
      if (window.innerWidth <= 768) return; // no resize on mobile
      isResizing = true;
      startX = e.clientX;
      startWidth = chatPanel.offsetWidth;
      const styles = getComputedStyle(document.documentElement);
      minW = parseInt(styles.getPropertyValue('--chat-min-width')) || 240;
      maxW = parseInt(styles.getPropertyValue('--chat-max-width')) || 600;
      chatResizeHandle.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      // Dragging left increases chat width (handle is left of chat panel)
      const delta = startX - e.clientX;
      const newWidth = Math.min(maxW, Math.max(minW, startWidth + delta));
      document.documentElement.style.setProperty('--chat-width', newWidth + 'px');
    });

    document.addEventListener('mouseup', () => {
      if (!isResizing) return;
      isResizing = false;
      chatResizeHandle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Save width
      const currentWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--chat-width'));
      if (currentWidth) {
        localStorage.setItem('jls-chat-width', currentWidth);
      }
      updateDrawToolsPosition();
    });
  }

  // === Draw Tools Position ===

  function updateDrawToolsPosition() {
    const drawToolsPanel = document.getElementById('draw-tools-panel');
    if (!drawToolsPanel) return;
    const isMobile = window.innerWidth <= 768;

    if (!isMobile && chatVisible && chatPanel && !chatPanel.classList.contains('collapsed')) {
      const chatW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--chat-width')) || 340;
      const handleW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--resize-handle-width')) || 4;
      drawToolsPanel.style.right = (chatW + handleW + 12) + 'px';
    } else {
      drawToolsPanel.style.right = '12px';
    }
  }

  // === Window Resize (mobile ↔ desktop) ===

  let lastIsMobile = window.innerWidth <= 768;

  function handleWindowResize() {
    const isMobile = window.innerWidth <= 768;
    if (isMobile !== lastIsMobile) {
      lastIsMobile = isMobile;
      // Reapply chat state for new mode
      if (isMobile) {
        // Switching to mobile: remove desktop classes, apply mobile classes
        chatPanel.classList.remove('collapsed');
        if (appLayout) appLayout.classList.remove('chat-open');
        if (chatResizeHandle) chatResizeHandle.classList.remove('visible');
        if (chatFloatToggle) chatFloatToggle.classList.remove('visible');
        if (!chatVisible) {
          chatPanel.classList.remove('open');
        } else {
          chatPanel.classList.add('open');
        }
      } else {
        // Switching to desktop: remove mobile classes, apply desktop classes
        chatPanel.classList.remove('open');
        if (chatVisible) {
          chatPanel.classList.remove('collapsed');
          if (appLayout) appLayout.classList.add('chat-open');
          if (chatResizeHandle) chatResizeHandle.classList.add('visible');
          if (chatFloatToggle) chatFloatToggle.classList.remove('visible');
        } else {
          chatPanel.classList.add('collapsed');
          if (appLayout) appLayout.classList.remove('chat-open');
          if (chatFloatToggle) chatFloatToggle.classList.add('visible');
        }
      }
    }
    updateDrawToolsPosition();
  }

})();
