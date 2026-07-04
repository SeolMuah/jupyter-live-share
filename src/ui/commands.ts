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
// 동의 모달·서버 기동 중 재진입 차단 래치 — isRunning은 서버 기동 후에야 true가 되므로,
// 모달이 떠 있는 동안 Start를 또 누르면 두 세션이 동시에 기동을 시도한다(EADDRINUSE 유발).
let isStarting = false;

const CLOUDFLARED_CONSENT_KEY = 'codeClassLive.cloudflaredConsent';

/**
 * cloudflared 다운로드·실행과 공개 URL 생성에 대한 1회 명시적 동의.
 * Marketplace 정책(Publisher Agreement §8(d))상, 리스팅에 공지된 범위를 넘는 실행코드
 * 설치·실행은 금지된다 — README 공지에 더해 런타임 동의로 사용자가 직접 승인하게 한다.
 * 승인은 globalState에 영구 저장(1회만 질문), 거부/취소 시 이번 세션은 localhost로만 서비스.
 */
async function ensureTunnelConsent(context: vscode.ExtensionContext): Promise<boolean> {
  if (context.globalState.get<boolean>(CLOUDFLARED_CONSENT_KEY) === true) return true;
  const allow = 'Allow';
  const choice = await vscode.window.showInformationMessage(
    'Share this session over the internet?',
    {
      modal: true,
      detail:
        "Code Class Live Sharing runs Cloudflare's cloudflared tool to create a temporary public URL (*.trycloudflare.com) that students open in their browser.\n\n" +
        "If cloudflared is not installed on this machine, it will be downloaded once from Cloudflare's official GitHub release (version-pinned, SHA-256 verified).\n\n" +
        'Anyone with the URL can view the shared file while the session is running. Choosing "Cancel" starts the session on localhost only.',
    },
    allow
  );
  if (choice === allow) {
    await context.globalState.update(CLOUDFLARED_CONSENT_KEY, true);
    return true;
  }
  return false;
}

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
  if (isRunning || isStarting) {
    vscode.window.showWarningMessage('Code Class Live Sharing session is already running.');
    return;
  }
  isStarting = true;

  // 활성 에디터 확인 (노트북 또는 텍스트) — 파일 없이도 세션 시작 가능
  const notebookEditor = vscode.window.activeNotebookEditor;
  const textEditor = vscode.window.activeTextEditor;

  const isNotebook = notebookEditor && notebookEditor.notebook.notebookType === 'jupyter-notebook';
  const isTextFile = textEditor && textEditor.document.uri.scheme === 'file';

  const config = getConfig();

  // 터널(공개 URL) 사용 전 1회 명시적 동의 — 거부/취소 시 localhost로만 서비스
  const tunnelConsent = config.tunnelProvider === 'cloudflare'
    ? await ensureTunnelConsent(context)
    : false;

  try {
    // PIN 없이 바로 시작 (뷰잉은 URL로 오픈, 교사 권한만 토큰으로 게이트)
    const pin: string | null = null;
    const teacherToken = crypto.randomBytes(24).toString('hex');

    // 1. HTTP 서버 시작
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Starting Code Class Live Sharing...' },
      async (progress) => {
        progress.report({ message: 'Starting server...' });
        const httpServer = await startHttpServer(config.port, config.bindAddress, async (busyPort) => {
          // 포트 점유 프로세스를 죽이기 전 반드시 사용자 확인 (대개 이전 세션의 잔재지만
          // 무관한 프로세스일 수도 있으므로 무단 종료하지 않는다)
          const terminate = 'Terminate and Continue';
          const picked = await vscode.window.showWarningMessage(
            `Port ${busyPort} is in use by another process`,
            {
              modal: true,
              detail: 'This is usually a previous sharing session that did not exit cleanly. Terminate that process and continue?',
            },
            terminate
          );
          return picked === terminate;
        });

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

        if (config.tunnelProvider === 'cloudflare' && tunnelConsent) {
          progress.report({ message: 'Creating tunnel (this may take a few seconds)...' });
          // 다운로드 바이너리는 globalStorage에 둔다 — 확장 설치 디렉터리 기록은
          // 확장 무결성 검증을 깨뜨리고 업데이트 시 유실된다.
          tunnel = new TunnelManager(context.globalStorageUri.fsPath);
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
        } else if (config.tunnelProvider === 'cloudflare') {
          // 동의 거부/취소 — 이번 세션은 localhost로만 서비스
          tunnelStatus = 'Tunnel off (not allowed) — localhost only';
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
          `Code Class Live Sharing started! URL copied to clipboard: ${tunnelUrl}`,
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
  } finally {
    isStarting = false;
  }
}

export async function stopSession(
  statusBar: StatusBarManager,
  sidebarView?: SessionViewProvider,
) {
  if (!isRunning) return;
  await cleanupSession(statusBar, sidebarView);
  vscode.window.showInformationMessage('Code Class Live Sharing session stopped.');
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
    // 서버가 IPv4 루프백(127.0.0.1)에만 바인딩되므로 Node fetch도 IPv4로 직접 접속
    // (Node 18의 fetch는 Happy Eyeballs 미적용 — localhost가 ::1로 먼저 풀리는 호스트에서 ECONNREFUSED 방지)
    const url = `http://127.0.0.1:${config.port}/api/poll/start`;

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
    // IPv4 직접 접속 — poll/start와 동일한 이유
    const url = `http://127.0.0.1:${config.port}/api/poll/end`;

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
