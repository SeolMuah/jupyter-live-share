import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { addNewViewerListener, broadcastAuthenticated, sendSnapshot } from '../server/wsServer';
import {
  createLineFolder,
  createSecretMasker,
  isBlockedCommand,
  looksLikeFullScreenTui,
  maskSecrets,
  mentionsSensitiveFile,
  mentionsSensitiveFileInOutput,
  stripEscapes,
  DEFAULT_BLOCKED_PATTERNS,
  SecretMasker,
  maskCommandLine,
} from './ansiNormalize';

/**
 * 강사가 고른 VS Code 통합 터미널 하나의 명령과 출력을 학생 뷰어로 미러링한다.
 *
 * 캡처는 shell integration API(VS Code 1.93+)에 의존한다. package.json의 engines는
 * ^1.82.0 그대로이므로 이 파일 안에서 최소 타입을 선언하고 런타임에 존재를 확인한다.
 * 없으면 조용히 아무것도 하지 않는다(구버전에서 확장 전체가 죽으면 안 된다).
 */

// shell integration API의 최소 타입. @types/vscode 버전과 무관하게 컴파일되도록 로컬 선언한다.
interface ShellCommandLineLike {
  value?: string;
  confidence?: number;
  isTrusted?: boolean;
}
interface ShellExecutionLike {
  commandLine?: ShellCommandLineLike;
  cwd?: unknown;
  read(): AsyncIterable<string>;
}
interface ShellExecutionStartEvent {
  terminal: vscode.Terminal;
  execution: ShellExecutionLike;
}
interface ShellExecutionEndEvent {
  terminal: vscode.Terminal;
  execution: ShellExecutionLike;
  exitCode?: number;
}
type EventLike<T> = (listener: (e: T) => void) => vscode.Disposable;
interface ShellIntegrationApi {
  onDidStartTerminalShellExecution?: EventLike<ShellExecutionStartEvent>;
  onDidEndTerminalShellExecution?: EventLike<ShellExecutionEndEvent>;
  onDidChangeTerminalShellIntegration?: EventLike<{ terminal: vscode.Terminal }>;
}

/** commandLine.confidence 의 Low 값. 낮으면 fail-closed로 출력을 보내지 않는다. */
const CONFIDENCE_LOW = 0;

/** terminal:data 스로틀 간격. watcher.ts의 throttleCellOutput과 같은 leading+trailing 방식이다. */
const DATA_THROTTLE_MS = 100;

/** 스냅샷 상한(설계안 §5.2). 자기증폭 재접속 루프를 막는 값이라 설정으로 열지 않는다. */
const SNAPSHOT_MAX_ENTRIES = 10;
const SNAPSHOT_MAX_BYTES = 256 * 1024;

interface TerminalEntry {
  execId: string;
  commandLine: string;
  cwd: string;
  startedAt: number;
  output: string;
  exitCode: number | null;
  endedAt: number | null;
  truncated: boolean;
  blocked: boolean;
  unsupported: boolean;
}

interface LiveExec {
  entry: TerminalEntry;
  folder: ReturnType<typeof createLineFolder>;
  masker: SecretMasker;
  pending: string;          // 스로틀 대기 중인 전송 버퍼
  lastSentAt: number;
  trailingTimer: NodeJS.Timeout | null;
  bytes: number;            // 정규화 이후 누적 바이트
  controlCount: number;
  visibleChars: number;
  limitBytes: number;
  ended: boolean;
  gen: number;
  blockNotified?: boolean;
}

let sharing = false;
// 공유 세션 세대. startSharing마다 증가한다. read 루프가 자기 세대를 확인해
// '중지 후 다른 터미널 공유' 시 이전 터미널의 스트림이 되살아나는 것을 막는다.
let shareGen = 0;
let targetTerminal: vscode.Terminal | undefined;
let entries: TerminalEntry[] = [];
const liveExecs = new Map<ShellExecutionLike, LiveExec>();
let execSeq = 0;
let cachedFull: unknown = null;
let sharingChangeCallbacks: Array<(sharing: boolean, terminalName?: string) => void> = [];
let disposables: vscode.Disposable[] = [];
let initialized = false;

// 설정 -----------------------------------------------------------------

function cfg() {
  return vscode.workspace.getConfiguration('codeClassLive');
}

