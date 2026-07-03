import * as http from 'http';
import * as crypto from 'crypto';
import WebSocket from 'ws';
import { Logger } from '../utils/logger';

export interface WsMessage {
  type: string;
  data: unknown;
}

interface ClientMeta {
  authenticated: boolean;
  isTeacher: boolean;
  isTeacherPanel: boolean;
  nickname: string | null;
  lastMessageTimes: number[];
  countedAsViewer: boolean; // Track if this client has been counted in viewerCount
  countedAsChatOnly: boolean; // Track if this client has been counted in chatOnlyCount
}

interface PollState {
  pollId: string;
  question: string;
  optionCount: number;
  options: string[] | null; // null = number mode, string[] = text label mode
  votes: number[];
  voterChoices: Map<WebSocket, number>;
}

// Read-only poll state for external consumers (no mutable references)
export interface PollStateReadonly {
  pollId: string;
  question: string;
  optionCount: number;
  options: readonly string[] | null;
  votes: readonly number[];
  totalVoters: number;
}

let wss: WebSocket.Server | null = null;
let viewerCount = 0;
let chatOnlyCount = 0;
let onViewerCountChange: ((count: number) => void) | null = null;
let sessionPin: string | null = null;
let teacherName: string = 'Teacher';
let teacherToken: string | null = null;
const clientMeta: Map<WebSocket, ClientMeta> = new Map();
let currentPoll: PollState | null = null;
let chatMessageId = 0;

// WS frame size ceiling — must exceed the largest legitimate payload
// (notebook:full / cell:output with base64 images, capped at MAX_OUTPUT_SIZE=5MB per cell in serializer.ts)
// while still bounding frame size against abuse.
const WS_MAX_PAYLOAD = 16 * 1024 * 1024; // 16MB

// Backpressure protection (선생님 VS Code 프로세스 메모리 보호):
// - HARD limit 초과 = 클라이언트가 전송을 전혀 따라잡지 못함 → 소켓 terminate. 뷰어는 자동
//   재접속해 notebook:full/document:full로 최신 상태를 통째로 다시 받으므로 정합성 보장.
//   (메시지를 선택적으로 드롭하지 않는 이유: cell:output 같은 1회성 이벤트나 편집 버스트의
//    마지막 cell:update를 드롭하면 그 학생만 영구 stale 됨.)
// - SOFT limit 초과 시에는 "손실돼도 무해한 순간 UI 힌트"(커서/스크롤)만 건너뛴다. 이들은
//   문서 상태가 아니라 일시적 위치 정보라 한두 개 빠져도 다음 것으로 즉시 갱신된다.
const WS_SOFT_LIMIT = 2 * 1024 * 1024;  // 2MB
const WS_HARD_LIMIT = 16 * 1024 * 1024; // 16MB (단일 메시지 최대치 WS_MAX_PAYLOAD 수준)

// 손실돼도 무해한 순간성(ephemeral) 메시지 — SOFT limit에서만 스킵 가능.
const EPHEMERAL_TYPES = new Set([
  'cursor:position',
  'scroll:sync',
]);

let heartbeatInterval: NodeJS.Timeout | null = null;
const HEARTBEAT_INTERVAL_MS = 30000;

// 연결 남용 방어(가용성): 터널 뒤에서는 모든 원격이 127.0.0.1로 보여 IP 기반 방어가
// 불가능하므로, join을 완료하지 않은 소켓이 FD/메모리를 점유하는 것을 시간·총량으로 제한한다.
const UNAUTHENTICATED_GRACE_MS = 15000; // join 없이 이 시간 경과 시 소켓 정리
// 전체 동시연결 상한 = maxViewers 기준 여유분(chatOnly + 교사 패널 2개 등)을 더해 산출.
const CONNECTION_CAP_BASE = 16;
const CONNECTION_CAP_MULTIPLIER = 2;

interface DrawStroke {
  strokeId: string;
  tool: 'pen' | 'highlighter' | 'eraser';
  color: string;
  width: number;
  alpha: number;
  points: Array<{ cellIndex: number; xRatio: number; yRatio: number }>;
}

