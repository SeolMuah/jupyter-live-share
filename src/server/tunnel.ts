import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as zlib from 'zlib';
import { Logger } from '../utils/logger';

// Bundled binaries included in the extension package
const BUNDLED_BINARIES: Record<string, string> = {
  'win32-x64': 'cloudflared.exe',
  'darwin-x64': 'cloudflared-darwin-x64',
  'darwin-arm64': 'cloudflared-darwin-arm64',
};

// Fallback download URLs if bundled binary is missing
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
  // 세션 내 확정된 cloudflared 경로. start()의 재시도 루프가 버전검사/다운로드를 반복하지 않도록 캐싱.
  private resolvedBinary: string | null = null;

  constructor(extensionPath: string) {
    this.binDir = path.join(extensionPath, 'bin');
  }

  get url(): string | null {
    return this.tunnelUrl;
  }

  private static readonly MAX_RETRIES = 2;
  private static readonly RETRY_DELAY_MS = 2000;
  // Cloudflare가 서버측에서 오래된 cloudflared의 quick-tunnel 생성을 거부한다("invalid UUID length: 0").
  // 이 값은 quick-tunnel 성공이 실증된 최소 버전. cloudflared는 날짜형(YYYY.M.P)이라 숫자 비교가 성립한다.
  // [하드코딩 리스크] Cloudflare가 하한을 다시 올리면 이 값을 올려야 하지만, 게이트가 트리거되면 항상
  // releases/latest를 받으므로 '알려진 정상값 이상'이기만 하면 노후 바이너리는 최신으로 자가치유된다.
  private static readonly MIN_VERSION = '2026.6.1';

  async start(port: number, onProgress?: (message: string) => void): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= TunnelManager.MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const msg = `Tunnel retry (${attempt}/${TunnelManager.MAX_RETRIES})...`;
          Logger.info(msg);
          onProgress?.(msg);
          this.stop();
          await new Promise(r => setTimeout(r, TunnelManager.RETRY_DELAY_MS));
        }

        const url = await this.startOnce(port);

        if (this.isValidTunnelUrl(url)) {
          return url;
        }

        Logger.warn(`Invalid tunnel URL received: "${url}", retrying...`);
        lastError = new Error(`Invalid tunnel URL: ${url}`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        Logger.warn(`Tunnel attempt ${attempt + 1} failed: ${lastError.message}`);
      }
    }

    this.stop();
    throw lastError || new Error('Tunnel creation failed after retries');
  }

  private isValidTunnelUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && parsed.hostname.endsWith('.trycloudflare.com');
    } catch {
      return false;
    }
  }

  private async startOnce(port: number): Promise<string> {
    const cloudflaredPath = await this.ensureBinary();
    return new Promise((resolve, reject) => {
      let settled = false;

      // Event handlers (stored for cleanup)
      let stderrHandler: ((data: Buffer) => void) | null = null;
      let stdoutHandler: ((data: Buffer) => void) | null = null;
      let exitHandler: ((code: number | null) => void) | null = null;
      let errorHandler: ((err: Error) => void) | null = null;

      const cleanup = () => {
        // Remove event listeners to prevent memory leaks
        if (this.process) {
          if (stderrHandler) this.process.stderr?.removeListener('data', stderrHandler);
          if (stdoutHandler) this.process.stdout?.removeListener('data', stdoutHandler);
          if (exitHandler) this.process.removeListener('exit', exitHandler);
          if (errorHandler) this.process.removeListener('error', errorHandler);
        }
      };

      const settle = (success: boolean, value: string | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cleanup();
        if (success) {
          resolve(value as string);
        } else {
          reject(value as Error);
        }
      };

      const timeout = setTimeout(() => {
        this.stop();
        settle(false, new Error('Tunnel creation timed out (30s). Check your internet connection.'));
      }, 30000);

      this.process = spawn(cloudflaredPath, [
        'tunnel', '--url', `http://localhost:${port}`,
        '--no-autoupdate',
      ]);

      stderrHandler = (data: Buffer) => {
        const text = data.toString();
        Logger.info(`[cloudflared] ${text.trim()}`);

        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match && !settled) {
          this.tunnelUrl = match[0];
          Logger.info(`Tunnel URL: ${this.tunnelUrl}`);
          settle(true, this.tunnelUrl);
        }
      };
      this.process.stderr?.on('data', stderrHandler);

      stdoutHandler = (data: Buffer) => {
        Logger.info(`[cloudflared] ${data.toString().trim()}`);
      };
      this.process.stdout?.on('data', stdoutHandler);

      exitHandler = (code: number | null) => {
        if (code !== 0 && code !== null) {
          Logger.error(`cloudflared exited with code ${code}`);
          settle(false, new Error(`cloudflared exited with code ${code}`));
        } else if (!this.tunnelUrl) {
          Logger.error('cloudflared exited without providing tunnel URL');
          settle(false, new Error('cloudflared exited without providing tunnel URL'));
        }
      };
      this.process.on('exit', exitHandler);

      errorHandler = (err: Error) => {
        Logger.error('cloudflared process error', err);
        settle(false, err);
      };
      this.process.on('error', errorHandler);
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
    // 세션 내 memoize: start()의 재시도 루프(MAX_RETRIES)가 버전검사/다운로드를 매번 반복
    // 트리거하지 않도록 한 번 확정한 경로를 재사용한다 (오프라인+구버전에서 재시도마다
    // doomed 다운로드를 반복하는 회귀 방지).
    if (this.resolvedBinary && fs.existsSync(this.resolvedBinary)) {
      return this.resolvedBinary;
    }

    const platform = process.platform;
    const arch = process.arch;
    const key = `${platform}-${arch}`;
    const binName = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const binPath = path.join(this.binDir, binName);
    const downloadUrl = CLOUDFLARED_URLS[key];

    if (!fs.existsSync(this.binDir)) {
      fs.mkdirSync(this.binDir, { recursive: true });
    }

    // 1) 다운로드 없이 '후보' 바이너리 확보 (기존 캐시 우선, 없으면 번들)
    let candidate: string | null = null;
    if (fs.existsSync(binPath)) {
      candidate = binPath;
    } else {
      const bundledBinName = BUNDLED_BINARIES[key];
      if (bundledBinName) {
        const bundledPath = path.join(this.binDir, bundledBinName);
        if (fs.existsSync(bundledPath)) {
          Logger.info(`Using bundled cloudflared for ${key}`);
          if (platform === 'win32') {
            candidate = bundledPath; // win32: 번들 .exe는 이미 올바른 이름 → 그대로 사용(현행 보존)
          } else {
            // macOS: 번들을 기대 이름 'cloudflared'로 복사(현행 보존)
            fs.copyFileSync(bundledPath, binPath);
            fs.chmodSync(binPath, 0o755);
            Logger.info(`Copied bundled binary to ${binPath}`);
            candidate = binPath;
          }
        }
      }
    }

    // 2) 후보가 있으면 fail-safe 버전 게이트
    if (candidate) {
      const version = await this.getBinaryVersion(candidate);

      // 버전 판별 불가(spawn 오류/타임아웃/파싱 실패) → 현행 그대로 사용(fail-safe: 절대 현행보다 나빠지지 않음)
      if (version === null) {
        Logger.warn('Could not determine cloudflared version; using existing binary as-is (fail-safe)');
        this.resolvedBinary = candidate;
        return candidate;
      }

      // 최신(>= MIN_VERSION)이면 다운로드 없이 즉시 반환(빠른 경로 보존)
      if (this.isVersionAtLeast(version, TunnelManager.MIN_VERSION)) {
        Logger.info(`cloudflared ${version} is up to date (>= ${TunnelManager.MIN_VERSION})`);
        this.resolvedBinary = candidate;
        return candidate;
      }

      // 확실히 구버전 → Cloudflare가 quick-tunnel을 거부하므로 latest로 갱신 시도
      Logger.warn(`cloudflared ${version} is older than ${TunnelManager.MIN_VERSION}; downloading the latest build`);
      if (downloadUrl) {
        try {
          // 임시 디렉터리로 받아 성공 시에만 원자적 교체 → 실패해도 후보(candidate) 훼손 없음
          await this.downloadBinary(downloadUrl, binPath, platform);
          Logger.info('cloudflared updated to the latest build');
          this.resolvedBinary = binPath;
          return binPath;
        } catch (err) {
          // 오프라인 등 실패 → 기존 후보로 폴백(현행보다 나빠지지 않음)
          Logger.warn(`Update download failed (${err instanceof Error ? err.message : String(err)}); falling back to existing binary`);
        }
      } else {
        Logger.warn(`No download URL for ${key}; falling back to existing binary`);
      }
      const fallback = fs.existsSync(candidate) ? candidate : binPath;
      this.resolvedBinary = fallback;
      return fallback;
    }

    // 3) 후보 자체가 없음: 반드시 다운로드(현행 동작)
    if (!downloadUrl) {
      throw new Error(`Unsupported platform: ${key}. Please install cloudflared manually.`);
    }
    Logger.info(`Downloading cloudflared for ${key}...`);
    await this.downloadBinary(downloadUrl, binPath, platform);
    Logger.info('cloudflared downloaded successfully');
    this.resolvedBinary = binPath;
    return binPath;
  }

  /**
   * URL을 binDir 하위 임시 디렉터리에 받아(.tgz면 해제) 성공 시에만 renameSync로 destPath에 원자적 배치.
   * 실패 시 destPath(기존 바이너리)를 절대 건드리지 않는다 → 무회귀 폴백 보장.
   * (임시 디렉터리를 binDir 하위에 두는 이유: rename이 동일 파일시스템 내 원자적 연산이 되어 EXDEV 회피)
   */
  private async downloadBinary(url: string, destPath: string, platform: string): Promise<void> {
    if (!fs.existsSync(this.binDir)) {
      fs.mkdirSync(this.binDir, { recursive: true });
    }
    const tmpDir = fs.mkdtempSync(path.join(this.binDir, '.dl-'));
    try {
      let producedPath: string;
      if (url.endsWith('.tgz')) {
        const tgzPath = path.join(tmpDir, 'cloudflared.tgz');
        await this.downloadFile(url, tgzPath);
        await this.extractTgz(tgzPath, tmpDir); // tar 내 파일명 'cloudflared'로 해제됨
        producedPath = path.join(tmpDir, 'cloudflared');
      } else {
        producedPath = path.join(tmpDir, path.basename(destPath));
        await this.downloadFile(url, producedPath);
      }
      if (!fs.existsSync(producedPath)) {
        throw new Error(`Downloaded cloudflared not found at ${producedPath}`);
      }
      if (platform !== 'win32') {
        fs.chmodSync(producedPath, 0o755);
      }
      fs.renameSync(producedPath, destPath); // 동일 파일시스템 내 원자적 교체
      if (platform !== 'win32') {
        fs.chmodSync(destPath, 0o755);
      }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  /** `binaryPath --version` 실행 → 'cloudflared version YYYY.M.P' 파싱. 실패/타임아웃 시 null(=판별불가). */
  private getBinaryVersion(binaryPath: string): Promise<string | null> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
      try {
        const child = spawn(binaryPath, ['--version']);
        let out = '';
        const to = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } finish(null); }, 5000);
        child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
        child.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
        child.on('error', () => { clearTimeout(to); finish(null); });
        child.on('close', () => {
          clearTimeout(to);
          const m = out.match(/cloudflared version (\d+)\.(\d+)\.(\d+)/i);
          finish(m ? `${m[1]}.${m[2]}.${m[3]}` : null);
        });
      } catch {
        finish(null);
      }
    });
  }

  /** YYYY.M.P 성분별 정수 비교로 version >= minimum 판정 (예: 2026.1.2 < 2026.6.1). */
  private isVersionAtLeast(version: string, minimum: string): boolean {
    const a = version.split('.').map(n => parseInt(n, 10) || 0);
    const b = minimum.split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0;
      const y = b[i] || 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return true; // 동일
  }

  private extractTgz(tgzPath: string, destDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const input = fs.createReadStream(tgzPath);
      const gunzip = zlib.createGunzip();
      const chunks: Buffer[] = [];

      input.pipe(gunzip);

      gunzip.on('data', (chunk: Buffer) => chunks.push(chunk));
      gunzip.on('end', () => {
        // tar 형식 파싱: 512바이트 헤더 + 파일 데이터
        const tar = Buffer.concat(chunks);
        let offset = 0;
        while (offset < tar.length) {
          const header = tar.slice(offset, offset + 512);
          if (header.every(b => b === 0)) break;

          const fileName = header.slice(0, 100).toString('utf8').replace(/\0/g, '').trim();
          const sizeOctal = header.slice(124, 136).toString('utf8').replace(/\0/g, '').trim();
          const fileSize = parseInt(sizeOctal, 8) || 0;
          offset += 512;

          if (fileSize > 0 && fileName && !fileName.endsWith('/')) {
            const baseName = path.basename(fileName);
            const destPath = path.join(destDir, baseName);
            fs.writeFileSync(destPath, tar.slice(offset, offset + fileSize));
            Logger.info(`Extracted: ${baseName} (${fileSize} bytes)`);
          }

          offset += Math.ceil(fileSize / 512) * 512;
        }
        resolve();
      });
      gunzip.on('error', reject);
      input.on('error', reject);
    });
  }

  private downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const follow = (currentUrl: string) => {
        const request = https.get(currentUrl, (response) => {
          // 리다이렉트 처리 (301/302/307/308)
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            response.resume(); // 리다이렉트 응답 본문 드레인 (소켓 누수 방지)
            follow(response.headers.location);
            return;
          }

          if (response.statusCode !== 200) {
            response.resume();
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
            try { fs.unlinkSync(dest); } catch { /* ignore */ }
            reject(err);
          });
        });
        // 무응답/방화벽 차단 시 무한 대기 방지 — 소켓 비활성 15s 상한(오프라인에서 빠른 폴백 보장)
        request.setTimeout(15000, () => request.destroy(new Error('Download connection timed out')));
        request.on('error', reject);
      };

      follow(url);
    });
  }
}
