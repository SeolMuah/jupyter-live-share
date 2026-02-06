import * as http from 'http';
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
let onViewerCountChange: ((count: number) => void) | null = null;
let sessionPin: string | null = null;
let teacherName: string = 'Teacher';
let clientMeta: Map<WebSocket, ClientMeta> = new Map();
let currentPoll: PollState | null = null;
let chatMessageId = 0;

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

function isLocalAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
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
  wss = new WebSocket.Server({ server: httpServer });

  wss.on('connection', (ws, req) => {
    const remoteAddress = req.socket.remoteAddress;
    const isTeacher = isLocalAddress(remoteAddress);

    const meta: ClientMeta = {
      authenticated: !sessionPin,
      isTeacher,
      isTeacherPanel: false,
      nickname: isTeacher ? teacherName : null,
      lastMessageTimes: [],
      countedAsViewer: false,
    };
    clientMeta.set(ws, meta);

    ws.on('message', (raw) => {
      try {
        const msg: WsMessage = JSON.parse(raw.toString());

        if (msg.type === 'join') {
          const joinData = msg.data as { pin?: string; teacherPanel?: boolean; chatOnly?: boolean };

          // Teacher Panel connection (sidebar WebSocket)
          if (joinData.teacherPanel && meta.isTeacher) {
            meta.authenticated = true;
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
            meta.authenticated = true;
            // chatOnly는 학생 연결 — localhost여도 isTeacher=false
            meta.isTeacher = false;
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

          // Max viewers check
          if (viewerCount >= maxViewers) {
            sendTo(ws, 'join:result', { success: false, error: 'Session is full' });
            ws.close(4002, 'Session full');
            return;
          }

          meta.authenticated = true;
          meta.countedAsViewer = true;
          viewerCount++;
          Logger.info(`Viewer connected (total: ${viewerCount}, isTeacher: ${isTeacher})`);

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
            isTeacher: meta.isTeacher,
          });
          return;
        }

        if (msg.type === 'poll:start') {
          if (!meta.isTeacher) return; // Only teacher
          const pollData = msg.data as { question: string; optionCount: number; pollId: string; options?: string[] };
          const question = (pollData.question || '').trim();
          if (!question) return; // Reject empty question
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
      } catch (err) {
        Logger.error('WebSocket message parse error', err);
      }
    });

    ws.on('close', () => {
      // Only decrement if this client was actually counted as a viewer
      if (meta.countedAsViewer) {
        meta.countedAsViewer = false; // Prevent double decrement
        viewerCount = Math.max(0, viewerCount - 1);
        Logger.info(`Viewer disconnected (total: ${viewerCount})`);
        broadcast('viewers:count', { count: viewerCount });
        onViewerCountChange?.(viewerCount);
      }
      clientMeta.delete(ws);
    });

    ws.on('error', (err) => {
      Logger.error('WebSocket client error', err);
    });
  });

  Logger.info('WebSocket server started');
  return wss;
}

let onNewViewer: ((ws: WebSocket) => void) | null = null;

export function setOnNewViewer(callback: (ws: WebSocket) => void) {
  onNewViewer = callback;
}

export function broadcast(type: string, data: unknown) {
  if (!wss) return;

  const message = JSON.stringify({ type, data });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
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
    sessionPin = null;
    teacherName = 'Teacher';
    clientMeta.clear();
    currentPoll = null;
    chatMessageId = 0;

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

    terminateAllClients();
  });
}

export function forceStopWsServer(): void {
  viewerCount = 0;
  sessionPin = null;
  teacherName = 'Teacher';
  clientMeta.clear();
  currentPoll = null;
  chatMessageId = 0;

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
