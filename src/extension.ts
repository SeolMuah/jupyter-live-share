import * as vscode from 'vscode';
import { startSession, stopSession } from './ui/commands';
import { StatusBarManager } from './ui/statusBar';
import { SessionViewProvider } from './ui/sidebarView';
import { Logger } from './utils/logger';

let statusBarManager: StatusBarManager | undefined;

export function activate(context: vscode.ExtensionContext) {
  Logger.init();
  Logger.info('Jupyter Live Share extension activated');

  // StatusBar
  statusBarManager = new StatusBarManager();
  context.subscriptions.push(statusBarManager);

  // Sidebar TreeView
  const sessionViewProvider = new SessionViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('jupyterLiveShare.sessionView', sessionViewProvider)
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('jupyterLiveShare.startSession', () =>
      startSession(context, statusBarManager!, sessionViewProvider)
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('jupyterLiveShare.stopSession', () =>
      stopSession(statusBarManager!, sessionViewProvider)
    )
  );
}

export function deactivate() {
  Logger.info('Jupyter Live Share extension deactivated');
  stopSession(statusBarManager!);
}
