import express from 'express';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { Logger } from '../utils/logger';
import { getWatchMode, getCurrentFileUri, getCurrentFileName, getCurrentContent } from '../notebook/watcher';
import { startPoll, endPoll, getTeacherToken } from './wsServer';

let server: http.Server | null = null;
let app: express.Express | null = null;
const activeConnections = new Set<net.Socket>();

/**
 * 포트를 점유 중인 프로세스를 강제 종료한다 (이전 비정상 종료 복구용)
 */
function killProcessOnPort(port: number): boolean {
  // 포트 값을 셸 명령에 문자열 보간하므로, 신뢰 가능한 정수인지 먼저 검증한다.
  // VS Code 설정(get<number>)은 런타임 타입을 강제하지 않아 악성 워크스페이스가
  // 문자열("48632; <명령>")을 주입할 수 있으므로 명령 주입을 원천 차단한다.
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    Logger.error(`killProcessOnPort: invalid port ${String(port)}`);
    return false;
  }
  // execSync에 넘길 PID도 순수 숫자만 허용한다 (심층 방어).
  const isPid = (s: string): boolean => /^\d+$/.test(s);
  try {
    if (process.platform === 'win32') {
      // netstat으로 포트 사용 중인 PID 찾기
      const output = execSync(`netstat -ano | findstr :${p} | findstr LISTENING`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const lines = output.trim().split('\n');
      const pids = new Set<string>();
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== '0' && isPid(pid)) {
          pids.add(pid);
        }
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /F /T`, { timeout: 5000 });
          Logger.info(`Killed process ${pid} occupying port ${p}`);
        } catch {
          // PID가 이미 종료된 경우 무시
        }
      }
      return pids.size > 0;
    } else {
      // Linux/macOS: lsof로 포트 사용 중인 PID 찾기
      const output = execSync(`lsof -ti :${p}`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const pids = output.trim().split('\n').filter((s) => isPid(s));
      for (const pid of pids) {
        try {
          execSync(`kill -9 ${pid}`, { timeout: 5000 });
          Logger.info(`Killed process ${pid} occupying port ${p}`);
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

/**
 * @param bindAddress listen 인터페이스. 기본 127.0.0.1(루프백) — cloudflared가 localhost로
 *        접속하므로 터널 공유에 손실이 없고, 터널 실패 폴백 시 LAN 노출도 차단된다.
 * @param onPortConflict 포트 점유 시 점유 프로세스를 종료해도 되는지 사용자 확인 콜백.
 *        미제공/거부 시 임의 프로세스를 죽이지 않고 에러로 종료한다.
 */
export function startHttpServer(
  port: number,
  bindAddress = '127.0.0.1',
  onPortConflict?: (port: number) => Promise<boolean>
): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    app = express();

    // 보안 응답 헤더 (모든 응답에 적용) — CSP는 index.html <meta>에서 관리하므로 여기서 설정하지 않는다
    app.use((_req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      next();
    });

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

    // 교사 토큰 검증 미들웨어 — /api/poll/* 는 requireLocalhost만으로는 안전하지 않다
    // (Cloudflare 터널을 거치면 원격 학생의 요청도 remoteAddress가 127.0.0.1로 보임).
    // constant-time 비교로 토큰을 검증해 실제 교사(확장 프로세스)만 호출을 허용한다.
    const requireTeacherToken: express.RequestHandler = (req, res, next) => {
      const token = getTeacherToken();
      const provided = req.header('x-teacher-token');
      if (!token || typeof provided !== 'string' || !provided) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const a = Buffer.from(provided);
      const b = Buffer.from(token);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      next();
    };

    // Health check
    app.get('/health', (_req, res) => {
      res.json({ status: 'ok' });
    });

    // 파일 다운로드 (메모리 기반 - 저장하지 않은 수정사항도 포함)
    app.get('/download', (_req, res) => {
      const fileName = getCurrentFileName();
      if (!fileName) {
        res.status(404).json({ error: 'No file is currently being shared' });
        return;
      }

      // 이미지 모드: 학생 화면엔 최적화본이 보이지만 다운로드는 '원본 파일'을 제공
      if (getWatchMode() === 'image') {
        const uri = getCurrentFileUri();
        if (uri) {
          try {
            const buf = fs.readFileSync(uri.fsPath);
            const ext = path.extname(uri.fsPath).toLowerCase();
            const mimeMap: Record<string, string> = {
              '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
              '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
            };
            res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
            res.send(buf);
            return;
          } catch {
            res.status(404).json({ error: 'Image file not readable' });
            return;
          }
        }
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
    app.post('/api/poll/start', requireLocalhost, requireTeacherToken, (req, res) => {
      const { question, optionCount, options } = req.body;
      const q = typeof question === 'string' ? question.trim() : '';
      const count = Math.min(Math.max(Number(optionCount) || 2, 2), 10);
      const pollId = Date.now().toString();
      const sanitizedOptions = Array.isArray(options)
        ? options.map((o: unknown) => String(o || '').trim().slice(0, 100))
        : undefined;
      startPoll(q, count, pollId, sanitizedOptions);
      res.json({ success: true, pollId });
    });

    app.post('/api/poll/end', requireLocalhost, requireTeacherToken, (_req, res) => {
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
      // 터널 뒤 학생 연결은 갑자기 끊기며(ECONNRESET/EPIPE) raw 소켓 error를 낸다.
      // 리스너가 없으면 프로세스 uncaughtException으로 번질 수 있으므로 명시적으로 흡수한다.
      socket.on('error', () => { /* 원격 급단절 흡수 */ });
      socket.on('close', () => {
        activeConnections.delete(socket);
      });
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        Logger.warn(`Port ${port} is already in use.`);

        // 점유 프로세스 종료는 사용자 확인을 받은 경우에만 수행한다
        // (확인 없는 kill -9/taskkill은 무관한 프로세스를 죽일 수 있음).
        void (async () => {
          const approved = onPortConflict ? await onPortConflict(port) : false;
          if (!approved) {
            reject(new Error(
              `Port ${port} is already in use. Close the application using it or change the port in settings (codeClassLive.port).`
            ));
            return;
          }
          const killed = killProcessOnPort(port);
          if (!killed) {
            reject(new Error(
              `Port ${port} is already in use and could not be reclaimed. Change the port in settings (codeClassLive.port).`
            ));
            return;
          }
          // 프로세스 종료 후 OS가 포트를 해제할 시간을 줌
          setTimeout(() => {
            server = http.createServer(app!);
            server.on('connection', (socket: net.Socket) => {
              activeConnections.add(socket);
              socket.on('error', () => { /* 원격 급단절 흡수 */ });
              socket.on('close', () => {
                activeConnections.delete(socket);
              });
            });
            server.on('error', (_retryErr: NodeJS.ErrnoException) => {
              Logger.error(`Port ${port} still in use after kill attempt`);
              reject(new Error(
                `Port ${port} is still in use. Please close the application using it or change the port in settings (codeClassLive.port).`
              ));
            });
            server.listen(port, bindAddress, () => {
              Logger.info(`HTTP server started on ${bindAddress}:${port} (after reclaim)`);
              resolve(server!);
            });
          }, 1000);
        })();
      } else {
        Logger.error('HTTP server error', err);
        reject(err);
      }
    });

    server.listen(port, bindAddress, () => {
      Logger.info(`HTTP server started on ${bindAddress}:${port}`);
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
