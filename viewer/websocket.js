/* websocket.js - WebSocket client with auto-reconnect */

const WsClient = (() => {
  let ws = null;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let messageHandler = null;
  let statusHandler = null;
  let pin = null;

  const MAX_RECONNECT_DELAY = 30000; // 30s max

  function getWsUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}`;
  }

  function connect(onMessage, onStatus, sessionPin) {
    messageHandler = onMessage;
    statusHandler = onStatus;
    pin = sessionPin;

    _doConnect();
  }

  function _doConnect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const url = getWsUrl();
    statusHandler?.('connecting');

    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.error('WebSocket creation error:', err);
      _scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      console.log('WebSocket connected');
      reconnectAttempt = 0;
      statusHandler?.('connected');

      // Send join event
      ws.send(JSON.stringify({
        type: 'join',
        data: { pin: pin || undefined }
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        messageHandler?.(msg);
      } catch (err) {
        console.error('Message parse error:', err);
      }
    };

    ws.onclose = (event) => {
      console.log('WebSocket closed:', event.code, event.reason);
      statusHandler?.('disconnected');

      // Don't reconnect on: normal close, auth failure, session full
      if (event.code === 1000 || event.code === 4001 || event.code === 4002) return;

      _scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }

  function _scheduleReconnect() {
    if (reconnectTimer) return;

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (max)
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), MAX_RECONNECT_DELAY);
    reconnectAttempt++;

    console.log(`Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempt})...`);
    statusHandler?.('reconnecting');

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      _doConnect();
    }, delay);
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (ws) {
      ws.onclose = null; // Prevent reconnect
      ws.close();
      ws = null;
    }
  }

  function isConnected() {
    return ws && ws.readyState === WebSocket.OPEN;
  }

  return {
    connect,
    disconnect,
    isConnected,
  };
})();
