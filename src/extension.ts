import * as vscode from 'vscode';
import { startSession, stopSession, createPoll, endPollCommand, setViewerChatPanel, registerTerminalCommands } from './ui/commands';
import { StatusBarManager } from './ui/statusBar';
import { SessionViewProvider } from './ui/sidebarView';
import { ViewerChatPanelProvider } from './ui/viewerChatPanel';
import { ViewerPanel } from './ui/viewerPanel';
import { TeacherPreviewPanel } from './ui/teacherPreviewPanel';
import { Logger } from './utils/logger';
import { forceStopHttpServer } from './server/httpServer';
import { forceStopWsServer } from './server/wsServer';
import { forceStopTunnel } from './ui/commands';
import { initTerminalShare, onSharingChange } from './terminal/terminalShare';

let statusBarManager: StatusBarManager | undefined;
let sessionViewProvider: SessionViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  Logger.init();
  Logger.info('Code Class Live Sharing extension activated');

  // 비정상 종료 시 포트 정리 핸들러 등록
  registerProcessCleanupHandlers();

  // StatusBar
  statusBarManager = new StatusBarManager();
  context.subscriptions.push(statusBarManager);

  // 터미널 공유 (VS Code 1.93+ shell integration이 없으면 내부에서 조용히 비활성화된다)
  context.subscriptions.push(initTerminalShare());
  registerTerminalCommands(context);
  // 컨텍스트 키를 활성화 시점에 명시적으로 초기화한다 (우클릭 메뉴 when 절 기준).
  vscode.commands.executeCommand('setContext', 'codeClassLive.terminalSharing', false);
  onSharingChange((sharing, terminalName) => {
    vscode.commands.executeCommand('setContext', 'codeClassLive.terminalSharing', sharing);
    if (sharing) {
      statusBarManager?.showTerminalSharing(terminalName);
    } else {
      statusBarManager?.hideTerminalSharing();
    }
  });

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

  // Viewer Chat Panel in bottom panel (학생용)
  const viewerChatPanelProvider = new ViewerChatPanelProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ViewerChatPanelProvider.viewType,
      viewerChatPanelProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  );

  // Wire ViewerChatPanel to ViewerPanel (학생 모드) & commands (교사 모드)
  ViewerPanel.setChatPanel(viewerChatPanelProvider);
  setViewerChatPanel(viewerChatPanelProvider);

  // Handle messages from sidebar webview
  sessionViewProvider.setOnCommand((command, data) => {
    switch (command) {
      case 'startSession': {
        const d = data as { teacherName?: string; shareImages?: boolean } | undefined;
        const teacherName = d?.teacherName ? String(d.teacherName) : undefined;
        const shareImages = d?.shareImages !== false;
        startSession(context, statusBarManager!, sessionViewProvider, teacherName, shareImages);
        break;
      }
      case 'stopSession':
        stopSession(statusBarManager!, sessionViewProvider);
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
    vscode.commands.registerCommand('codeClassLive.startSession', () => {
      if (!statusBarManager) {
        vscode.window.showErrorMessage('Extension not properly initialized');
        return;
      }
      startSession(context, statusBarManager, sessionViewProvider);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('codeClassLive.stopSession', () => {
      if (!statusBarManager) return;
      stopSession(statusBarManager, sessionViewProvider);
    })
  );

  // Poll commands
  context.subscriptions.push(
    vscode.commands.registerCommand('codeClassLive.createPoll', () => createPoll(sessionViewProvider))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('codeClassLive.endPoll', () => endPollCommand(sessionViewProvider))
  );

  // Viewer Panel (학생용)
  context.subscriptions.push(
    vscode.commands.registerCommand('codeClassLive.openViewer', () =>
      ViewerPanel.createOrShow(context)
    )
  );

  // Teacher Preview Panel (선생님 판서용)
  context.subscriptions.push(
    vscode.commands.registerCommand('codeClassLive.openTeacherPreview', () =>
      TeacherPreviewPanel.createOrShow(context)
    )
  );

  // 확장호스트 재시작을 넘어온 Teacher Preview 탭 재입양 — 미등록 시 그런 탭은
  // currentPanel 추적이 끊긴 고아가 되어 새 세션 시작에도 갱신되지 않는다.
  context.subscriptions.push(TeacherPreviewPanel.registerSerializer(context));

  // StatusBar 클릭 시 URL 복사 (사이드바와 동일한 URL 상태를 재사용)
  context.subscriptions.push(
    vscode.commands.registerCommand('codeClassLive.copyUrl', async () => {
      const url = sessionViewProvider?.getCurrentUrl();
      if (!url) {
        vscode.window.showWarningMessage('No active Code Class Live Sharing session.');
        return;
      }
      await vscode.env.clipboard.writeText(url);
      vscode.window.showInformationMessage(`URL copied to clipboard: ${url}`);
    })
  );
}

export function deactivate() {
  Logger.info('Code Class Live Sharing extension deactivating...');

  // 정상 종료 시도
  try {
    if (statusBarManager) {
      stopSession(statusBarManager, sessionViewProvider);
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

  // 처리되지 않은 예외: 절대로 세션을 강제 종료하지 않는다 (로그만).
  // uncaughtException은 프로세스를 종료시키지 않는다. 여기서 emergencyCleanup()으로
  // 터널/WS/HTTP를 내리면, '아무' 예외(우리 코드·타 확장·VS Code 내부 무관)가 한 번만
  // 튀어도 학생·교사에게 session:end가 나가고 서버가 사라져 재접속이 불가한데 사이드바는
  // 'running'으로 남아 좀비 세션이 된다(실측 재현됨). 실제 종료 시 자원 해제는 아래
  // process 'exit' 핸들러가 담당하므로, 여기서는 진단용 로깅만 하고 세션을 그대로 둔다.
  process.on('uncaughtException', (err) => {
    Logger.error('Uncaught exception (session left intact — no teardown)', err);
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