function getMaskSecrets(): boolean {
  return cfg().get<boolean>('terminal.maskSecrets', true) !== false;
}

function getMaxOutputBytes(): number {
  const kb = cfg().get<number>('terminal.maxOutputKB', 64);
  const clamped = Math.max(1, Math.min(256, typeof kb === 'number' && isFinite(kb) ? kb : 64));
  return clamped * 1024;
}

function getMaxCommands(): number {
  const n = cfg().get<number>('terminal.maxCommands', 50);
  return Math.max(1, Math.min(100, typeof n === 'number' && isFinite(n) ? n : 50));
}

function getBlockedPatterns(): string[] {
  const list = cfg().get<string[]>('terminal.blockedCommandPatterns', DEFAULT_BLOCKED_PATTERNS);
  return Array.isArray(list) && list.length > 0 ? list : DEFAULT_BLOCKED_PATTERNS;
}

// 유틸 -----------------------------------------------------------------

function shellApi(): ShellIntegrationApi {
  return vscode.window as unknown as ShellIntegrationApi;
}

/** shell integration 캡처 API가 이 VS Code 런타임에 있는지 확인한다. */
export function isShellIntegrationSupported(): boolean {
  const api = shellApi();
  return typeof api.onDidStartTerminalShellExecution === 'function';
}

/** cwd는 실제 API에서 Uri이므로 문자열로 정규화한다. */
function toCwdString(cwd: unknown): string {
  if (!cwd) return '';
  if (typeof cwd === 'string') return cwd;
  const u = cwd as { fsPath?: string; path?: string };
  return u.fsPath || u.path || '';
}

function invalidateSnapshot() {
  cachedFull = null;
}

function notifySharingChange() {
  for (const cb of [...sharingChangeCallbacks]) {
    try { cb(sharing, targetTerminal?.name); } catch (err) { Logger.error('terminal sharing callback failed', err); }
  }
}

// 링버퍼와 스냅샷 -------------------------------------------------------

function pushEntry(entry: TerminalEntry) {
  entries.push(entry);
  const max = getMaxCommands();
  while (entries.length > max) {
    const dropped = entries.shift();
    // 끝나지 않은 채 밀려난 실행은 맵에 남으면 누수가 되므로 함께 정리한다.
    if (dropped) {
      for (const [key, live] of liveExecs) {
        if (live.entry === dropped) { clearLive(live); liveExecs.delete(key); }
      }
    }
  }
  invalidateSnapshot();
}

function clearLive(live: LiveExec) {
  if (live.trailingTimer) { clearTimeout(live.trailingTimer); live.trailingTimer = null; }
}

function buildSnapshot(): unknown {
  if (cachedFull) return cachedFull;
  // 공유 중이 아니면 내용을 아예 담지 않는다. 링버퍼는 유지되므로, 담으면
  // '공유 중지' 이후 접속한 학생에게 중지 전 출력이 그대로 전송된다(화면에 안 그려도 전송은 된다).
  if (!sharing) {
    const empty = { sharing: false, terminalName: undefined, omitted: 0, entries: [] };
    cachedFull = empty;
    return empty;
  }
  const recent = entries.slice(-SNAPSHOT_MAX_ENTRIES);
  const picked: TerminalEntry[] = [];
  let total = 0;
  // 최신부터 담고 상한을 넘으면 멈춘다. 넘긴 개수는 omitted로 알린다.
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i];
    const size = Buffer.byteLength(e.output, 'utf8') + Buffer.byteLength(e.commandLine, 'utf8')
      + Buffer.byteLength(e.cwd || '', 'utf8') + 128;
    if (total + size > SNAPSHOT_MAX_BYTES) break;
    total += size;
    picked.unshift(e);
  }
  const snapshot = {
    sharing,
    terminalName: targetTerminal?.name,
    omitted: entries.length - picked.length,
    entries: picked.map((e) => ({ ...e })),
  };
  cachedFull = snapshot;
  return snapshot;
}

// 전송 -----------------------------------------------------------------

function sendData(live: LiveExec) {
  const chunk = live.pending;
  live.pending = '';
  live.lastSentAt = Date.now();
  if (!chunk) return;
  broadcastAuthenticated('terminal:data', { execId: live.entry.execId, chunk });
}

