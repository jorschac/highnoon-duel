import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import { Server, type Socket } from 'socket.io';
import { ERROR_MESSAGES, PROTOCOL, RULES, type Command, type Reply, type Snapshot, type PlayerView } from '../shared/protocol.js';
import type { Authority, RawPlayer, RawState, InternalCommand } from './authority.js';

const actions = new Set(['session.enter', 'lobby.ready', 'lobby.challenge', 'room.loaded', 'round.scheduleAck', 'round.fire', 'round.falseStart', 'room.rematch', 'room.leave', 'state.sync', 'clock.ping']);
const roomActions = new Set(['room.loaded', 'round.scheduleAck', 'round.fire', 'round.falseStart', 'room.rematch', 'room.leave']);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const viewPlayer = (p: RawPlayer): PlayerView => ({ id: p.id, nickname: p.nickname, online: p.online, ready: p.ready, roomId: p.roomId });
export function projectSnapshot(state: RawState, playerId: string): Snapshot | undefined {
  const player = state.players[playerId];
  if (!player) return undefined;
  const room = player.roomId ? state.rooms[player.roomId] : undefined;
  return {
    protocol: PROTOCOL, revision: state.revision, serverNow: state.now, playerId,
    players: Object.values(state.players).filter(p => p.online).map(viewPlayer),
    room: room ? {
      id: room.id, roundId: room.roundId, phase: room.phase,
      players: room.seats.map(id => state.players[id]).filter((p): p is RawPlayer => Boolean(p)).map(viewPlayer),
      loaded: room.loaded, rematch: room.rematch, countdownStartAt: room.countdownStartAt,
      goAt: room.goAt, deadlineAt: room.deadlineAt, loadDeadline: room.loadDeadline,
      rematchDeadline: room.rematchDeadline, scheduleId: room.scheduleId,
      result: room.result, revision: room.revision,
    } : null,
    notice: player.notice, rules: RULES,
  };
}
function validString(value: unknown, max = 100): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function validateCommand(value: unknown): value is Command {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Command;
  if (c.protocol !== PROTOCOL || !validString(c.commandId, 80) || !actions.has(c.type)) return false;
  if (c.payload !== undefined && (!c.payload || typeof c.payload !== 'object' || Array.isArray(c.payload))) return false;
  if (Buffer.byteLength(JSON.stringify(c), 'utf8') > 4096) return false;
  if (c.type === 'lobby.ready' && typeof c.payload?.ready !== 'boolean') return false;
  if (c.type === 'lobby.challenge' && !validString(c.payload?.targetId)) return false;
  if (roomActions.has(c.type) && (!validString(c.payload?.roomId) || !validString(c.payload?.roundId))) return false;
  if (c.type === 'round.scheduleAck' && !validString(c.payload?.scheduleId, 200)) return false;
  return true;
}
function sameCode(candidate: unknown, expected: string | undefined) {
  if (!expected) return true;
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function acceptsOrigin(req: IncomingMessage, origins: string[], production: boolean) {
  const origin = req.headers.origin;
  if (!origin) return !production;
  if (origins.includes(origin)) return true;
  try {
    const url = new URL(origin);
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return url.host === host && ['http:', 'https:'].includes(url.protocol);
  } catch { return false; }
}
export interface HubOptions { production?: boolean; allowedOrigins?: string[]; testCode?: string; log?: (value: object) => void }
export function attachHub(server: HttpServer, authority: Authority, options: HubOptions = {}) {
  const io = new Server(server, {
    path: '/api/socket', addTrailingSlash: false, transports: ['websocket'],
    maxHttpBufferSize: 4096, pingInterval: 5000, pingTimeout: 7000,
    allowRequest: (req, callback) => callback(null, acceptsOrigin(req, options.allowedOrigins || [], Boolean(options.production))),
  });
  const members = new Map<string, { socket: Socket; playerId: string }>();
  const logged = new Set<string>();
  let closing = false;
  let lastState: RawState | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  const log = options.log || ((entry: object) => console.log(JSON.stringify(entry)));
  const emitState = (state: RawState) => {
    if (closing || (lastState && (state.revision < lastState.revision ||
      (state.revision === lastState.revision && state.now < lastState.now)))) return;
    lastState = state;
    for (const member of members.values()) {
      const snapshot = projectSnapshot(state, member.playerId);
      if (snapshot) member.socket.emit('state', snapshot);
    }
    for (const room of Object.values(state.rooms)) {
      if (room.result && !logged.has(room.result.id)) {
        logged.add(room.result.id);
        if (logged.size > 500) logged.delete(logged.values().next().value!);
        log({ event: 'round.resolved', roomId: room.id, roundId: room.roundId, result: room.result });
      }
    }
    schedule(state);
  };
  function schedule(state: RawState) {
    if (timer) clearTimeout(timer);
    const deadlines: number[] = [];
    for (const room of Object.values(state.rooms)) {
      const next = room.phase === 'PREPARING' ? room.loadDeadline
        : room.phase === 'SCHEDULED' ? room.countdownStartAt
        : room.phase === 'COUNTDOWN' ? room.goAt
        : room.phase === 'DUEL' ? room.deadlineAt : room.rematchDeadline;
      if (next !== null && next !== undefined) deadlines.push(next);
    }
    if (!deadlines.length || !members.size) return;
    const delay = Math.min(5000, Math.max(10, Math.min(...deadlines) - state.now + 2));
    timer = setTimeout(() => { void authority.execute({ type: 'tick' }).then(r => emitState(r.state)).catch(reportServiceError); }, delay);
    timer.unref();
  }
  const reportServiceError = (error: unknown) => {
    log({ event: 'authority.unavailable', error: error instanceof Error ? error.name : 'UnknownError' });
    for (const { socket } of members.values()) socket.emit('service.error', { code: 'SERVICE_UNAVAILABLE', message: ERROR_MESSAGES.SERVICE_UNAVAILABLE });
  };
  const ready = authority.subscribe(emitState).then(stop => { unsubscribe = stop; });
  // The event handlers are registered synchronously, before waiting for any storage I/O.
  io.on('connection', socket => {
    let playerId: string | undefined;
    let entering = false;
    let tokens = 40;
    let replenished = performance.now();
    socket.on('command', (unknownCommand: unknown, callback?: (reply: Reply) => void) => {
      const ack = typeof callback === 'function' ? callback : () => {};
      const now = performance.now();
      tokens = Math.min(40, tokens + (now - replenished) * 0.02);
      replenished = now;
      if (tokens < 1) { ack({ ok: false, code: 'RATE_LIMITED', message: ERROR_MESSAGES.RATE_LIMITED, serverNow: lastState?.now || 0 }); return; }
      tokens -= 1;
      try {
        if (!validateCommand(unknownCommand)) {
          const code = (unknownCommand as Command | null)?.protocol && (unknownCommand as Command).protocol !== PROTOCOL ? 'INCOMPATIBLE' : 'INVALID_MESSAGE';
          ack({ ok: false, code, message: ERROR_MESSAGES[code], serverNow: lastState?.now || 0 }); return;
        }
      } catch { ack({ ok: false, code: 'INVALID_MESSAGE', message: ERROR_MESSAGES.INVALID_MESSAGE, serverNow: 0 }); return; }
      const command = unknownCommand as Command;
      if (command.type === 'session.enter' && entering) {
        ack({ ok: false, code: 'SESSION_IN_USE', message: '入场正在确认，请勿重复提交。', serverNow: lastState?.now || 0 });
        return;
      }
      if (command.type === 'session.enter') entering = true;
      void handle(command, ack).finally(() => { if (command.type === 'session.enter') entering = false; });
    });
    async function handle(command: Command, ack: (reply: Reply) => void) {
      try {
        await ready;
        let issuedToken: string | undefined;
        let internal: InternalCommand;
        if (command.type === 'session.enter') {
          if (!sameCode(command.payload?.testCode, options.testCode)) {
            ack({ ok: false, code: 'TEST_CODE_REQUIRED', message: ERROR_MESSAGES.TEST_CODE_REQUIRED, serverNow: lastState?.now || 0 }); return;
          }
          if (playerId) {
            const r = await authority.execute({ type: 'snapshot' });
            ack({ ok: true, serverNow: r.state.now, snapshot: projectSnapshot(r.state, playerId) }); return;
          }
          const oldId = command.payload?.playerId;
          const oldToken = command.payload?.resumeToken;
          if (oldId && (!validString(oldId) || !validString(oldToken, 128))) {
            ack({ ok: false, code: 'SESSION_EXPIRED', message: ERROR_MESSAGES.SESSION_EXPIRED, serverNow: 0 }); return;
          }
          const nickname = typeof command.payload?.nickname === 'string' ? command.payload.nickname.trim() : '';
          const length = Array.from(new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(nickname)).length;
          if (!oldId && (!nickname || length > 16 || /[\u0000-\u001f\u007f]/.test(nickname))) {
            ack({ ok: false, code: 'INVALID_MESSAGE', message: '昵称请输入 1–16 个可见字符。', serverNow: 0 }); return;
          }
          issuedToken = oldId ? oldToken! : randomBytes(32).toString('hex');
          internal = { type: command.type, commandId: command.commandId, playerId: oldId || randomUUID(), connectionId: socket.id, ...(oldId ? {} : { nickname }), resumeHash: sha(issuedToken) };
        } else {
          if (!playerId) { ack({ ok: false, code: 'NOT_JOINED', message: ERROR_MESSAGES.NOT_JOINED, serverNow: 0 }); return; }
          internal = {
            type: ['clock.ping', 'state.sync'].includes(command.type) ? 'snapshot' : command.type,
            commandId: command.commandId, playerId, connectionId: socket.id,
            payload: command.payload as Record<string, unknown> | undefined,
            newRoomId: randomUUID(), newRoundId: randomUUID(),
          };
        }
        const result = await authority.execute(internal);
        if (result.ok && command.type === 'session.enter') {
          playerId = result.playerId || internal.playerId!;
          if (!socket.connected) {
            const dropped = await authority.execute({ type: 'disconnected', playerId, connectionId: socket.id });
            emitState(dropped.state);
            return;
          }
          members.set(socket.id, { socket, playerId });
        }
        const snapshot = playerId ? projectSnapshot(result.state, playerId) : undefined;
        const reply: Reply = { ok: result.ok, code: result.code, message: result.code ? (ERROR_MESSAGES[result.code] || '操作未生效，请同步状态。') : undefined, serverNow: result.state.now, snapshot };
        if (issuedToken && result.ok && snapshot) {
          reply.welcome = { playerId: playerId!, resumeToken: issuedToken, snapshot };
          socket.emit('welcome', reply.welcome);
        }
        ack(reply);
        emitState(result.state);
      } catch (error) {
        ack({ ok: false, code: 'SERVICE_UNAVAILABLE', message: ERROR_MESSAGES.SERVICE_UNAVAILABLE, serverNow: lastState?.now || 0 });
        reportServiceError(error);
      }
    }
    socket.on('disconnect', () => {
      members.delete(socket.id);
      if (playerId && !closing) void authority.execute({ type: 'disconnected', playerId, connectionId: socket.id }).then(r => emitState(r.state)).catch(reportServiceError);
    });
  });
  const heartbeat = setInterval(() => {
    if (!members.size || closing) return;
    const connections = [...members.entries()].map(([connectionId, member]) => ({ connectionId, playerId: member.playerId }));
    void authority.execute({ type: 'heartbeat', connections }).then(r => { lastState = r.state; schedule(r.state); }).catch(reportServiceError);
  }, 5000);
  heartbeat.unref();
  // Do not let a failed subscription become an unhandled rejection during cold start.
  void ready.catch(reportServiceError);
  return {
    io, ready,
    close: async () => {
      closing = true; clearInterval(heartbeat); if (timer) clearTimeout(timer); unsubscribe?.();
      await new Promise<void>(resolve => io.close(() => resolve()));
    },
  };
}