let drawStrokes: DrawStroke[] = [];
let lastScrollSync: unknown = null;
const MAX_DRAW_STROKES = 500;
const MAX_POINTS_PER_STROKE = 5000;

// Rate limit constants
const RATE_LIMIT_WINDOW = 10000; // 10 seconds
const RATE_LIMIT_MAX = 5; // max 5 messages per window
const RATE_LIMIT_MIN_INTERVAL = 500; // min 500ms between messages
const MAX_MESSAGE_LENGTH = 500;

export function setSessionPin(pin: string | null) {
  sessionPin = pin;
}

export function setTeacherName(name: string) {
  teacherName = name || 'Teacher';
}

export function setTeacherToken(token: string | null) {
  teacherToken = token;
}

export function getTeacherToken(): string | null {
  return teacherToken;
}

export function setOnViewerCountChange(callback: (count: number) => void) {
  onViewerCountChange = callback;
}

export function getViewerCount(): number {
  return viewerCount;
}

export function getCurrentPollState(): PollStateReadonly | null {
  if (!currentPoll) return null;
  // Return read-only snapshot - no mutable references exposed
  return {
    pollId: currentPoll.pollId,
    question: currentPoll.question,
    optionCount: currentPoll.optionCount,
    options: currentPoll.options ? [...currentPoll.options] : null, // cloned or null
    votes: [...currentPoll.votes], // cloned array
    totalVoters: currentPoll.voterChoices.size, // only the count, not the Map
  };
}

