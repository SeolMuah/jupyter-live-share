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

/**
 * 터널을 동기적으로 강제 종료한다 (프로세스 exit 핸들러용)
 */
export function forceStopTunnel(): void {
  if (tunnel) {
    tunnel.stop();
    tunnel = null;
  }
}

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
    // PIN 없이 바로 시작
    const pin: string | null = null;

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
          port: config.port,
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

export async function createPoll(sidebarView?: SessionViewProvider) {
  const config = getConfig();

  const question = await vscode.window.showInputBox({
    prompt: 'Enter poll question',
    placeHolder: 'e.g. How well do you understand?',
  });
  if (!question) return;

  const optionCountStr = await vscode.window.showQuickPick(
    ['2', '3', '4', '5'],
    { placeHolder: 'Number of options' }
  );
  if (!optionCountStr) return;

  const optionCount = parseInt(optionCountStr);

  try {
    const postData = JSON.stringify({ question, optionCount });
    const url = `http://localhost:${config.port}/api/poll/start`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: postData,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      sidebarView?.updateState({ pollActive: true });
      vscode.window.showInformationMessage(`Poll started: "${question}"`);
    } else {
      const data = await response.json() as { error?: string };
      vscode.window.showErrorMessage(`Failed to start poll: ${data.error || 'Unknown error'}`);
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      vscode.window.showErrorMessage('Failed to start poll: Request timed out');
    } else {
      vscode.window.showErrorMessage(`Failed to start poll: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export async function endPollCommand(sidebarView?: SessionViewProvider) {
  const config = getConfig();

  try {
    const url = `http://localhost:${config.port}/api/poll/end`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      sidebarView?.updateState({ pollActive: false });
      vscode.window.showInformationMessage('Poll ended.');
    } else {
      const data = await response.json() as { error?: string };
      vscode.window.showErrorMessage(`Failed to end poll: ${data.error || 'Unknown error'}`);
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      vscode.window.showErrorMessage('Failed to end poll: Request timed out');
    } else {
      vscode.window.showErrorMessage(`Failed to end poll: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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
    port: undefined,
    pin: undefined,
    viewerCount: 0,
    fileName: undefined,
    pollActive: false,
  });

  Logger.info('Session cleaned up');
}
