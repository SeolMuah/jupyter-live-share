import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { startHttpServer, stopHttpServer } from '../server/httpServer';
import { startWsServer, stopWsServer, setSessionPin, setOnViewerCountChange, setTeacherName, setTeacherToken, getTeacherToken } from '../server/wsServer';
import { TunnelManager } from '../server/tunnel';
import { startWatching, stopWatching, setImageShareEnabled } from '../notebook/watcher';
import { StatusBarManager } from './statusBar';
import { SessionViewProvider } from './sidebarView';
import { TeacherPreviewPanel } from './teacherPreviewPanel';
import { ViewerChatPanelProvider } from './viewerChatPanel';
import { getConfig } from '../utils/config';
import { Logger } from '../utils/logger';
import {
  clearBuffer as clearTerminalBuffer,
  isSharing as isTerminalSharing,
  isShellIntegrationSupported,
  startSharing as startTerminalSharing,
  stopSharing as stopTerminalSharing,
} from '../terminal/terminalShare';

let tunnel: TunnelManager | null = null;
let isRunning = false;
// 하단 Viewer Chat 패널 — 세션 시작 시 교사 모드로 자동 연결하기 위한 참조 (extension.ts에서 주입)
let viewerChatPanel: ViewerChatPanelProvider | undefined;

export function setViewerChatPanel(provider: ViewerChatPanelProvider): void {
  viewerChatPanel = provider;
}
// 동의 모달·서버 기동 중 재진입 차단 래치 — isRunning은 서버 기동 후에야 true가 되므로,
// 모달이 떠 있는 동안 Start를 또 누르면 두 세션이 동시에 기동을 시도한다(EADDRINUSE 유발).
let isStarting = false;

const CLOUDFLARED_CONSENT_KEY = 'codeClassLive.cloudflaredConsent';

// 터미널 공유 확인 대화상자를 이번 세션에서 다시 묻지 않기로 했는지. 세션 시작마다 초기화한다.
let terminalConsentSkipped = false;
// 확인 대화상자를 기다리는 동안 재진입해 두 번 공유가 시작되는 것을 막는 래치.
let isStartingTerminalShare = false;

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
  // 새 수업이 시작되므로 터미널 공유 확인 대화상자를 다시 묻는다.
  terminalConsentSkipped = false;

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

        // 하단 Viewer Chat 패널을 교사 모드로 연결 — 강사도 학생과 동일 UI로 채팅.
        // (패널 표시/포커스 처리는 connectAsTeacher 내부에서 resolve 여부에 따라 수행)
        viewerChatPanel?.connectAsTeacher(`ws://localhost:${config.port}`, teacherToken);

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

  // 터미널 공유 중지와 링버퍼 폐기. WS 서버가 살아 있는 동안 해야 학생에게
  // terminal:state {sharing:false} 가 전달된다. 링버퍼를 비우지 않으면 다음 수업에
  // 이전 수업의 출력이 남아 프라이버시 사고가 된다.
  try {
    stopTerminalSharing('session stopped');
    clearTerminalBuffer();
  } catch (err) {
    Logger.warn(`Terminal share cleanup failed: ${err}`);
  }
  terminalConsentSkipped = false;
  isStartingTerminalShare = false;

  // 교사 모드 채팅 패널 해제 (학생 모드 연결은 건드리지 않음)
  viewerChatPanel?.disconnectTeacher();

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

// 터미널 공유 ---------------------------------------------------------------

/**
 * 컨텍스트 메뉴가 넘겨준 인자가 터미널인지 덕 타이핑으로 확인한다.
 * terminal/context 계열이 넘기는 값은 VS Code 버전마다 다를 수 있어 캐스팅하지 않는다.
 */
function asTerminal(arg: unknown): vscode.Terminal | undefined {
  const t = arg as { name?: unknown; sendText?: unknown } | undefined;
  if (t && typeof t.name === 'string' && typeof t.sendText === 'function') {
    return arg as vscode.Terminal;
  }
  return undefined;
}

