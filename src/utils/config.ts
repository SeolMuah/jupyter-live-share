import * as vscode from 'vscode';

export interface LiveShareConfig {
  port: number;
  maxViewers: number;
  tunnelProvider: 'cloudflare' | 'none';
}

export function getConfig(): LiveShareConfig {
  const cfg = vscode.workspace.getConfiguration('jupyterLiveShare');
  return {
    port: cfg.get<number>('port', 3000),
    maxViewers: cfg.get<number>('maxViewers', 100),
    tunnelProvider: cfg.get<string>('tunnelProvider', 'cloudflare') as LiveShareConfig['tunnelProvider'],
  };
}