/** watcher.ts:303의 throttleCellOutput과 같은 leading+trailing 스로틀. */
function throttleSend(live: LiveExec) {
  const now = Date.now();
  const since = now - live.lastSentAt;
  if (since < DATA_THROTTLE_MS) {
    if (live.trailingTimer) clearTimeout(live.trailingTimer);
    live.trailingTimer = setTimeout(() => {
      live.trailingTimer = null;
      try { sendData(live); } catch (err) { Logger.error('terminal:data trailing failed', err); }
    }, DATA_THROTTLE_MS - since);
    return;
  }
  sendData(live);
}

/** 이 실행의 출력 전송을 중단하고 이미 쌓인 내용을 폐기한다. */
function blockExec(live: LiveExec, reason: string) {
  live.entry.blocked = true;
  live.entry.output = '';
  live.pending = '';
  clearLive(live);
  invalidateSnapshot();
  // 종료를 기다리지 않고 즉시 알린다. 대화형 대기나 장시간 스트림처럼 종료 이벤트가
  // 늦게 오는(또는 안 오는) 실행에서는, 차단 이전에 이미 보낸 청크가 학생 화면에 계속 남는다.
  if (!live.blockNotified) {
    live.blockNotified = true;
    broadcastAuthenticated('terminal:end', {
      execId: live.entry.execId,
      exitCode: null,
      endedAt: Date.now(),
      truncated: live.entry.truncated,
      blocked: true,
      unsupported: live.entry.unsupported,
    });
  }
  Logger.warn(`Terminal output blocked (${reason}): ${live.entry.execId}`);
}

// 캡처 -----------------------------------------------------------------

function appendOutput(live: LiveExec, text: string) {
  if (!text) return;
  const entry = live.entry;
  if (entry.blocked || entry.unsupported) return;

  let piece = text;
  const size = Buffer.byteLength(piece, 'utf8');
  if (live.bytes + size > live.limitBytes) {
    // 상한을 넘으면 넘는 지점까지만 남기고 이후 출력은 서버에서도 버린다.
    const room = live.limitBytes - live.bytes;
    if (room > 0) {
      const buf = Buffer.from(piece, 'utf8').subarray(0, room);
      piece = buf.toString('utf8');
    } else {
      piece = '';
    }
    entry.truncated = true;
  }
  if (!piece) { invalidateSnapshot(); return; }

  live.bytes += Buffer.byteLength(piece, 'utf8');
  entry.output += piece;

  // 민감 파일명은 명령줄뿐 아니라 출력에도 적용한다. 첫 전송 전에 걸러야 의미가 있다.
  if (mentionsSensitiveFileInOutput(entry.output)) {
    blockExec(live, 'sensitive filename in output');
    return;
  }

  live.pending += piece;
  invalidateSnapshot();
  throttleSend(live);
}

function handleChunk(live: LiveExec, raw: string) {
  const norm = stripEscapes(raw);
  live.controlCount += norm.controlCount;
  live.visibleChars += norm.text.length;

  if (!live.entry.unsupported && looksLikeFullScreenTui(live.controlCount, live.visibleChars)) {
    // 전체 화면 TUI는 줄 단위로 재현할 수 없다. 본문을 비우고 배지로만 알린다.
    live.entry.unsupported = true;
    live.entry.output = '';
    live.pending = '';
    clearLive(live);
    invalidateSnapshot();
    return;
  }

  const folded = live.folder.push(norm.text);
  if (!folded) return;
  appendOutput(live, live.masker.push(folded));
}

function finishExec(live: LiveExec, exitCode: number | null) {
  if (live.ended) return;
  live.ended = true;

  // 남은 미완결 줄과 마스커 꼬리를 마지막으로 흘려보낸다.
  const tail = live.folder.flush();
  if (tail) appendOutput(live, live.masker.push(tail));
  const rest = live.masker.flush();
  if (rest) appendOutput(live, rest);

  if (live.trailingTimer) { clearTimeout(live.trailingTimer); live.trailingTimer = null; }
  if (live.pending) sendData(live);

  live.entry.exitCode = exitCode;
  live.entry.endedAt = Date.now();
  invalidateSnapshot();

  broadcastAuthenticated('terminal:end', {
    execId: live.entry.execId,
    exitCode: live.entry.exitCode,
    endedAt: live.entry.endedAt,
    truncated: live.entry.truncated,
    blocked: live.entry.blocked,
    unsupported: live.entry.unsupported,
  });
}

