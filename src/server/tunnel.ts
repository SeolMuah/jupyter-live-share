import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import { Logger } from '../utils/logger';

const CLOUDFLARED_URLS: Record<string, string> = {
  'win32-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  'darwin-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz',
  'darwin-arm64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz',
  'linux-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
};

export class TunnelManager {
  private process: ChildProcess | null = null;
  private tunnelUrl: string | null = null;
  private binDir: string;

  constructor(extensionPath: string) {
    this.binDir = path.join(extensionPath, 'bin');
  }

  get url(): string | null {
    return this.tunnelUrl;
  }

  async start(port: number): Promise<string> {
    const cloudflaredPath = await this.ensureBinary();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.stop();
        reject(new Error('Tunnel creation timed out (30s). Check your internet connection.'));
      }, 30000);

      this.process = spawn(cloudflaredPath, [
        'tunnel', '--url', `http://localhost:${port}`,
        '--no-autoupdate',
      ]);

      this.process.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        Logger.info(`[cloudflared] ${text.trim()}`);

        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) {
          clearTimeout(timeout);
          this.tunnelUrl = match[0];
          Logger.info(`Tunnel URL: ${this.tunnelUrl}`);
          resolve(this.tunnelUrl);
        }
      });

      this.process.stdout?.on('data', (data: Buffer) => {
        Logger.info(`[cloudflared] ${data.toString().trim()}`);
      });

      this.process.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          clearTimeout(timeout);
          Logger.error(`cloudflared exited with code ${code}`);
          reject(new Error(`cloudflared exited with code ${code}`));
        }
      });

      this.process.on('error', (err) => {
        clearTimeout(timeout);
        Logger.error('cloudflared process error', err);
        reject(err);
      });
    });
  }

  stop() {
    if (this.process) {
      // Windows에서는 프로세스 트리 전체 종료 필요
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(this.process.pid), '/f', '/t']);
      } else {
        this.process.kill('SIGTERM');
      }
      this.process = null;
      this.tunnelUrl = null;
      Logger.info('Tunnel stopped');
    }
  }

  private async ensureBinary(): Promise<string> {
    const platform = process.platform;
    const arch = process.arch;
    const key = `${platform}-${arch}`;
    const binName = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const binPath = path.join(this.binDir, binName);

    if (fs.existsSync(binPath)) {
      return binPath;
    }

    const downloadUrl = CLOUDFLARED_URLS[key];
    if (!downloadUrl) {
      throw new Error(`Unsupported platform: ${key}. Please install cloudflared manually.`);
    }

    Logger.info(`Downloading cloudflared for ${key}...`);

    if (!fs.existsSync(this.binDir)) {
      fs.mkdirSync(this.binDir, { recursive: true });
    }

    await this.downloadFile(downloadUrl, binPath);

    // Linux/macOS: 실행 권한 부여
    if (platform !== 'win32') {
      fs.chmodSync(binPath, 0o755);
    }

    Logger.info('cloudflared downloaded successfully');
    return binPath;
  }

  private downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const follow = (currentUrl: string) => {
        https.get(currentUrl, (response) => {
          // 리다이렉트 처리
          if (response.statusCode === 301 || response.statusCode === 302) {
            const location = response.headers.location;
            if (location) {
              follow(location);
              return;
            }
          }

          if (response.statusCode !== 200) {
            reject(new Error(`Download failed with status ${response.statusCode}`));
            return;
          }

          const file = fs.createWriteStream(dest);
          response.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve();
          });
          file.on('error', (err) => {
            fs.unlinkSync(dest);
            reject(err);
          });
        }).on('error', reject);
      };

      follow(url);
    });
  }
}
