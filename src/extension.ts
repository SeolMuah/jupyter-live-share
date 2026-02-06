import * as vscode from 'vscode';
import { startSession, stopSession, createPoll, endPollCommand } from './ui/commands';
import { StatusBarManager } from './ui/statusBar';
import { SessionViewProvider } from './ui/sidebarView';
import { ChatPanelProvider } from './ui/chatPanelView';
import { ViewerPanel } from './ui/viewerPanel';
import { Logger } from './utils/logger';
import { forceStopHttpServer } from './server/httpServer';
import { forceStopWsServer } from './server/wsServer';
import { forceStopTunnel } from './ui/commands';

let statusBarManager: StatusBarManager | undefined;
let sessionViewProvider: SessionViewProvider | undefined;
let chatPanelProvider: ChatPanelProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  Logger.init();
  Logger.info('Jupyter Live Share extension activated');

  // 비정상 종료 시 포트 정리 핸들러 등록
  registerProcessCleanupHandlers();

  // StatusBar
  statusBarManager = new StatusBarManager();
  context.subscriptions.push(statusBarManager);

  // Sidebar WebviewView
  sessionViewProvider = new SessionViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SessionViewProvider.viewType,
      sessionViewProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  );

  // Chat Panel in bottom panel (terminal area)
  chatPanelProvider = new ChatPanelProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatPanelProvider.viewType,
      chatPanelProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  );

  // Handle messages from sidebar webview
  sessionViewProvider.setOnCommand((command, data) => {
    switch (command) {
      case 'startSession': {
        const teacherName = (data && typeof data === 'object' && 'teacherName' in data)
          ? String((data as { teacherName: string }).teacherName)
          : undefined;
        startSession(context, statusBarManager!, sessionViewProvider, chatPanelProvider, teacherName);
        break;
      }
      case 'stopSession':
        stopSession(statusBarManager!, sessionViewProvider, chatPanelProvider);
        break;
      case 'copyUrl':
        if (data && typeof data === 'object' && 'url' in data) {
          vscode.env.clipboard.writeText(String((data as { url: string }).url));
        }
        break;
    }
  });

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('jupyterLiveShare.startSession', () => {
      if (!statusBarManager) {
        vscode.window.showErrorMessage('Extension not properly initialized');
        return;
      }
      startSession(context, statusBarManager, sessionViewProvider, chatPanelProvider);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('jupyterLiveShare.stopSession', () => {
      if (!statusBarManager) return;
      stopSession(statusBarManager, sessionViewProvider, chatPanelProvider);
    })
  );

  // Poll commands
  context.subscriptions.push(
    vscode.commands.registerCommand('jupyterLiveShare.createPoll', () => createPoll(sessionViewProvider))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('jupyterLiveShare.endPoll', () => endPollCommand(sessionViewProvider))
  );

  // Viewer Panel (학생용)
  context.subscriptions.push(
    vscode.commands.registerCommand('jupyterLiveShare.openViewer', () =>
      ViewerPanel.createOrShow(context)
    )
  );
}

export function deactivate() {
  Logger.info('Jupyter Live Share extension deactivating...');

  // 정상 종료 시도
  try {
    if (statusBarManager) {
      stopSession(statusBarManager, sessionViewProvider, chatPanelProvider);
    }
  } catch {
    // 정상 종료 실패 시 강제 정리
    emergencyCleanup();
  }
}

/**
 * 프로세스 비정상 종료 시 포트와 리소스를 강제 해제하는 핸들러를 등록한다.
 */
function registerProcessCleanupHandlers(): void {
  // 프로세스 종료 시 (정상/비정상 모두)
  process.on('exit', () => {
    emergencyCleanup();
  });

  // Ctrl+C 등 인터럽트
  process.on('SIGINT', () => {
    Logger.info('Received SIGINT, cleaning up...');
    emergencyCleanup();
  });

  // kill 명령
  process.on('SIGTERM', () => {
    Logger.info('Received SIGTERM, cleaning up...');
    emergencyCleanup();
  });

  // 처리되지 않은 예외로 인한 종료
  process.on('uncaughtException', (err) => {
    Logger.error('Uncaught exception, cleaning up...', err);
    emergencyCleanup();
  });
}

/**
 * 동기적 강제 정리 - 프로세스가 종료되기 직전에 호출
 */
function emergencyCleanup(): void {
  try {
    forceStopTunnel();
  } catch { /* 무시 */ }

  try {
    forceStopWsServer();
  } catch { /* 무시 */ }

  try {
    forceStopHttpServer();
  } catch { /* 무시 */ }
}