function onExecutionStart(e: ShellExecutionStartEvent) {
  if (!sharing || !targetTerminal || e.terminal !== targetTerminal) return;

  const cl = e.execution.commandLine;
  const rawCommand = (cl?.value || '').trim();
  // fail-closed: 명령줄을 못 얻었거나 신뢰도가 낮으면 출력을 보내지 않는다.
  const lowConfidence = !rawCommand || cl?.confidence === undefined || cl.confidence === CONFIDENCE_LOW;
  const patterns = getBlockedPatterns();
  const blocked =
    lowConfidence ||
    isBlockedCommand(rawCommand, patterns) ||
    mentionsSensitiveFile(rawCommand);

  // 명령줄 자체에 토큰이 실려 있을 수 있으므로 카드 헤더도 마스킹해서 보낸다.
  const commandLine = getMaskSecrets() ? maskSecrets(rawCommand) : rawCommand;

  const entry: TerminalEntry = {
    execId: `x${++execSeq}`,
    commandLine,
    cwd: toCwdString(e.execution.cwd),
    startedAt: Date.now(),
    output: '',
    exitCode: null,
    endedAt: null,
    truncated: false,
    blocked,
    unsupported: false,
  };

  const live: LiveExec = {
    entry,
    folder: createLineFolder(),
    masker: createSecretMasker(getMaskSecrets()),
    pending: '',
    lastSentAt: 0,
    trailingTimer: null,
    bytes: 0,
    controlCount: 0,
    visibleChars: 0,
    limitBytes: getMaxOutputBytes(),
    ended: false,
    gen: shareGen,
  };

  pushEntry(entry);
  liveExecs.set(e.execution, live);

  // 명령줄에 인라인으로 박힌 자격증명을 지운다. 차단된 명령이라도 명령줄은 표시되므로
  // (`export DB_PASSWORD=...`, `mysql -phunter2`) 여기서 걸러야 새지 않는다.
  entry.commandLine = maskCommandLine(entry.commandLine);

  broadcastAuthenticated('terminal:start', {
    execId: entry.execId,
    commandLine: entry.commandLine,
    cwd: entry.cwd,
    startedAt: entry.startedAt,
  });

  // read()는 호출 전 출력을 유실하므로 핸들러 안에서 즉시 호출해야 한다.
  let stream: AsyncIterable<string> | undefined;
  try {
    stream = e.execution.read();
  } catch (err) {
    Logger.error('terminal execution.read failed', err);
    return;
  }

  void (async () => {
    try {
      for await (const raw of stream as AsyncIterable<string>) {
        // 세대가 바뀌었다면 이 스트림은 지난 공유 세션 소속이다. 소비를 멈춘다.
        if (live.gen !== shareGen) break;
        if (!sharing || live.entry.blocked) continue;
        handleChunk(live, raw);
      }
    } catch (err) {
      Logger.error('terminal read loop failed', err);
    }
  })();
}

function onExecutionEnd(e: ShellExecutionEndEvent) {
  const live = liveExecs.get(e.execution);
  if (!live) return;
  liveExecs.delete(e.execution);
  // 종료 시점에 명령줄 신뢰도가 올라가는 경우가 있지만, 출력은 이미 나갔으므로
  // 시작 시점의 판정을 그대로 유지한다(뒤늦게 완화하면 fail-closed가 무의미해진다).
  finishExec(live, typeof e.exitCode === 'number' ? e.exitCode : null);
}

// 공개 API --------------------------------------------------------------

