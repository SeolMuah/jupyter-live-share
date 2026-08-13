import * as vscode from 'vscode';

export interface LiveShareConfig {
  port: number;
  maxViewers: number;
  tunnelProvider: 'cloudflare' | 'none';
  bindAddress: string;
  imageMaxSizeKB: number;
  shareExplorer: boolean;
  // 터미널 공유 설정 (VS Code 1.93 이상에서만 의미가 있다)
  terminalMaskSecrets: boolean;
  terminalMaxOutputKB: number;
  terminalMaxCommands: number;
  terminalBlockedCommandPatterns: string[];
}

export function getConfig(): LiveShareConfig {
  const cfg = vscode.workspace.getConfiguration('codeClassLive');
  // bindAddress는 서버 listen 인자로 흘러가므로 화이트리스트로 강제한다
  // (워크스페이스 설정은 신뢰 불가 입력 — 임의 문자열 주입 차단).
  const rawBind = cfg.get<string>('bindAddress', '127.0.0.1');
  const bindAddress = rawBind === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
  // 명령당 출력 상한은 1~256KB로 클램프한다 (terminalShare.ts의 런타임 클램프와 동일 범위).
  const rawOutputKB = cfg.get<number>('terminal.maxOutputKB', 64);
  const terminalMaxOutputKB = Math.max(
    1,
    Math.min(256, typeof rawOutputKB === 'number' && isFinite(rawOutputKB) ? rawOutputKB : 64)
  );
  const rawMaxCommands = cfg.get<number>('terminal.maxCommands', 50);
  const terminalMaxCommands = Math.max(
    1,
    Math.min(500, typeof rawMaxCommands === 'number' && isFinite(rawMaxCommands) ? rawMaxCommands : 50)
  );
  const rawBlocked = cfg.get<string[]>('terminal.blockedCommandPatterns', []);
  return {
    port: cfg.get<number>('port', 48632),
    maxViewers: cfg.get<number>('maxViewers', 100),
    tunnelProvider: cfg.get<string>('tunnelProvider', 'cloudflare') as LiveShareConfig['tunnelProvider'],
    bindAddress,
    imageMaxSizeKB: cfg.get<number>('imageMaxSizeKB', 2048),
    shareExplorer: cfg.get<boolean>('shareExplorer', true),
    terminalMaskSecrets: cfg.get<boolean>('terminal.maskSecrets', true) !== false,
    terminalMaxOutputKB,
    terminalMaxCommands,
    terminalBlockedCommandPatterns: Array.isArray(rawBlocked) ? rawBlocked : [],
  };
}
