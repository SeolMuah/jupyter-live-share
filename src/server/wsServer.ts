import * as http from 'http';
import WebSocket from 'ws';
import { Logger } from '../utils/logger';

export interface WsMessage {
  type: string;
  data: unknown;
}

let wss: WebSocket.Server | null = null;
let viewerCount = 0;
let onViewerCountChange: ((count: number) => void) | null = null;
let sessionPin: string | null = null;

export function setSessionPin(pin: string | null) {
  sessionPin = pin;
}

export function setOnViewerCountChange(callback: (count: number) => void) {
  onViewerCountChange = callback;
}

export function getViewerCount(): number {
  return viewerCount;
}

export function startWsServer(
  httpServer: http.Server,
  maxViewers: number
): WebSocket.Server {
  wss = new WebSocket.Server({ server: httpServer });

  wss.on('connection', (ws) => {
    let authenticated = !sessionPin; // PIN 없으면 바로 인증

    ws.on('message', (raw) => {
      try {
        const msg: WsMessage = JSON.parse(raw.toString());

        if (msg.type === 'join') {
          const joinData = msg.data as { pin?: string };

          // PIN 검증
          if (sessionPin && joinData.pin !== sessionPin) {
            sendTo(ws, 'join:result', { success: false, error: 'Invalid PIN' });
            ws.close(4001, 'Invalid PIN');
            return;
          }

          // 최대 접속자 확인
          if (viewerCount >= maxViewers) {
            sendTo(ws, 'join:result', { success: false, error: 'Session is full' });
            ws.close(4002, 'Session full');
            return;
          }

          authenticated = true;
          viewerCount++;
          Logger.info(`Viewer connected (total: ${viewerCount})`);

          sendTo(ws, 'join:result', { success: true });
          broadcast('viewers:count', { count: viewerCount });
          onViewerCountChange?.(viewerCount);

          // 현재 노트북 상태 전송은 watcher에서 처리
          if (onNewViewer) {
            onNewViewer(ws);
          }
        }
      } catch (err) {
        Logger.error('WebSocket message parse error', err);
      }
    });

    ws.on('close', () => {
      if (authenticated) {
        viewerCount = Math.max(0, viewerCount - 1);
        Logger.info(`Viewer disconnected (total: ${viewerCount})`);
        broadcast('viewers:count', { count: viewerCount });
        onViewerCountChange?.(viewerCount);
      }
    });

    ws.on('error', (err) => {
      Logger.error('WebSocket client error', err);
    });

    // PIN 없으면 자동 인증 메시지 불필요
    // 클라이언트가 join 이벤트를 보내야 함
  });

  Logger.info('WebSocket server started');
  return wss;
}

let onNewViewer: ((ws: WebSocket) => void) | null = null;

export function setOnNewViewer(callback: (ws: WebSocket) => void) {
  onNewViewer = callback;
}

export function broadcast(type: string, data: unknown) {
  if (!wss) return;

  const message = JSON.stringify({ type, data });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

export function sendTo(ws: WebSocket, type: string, data: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

export function stopWsServer(): Promise<void> {
  return new Promise((resolve) => {
    viewerCount = 0;
    sessionPin = null;

    if (wss) {
      // 모든 클라이언트에게 세션 종료 알림
      broadcast('session:end', {});

      wss.close(() => {
        Logger.info('WebSocket server stopped');
        wss = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}
