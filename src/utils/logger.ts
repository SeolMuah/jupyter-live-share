import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

export class Logger {
  static init() {
    if (!outputChannel) {
      outputChannel = vscode.window.createOutputChannel('Jupyter Live Share');
    }
  }

  static info(message: string) {
    const timestamp = new Date().toISOString().slice(11, 19);
    outputChannel?.appendLine(`[${timestamp}] INFO: ${message}`);
  }

  static warn(message: string) {
    const timestamp = new Date().toISOString().slice(11, 19);
    outputChannel?.appendLine(`[${timestamp}] WARN: ${message}`);
  }

  static error(message: string, error?: unknown) {
    const timestamp = new Date().toISOString().slice(11, 19);
    const errMsg = error instanceof Error ? error.message : String(error ?? '');
    outputChannel?.appendLine(`[${timestamp}] ERROR: ${message} ${errMsg}`);
  }

  static show() {
    outputChannel?.show();
  }
}
