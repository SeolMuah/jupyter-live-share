/* viewer.js - Main viewer application */

(function () {
  'use strict';

  // State
  let notebookCells = [];
  let needsPin = false;
  let documentType = 'notebook'; // 'notebook' | 'plaintext'
  let currentDocument = null;

  // Chat/Poll state
  let myNickname = '';
  let isTeacher = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  let chatVisible = false;
  let unreadCount = 0;
  let currentPollId = null;
  let hasVoted = false;

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

  // Chat elements
  const chatPanel = document.getElementById('chat-panel');
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const chatSend = document.getElementById('chat-send');
  const chatClose = document.getElementById('chat-close');
  const btnChat = document.getElementById('btn-chat');

  // Poll elements
  const pollBanner = document.getElementById('poll-banner');
  const pollModal = document.getElementById('poll-modal');
  const pollQuestionInput = document.getElementById('poll-question-input');
  const pollOptionCount = document.getElementById('poll-option-count');
  const pollModalCancel = document.getElementById('poll-modal-cancel');
  const pollModalStart = document.getElementById('poll-modal-start');
  const btnPoll = document.getElementById('btn-poll');
  const btnEndPoll = document.getElementById('btn-end-poll');

  // Initialize
  init();

  function init() {
    // Theme
    initTheme();

    // Teacher UI
    if (isTeacher) {
      myNickname = 'Teacher';
      if (btnPoll) btnPoll.style.display = '';
    }

    // Restore saved nickname
    const savedName = localStorage.getItem('jls-nickname');
    if (savedName && nameInput) {
      nameInput.value = savedName;
    }

    // Connect WebSocket
    WsClient.connect(handleMessage, handleStatus, null);

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
    btnChat?.addEventListener('click', () => toggleChat(!chatVisible));

    // Poll events (teacher only)
    btnPoll?.addEventListener('click', showNewPollModal);
    btnEndPoll?.addEventListener('click', () => {
      WsClient.send('poll:end', {});
    });
    pollModalCancel?.addEventListener('click', () => {
      pollModal.style.display = 'none';
    });
    pollModalStart?.addEventListener('click', submitNewPoll);
    pollQuestionInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitNewPoll();
    });
  }

  // === Name Flow ===

  function submitName() {
    const name = nameInput.value.trim();
    if (!name) return;
    myNickname = name;
    localStorage.setItem('jls-nickname', name);
    WsClient.send('join:name', { nickname: name });
    nameScreen.style.display = 'none';
    toolbar.style.display = 'flex';
  }

  function showNameScreen() {
    if (isTeacher) {
      // Teacher skips name screen
      WsClient.send('join:name', { nickname: 'Teacher' });
      toolbar.style.display = 'flex';
      return;
    }

    // Reconnection: if student already has nickname, skip name screen
    if (myNickname) {
      WsClient.send('join:name', { nickname: myNickname });
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
        if (documentType === 'notebook') {
          Renderer.showTeacherCursor(msg.data);
        }
        break;

      case 'viewport:sync':
        handleViewportSync(msg.data);
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

      default:
        console.log('Unknown message type:', msg.type);
    }
  }

  function handleJoinResult(data) {
    if (data.success) {
      pinScreen.style.display = 'none';
      needsPin = false;
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
    if (data.index >= 0 && data.index < notebookCells.length) {
      notebookCells[data.index].source = data.source;
      Renderer.updateCellSource(data.index, data.source);
    }
  }

  function handleCellOutput(data) {
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
    if (data.type === 'insert' && data.addedCells) {
      notebookCells.splice(data.index, 0, ...data.addedCells);
    } else if (data.type === 'delete') {
      notebookCells.splice(data.index, data.removedCount || 1);
    }
    Renderer.handleStructureChange(data, notebookCells);
  }

  function handleSessionEnd() {
    WsClient.disconnect();
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
      const autoScroll = document.getElementById('auto-scroll');
      if (autoScroll && autoScroll.checked && typeof data.firstVisibleLine === 'number') {
        Renderer.scrollToLine(data.firstVisibleLine);
      }
    }
  }

  // === Chat ===

  function handleChatBroadcast(data) {
    const msgEl = document.createElement('div');
    msgEl.className = 'chat-msg';

    const header = document.createElement('div');
    header.className = 'chat-msg-header';

    const nick = document.createElement('span');
    nick.className = 'chat-nickname';
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
    if (chatVisible) {
      chatPanel.classList.add('open');
      unreadCount = 0;
      updateChatBadge();
      chatInput.focus();
      chatMessages.scrollTop = chatMessages.scrollHeight;
    } else {
      chatPanel.classList.remove('open');
    }
  }

  function updateChatBadge() {
    if (!btnChat) return;
    // Remove existing badge
    const existing = btnChat.querySelector('.chat-badge');
    if (existing) existing.remove();

    if (unreadCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'chat-badge';
      badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
      btnChat.appendChild(badge);
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
    hasVoted = false;

    // Check localStorage for previous vote on this poll
    const savedVote = localStorage.getItem('jls-poll-' + data.pollId);
    if (savedVote !== null) {
      hasVoted = true;
    }

    // Idempotency: skip if card already exists (e.g. reconnection)
    const existingCard = document.getElementById('poll-card-' + data.pollId);
    if (existingCard) return;

    // Create poll card in chat messages
    const card = document.createElement('div');
    card.className = 'chat-poll-card';
    card.id = 'poll-card-' + data.pollId;

    const questionEl = document.createElement('div');
    questionEl.className = 'chat-poll-question';
    questionEl.textContent = '\u{1F4CA} ' + data.question;
    card.appendChild(questionEl);

    const buttonsEl = document.createElement('div');
    buttonsEl.className = 'chat-poll-buttons';

    for (let i = 0; i < data.optionCount; i++) {
      const btn = document.createElement('button');
      btn.textContent = (i + 1).toString();
      btn.dataset.option = i;
      if (hasVoted) {
        btn.disabled = true;
        if (savedVote !== null && parseInt(savedVote) === i) {
          btn.classList.add('voted');
        }
      } else {
        btn.addEventListener('click', () => votePoll(data.pollId, i));
      }
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
    if (hasVoted || pollId !== currentPollId) return;

    hasVoted = true;
    localStorage.setItem('jls-poll-' + pollId, option.toString());
    WsClient.send('poll:vote', { pollId, option });

    // Disable all buttons and highlight voted one in the poll card
    const card = document.getElementById('poll-card-' + pollId);
    if (card) {
      const buttons = card.querySelectorAll('.chat-poll-buttons button');
      buttons.forEach((btn, i) => {
        btn.disabled = true;
        if (i === option) btn.classList.add('voted');
      });
    }
  }

  function handlePollResults(data) {
    if (data.pollId !== currentPollId) return;
    const card = document.getElementById('poll-card-' + data.pollId);
    if (card) {
      const resultsEl = card.querySelector('.chat-poll-results');
      const statusEl = card.querySelector('.chat-poll-status');
      if (resultsEl) renderPollBars(resultsEl, data.votes, data.totalVoters);
      if (statusEl) statusEl.textContent = `${data.totalVoters}\uBA85 \uD22C\uD45C`;
    }
  }

  function handlePollEnd(data) {
    // Find the poll card (use saved pollId from data, or find the latest card)
    const cardId = data.pollId || currentPollId;
    const card = cardId ? document.getElementById('poll-card-' + cardId) : null;
    currentPollId = null;

    if (card) {
      const resultsEl = card.querySelector('.chat-poll-results');
      const statusEl = card.querySelector('.chat-poll-status');
      if (resultsEl) renderPollBars(resultsEl, data.finalVotes, data.totalVoters);
      if (statusEl) statusEl.textContent = `\uD22C\uD45C \uC885\uB8CC \u2014 \uCD1D ${data.totalVoters}\uBA85`;
      card.classList.add('ended');

      // Disable buttons
      const buttons = card.querySelectorAll('.chat-poll-buttons button');
      buttons.forEach(btn => { btn.disabled = true; });
    }

    // Hide End Poll button
    if (btnEndPoll) btnEndPoll.style.display = 'none';
  }

  function renderPollBars(container, votes, totalVoters) {
    container.innerHTML = '';

    for (let i = 0; i < votes.length; i++) {
      const row = document.createElement('div');
      row.className = 'poll-bar-row';

      const label = document.createElement('span');
      label.className = 'poll-bar-label';
      label.textContent = (i + 1).toString();

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
    pollModal.style.display = 'flex';
    pollQuestionInput.focus();
  }

  function submitNewPoll() {
    const question = pollQuestionInput.value.trim();
    if (!question) {
      pollQuestionInput.focus();
      return;
    }
    const optionCount = parseInt(pollOptionCount.value) || 5;
    const pollId = Date.now().toString();
    WsClient.send('poll:start', { question, optionCount, pollId });
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

})();
