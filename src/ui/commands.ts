import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { startHttpServer, stopHttpServer } from '../server/httpServer';
import { startWsServer, stopWsServer, setSessionPin, setOnViewerCountChange, setTeacherName, setTeacherToken, getTeacherToken } from '../server/wsServer';
import { TunnelManager } from '../server/tunnel';
import { startWatching, stopWatching, setImageShareEnabled } from '../notebook/watcher';
import { StatusBarManager } from './statusBar';
import { SessionViewProvider } from './sidebarView';
import { TeacherPreviewPanel } from './teacherPreviewPanel';
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
  sidebarView?: SessionViewProvider,
  teacherNameParam?: string,
  shareImages?: boolean
) {
  if (isRunning) {
    vscode.window.showWarningMessage('Jupyter Live Share session is already running.');
    return;
  }

  // 활성 에디터 확인 (노트북 또는 텍스트) — 파일 없이도 세션 시작 가능
  const notebookEditor = vscode.window.activeNotebookEditor;
  const textEditor = vscode.window.activeTextEditor;

  const isNotebook = notebookEditor && notebookEditor.notebook.notebookType === 'jupyter-notebook';
  const isTextFile = textEditor && textEditor.document.uri.scheme === 'file';

  const config = getConfig();

  try {
    // PIN 없이 바로 시작 (뷰잉은 URL로 오픈, 교사 권한만 토큰으로 게이트)
    const pin: string | null = null;
    const teacherToken = crypto.randomBytes(24).toString('hex');

    // 1. HTTP 서버 시작
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Starting Jupyter Live Share...' },
      async (progress) => {
        progress.report({ message: 'Starting server...' });
        const httpServer = await startHttpServer(config.port);

        // 2. WebSocket 서버 시작
        progress.report({ message: 'Starting WebSocket...' });
        if (pin) setSessionPin(pin);
        if (teacherNameParam) setTeacherName(teacherNameParam);
        setTeacherToken(teacherToken);
        startWsServer(httpServer, config.maxViewers);

        // 접속자 수 변경 콜백
        setOnViewerCountChange((count) => {
          statusBar.updateCount(count);
          sidebarView?.updateState({ viewerCount: count });
        });

        // 3. 파일 변경 감시 시작
        progress.report({ message: 'Setting up file watcher...' });
        setImageShareEnabled(shareImages !== false);
        startWatching();

        // Teacher Preview 패널이 열려있으면 새 세션으로 즉시 갱신.
        // 터널 기동(수 초)을 기다리지 않는다 — 프리뷰는 ws://localhost로 붙으므로
        // 여기서 바로 재생성해야 구 패널이 stale 토큰으로 남는 창이 사라진다.
        TeacherPreviewPanel.reload(context);

        // 4. 터널 시작 (설정에 따라)
        let tunnelUrl = `http://localhost:${config.port}`;

        isRunning = true;
        let fileName: string;
        if (isNotebook) {
          fileName = notebookEditor!.notebook.uri.path.split('/').pop() || 'notebook.ipynb';
        } else if (isTextFile) {
          fileName = textEditor!.document.uri.path.split('/').pop() || 'untitled.txt';
        } else {
          fileName = '(대기 중)';
        }

        let tunnelStatus: string | undefined;

        if (config.tunnelProvider === 'cloudflare') {
          progress.report({ message: 'Creating tunnel (this may take a few seconds)...' });
          tunnel = new TunnelManager(context.extensionPath);
          try {
            tunnelUrl = await tunnel.start(config.port, (msg) => {
              progress.report({ message: msg });
            });
            tunnelStatus = undefined; // 성공 시 상태 메시지 제거
          } catch (err) {
            Logger.warn(`Tunnel failed, using localhost: ${err}`);
            tunnelStatus = 'Tunnel failed — using localhost';
            vscode.window.showWarningMessage(
              `Tunnel creation failed (retries exhausted). Using local URL: http://localhost:${config.port}`
            );
          }
        }

        // 5. UI 업데이트 (최종 URL 반영)
        statusBar.show(0, tunnelUrl);
        sidebarView?.updateState({
          isRunning: true,
          url: tunnelUrl,
          port: config.port,
          pin: pin || undefined,
          teacherToken,
          viewerCount: 0,
          fileName,
          tunnelStatus,
        });

        // URL 클립보드 복사 (학생 배포용 — 교사 토큰을 붙이지 않은 원본 URL)
        await vscode.env.clipboard.writeText(tunnelUrl);

        vscode.window.showInformationMessage(
          `Jupyter Live Share started! URL copied to clipboard: ${tunnelUrl}`,
          'Open in Browser'
        ).then((choice) => {
          if (choice === 'Open in Browser') {
            // 선생님 본인이 여는 탭 — URL 프래그먼트로 교사 토큰을 전달해
            // teacherPanel로 조인시킨다(학생 수 미집계 + 교사 권한).
            // 프래그먼트(#)는 서버/터널/프록시 로그에 남지 않고, 뷰어가 로드 즉시
            // 주소창에서 제거한다. 클립보드의 학생용 URL에는 붙지 않는다.
            vscode.env.openExternal(vscode.Uri.parse(`${tunnelUrl}#tt=${teacherToken}`));
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
  sidebarView?: SessionViewProvider,
) {
  if (!isRunning) return;
  await cleanupSession(statusBar, sidebarView);
  vscode.window.showInformationMessage('Jupyter Live Share session stopped.');
}

export async function createPoll(sidebarView?: SessionViewProvider) {
  const config = getConfig();

  const question = await vscode.window.showInputBox({
    prompt: 'Enter poll question (optional)',
    placeHolder: 'e.g. How well do you understand?',
  });
  if (question === undefined) return; // Escape 취소만 중단, 빈 문자열은 허용

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
      headers: { 'Content-Type': 'application/json', 'X-Teacher-Token': getTeacherToken() || '' },
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
      headers: { 'Content-Type': 'application/json', 'X-Teacher-Token': getTeacherToken() || '' },
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
  sidebarView?: SessionViewProvider,
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
    tunnelStatus: undefined,
    pin: undefined,
    teacherToken: undefined,
    viewerCount: 0,
    fileName: undefined,
    pollActive: false,
  });
  sidebarView?.resetBadge();

  Logger.info('Session cleaned up');
}
