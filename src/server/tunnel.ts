import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { Logger } from '../utils/logger';

// 고정 릴리스에서만 다운로드하고, 자산별 공식 SHA-256(GitHub release asset digest)을
// 하드코딩해 다운로드 직후 검증한다(fail-closed: 불일치 시 삭제·실행 거부).
// 'latest' 미고정 다운로드는 릴리스 하이재킹 시 임의 바이너리가 그대로 실행되는
// 공급망 구멍이자, 마켓플레이스 보안 스캐너가 dropper로 분류하는 행위 패턴이다.
// 버전을 올릴 때는 URL 태그와 sha256을 함께 갱신할 것 (digest는
// https://api.github.com/repos/cloudflare/cloudflared/releases 의 asset digest 필드).
const CLOUDFLARED_VERSION = '2026.6.1';

interface CloudflaredAsset {
  url: string;
  sha256: string;
  archive: 'none' | 'tgz';
}

const CLOUDFLARED_ASSETS: Record<string, CloudflaredAsset> = {
  'win32-x64': {
    url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-amd64.exe`,
    sha256: '5253e66f1f493c4e13539749f1aa86fd0c61e3072900fec29a44ba046a6d97e2',
    archive: 'none',
  },
  // Windows on ARM: cloudflared가 win-arm64 네이티브 자산을 제공하지 않음(2026.6.1 기준)
  // — Windows 11 ARM64의 x64 에뮬레이션으로 amd64 빌드를 실행한다.
  'win32-arm64': {
    url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-amd64.exe`,
    sha256: '5253e66f1f493c4e13539749f1aa86fd0c61e3072900fec29a44ba046a6d97e2',
    archive: 'none',
  },
  'darwin-x64': {
    url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-darwin-amd64.tgz`,
    sha256: 'd7a66b525fe76820da6e5406611b61e48b40de682368ac00454d9158f085be4b',
    archive: 'tgz',
  },
  'darwin-arm64': {
    url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-darwin-arm64.tgz`,
    sha256: 'f6d4c439c6c782b83264951d327989ce5e23373acc5942b872411601fedb020d',
    archive: 'tgz',
  },
  'linux-x64': {
    url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64`,
    sha256: '5861a10a438fe8ddcfebb3b830f83966cbf193edafce0fe2eeb198fbae1f7a22',
    archive: 'none',
  },
  'linux-arm64': {
    url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-arm64`,
    sha256: '59816ce9b16db71f5bc2a86d59b3632a96c8c3ee934bde2bc8641ee83a6070eb',
    archive: 'none',
  },
};

export class TunnelManager {
  private process: ChildProcess | null = null;
  private tunnelUrl: string | null = null;
  private binDir: string;
  // 세션 내 확정된 cloudflared 경로. start()의 재시도 루프가 버전검사/다운로드를 반복하지 않도록 캐싱.
  private resolvedBinary: string | null = null;

  /**
   * @param storageDir 확장의 globalStorage 경로 (context.globalStorageUri.fsPath).
   * 다운로드 바이너리는 확장 설치 디렉터리가 아닌 globalStorage에 둔다 —
   * 설치 디렉터리 기록은 확장 무결성 검증을 깨뜨리고 업데이트 시 유실된다.
   */
  constructor(storageDir: string) {
    this.binDir = path.join(storageDir, 'cloudflared');
  }

  get url(): string | null {
    return this.tunnelUrl;
  }

  private static readonly MAX_RETRIES = 2;
  private static readonly RETRY_DELAY_MS = 2000;
  // Cloudflare가 서버측에서 오래된 cloudflared의 quick-tunnel 생성을 거부한다("invalid UUID length: 0").
  // 이 값은 quick-tunnel 성공이 실증된 최소 버전으로, '시스템 PATH에 설치된 cloudflared'의
  // 사용 가능 여부 게이트에만 쓰인다(구버전이면 무시하고 고정 릴리스를 다운로드).
  // cloudflared는 날짜형(YYYY.M.P)이라 숫자 비교가 성립한다. CLOUDFLARED_VERSION을 올릴 때 함께 검토할 것.
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
          // cleanup()이 startup용 리스너를 모두 떼므로, 이후 살아있는 cloudflared가 죽거나
          // stdio가 error를 내면 리스너 부재로 프로세스 uncaughtException이 될 수 있다.
          // 수명 동안 유지되는 경량 핸들러로 흡수·로깅한다 (세션/서버는 건드리지 않음).
          if (this.process) this.attachLifetimeHandlers(this.process);
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

