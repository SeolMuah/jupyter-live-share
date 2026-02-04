/* viewer.js - Main viewer application */

(function () {
  'use strict';

  // State
  let notebookCells = [];
  let needsPin = false;
  let documentType = 'notebook'; // 'notebook' | 'plaintext'
  let currentDocument = null;

  // DOM elements
  const pinScreen = document.getElementById('pin-screen');
  const pinInput = document.getElementById('pin-input');
  const pinSubmit = document.getElementById('pin-submit');
  const pinError = document.getElementById('pin-error');
  const connectionStatus = document.getElementById('connection-status');
  const statusText = document.getElementById('status-text');
  const fileName = document.getElementById('file-name');
  const viewerCount = document.getElementById('viewer-count');
  const notebookContainer = document.getElementById('notebook-cells');
  const toolbar = document.getElementById('toolbar');
  const themeToggle = document.getElementById('theme-toggle');
  const btnDownload = document.getElementById('btn-download');

  // Initialize
  init();

  function init() {
    // Theme
    initTheme();

    // Connect WebSocket
    WsClient.connect(handleMessage, handleStatus, null);

    // Event listeners
    themeToggle.addEventListener('click', toggleTheme);
    btnDownload?.addEventListener('click', downloadNotebook);

    pinSubmit?.addEventListener('click', submitPin);
    pinInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitPin();
    });
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

      case 'viewers:count':
        viewerCount.textContent = `${msg.data.count}명 접속`;
        break;

      case 'session:end':
        handleSessionEnd();
        break;

      default:
        console.log('Unknown message type:', msg.type);
    }
  }

  function handleJoinResult(data) {
    if (data.success) {
      pinScreen.style.display = 'none';
      toolbar.style.display = 'flex';
      needsPin = false;
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
    toolbar.style.display = 'flex';

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
    toolbar.style.display = 'flex';

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
    // For simplicity, request full notebook on structure change
    // The server will send notebook:full via the watcher
    // But we also handle it locally for immediate feedback
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