/**
 * 무엇이 나가고 무엇이 안 나가는지 알리는 1회 확인 대화상자.
 * 세션당 1회만 물으며, "다시 묻지 않기"는 이번 세션에만 유효하다.
 */
async function confirmTerminalShare(terminalName: string): Promise<boolean> {
  if (terminalConsentSkipped) return true;
  const proceed = '계속';
  const dontAsk = '이 세션에서 다시 묻지 않기';
  const choice = await vscode.window.showWarningMessage(
    `터미널 "${terminalName}" 을(를) 학생에게 공유할까요?`,
    {
      modal: true,
      detail:
        '학생에게 나가는 것: 이 터미널에서 실행한 명령줄, 그 출력, 작업 디렉터리, 종료 코드.\n' +
        '나가지 않는 것: 키 입력 자체, 다른 터미널, 화면 전체를 쓰는 프로그램(vim, htop 등)의 화면.\n\n' +
        '비밀정보 마스킹과 차단 명령 목록은 실수 방지 장치이며 보안 보장이 아닙니다. ' +
        '자격증명이 화면에 뜰 수 있는 작업은 공유를 끄고 하세요.',
    },
    proceed,
    dontAsk
  );
  if (choice === dontAsk) {
    terminalConsentSkipped = true;
    return true;
  }
  return choice === proceed;
}

/** shell integration을 쓸 수 없을 때의 안내. 지원 셸과 Windows 기본 프로필 변경법을 함께 준다. */
function showShellIntegrationHelp(message: string): void {
  vscode.window.showWarningMessage(message, {
    modal: true,
    detail:
      '터미널 공유는 VS Code 1.93 이상과 셸 통합(shell integration)이 필요합니다.\n' +
      '지원 셸: bash, zsh, fish, pwsh(PowerShell 7+), Git Bash.\n\n' +
      'Windows에서 기본 프로필이 Command Prompt(cmd.exe)이면 지원되지 않습니다. ' +
      '명령 팔레트에서 "Terminal: Select Default Profile"을 실행해 PowerShell을 고른 뒤 ' +
      '터미널을 새로 열고 다시 시도하세요.',
  });
}

async function shareTerminalCommand(arg?: unknown): Promise<void> {
  if (!isRunning) {
    vscode.window.showWarningMessage('먼저 Code Class Live Sharing 세션을 시작하세요.');
    return;
  }
  if (isStartingTerminalShare) return;

  // 컨텍스트 메뉴 인자가 없으면(명령 팔레트 실행) 활성 터미널을 쓴다.
  const terminal = asTerminal(arg) ?? vscode.window.activeTerminal;
  if (!terminal) {
    vscode.window.showWarningMessage('공유할 터미널이 없습니다. 터미널을 먼저 열어 주세요.');
    return;
  }

  if (!isShellIntegrationSupported()) {
    showShellIntegrationHelp('이 VS Code 버전은 터미널 공유를 지원하지 않습니다.');
    return;
  }

  isStartingTerminalShare = true;
  try {
    if (!(await confirmTerminalShare(terminal.name))) return;
    await startTerminalSharing(terminal);
    vscode.window.showInformationMessage(`터미널 "${terminal.name}" 을(를) 학생에게 공유합니다.`);
  } catch (err) {
    Logger.warn(`Terminal sharing failed: ${err}`);
    showShellIntegrationHelp(err instanceof Error ? err.message : String(err));
  } finally {
    isStartingTerminalShare = false;
  }
}

function stopShareTerminalCommand(): void {
  // 공유 중이 아니면 조용히 아무것도 하지 않는다 (에러로 처리하지 않는다).
  if (!isTerminalSharing()) return;
  stopTerminalSharing('stopped by teacher');
  vscode.window.showInformationMessage('터미널 공유를 중지했습니다.');
}

/** 터미널 공유 명령 2개를 등록한다. extension.ts에서 1회 호출한다. */
export function registerTerminalCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeClassLive.shareTerminal', (arg?: unknown) => shareTerminalCommand(arg))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('codeClassLive.stopShareTerminal', () => stopShareTerminalCommand())
  );
}