  /**
   * URL 확보 후(=start 성공) 프로세스 수명 동안 유지되는 경량 이벤트 핸들러를 붙인다.
   * 목적: cloudflared가 세션 중 스스로 죽거나 stdio가 error를 낼 때 리스너 부재로 인한
   * 프로세스 uncaughtException을 방지하고(→ 확장이 세션 전체를 내리는 회귀 차단), 터널
   * 다운을 로그로 진단 가능하게 남긴다. 우리가 stop()으로 죽인 경우엔 조용히 무시한다.
   */
  private attachLifetimeHandlers(proc: ChildProcess): void {
    proc.on('error', (err: Error) => {
      if (this.process === proc) Logger.error('cloudflared process error (post-start)', err);
    });
    proc.on('exit', (code: number | null) => {
      // stop()은 this.process를 먼저 null로 만들므로, 의도적 종료는 여기서 걸러진다.
      if (this.process === proc) {
        Logger.warn(`cloudflared exited unexpectedly (code ${code}) — tunnel is down`);
        this.tunnelUrl = null;
      }
    });
    // 남은 stdio는 계속 흘려보내고(버퍼 정체 방지), 스트림 error도 흡수한다.
    proc.stdout?.on('error', () => { /* ignore */ });
    proc.stderr?.on('error', () => { /* ignore */ });
    proc.stdout?.resume();
    proc.stderr?.resume();
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
    // 세션 내 memoize: start()의 재시도 루프(MAX_RETRIES)가 탐지/다운로드를 매번 반복하지 않도록.
    if (this.resolvedBinary && fs.existsSync(this.resolvedBinary)) {
      return this.resolvedBinary;
    }

    // 1) 사용자가 직접 설치한 시스템 cloudflared 우선 (다운로드 자체를 회피)
    const system = await this.findUsableSystemBinary();
    if (system) {
      this.resolvedBinary = system;
      return system;
    }

    const key = `${process.platform}-${process.arch}`;
    const asset = CLOUDFLARED_ASSETS[key];
    if (!asset) {
      throw new Error(
        `Unsupported platform: ${key}. Install cloudflared manually (https://developers.cloudflare.com/cloudflared/) and make sure it is on PATH.`
      );
    }

    const binName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const versionDir = path.join(this.binDir, CLOUDFLARED_VERSION);
    const binPath = path.join(versionDir, binName);
    const markerPath = `${binPath}.sha256`;

    // 2) 기존 설치본 재사용 — 설치 시 기록한 최종 바이너리 해시로 무결성 재검증
    //    (변조·부분쓰기 감지 시 폐기 후 재다운로드)
    if (fs.existsSync(binPath) && fs.existsSync(markerPath)) {
      try {
        const expected = fs.readFileSync(markerPath, 'utf8').trim();
        const actual = await this.fileSha256(binPath);
        if (expected && actual === expected) {
          this.resolvedBinary = binPath;
          return binPath;
        }
        Logger.warn('Cached cloudflared failed its integrity check; re-downloading');
      } catch (err) {
        Logger.warn(`Cached cloudflared integrity check errored (${err instanceof Error ? err.message : String(err)}); re-downloading`);
      }
      try { fs.rmSync(versionDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    // 3) 고정 릴리스 다운로드 + SHA-256 검증 (불일치 시 실행 없이 중단)
    Logger.info(`Downloading cloudflared ${CLOUDFLARED_VERSION} for ${key}...`);
    await this.downloadPinnedBinary(asset, binPath);
    Logger.info(`cloudflared ${CLOUDFLARED_VERSION} downloaded and SHA-256 verified`);
    this.resolvedBinary = binPath;
    return binPath;
  }

  /**
   * PATH에서 사용자가 설치한 cloudflared를 찾는다. MIN_VERSION 이상일 때만 사용
   * (Cloudflare가 구버전의 quick-tunnel 생성을 서버측에서 거부하므로).
   * 사용자 소유 바이너리라 해시 검증 대상이 아니다 — 우리 확장이 설치한 것만 검증한다.
   */
  private async findUsableSystemBinary(): Promise<string | null> {
    try {
      const finder = process.platform === 'win32' ? 'where' : 'which';
      const res = spawnSync(finder, ['cloudflared'], { timeout: 3000, encoding: 'utf8' });
      if (res.status !== 0 || !res.stdout) return null;
      const found = res.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
      if (!found || !fs.existsSync(found)) return null;
      const version = await this.getBinaryVersion(found);
      if (version && this.isVersionAtLeast(version, TunnelManager.MIN_VERSION)) {
        Logger.info(`Using system-installed cloudflared ${version} (${found})`);
        return found;
      }
      if (version) {
        Logger.info(`System cloudflared ${version} is older than ${TunnelManager.MIN_VERSION}; using the pinned download instead`);
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 고정 릴리스 자산을 임시 디렉터리에 받아 하드코딩된 SHA-256과 대조하고(fail-closed),
   * 통과 시에만 해제·배치한다. 실패 시 어떤 파일도 실행되지 않고 임시 디렉터리는 삭제된다.
   * 배치 후 최종 바이너리의 해시를 .sha256 마커로 남겨 이후 세션의 재검증에 쓴다.
   */
  private async downloadPinnedBinary(asset: CloudflaredAsset, destPath: string): Promise<void> {
    const destDir = path.dirname(destPath);
    fs.mkdirSync(destDir, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(destDir, '.dl-'));
    try {
      const downloadPath = path.join(tmpDir, asset.archive === 'tgz' ? 'cloudflared.tgz' : path.basename(destPath));
      await this.downloadFile(asset.url, downloadPath);

      // 공급망 방어의 핵심: 다운로드 자산을 공식 릴리스의 고정 해시와 대조.
      // 불일치 = 전송 오류 또는 릴리스 변조 → 절대 실행하지 않는다.
      const actual = await this.fileSha256(downloadPath);
      if (actual !== asset.sha256) {
        throw new Error(
          `cloudflared download failed integrity verification (SHA-256 mismatch; expected ${asset.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…). The file was NOT executed.`
        );
      }

      let producedPath = downloadPath;
      if (asset.archive === 'tgz') {
        await this.extractTgz(downloadPath, tmpDir); // tar 내 파일명 'cloudflared'로 해제됨
        producedPath = path.join(tmpDir, 'cloudflared');
        if (!fs.existsSync(producedPath)) {
          throw new Error('cloudflared binary not found inside the downloaded archive');
        }
      }
      if (process.platform !== 'win32') {
        fs.chmodSync(producedPath, 0o755);
      }

      const binHash = await this.fileSha256(producedPath);
      fs.renameSync(producedPath, destPath); // 동일 파일시스템 내 원자적 배치
      if (process.platform !== 'win32') {
        fs.chmodSync(destPath, 0o755);
      }
      fs.writeFileSync(`${destPath}.sha256`, binHash);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  /** 파일의 SHA-256 hex digest (스트리밍 — 대용량 바이너리 메모리 부담 없음). */
  private fileSha256(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (d) => hash.update(d));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
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

  private static readonly MAX_REDIRECTS = 5;
  private static readonly MAX_DOWNLOAD_BYTES = 120 * 1024 * 1024; // 자산 최대 ~55MB의 2배 여유

  private downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const follow = (currentUrl: string, redirectsLeft: number) => {
        const request = https.get(currentUrl, (response) => {
          // 리다이렉트 처리 (301/302/307/308) — 깊이 제한으로 무한 재귀 차단
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            response.resume(); // 리다이렉트 응답 본문 드레인 (소켓 누수 방지)
            if (redirectsLeft <= 0) {
              reject(new Error('Download failed: too many redirects'));
              return;
            }
            // location이 상대경로일 수 있으므로 현재 URL 기준으로 해석
            follow(new URL(response.headers.location, currentUrl).toString(), redirectsLeft - 1);
            return;
          }

          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error(`Download failed with status ${response.statusCode}`));
            return;
          }

          // 크기 상한 — 비정상적으로 큰 응답(오도된 리다이렉트/변조)을 조기 차단
          let received = 0;
          response.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > TunnelManager.MAX_DOWNLOAD_BYTES) {
              request.destroy(new Error('Download exceeds size limit'));
            }
          });

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

      follow(url, TunnelManager.MAX_REDIRECTS);
    });
  }
}
