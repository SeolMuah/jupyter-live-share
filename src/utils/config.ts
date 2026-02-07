import * as vscode from 'vscode';

export interface LiveShareConfig {
  port: number;
  maxViewers: number;
  tunnelProvider: 'cloudflare' | 'none';
  imageMaxWidth: number;
  imageMaxSizeKB: number;
}

export function getConfig(): LiveShareConfig {
  const cfg = vscode.workspace.getConfiguration('jupyterLiveShare');
  return {
    port: cfg.get<number>('port', 48632),
    maxViewers: cfg.get<number>('maxViewers', 100),
    tunnelProvider: cfg.get<string>('tunnelProvider', 'cloudflare') as LiveShareConfig['tunnelProvider'],
    imageMaxWidth: cfg.get<number>('imageMaxWidth', 1280),
    imageMaxSizeKB: cfg.get<number>('imageMaxSizeKB', 2048),
  };
}
