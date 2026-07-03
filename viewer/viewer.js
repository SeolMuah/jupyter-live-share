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

  // Scroll priority: cursor:position이 scroll:sync보다 우선
  let lastCursorScrollTime = 0;
  const CURSOR_SCROLL_PRIORITY_MS = 300;

  // 프리뷰가 에디터를 따라 프로그램적으로 스크롤한 직후, 그 스크롤이 scroll:sync로 재전송(에코)되지 않도록 억제
  let lastProgrammaticScrollTime = 0;
  const PROGRAMMATIC_SCROLL_SUPPRESS_MS = 250;

  // 셀 추가/삭제(cells:structure) 직후 억제창. 셀을 지우면 교사 쪽 선택/뷰포트가 바뀌어
  // 서버가 focus:cell·scroll:sync를 연달아 보내는데, 그 auto-scroll이 handleStructureChange가
  // 이미 보존해 둔 앵커 위치를 덮어써 학생 화면이 맨 위로 튄다(특히 상단 마크다운 셀 삭제 시).
  // 이 창 동안은 파생 focus/scroll의 '스크롤'만 억제한다(활성 셀 하이라이트는 계속 갱신).
  // 창 밖의 '의도적 셀 클릭' 추종은 그대로 동작한다.
  let lastStructureChangeTime = 0;
  const STRUCTURE_SETTLE_MS = 400;

  // 가로 스크롤 프록시 상태 — init()이 로드 직후 실행되며 toggleChat→updateHScrollProxy에서
  // 즉시 참조하므로 반드시 상단에 선언(TDZ 방지). 아래 함수 정의부에서 사용.
  let hScrollProxy = null;
  let hScrollSyncing = false;

  // 교사 브라우저 탭 식별: 확장이 'Open in Browser'로 열 때 URL 프래그먼트(#tt=토큰)로
  // teacherToken을 전달한다. 이 토큰으로 teacherPanel 조인해 학생 수(viewerCount)에
  // 집계되지 않게 한다. 주소창 노출·실수 공유를 막기 위해 URL에서 즉시 제거하고,
  // sessionStorage(탭 전용 — 새로고침은 생존, 링크 복사로는 전파 안 됨)에 보관한다.
  let teacherTabToken = null;
  try {
    const ttMatch = (location.hash || '').match(/[#&]tt=([0-9a-f]+)/);
    if (ttMatch) {
      teacherTabToken = ttMatch[1];
      sessionStorage.setItem('jls-teacher-token', teacherTabToken);
      history.replaceState(null, '', location.pathname + location.search);
    } else {
      teacherTabToken = sessionStorage.getItem('jls-teacher-token');
    }
  } catch (e) { /* sessionStorage/replaceState 불가 환경 무시 — 학생으로 동작 */ }

  // 교사 토큰이 서버에서 거부(4003)된 뒤에는 재접속이 없으므로 상태 문구를 안내로 고정
  let teacherTokenRejected = false;

  // Chat/Poll state
  let myNickname = '';
  let isTeacher = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || !!window.__TEACHER_PREVIEW__ || !!teacherTabToken;
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
  const chatEdgeTab = document.getElementById('chat-edge-tab');
  const chatEdgeBadge = document.getElementById('chat-edge-badge');
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

  // 한글 등 IME 조합 중 Enter는 "글자 확정"이지 제출이 아니다. 조합 확정 Enter와 제출 Enter가
  // keydown을 연달아 발생시켜 채팅이 2번 전송되고, 두 번째가 서버 rate limit(500ms)에 걸려
  // "Too fast. Please wait a moment."가 뜨는 원인이었다. (keyCode 229 = 레거시 IME 신호)
  function isImeComposing(e) {
    return e.isComposing || e.keyCode === 229;
  }

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

    // Connect WebSocket (teacher preview joins as teacherPanel to avoid viewerCount increment).
    // teacherToken proves this is the trusted Teacher Preview webview, not a remote student
    // (source IP alone is unreliable once traffic passes through the Cloudflare tunnel).
    // 교사 브라우저 탭(#tt= 프래그먼트로 열림)도 동일하게 teacherPanel로 조인해 미집계.
    const joinData = isTeacherPreview
      ? { teacherPanel: true, teacherToken: window.__TEACHER_TOKEN__ }
      : (teacherTabToken ? { teacherPanel: true, teacherToken: teacherTabToken } : undefined);
    WsClient.connect(handleMessage, handleStatus, null, joinData);

    // Event listeners
    themeToggle.addEventListener('click', toggleTheme);
    btnDownload?.addEventListener('click', downloadNotebook);

    pinSubmit?.addEventListener('click', submitPin);
    pinInput?.addEventListener('keydown', (e) => {
      if (isImeComposing(e)) return;
      if (e.key === 'Enter') submitPin();
    });

    nameSubmit?.addEventListener('click', submitName);
    nameInput?.addEventListener('keydown', (e) => {
      if (isImeComposing(e)) return;
      if (e.key === 'Enter') submitName();
    });

    // Chat events
    chatSend?.addEventListener('click', sendChatMessage);
    chatInput?.addEventListener('keydown', (e) => {
      if (isImeComposing(e)) return;
      if (e.key === 'Enter') sendChatMessage();
    });
    chatClose?.addEventListener('click', () => toggleChat(false));
    chatCollapse?.addEventListener('click', () => toggleChat(false));
    chatEdgeTab?.addEventListener('click', () => toggleChat(true));
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
      if (isImeComposing(e)) return;
      if (e.key === 'Enter') submitNewPoll();
    });

    // Drawing module initialization
    Drawing.init(isTeacherPreview);

    // When cursor removal restores markup (raw→rendered), cell heights change —
    // redraw all drawing strokes at new positions.
    // Debounce via rAF so layout is fully settled before reading cell positions.
    let layoutRedrawRAF = 0;
    Renderer.onLayoutChange(() => {
      cancelAnimationFrame(layoutRedrawRAF);
      layoutRedrawRAF = requestAnimationFrame(() => Drawing.redrawAll());
    });

    // VS Code Webview: listen for extension messages (e.g., session reconnect)
    if (isVSCodeWebview) {
      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg && msg.type === 'sessionReady') {
          // New session started — reset UI state, re-init Drawing, reconnect WS
          notebookContainer.innerHTML = '';
          connectionStatus.style.display = 'block';
          statusText.textContent = 'Connecting...';
          notebookCells = [];
          currentDocument = null;
          currentPollId = null;

          Drawing.destroy();
          Drawing.init(isTeacherPreview);
          WsClient.reconnect(msg.wsUrl || null);
        }
      });
    }

    // Teacher scroll sync — 선생님 프리뷰에서만 활성
    if (isTeacherPreview) {
      let scrollThrottleTimer = null;
      const SCROLL_THROTTLE_MS = 150;

      let lastScrollEventTime = 0;
      const onScroll = () => {
        // 에디터 추종으로 인한 프로그램적 스크롤이면 학생에게 재전송하지 않음 (에코 방지)
        if (performance.now() - lastProgrammaticScrollTime < PROGRAMMATIC_SCROLL_SUPPRESS_MS) return;

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

    if (documentType === 'notebook') {
      const cells = document.querySelectorAll('#notebook-cells .cell');
      let anchorCell = null;
      let anchorRect = null;
      let anchorIndex = 0;

      // Use getBoundingClientRect for reliable positioning regardless of
      // positioned ancestors (container has position:relative for canvas overlay)
      for (let i = 0; i < cells.length; i++) {
        const rect = cells[i].getBoundingClientRect();
        if (rect.bottom > headerHeight) {
          anchorCell = cells[i];
          anchorRect = rect;
          anchorIndex = i;
          break;
        }
      }
      if (!anchorCell) return null;

      // How far into the cell the visible area top (header bottom) is
      const offsetRatio = Math.max(0, Math.min(1,
        (headerHeight - anchorRect.top) / (anchorRect.height || 1)
      ));
      return { type: 'notebook', cellIndex: anchorIndex, offsetRatio };
    }

    // Plaintext: 첫 번째 가시 소스 라인을 앵커로 사용 (화면 크기 독립적)
    // 하위 호환을 위해 scrollRatio도 함께 포함
    const clamp01 = (x) => Math.min(1, Math.max(0, x));
    const scrollY = getScrollY();
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    const scrollRatio = maxScroll > 0 ? scrollY / maxScroll : 0;

    const contentEl = document.getElementById('document-content');
    if (!contentEl) return maxScroll > 0 ? { type: 'plaintext', scrollRatio } : null;

    // Markdown plaintext: [data-line] 속성 기반 앵커
    const markupEl = contentEl.querySelector('.cell-markup');
    if (markupEl) {
      const lineEls = markupEl.querySelectorAll('[data-line]');
      for (const el of lineEls) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom > headerHeight) {
          const line = parseInt(el.getAttribute('data-line'), 10);
          const offsetRatio = clamp01((headerHeight - rect.top) / (rect.height || 1));
          return { type: 'plaintext', line, offsetRatio, scrollRatio };
        }
      }
      // 앵커 요소를 찾지 못한 경우 비율 fallback
      return { type: 'plaintext', scrollRatio };
    }

    // 코드 plaintext: 균일 라인 높이 기반 앵커 (white-space:pre, no-wrap)
    const code = contentEl.querySelector('pre code');
    if (code) {
      const lineHeight = parseFloat(getComputedStyle(code).lineHeight) || 24;
      const codeTop = code.getBoundingClientRect().top;
      // 문서 최상단(scrollY≈0)에서는 코드 상단이 sticky 헤더 아래에 있어
      // firstVisible가 음수가 될 수 있음 → line/offsetRatio가 어긋나지 않도록 0으로 클램프
      const firstVisible = Math.max(0, (headerHeight - codeTop) / lineHeight);
      const line = Math.floor(firstVisible);
      const offsetRatio = firstVisible - line;
      return { type: 'plaintext', line, offsetRatio, scrollRatio };
    }

    // 콘텐츠 요소가 없는 경우
    return maxScroll > 0 ? { type: 'plaintext', scrollRatio } : null;
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
          // focus:cell fires on deliberate cell click — all viewers (including teacher preview) should follow.
          // 단, 셀 추가/삭제 직후 파생된 focus:cell은 구조 변경의 부수효과이므로 스크롤을 억제한다
          // (handleStructureChange가 이미 앵커로 위치를 보존함). 활성 셀 하이라이트는 그대로 갱신.
          const structureSettling = (Date.now() - lastStructureChangeTime) < STRUCTURE_SETTLE_MS;
          Renderer.setActiveCell(msg.data.cellIndex, structureSettling);
          if (!structureSettling) lastCursorScrollTime = Date.now();  // 셀 클릭 직후 휠 스크롤 동기화보다 우선
        }
        break;

      case 'cursor:position':
        // All viewers (including teacher preview) display cursor identically.
        // Teacher preview auto-scroll fight is prevented by:
        //   1) scroll:sync: 프리뷰는 source:'editor' 태그된 에디터 스크롤만 따라감 (자신의 에코 무시)
        //   2) cursor-priority guard: 커서 클릭 직후 300ms 동안 scroll:sync 무시 (클릭↔스크롤 충돌 방지)
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
      } else if (data.error === 'Invalid teacher token') {
        // 이전 세션의 stale 교사 토큰 — 폐기하고 안내만 표시.
        // (서버가 4003으로 닫아 자동 재접속은 없다. 새 토큰은 'Open in Browser'로 다시 열면 됨)
        try { sessionStorage.removeItem('jls-teacher-token'); } catch (e) { /* 무시 */ }
        teacherTabToken = null;
        teacherTokenRejected = true; // handleStatus('disconnected')가 'Reconnecting...'으로 덮어쓰지 않게
        isTeacher = false;
        if (btnPoll) btnPoll.style.display = 'none'; // 연결 없는 탭에 교사 UI 잔존 방지
        statusText.textContent = '세션이 바뀌었습니다. Open in Browser로 다시 열어주세요.';
        connectionStatus.style.display = 'block';
      } else {
        alert(data.error || 'Failed to join session');
      }
    }
  }

  function handleNotebookFull(data) {
    documentType = 'notebook';
    currentDocument = null;
    notebookCells = data.cells || [];
    // 헤더: 프로젝트 루트 기준 상대경로 표시 (없으면 파일명 폴백)
    const nbPath = data.filePath || data.fileName || 'notebook.ipynb';
    fileName.textContent = nbPath;
    fileName.title = nbPath;
    Renderer.renderNotebook(data, notebookContainer);
    updateHScrollProxy(); // 노트북 모드에서는 프록시 숨김

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
      Drawing.invalidateCellCache(); // cell height may change
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
      Drawing.invalidateCellCache(); // output changes cell height
    }
  }

  function handleDocumentFull(data) {
    documentType = 'plaintext';
    currentDocument = data;
    notebookCells = [];
    // 헤더: 프로젝트 루트 기준 상대경로 표시 (없으면 파일명 폴백)
    const docPath = data.filePath || data.fileName || 'untitled.txt';
    fileName.textContent = docPath;
    fileName.title = docPath;
    Renderer.renderPlaintextDocument(data, notebookContainer);
    updateHScrollProxy();

    // 다운로드 버튼 텍스트 업데이트
    if (btnDownload) {
      btnDownload.textContent = 'Download';
      btnDownload.title = `Download ${data.fileName || 'file'}`;
    }
  }

  // === 가로 스크롤 프록시 ===
  // plaintext 코드가 가로로 넘칠 때, 세로 스크롤 위치와 무관하게 화면 하단에
  // 항상 보이는(고정) 가로 스크롤바를 제공한다 (파일 맨 끝까지 안 내려가도 사용 가능).
  // (상태 변수 hScrollProxy/hScrollSyncing는 파일 상단에 선언 — init()이 로드 직후 참조하므로 TDZ 방지)
  function ensureHScrollProxy() {
    if (hScrollProxy) return hScrollProxy;
    hScrollProxy = document.createElement('div');
    hScrollProxy.id = 'hscroll-proxy';
    hScrollProxy.setAttribute('aria-hidden', 'true');
    const inner = document.createElement('div');
    inner.id = 'hscroll-proxy-inner';
    hScrollProxy.appendChild(inner);
    document.body.appendChild(hScrollProxy);
    // 프록시 스크롤 → 코드 pre로 반영
    hScrollProxy.addEventListener('scroll', () => {
      if (hScrollSyncing) return;
      const pre = document.querySelector('#document-content pre');
      if (!pre) return;
      hScrollSyncing = true;
      pre.scrollLeft = hScrollProxy.scrollLeft;
      hScrollSyncing = false;
    }, { passive: true });
    // 창 크기 변경 시 위치/크기 갱신
    window.addEventListener('resize', () => updateHScrollProxy(), { passive: true });
    return hScrollProxy;
  }

  function updateHScrollProxy() {
    const proxy = ensureHScrollProxy();
    // 마크다운 문서는 문서 전체 pre가 없고 코드블록만 개별 pre → 프록시 미적용(코드블록 자체 스크롤바 사용)
    const isMarkdownDoc = currentDocument && currentDocument.languageId === 'markdown';
    const pre = (documentType === 'plaintext' && !isMarkdownDoc)
      ? document.querySelector('#document-content pre')
      : null;
    // plaintext가 아니거나 가로 넘침이 없으면 숨김
    if (!pre || pre.scrollWidth <= pre.clientWidth + 1) {
      proxy.style.display = 'none';
      return;
    }
    const rect = pre.getBoundingClientRect();
    proxy.style.left = Math.max(0, rect.left) + 'px';
    proxy.style.width = rect.width + 'px';
    hScrollProxy.firstChild.style.width = pre.scrollWidth + 'px';
    proxy.style.display = 'block';
    proxy.scrollLeft = pre.scrollLeft;

    // 코드 pre 스크롤 → 프록시로 반영 (한 번만 바인딩)
    if (!pre.__hscrollBound) {
      pre.__hscrollBound = true;
      pre.addEventListener('scroll', () => {
        if (hScrollSyncing) return;
        hScrollSyncing = true;
        proxy.scrollLeft = pre.scrollLeft;
        hScrollSyncing = false;
      }, { passive: true });
    }
  }

  function handleDocumentUpdate(data) {
    if (documentType !== 'plaintext') return;
    if (currentDocument) {
      currentDocument.content = data.content;
    }
    Renderer.updateDocumentContent(data.content);
    updateHScrollProxy(); // 내용 변경으로 코드 폭이 바뀔 수 있음
  }

  function handleCellsStructure(data) {
    if (documentType !== 'notebook') return;
    if (data.type === 'insert' && data.addedCells) {
      notebookCells.splice(data.index, 0, ...data.addedCells);
    } else if (data.type === 'delete') {
      notebookCells.splice(data.index, data.removedCount || 1);
    }
    Renderer.handleStructureChange(data, notebookCells);
    // 이 시점 이후 짧게, 삭제/삽입이 유발하는 파생 focus:cell·scroll:sync의 auto-scroll을 억제해
    // handleStructureChange가 보존한 앵커 위치가 덮어써지지(맨 위로 튐) 않도록 한다.
    lastStructureChangeTime = Date.now();
    Drawing.invalidateCellCache(); // cells added/removed changes all positions
  }

  function handleSessionEnd() {
    WsClient.disconnect();
    Drawing.destroy();
    // 헤더의 접속자 수를 리셋한다 — 리셋하지 않으면 죽은 화면에 '이전 세션의 마지막
    // 카운트'가 동결 표시되어, 새 세션의 실제 수(사이드바)와 어긋나 보이는 혼란을 만든다.
    if (viewerCount) viewerCount.textContent = '0명 접속';
    notebookContainer.innerHTML = '';
    if (hScrollProxy) hScrollProxy.style.display = 'none'; // 세션 종료 시 가로 스크롤 프록시 명시적 숨김
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

  // === Scroll Sync (선생님→학생 스크롤 동기화) ===

  function handleScrollSync(data) {
    // Teacher Preview: 실제 에디터 스크롤(source:'editor')은 따라가되, 자신이 보낸 에코(source 없음)는 무시
    if (isTeacherPreview && data.source !== 'editor') return;

    // Auto-scroll 체크
    const autoScroll = document.getElementById('auto-scroll');
    if (!autoScroll || !autoScroll.checked) return;

    // 커서 스크롤 우선 (300ms 이내 cursor:position이 있었으면 무시)
    if (Date.now() - lastCursorScrollTime < CURSOR_SCROLL_PRIORITY_MS) return;

    // 구조 변경 직후 파생된 scroll:sync(뷰포트 변동)도 억제 — 앵커 보존을 덮어써 튐 유발.
    if (Date.now() - lastStructureChangeTime < STRUCTURE_SETTLE_MS) return;

    if (data.type === 'notebook' && documentType === 'notebook') {
      const scrolled = Renderer.scrollToNotebookAnchor(data.cellIndex, data.offsetRatio);
      // 프리뷰 에코 억제: 실제로 스크롤한 경우에만 억제창을 켠다. 튐 제거로 스크롤을 생략했는데
      // 억제하면, 직후 교사의 진짜 수동 스크롤이 억제창(250ms)에 먹혀 동기화를 놓친다.
      if (isTeacherPreview && scrolled) lastProgrammaticScrollTime = performance.now();
    } else if (data.type === 'plaintext' && documentType === 'plaintext') {
      // 프리뷰가 에디터를 따라 스크롤하기 직전 타임스탬프 기록 → onScroll 재전송 억제
      if (isTeacherPreview) lastProgrammaticScrollTime = performance.now();
      // 새 라인 앵커 방식 우선, 없으면 비율 fallback
      if (typeof data.line === 'number') {
        Renderer.scrollToDocumentAnchor(data.line, typeof data.offsetRatio === 'number' ? data.offsetRatio : 0);
      } else {
        Renderer.scrollToRatio(data.scrollRatio);
      }
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
      } else {
        chatPanel.classList.add('collapsed');
        if (appLayout) appLayout.classList.remove('chat-open');
        if (chatResizeHandle) chatResizeHandle.classList.remove('visible');
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

    // 채팅 열림/닫힘으로 코드 영역 폭이 바뀜 → 가로 스크롤 프록시 재정렬
    // (레이아웃 트랜지션 0.25s 후에도 한 번 더 갱신)
    updateHScrollProxy();
    setTimeout(updateHScrollProxy, 280);
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

    // Edge tab badge
    if (chatEdgeBadge) {
      if (unreadCount > 0) {
        chatEdgeBadge.textContent = unreadCount > 99 ? '99+' : unreadCount;
        chatEdgeBadge.style.display = '';
      } else {
        chatEdgeBadge.style.display = 'none';
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

    // Show End Poll button for teacher (toolbar에 표시, VS Code webview 포함)
    if (isTeacher && btnEndPoll) {
      btnEndPoll.style.display = '';
    }

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

    // Hide End Poll button (toolbar, VS Code webview 포함)
    if (btnEndPoll) btnEndPoll.style.display = 'none';

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
    pollOptionCount.value = '2';
    if (pollModeSelect) pollModeSelect.value = 'number';
    if (pollNumberMode) pollNumberMode.style.display = '';
    if (pollTextMode) pollTextMode.style.display = 'none';
    if (pollTextOptions) pollTextOptions.value = '';
    pollModal.style.display = 'flex';
    pollQuestionInput.focus();
  }

  function submitNewPoll() {
    const question = pollQuestionInput.value.trim();
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
      const optionCount = parseInt(pollOptionCount.value) || 2;
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
        // 교사 토큰 거부(4003)로 닫힌 경우엔 재접속하지 않으므로 'Reconnecting...'이
        // 아닌 안내 문구를 유지한다 (join:result 핸들러가 이미 표시).
        if (!teacherTokenRejected) statusText.textContent = 'Disconnected. Reconnecting...';
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

    // Mermaid 다이어그램도 테마에 맞게 재렌더링
    if (window.Renderer && Renderer.reRenderMermaid) Renderer.reRenderMermaid();
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
    } else if (!isMobile) {
      const tabW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--chat-tab-width')) || 32;
      drawToolsPanel.style.right = (tabW + 12) + 'px';
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
        } else {
          chatPanel.classList.add('collapsed');
          if (appLayout) appLayout.classList.remove('chat-open');
        }
      }
    }
    updateDrawToolsPosition();
  }

})();
