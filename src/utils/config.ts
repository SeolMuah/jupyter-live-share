import * as vscode from 'vscode';

export interface LiveShareConfig {
  port: number;
  maxViewers: number;
  tunnelProvider: 'cloudflare' | 'none';
  bindAddress: string;
  imageMaxWidth: number;
  imageMaxSizeKB: number;
  shareExplorer: boolean;
}

export function getConfig(): LiveShareConfig {
  const cfg = vscode.workspace.getConfiguration('codeClassLive');
  // bindAddress는 서버 listen 인자로 흘러가므로 화이트리스트로 강제한다
  // (워크스페이스 설정은 신뢰 불가 입력 — 임의 문자열 주입 차단).
  const rawBind = cfg.get<string>('bindAddress', '127.0.0.1');
  const bindAddress = rawBind === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
  return {
    port: cfg.get<number>('port', 48632),
    maxViewers: cfg.get<number>('maxViewers', 100),
    tunnelProvider: cfg.get<string>('tunnelProvider', 'cloudflare') as LiveShareConfig['tunnelProvider'],
    bindAddress,
    imageMaxWidth: cfg.get<number>('imageMaxWidth', 1280),
    imageMaxSizeKB: cfg.get<number>('imageMaxSizeKB', 2048),
    shareExplorer: cfg.get<boolean>('shareExplorer', true),
  };
}
