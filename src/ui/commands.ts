import * as vscode from 'vscode';
import { startHttpServer, stopHttpServer, getServer } from '../server/httpServer';
import { startWsServer, stopWsServer, setSessionPin, setOnViewerCountChange } from '../server/wsServer';
import { TunnelManager } from '../server/tunnel';
import { startWatching, stopWatching } from '../notebook/watcher';
import { StatusBarManager } from './statusBar';
import { SessionViewProvider } from './sidebarView';
import { getConfig } from '../utils/config';
import { Logger } from '../utils/logger';

let tunnel: TunnelManager | null = null;
let isRunning = false;

export async function startSession(
  context: vscode.ExtensionContext,
  statusBar: StatusBarManager,
  sidebarView?: SessionViewProvider
) {
  if (isRunning) {
    vscode.window.showWarningMessage('Jupyter Live Share session is already running.');
    return;
  }

  // 활성 에디터 확인 (노트북 또는 텍스트)
  const notebookEditor = vscode.window.activeNotebookEditor;
  const textEditor = vscode.window.activeTextEditor;

  const isNotebook = notebookEditor && notebookEditor.notebook.notebookType === 'jupyter-notebook';
  const isTextFile = textEditor && textEditor.document.uri.scheme === 'file';

  if (!isNotebook && !isTextFile) {
    vscode.window.showErrorMessage('Please open a file first (.ipynb, .py, .txt, .md, etc.).');
    return;
  }

  const config = getConfig();

  try {
    // 선택적 PIN 설정
    const pinInput = await vscode.window.showInputBox({
      prompt: 'Set a session PIN (optional, leave empty for no PIN)',
      placeHolder: '1234',
      password: false,
      validateInput: (value) => {
        if (value && !/^\d{4,6}$/.test(value)) {
          return 'PIN must be 4-6 digits';
        }
        return undefined;
      },
    });

    // ESC 취소가 아닌 빈 값은 PIN 없음으로 처리
    if (pinInput === undefined) return; // ESC pressed
    const pin = pinInput || null;

    // 1. HTTP 서버 시작
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Starting Jupyter Live Share...' },
      async (progress) => {
        progress.report({ message: 'Starting server...' });
        const httpServer = await startHttpServer(config.port);

        // 2. WebSocket 서버 시작
        progress.report({ message: 'Starting WebSocket...' });
        if (pin) setSessionPin(pin);
        startWsServer(httpServer, config.maxViewers);

        // 접속자 수 변경 콜백
        setOnViewerCountChange((count) => {
          statusBar.updateCount(count);
          sidebarView?.updateState({ viewerCount: count });
        });

        // 3. 파일 변경 감시 시작
        progress.report({ message: 'Setting up file watcher...' });
        startWatching();

        // 4. 터널 시작 (설정에 따라)
        let tunnelUrl = `http://localhost:${config.port}`;

        if (config.tunnelProvider === 'cloudflare') {
          progress.report({ message: 'Creating tunnel (this may take a few seconds)...' });
          tunnel = new TunnelManager(context.extensionPath);
          try {
            tunnelUrl = await tunnel.start(config.port);
          } catch (err) {
            Logger.warn(`Tunnel failed, using localhost: ${err}`);
            vscode.window.showWarningMessage(
              `Tunnel creation failed. Using local URL: http://localhost:${config.port}`
            );
          }
        }

        // 5. UI 업데이트
        isRunning = true;
        let fileName: string;
        if (isNotebook) {
          fileName = notebookEditor!.notebook.uri.path.split('/').pop() || 'notebook.ipynb';
        } else {
          fileName = textEditor!.document.uri.path.split('/').pop() || 'untitled.txt';
        }

        statusBar.show(0, tunnelUrl);
        sidebarView?.updateState({
          isRunning: true,
          url: tunnelUrl,
          pin: pin || undefined,
          viewerCount: 0,
          fileName,
        });

        // URL 클립보드 복사
        await vscode.env.clipboard.writeText(tunnelUrl);

        vscode.window.showInformationMessage(
          `Jupyter Live Share started! URL copied to clipboard: ${tunnelUrl}`,
          'Open in Browser'
        ).then((choice) => {
          if (choice === 'Open in Browser') {
            vscode.env.openExternal(vscode.Uri.parse(tunnelUrl));
          }
        });

        Logger.info(`Session started: ${tunnelUrl}`);
      }
    );
  } catch (err) {
    Logger.error('Failed to start session', err);
    vscode.window.showErrorMessage(
      `Failed to start session: ${err instanceof Error ? err.message : String(err)}`
    );
    // 정리
    await cleanupSession(statusBar, sidebarView);
  }
}

export async function stopSession(
  statusBar: StatusBarManager,
  sidebarView?: SessionViewProvider
) {
  if (!isRunning) return;
  await cleanupSession(statusBar, sidebarView);
  vscode.window.showInformationMessage('Jupyter Live Share session stopped.');
}

async function cleanupSession(
  statusBar: StatusBarManager,
  sidebarView?: SessionViewProvider
) {
  isRunning = false;

  stopWatching();

  if (tunnel) {
    tunnel.stop();
    tunnel = null;
  }

  await stopWsServer();
  await stopHttpServer();

  statusBar.hide();
  sidebarView?.updateState({
    isRunning: false,
    url: undefined,
    pin: undefined,
    viewerCount: 0,
    fileName: undefined,
  });

  Logger.info('Session cleaned up');
}