// Cloudflare 터널을 거치면 원격 학생의 접속도 서버 입장에서는 127.0.0.1로 보인다.
// 따라서 소스 IP는 더 이상 신뢰할 수 없는 신호이며, 교사 권한은 반드시
// 세션 시작 시 발급된 비밀 토큰(constant-time 비교)으로만 부여한다.
function isValidTeacherToken(candidate: unknown): boolean {
  if (!teacherToken || typeof candidate !== 'string' || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(teacherToken);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isValidDrawStroke(data: unknown): data is DrawStroke {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (typeof d.strokeId !== 'string' || !d.strokeId) return false;
  if (!Array.isArray(d.points) || d.points.length === 0) return false;
  if (d.points.length > MAX_POINTS_PER_STROKE) return false;
  if (typeof d.color !== 'string') return false;
  if (typeof d.width !== 'number' || d.width <= 0 || d.width > 100) return false;
  return true;
}

function checkRateLimit(meta: ClientMeta): string | null {
  const now = Date.now();

  // Check minimum interval
  if (meta.lastMessageTimes.length > 0) {
    const lastTime = meta.lastMessageTimes[meta.lastMessageTimes.length - 1];
    if (now - lastTime < RATE_LIMIT_MIN_INTERVAL) {
      return 'Too fast. Please wait a moment.';
    }
  }

  // Remove old entries outside the window
  meta.lastMessageTimes = meta.lastMessageTimes.filter(t => now - t < RATE_LIMIT_WINDOW);

  // Check max messages in window
  if (meta.lastMessageTimes.length >= RATE_LIMIT_MAX) {
    return 'Too many messages. Please wait a few seconds.';
  }

  meta.lastMessageTimes.push(now);
  return null;
}

export function startPoll(question: string, optionCount: number, pollId: string, options?: string[]): void {
  const opts = options && options.length === optionCount ? options : null;
  currentPoll = {
    pollId,
    question,
    optionCount,
    options: opts,
    votes: new Array(optionCount).fill(0),
    voterChoices: new Map(),
  };
  broadcast('poll:start', { pollId, question, optionCount, ...(opts ? { options: opts } : {}) });
  Logger.info(`Poll started: "${question}" with ${optionCount} options`);
}

export function endPoll(): { pollId: string; finalVotes: number[]; totalVoters: number; options?: string[] } | null {
  if (!currentPoll) return null;
  const result: { pollId: string; finalVotes: number[]; totalVoters: number; options?: string[] } = {
    pollId: currentPoll.pollId,
    finalVotes: [...currentPoll.votes],
    totalVoters: currentPoll.voterChoices.size,
  };
  if (currentPoll.options) {
    result.options = currentPoll.options;
  }
  broadcast('poll:end', result);
  Logger.info(`Poll ended: "${currentPoll.question}"`);
  currentPoll = null;
  return result;
}

export function startWsServer(
  httpServer: http.Server,
  maxViewers: number
): WebSocket.Server {
  // permessage-deflate는 백프레셔(bufferedAmount)와 상호작용해 지속 버스트 시 전 클라이언트
  // 전송이 교착되는 문제가 부하테스트에서 확인되어 비활성화한다. (대역폭 절감보다 안정성 우선)
  wss = new WebSocket.Server({
    server: httpServer,
    maxPayload: WS_MAX_PAYLOAD,
  });

  // 전체 동시연결 하드캡: join 여부와 무관하게 소켓 수 자체를 상한으로 묶어
  // 미인증 연결 홍수로 인한 FD/메모리 고갈(DoS)을 방어한다.
  const connectionCap = maxViewers * CONNECTION_CAP_MULTIPLIER + CONNECTION_CAP_BASE;

  wss.on('connection', (ws) => {
    // 이 시점에 새 소켓은 이미 wss.clients에 포함되어 size에 반영되어 있다.
    if (wss && wss.clients.size > connectionCap) {
      try { ws.close(1013, 'Server busy'); } catch { /* 이미 닫힘 */ }
      return;
    }

    // isTeacher는 더 이상 소스 IP로 부여하지 않는다 (터널을 거치면 모든 원격 학생이
    // 127.0.0.1로 보이는 문제). join 메시지에서 유효한 teacherToken을 제시한 경우에만 true가 된다.
    const meta: ClientMeta = {
      authenticated: !sessionPin,
      isTeacher: false,
      isTeacherPanel: false,
      nickname: null,
      lastMessageTimes: [],
      countedAsViewer: false,
      countedAsChatOnly: false,
    };
    clientMeta.set(ws, meta);

    // 미인증(join 미완료) 유예 타이머: 시간 내 어떤 형태로도 join하지 않으면 소켓을 정리한다.
    const graceTimer = setTimeout(() => {
      if (!meta.countedAsViewer && !meta.countedAsChatOnly && !meta.isTeacherPanel) {
        try { ws.close(4008, 'Join timeout'); } catch { /* 이미 닫힘 */ }
      }
    }, UNAUTHENTICATED_GRACE_MS);

    // Heartbeat liveness flag — reset to true on connect and on every pong.
    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    ws.on('pong', () => {
      (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    });

    ws.on('message', (raw) => {
      try {
        const msg: WsMessage = JSON.parse(raw.toString());

        if (msg.type === 'join') {
          const joinData = msg.data as { pin?: string; teacherPanel?: boolean; chatOnly?: boolean; teacherToken?: string };

          // 멱등성 가드: 이 소켓이 이미 join을 완료했다면(교사패널/채팅/뷰어 어느 형태든)
          // 재처리하지 않는다. 신뢰 불가한 클라이언트가 join을 반복 전송해 viewerCount/
          // chatOnlyCount를 부풀려 정원을 소진시키는 DoS(griefing)를 차단한다.
          if (meta.countedAsViewer || meta.countedAsChatOnly || meta.isTeacherPanel) {
            sendTo(ws, 'join:result', { success: true });
            return;
          }

          // Teacher Panel connection (sidebar WebSocket / Teacher Preview webview / 교사 브라우저 탭)
          // 오직 유효한 teacherToken을 제시한 경우에만 교사 권한을 부여한다.
          // 무효/빈 토큰(세션 시작 전 생성된 패널, 이전 세션의 stale 토큰)은 학생 분기로
          // 폴스루시키지 않고 명시적으로 거부한다 — 교사 연결이 어떤 경로로도 학생 수
          // (viewerCount)에 오염되지 않게 보장 (4003은 클라이언트의 재접속 제외 코드).
          if (joinData.teacherPanel && !isValidTeacherToken(joinData.teacherToken)) {
            Logger.warn('Rejected teacherPanel join with invalid/stale token');
            sendTo(ws, 'join:result', { success: false, error: 'Invalid teacher token' });
            ws.close(4003, 'Invalid teacher token');
            return;
          }
          if (joinData.teacherPanel && isValidTeacherToken(joinData.teacherToken)) {
            meta.authenticated = true;
            meta.isTeacher = true;
            meta.isTeacherPanel = true;
            meta.nickname = teacherName;
            sendTo(ws, 'join:result', { success: true });
            // Send current viewer count
            sendTo(ws, 'viewers:count', { count: viewerCount });
            // Send current poll state if active
            if (currentPoll) {
              sendTo(ws, 'poll:start', {
                pollId: currentPoll.pollId,
                question: currentPoll.question,
                optionCount: currentPoll.optionCount,
                ...(currentPoll.options ? { options: currentPoll.options } : {}),
              });
              sendTo(ws, 'poll:results', {
                pollId: currentPoll.pollId,
                votes: [...currentPoll.votes],
                totalVoters: currentPoll.voterChoices.size,
                ...(currentPoll.options ? { options: currentPoll.options } : {}),
              });
            }
            // Don't increment viewerCount or broadcast viewers:count
            if (onNewViewer) {
              onNewViewer(ws);
            }
            return;
          }

          // Chat-only connection (VS Code viewer chat panel)
          if (joinData.chatOnly) {
            if (sessionPin && joinData.pin !== sessionPin) {
              sendTo(ws, 'join:result', { success: false, error: 'Invalid PIN' });
              ws.close(4001, 'Invalid PIN');
              return;
            }
            // chatOnly는 학생 연결 — isTeacher는 기본값 false 그대로 유지
            // viewerCount에는 포함되지 않지만, maxViewers 우회를 막기 위해
            // 별도 카운터(chatOnlyCount)로 정원을 함께 검사한다.
            if (viewerCount + chatOnlyCount >= maxViewers) {
              sendTo(ws, 'join:result', { success: false, error: 'Session is full' });
              ws.close(4002, 'Session full');
              return;
            }
            meta.authenticated = true;
            meta.countedAsChatOnly = true;
            chatOnlyCount++;
            // NOT counted as viewer
            sendTo(ws, 'join:result', { success: true });
            // Send current poll state if active
            if (currentPoll) {
              sendTo(ws, 'poll:start', {
                pollId: currentPoll.pollId,
                question: currentPoll.question,
                optionCount: currentPoll.optionCount,
                ...(currentPoll.options ? { options: currentPoll.options } : {}),
              });
              sendTo(ws, 'poll:results', {
                pollId: currentPoll.pollId,
                votes: [...currentPoll.votes],
                totalVoters: currentPoll.voterChoices.size,
                ...(currentPoll.options ? { options: currentPoll.options } : {}),
              });
            }
            if (onNewViewer) {
              onNewViewer(ws);
            }
            return;
          }

          // PIN verification
          if (sessionPin && joinData.pin !== sessionPin) {
            sendTo(ws, 'join:result', { success: false, error: 'Invalid PIN' });
            ws.close(4001, 'Invalid PIN');
            return;
          }

          // Max viewers check — chatOnly 연결과 합산해 정원을 대칭적으로 검사한다.
          // (chatOnly 분기와 동일 기준. 한쪽만 chatOnlyCount를 무시하면 총 접속자가
          //  maxViewers를 최대 2배까지 초과할 수 있어 50~100명 안정화 목표를 깬다.)
          if (viewerCount + chatOnlyCount >= maxViewers) {
            sendTo(ws, 'join:result', { success: false, error: 'Session is full' });
            ws.close(4002, 'Session full');
            return;
          }

          meta.authenticated = true;
          meta.countedAsViewer = true;
          viewerCount++;
          Logger.info(`Viewer connected (total: ${viewerCount}, isTeacher: ${meta.isTeacher})`);

          sendTo(ws, 'join:result', { success: true });
          broadcast('viewers:count', { count: viewerCount });
          onViewerCountChange?.(viewerCount);

          if (onNewViewer) {
            onNewViewer(ws);
          }
          return;
        }

        // All other messages require authentication
        if (!meta.authenticated) return;

        if (msg.type === 'join:name') {
          const nameData = msg.data as { nickname: string };
          const nickname = (nameData.nickname || '').trim().slice(0, 30);
          if (nickname) {
            meta.nickname = nickname;
            Logger.info(`Viewer set name: ${nickname}`);
          }
          return;
        }

        if (msg.type === 'chat:message') {
          if (!meta.nickname) {
            sendTo(ws, 'chat:error', { error: 'Please set your name first.' });
            return;
          }

          const chatData = msg.data as { text: string };
          let text = (chatData.text || '').trim();
          if (!text) return;
          if (text.length > MAX_MESSAGE_LENGTH) {
            text = text.slice(0, MAX_MESSAGE_LENGTH);
          }

          // Rate limit (teachers are exempt)
          if (!meta.isTeacher) {
            const rateLimitError = checkRateLimit(meta);
            if (rateLimitError) {
              sendTo(ws, 'chat:error', { error: rateLimitError });
              return;
            }
          }

          chatMessageId++;
          broadcast('chat:broadcast', {
            id: chatMessageId,
            nickname: meta.nickname,
            text,
            timestamp: Date.now(),
            isTeacher: meta.isTeacherPanel,
          });
          return;
        }

        if (msg.type === 'poll:start') {
          if (!meta.isTeacher) return; // Only teacher
          const pollData = msg.data as { question: string; optionCount: number; pollId: string; options?: string[] };
          const question = (pollData.question || '').trim();
          const optionCount = Math.min(Math.max(pollData.optionCount || 2, 2), 10);
          const pollId = pollData.pollId || Date.now().toString();
          // Sanitize options
          const options = pollData.options?.map(o => (o || '').trim().slice(0, 100));
          startPoll(question, optionCount, pollId, options);
          return;
        }

        if (msg.type === 'poll:vote') {
          if (!currentPoll) return;
          const voteData = msg.data as { pollId: string; option: number };
          if (voteData.pollId !== currentPoll.pollId) return;

          const option = Math.floor(Number(voteData.option));
          if (isNaN(option) || option < 0 || option >= currentPoll.optionCount) return;

          // 1인 1표: 이미 투표했으면 무시
          if (currentPoll.voterChoices.has(ws)) return;

          currentPoll.voterChoices.set(ws, option);
          currentPoll.votes[option]++;

          broadcast('poll:results', {
            pollId: currentPoll.pollId,
            votes: [...currentPoll.votes],
            totalVoters: currentPoll.voterChoices.size,
            ...(currentPoll.options ? { options: currentPoll.options } : {}),
          });
          return;
        }

        if (msg.type === 'poll:end') {
          if (!meta.isTeacher) return;
          endPoll();
          return;
        }

        // Drawing events — exclude sender to avoid echo
        if (msg.type === 'draw:stroke') {
          if (!meta.isTeacher) return;
          const stroke = msg.data as DrawStroke;
          if (!isValidDrawStroke(stroke)) return;
          // Enforce max strokes limit
          if (drawStrokes.length >= MAX_DRAW_STROKES) {
            drawStrokes.shift(); // remove oldest
          }
          drawStrokes.push(stroke);
          broadcastExclude(ws, 'draw:stroke', msg.data);
          return;
        }
        if (msg.type === 'draw:stroking') {
          if (!meta.isTeacher) return;
          const sd = msg.data as Record<string, unknown>;
          if (!sd || !Array.isArray(sd.points) || sd.points.length > 200) return;
          broadcastExclude(ws, 'draw:stroking', msg.data);
          return;
        }
        if (msg.type === 'draw:undo') {
          if (!meta.isTeacher) return;
          const removed = drawStrokes.pop();
          if (removed) broadcastExclude(ws, 'draw:undo', { strokeId: removed.strokeId });
          return;
        }
        if (msg.type === 'draw:erase') {
          if (!meta.isTeacher) return;
          const eraseData = msg.data as { strokeId: string };
          const idx = drawStrokes.findIndex(s => s.strokeId === eraseData.strokeId);
          if (idx !== -1) {
            drawStrokes.splice(idx, 1);
            broadcastExclude(ws, 'draw:erase', eraseData);
          }
          return;
        }
        if (msg.type === 'draw:clear') {
          if (!meta.isTeacher) return;
          drawStrokes = [];
          broadcastExclude(ws, 'draw:clear', {});
          return;
        }

        if (msg.type === 'scroll:sync') {
          if (!meta.isTeacher) return;
          const d = msg.data as Record<string, unknown>;
          if (!d || typeof d !== 'object') return;
          if (d.type === 'notebook') {
            if (typeof d.cellIndex !== 'number' || typeof d.offsetRatio !== 'number') return;
          } else if (d.type === 'plaintext') {
            // 새 라인 앵커 또는 기존 비율 중 하나라도 있으면 유효
            if (typeof d.line !== 'number' && typeof d.scrollRatio !== 'number') return;
          } else {
            return;
          }
          lastScrollSync = msg.data;
          broadcast('scroll:sync', msg.data);
          return;
        }
      } catch (err) {
        Logger.error('WebSocket message parse error', err);
      }
    });

    ws.on('close', () => {
      clearTimeout(graceTimer);
      // Only decrement if this client was actually counted as a viewer
      if (meta.countedAsViewer) {
        meta.countedAsViewer = false; // Prevent double decrement
        viewerCount = Math.max(0, viewerCount - 1);
        Logger.info(`Viewer disconnected (total: ${viewerCount})`);
        broadcast('viewers:count', { count: viewerCount });
        onViewerCountChange?.(viewerCount);
      }
      if (meta.countedAsChatOnly) {
        meta.countedAsChatOnly = false; // Prevent double decrement
        chatOnlyCount = Math.max(0, chatOnlyCount - 1);
      }
      // 주의: currentPoll.voterChoices는 여기서 정리하지 않는다.
      // totalVoters(voterChoices.size)와 votes[] 합계의 일관성을 위해 endPoll에서 일괄 정리한다.
      // (연결 종료 시 삭제하면 votes[]는 그대로인데 totalVoters만 줄어 백분율이 100%를 초과할 수 있음)
      clientMeta.delete(ws);
    });

    ws.on('error', (err) => {
      Logger.error('WebSocket client error', err);
    });
  });

  // Heartbeat: reap dead/ghost connections (e.g. tunnel-side sockets that never sent a
  // close frame) so viewerCount stays honest and the client list doesn't grow unbounded.
  // ws.terminate() below fires the client's 'close' handler, which already decrements
  // viewerCount/chatOnlyCount correctly — no separate cleanup needed here.
  // 이전 세션의 인터벌이 남아있으면 정리 (start/stop 반복 시 인터벌 누수 방지)
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  heartbeatInterval = setInterval(() => {
    if (!wss) return;
    wss.clients.forEach((client) => {
      // setInterval 콜백은 VS Code가 감싸주지 않으므로, 여기서 throw가 새면 프로세스
      // uncaughtException이 된다. 소켓 하나의 ping/terminate 실패가 세션을 위협하지
      // 않도록 개별 격리한다 (ping은 OPEN 상태에서만 호출).
      try {
        const withAlive = client as WebSocket & { isAlive?: boolean };
        if (withAlive.isAlive === false) {
          client.terminate();
          return;
        }
        withAlive.isAlive = false;
        if (client.readyState === WebSocket.OPEN) client.ping();
      } catch (err) {
        Logger.error('heartbeat ping/terminate failed', err);
      }
    });
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('close', () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  });

  Logger.info('WebSocket server started');
  return wss;
}

export function getDrawStrokes(): DrawStroke[] { return [...drawStrokes]; }
export function clearDrawStrokes(): void { drawStrokes = []; }
export function getLastScrollSync(): unknown { return lastScrollSync; }
export function clearLastScrollSync(): void { lastScrollSync = null; }
export function setLastScrollSync(data: unknown): void { lastScrollSync = data; }

let onNewViewer: ((ws: WebSocket) => void) | null = null;

export function setOnNewViewer(callback: (ws: WebSocket) => void) {
  onNewViewer = callback;
}

export function broadcast(type: string, data: unknown) {
  if (!wss) return;

  const message = JSON.stringify({ type, data });

  wss.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return;
    const buffered = client.bufferedAmount;
    // 따라잡지 못하는 클라이언트는 종료 → 재접속 시 full-sync로 최신화 (내용 유실 없음).
    // 단 session:end는 terminate하지 않는다 — 직후 stopWsServer의 closeAllClients(1000)가
    // 정상 close를 보내므로, 여기서 terminate하면 1006 재접속 좀비를 만들 뿐이다.
    if (buffered > WS_HARD_LIMIT) { if (type !== 'session:end') client.terminate(); return; }
    // SOFT limit 초과 시 순간성 힌트(커서/스크롤)만 스킵 (문서 상태 메시지는 항상 전송).
    if (buffered > WS_SOFT_LIMIT && EPHEMERAL_TYPES.has(type)) return;
    // 한 소켓의 send가 동기적으로 throw해도 나머지 클라이언트 전파가 끊기지 않도록 격리한다.
    try { client.send(message); } catch (err) { Logger.error('broadcast send failed', err); }
  });
}

function broadcastExclude(exclude: WebSocket, type: string, data: unknown) {
  if (!wss) return;

  const message = JSON.stringify({ type, data });

  wss.clients.forEach((client) => {
    if (client === exclude || client.readyState !== WebSocket.OPEN) return;
    const buffered = client.bufferedAmount;
    if (buffered > WS_HARD_LIMIT) { client.terminate(); return; }
    if (buffered > WS_SOFT_LIMIT && EPHEMERAL_TYPES.has(type)) return;
    try { client.send(message); } catch (err) { Logger.error('broadcast send failed', err); }
  });
}

export function sendTo(ws: WebSocket, type: string, data: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

export function stopWsServer(): Promise<void> {
  return new Promise((resolve) => {
    viewerCount = 0;
    chatOnlyCount = 0;
    sessionPin = null;
    teacherName = 'Teacher';
    teacherToken = null;
    clientMeta.clear();
    currentPoll = null;
    chatMessageId = 0;
    drawStrokes = [];
    lastScrollSync = null;

    if (!wss) {
      resolve();
      return;
    }

    const SHUTDOWN_TIMEOUT = 3000;

    broadcast('session:end', {});

    const forceShutdown = setTimeout(() => {
      Logger.warn('WebSocket server graceful shutdown timed out, forcing close');
      terminateAllClients();
      wss = null;
      resolve();
    }, SHUTDOWN_TIMEOUT);

    wss.close(() => {
      clearTimeout(forceShutdown);
      Logger.info('WebSocket server stopped');
      wss = null;
      resolve();
    });

    // terminate()가 아닌 정상 close(1000)로 종료한다: terminate는 close frame 없이
    // 소켓을 파괴해, session:end 프레임을 미처 못 받은 클라이언트가 1006으로 무한
    // 재접속하다가 같은 포트의 '다음' 세션에 유령 재조인하는 경로를 만들었다.
    // 1000은 클라이언트(websocket.js)의 재접속 제외 코드라 프레임 유실과 무관하게 안전.
    // 느린/죽은 소켓은 위 SHUTDOWN_TIMEOUT의 terminateAllClients가 정리한다.
    closeAllClients(1000, 'Session ended');
  });
}

export function forceStopWsServer(): void {
  viewerCount = 0;
  chatOnlyCount = 0;
  sessionPin = null;
  teacherName = 'Teacher';
  teacherToken = null;
  clientMeta.clear();
  currentPoll = null;
  chatMessageId = 0;
  drawStrokes = [];
  lastScrollSync = null;

  if (wss) {
    try {
      broadcast('session:end', {});
    } catch { /* ignore */ }

    terminateAllClients();

    try {
      wss.close();
    } catch { /* ignore */ }
    wss = null;
  }
  Logger.info('WebSocket server force-stopped');
}

function terminateAllClients(): void {
  if (!wss) return;
  for (const client of wss.clients) {
    try {
      client.terminate();
    } catch { /* ignore */ }
  }
}

/** 정상 close 핸드셰이크로 전 클라이언트 종료 (버퍼 flush 후 close frame 전송). */
function closeAllClients(code: number, reason: string): void {
  if (!wss) return;
  for (const client of wss.clients) {
    try {
      client.close(code, reason);
    } catch { /* ignore */ }
  }
}
