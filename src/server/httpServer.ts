import express from 'express';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { execSync } from 'child_process';
import { Logger } from '../utils/logger';
import { getWatchMode, getCurrentFileUri, getCurrentFileName, getCurrentContent } from '../notebook/watcher';
import { startPoll, endPoll } from './wsServer';

let server: http.Server | null = null;
let app: express.Express | null = null;
const activeConnections = new Set<net.Socket>();

export function getApp(): express.Express | null {
  return app;
}

export function getServer(): http.Server | null {
  return server;
}

/**
 * 포트를 점유 중인 프로세스를 강제 종료한다 (이전 비정상 종료 복구용)
 */
function killProcessOnPort(port: number): boolean {
  try {
    if (process.platform === 'win32') {
      // netstat으로 포트 사용 중인 PID 찾기
      const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const lines = output.trim().split('\n');
      const pids = new Set<string>();
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== '0') {
          pids.add(pid);
        }
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /F /T`, { timeout: 5000 });
          Logger.info(`Killed process ${pid} occupying port ${port}`);
        } catch {
          // PID가 이미 종료된 경우 무시
        }
      }
      return pids.size > 0;
    } else {
      // Linux/macOS: lsof로 포트 사용 중인 PID 찾기
      const output = execSync(`lsof -ti :${port}`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const pids = output.trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        try {
          execSync(`kill -9 ${pid}`, { timeout: 5000 });
          Logger.info(`Killed process ${pid} occupying port ${port}`);
        } catch {
          // PID가 이미 종료된 경우 무시
        }
      }
      return pids.length > 0;
    }
  } catch {
    // 포트를 사용 중인 프로세스가 없는 경우 (정상)
    return false;
  }
}

export function startHttpServer(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    app = express();

    // 정적 파일 서빙 (브라우저 뷰어) — 캐시 완전 비활성화
    // 학생 브라우저가 구버전 JS/CSS를 캐시하면 실시간 동기화 버그 발생
    const viewerPath = path.join(__dirname, 'viewer');
    app.use(express.static(viewerPath, {
      etag: false,
      lastModified: false,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      },
    }));

    app.use(express.json());

    // Localhost-only middleware for API routes
    const requireLocalhost: express.RequestHandler = (req, res, next) => {
      const addr = req.socket.remoteAddress;
      if (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') {
        next();
      } else {
        res.status(403).json({ error: 'Forbidden' });
      }
    };

    // Health check
    app.get('/health', (_req, res) => {
      res.json({
        status: 'ok',
        uptime: process.uptime(),
      });
    });

    // 파일 다운로드 (메모리 기반 - 저장하지 않은 수정사항도 포함)
    app.get('/download', (_req, res) => {
      const fileName = getCurrentFileName();
      if (!fileName) {
        res.status(404).json({ error: 'No file is currently being shared' });
        return;
      }

      const current = getCurrentContent();
      if (!current) {
        res.status(404).json({ error: 'No content available' });
        return;
      }

      const contentType = current.mode === 'notebook'
        ? 'application/json'
        : 'text/plain';

      res.setHeader('Content-Type', `${contentType}; charset=utf-8`);
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      res.send(current.content);
    });

    // Poll API (VS Code에서 사용)
    app.post('/api/poll/start', requireLocalhost, (req, res) => {
      const { question, optionCount, options } = req.body;
      if (!question || typeof question !== 'string') {
        res.status(400).json({ error: 'question is required' });
        return;
      }
      const count = Math.min(Math.max(Number(optionCount) || 2, 2), 10);
      const pollId = Date.now().toString();
      const sanitizedOptions = Array.isArray(options)
        ? options.map((o: unknown) => String(o || '').trim().slice(0, 100))
        : undefined;
      startPoll(question.trim(), count, pollId, sanitizedOptions);
      res.json({ success: true, pollId });
    });

    app.post('/api/poll/end', requireLocalhost, (_req, res) => {
      const result = endPoll();
      if (!result) {
        res.status(404).json({ error: 'No active poll' });
        return;
      }
      res.json({ success: true, ...result });
    });

    // 뷰어 진입점
    app.get('/', (_req, res) => {
      res.sendFile(path.join(viewerPath, 'index.html'));
    });

    server = http.createServer(app);

    // 활성 연결 추적 (강제 종료 시 즉시 정리 가능하도록)
    server.on('connection', (socket: net.Socket) => {
      activeConnections.add(socket);
      socket.on('close', () => {
        activeConnections.delete(socket);
      });
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        Logger.warn(`Port ${port} is already in use. Attempting to reclaim...`);

        // 이전 비정상 종료로 포트가 점유된 경우 강제 해제 후 재시도
        const killed = killProcessOnPort(port);
        if (killed) {
          // 프로세스 종료 후 OS가 포트를 해제할 시간을 줌
          setTimeout(() => {
            server = http.createServer(app!);
            server.on('connection', (socket: net.Socket) => {
              activeConnections.add(socket);
              socket.on('close', () => {
                activeConnections.delete(socket);
              });
            });
            server.on('error', (_retryErr: NodeJS.ErrnoException) => {
              Logger.error(`Port ${port} still in use after kill attempt`);
              reject(new Error(
                `Port ${port} is still in use. Please close the application using it or change the port in settings (jupyterLiveShare.port).`
              ));
            });
            server.listen(port, () => {
              Logger.info(`HTTP server started on port ${port} (after reclaim)`);
              resolve(server!);
            });
          }, 1000);
        } else {
          reject(new Error(
            `Port ${port} is already in use. Change the port in settings (jupyterLiveShare.port).`
          ));
        }
      } else {
        Logger.error('HTTP server error', err);
        reject(err);
      }
    });

    server.listen(port, () => {
      Logger.info(`HTTP server started on port ${port}`);
      resolve(server!);
    });
  });
}

export function stopHttpServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }

    const SHUTDOWN_TIMEOUT = 3000;

    // 타임아웃: 정상 종료가 안 되면 강제로 끝냄
    const forceShutdown = setTimeout(() => {
      Logger.warn('HTTP server graceful shutdown timed out, destroying connections');
      destroyAllConnections();
      server = null;
      app = null;
      resolve();
    }, SHUTDOWN_TIMEOUT);

    // 먼저 새 연결 수락 중지
    server.close(() => {
      clearTimeout(forceShutdown);
      Logger.info('HTTP server stopped');
      activeConnections.clear();
      server = null;
      app = null;
      resolve();
    });

    // 기존 활성 연결 즉시 종료 (빠른 shutdown을 위해)
    destroyAllConnections();
  });
}

/**
 * 동기적으로 서버를 강제 종료한다 (프로세스 exit 핸들러용)
 */
export function forceStopHttpServer(): void {
  destroyAllConnections();
  if (server) {
    try {
      server.close();
    } catch {
      // 이미 닫힌 경우 무시
    }
    server = null;
    app = null;
  }
  Logger.info('HTTP server force-stopped');
}

function destroyAllConnections(): void {
  for (const socket of activeConnections) {
    try {
      socket.destroy();
    } catch {
      // 이미 닫힌 소켓 무시
    }
  }
  activeConnections.clear();
}
