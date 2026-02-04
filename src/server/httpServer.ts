import express from 'express';
import * as http from 'http';
import * as path from 'path';
import { Logger } from '../utils/logger';
import { getWatchMode, getCurrentFileUri, getCurrentFileName, getCurrentContent } from '../notebook/watcher';

let server: http.Server | null = null;
let app: express.Express | null = null;

export function getApp(): express.Express | null {
  return app;
}

export function getServer(): http.Server | null {
  return server;
}

export function startHttpServer(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    app = express();

    // 정적 파일 서빙 (브라우저 뷰어)
    const viewerPath = path.join(__dirname, 'viewer');
    app.use(express.static(viewerPath));

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

    // 뷰어 진입점
    app.get('/', (_req, res) => {
      res.sendFile(path.join(viewerPath, 'index.html'));
    });

    server = http.createServer(app);

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        Logger.error(`Port ${port} is already in use`);
        reject(new Error(`Port ${port} is already in use. Change the port in settings.`));
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
    if (server) {
      server.close(() => {
        Logger.info('HTTP server stopped');
        server = null;
        app = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}