/** 확장 활성화 시 1회 호출한다. 이벤트 구독과 신규 접속자 스냅샷 리스너를 등록한다. */
export function initTerminalShare(): vscode.Disposable {
  if (initialized) {
    return new vscode.Disposable(() => { /* 중복 초기화 무시 */ });
  }
  initialized = true;

  const api = shellApi();
  if (typeof api.onDidStartTerminalShellExecution === 'function') {
    disposables.push(api.onDidStartTerminalShellExecution((e) => {
      try { onExecutionStart(e); } catch (err) { Logger.error('onDidStartTerminalShellExecution failed', err); }
    }));
  } else {
    Logger.info('Terminal shell integration API not available; terminal sharing disabled');
  }
  if (typeof api.onDidEndTerminalShellExecution === 'function') {
    disposables.push(api.onDidEndTerminalShellExecution((e) => {
      try { onExecutionEnd(e); } catch (err) { Logger.error('onDidEndTerminalShellExecution failed', err); }
    }));
  }

  disposables.push(vscode.window.onDidCloseTerminal((t) => {
    if (sharing && t === targetTerminal) stopSharing('terminal closed');
  }));

  // 공유 중이 아니어도 sharing:false 스냅샷을 보내야 학생 버튼이 확실히 숨겨진다.
  const listener = addNewViewerListener((ws) => {
    try { sendSnapshot(ws, 'terminal:full', buildSnapshot()); } catch (err) { Logger.error('terminal:full snapshot failed', err); }
  });
  disposables.push(new vscode.Disposable(() => listener.dispose()));

  return new vscode.Disposable(() => {
    for (const d of disposables) { try { d.dispose(); } catch { /* 무시 */ } }
    disposables = [];
    for (const live of liveExecs.values()) clearLive(live);
    liveExecs.clear();
    sharingChangeCallbacks = [];
    sharing = false;
    targetTerminal = undefined;
    initialized = false;
  });
}

/**
 * 대상 터미널의 공유를 시작한다. shell integration이 아직 붙지 않았으면 최대 3초 기다린다.
 * 지원되지 않는 셸이면 예외를 던지고, 호출자가 안내 메시지를 띄운다.
 */
export async function startSharing(terminal: vscode.Terminal): Promise<void> {
  if (!isShellIntegrationSupported()) {
    throw new Error('이 VS Code 버전은 터미널 공유를 지원하지 않습니다. VS Code 1.93 이상이 필요합니다.');
  }

  const hasIntegration = () => (terminal as unknown as { shellIntegration?: unknown }).shellIntegration !== undefined;

  if (!hasIntegration()) {
    const api = shellApi();
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); sub?.dispose(); resolve(); };
      const timer = setTimeout(finish, 3000);
      const sub = typeof api.onDidChangeTerminalShellIntegration === 'function'
        ? api.onDidChangeTerminalShellIntegration((e) => { if (e.terminal === terminal) finish(); })
        : undefined;
      if (!sub) { /* 이벤트가 없으면 타이머만 기다린다 */ }
    });
  }

  if (!hasIntegration()) {
    throw new Error('이 터미널에서 셸 통합(shell integration)이 활성화되지 않았습니다. bash, zsh, pwsh, fish 중 하나를 기본 프로필로 사용해 주세요.');
  }

  shareGen++;
  sharing = true;
  targetTerminal = terminal;
  invalidateSnapshot();
  broadcastAuthenticated('terminal:state', { sharing: true, terminalName: terminal.name });
  notifySharingChange();
  Logger.info(`Terminal sharing started: ${terminal.name}`);
}

/** 공유를 중지한다. 링버퍼는 유지한다(폐기는 clearBuffer가 담당). */
export function stopSharing(reason?: string): void {
  if (!sharing && !targetTerminal) {
    broadcastAuthenticated('terminal:state', { sharing: false });
    return;
  }
  sharing = false;
  targetTerminal = undefined;
  for (const live of liveExecs.values()) clearLive(live);
  liveExecs.clear();
  invalidateSnapshot();
  broadcastAuthenticated('terminal:state', { sharing: false });
  notifySharingChange();
  Logger.info(`Terminal sharing stopped${reason ? ` (${reason})` : ''}`);
}

export function isSharing(): boolean {
  return sharing;
}

export function getSharedTerminalName(): string | undefined {
  return targetTerminal?.name;
}

/** 세션 종료 시 호출한다. 다음 수업에 이전 출력이 남지 않게 링버퍼와 캐시를 비운다. */
export function clearBuffer(): void {
  entries = [];
  for (const live of liveExecs.values()) clearLive(live);
  liveExecs.clear();
  execSeq = 0;
  invalidateSnapshot();
}

export function onSharingChange(cb: (sharing: boolean, terminalName?: string) => void): void {
  sharingChangeCallbacks.push(cb);
}
