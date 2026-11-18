import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { io, type Socket } from 'socket.io-client';
import { MemoryAuthority } from '../server/authority.js';
import { attachHub } from '../server/hub.js';
import { PROTOCOL, type CommandType, type Command, type Reply, type Snapshot } from '../shared/protocol.js';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('real-clock sockets with modeled 100–200ms RTT and 0–50ms jitter do not diverge or stall', async () => {
  const authority = new MemoryAuthority();
  const server = createServer();
  const resultLogs: object[] = [];
  const hub = attachHub(server, authority, { log: entry => resultLogs.push(entry) });
  await hub.ready;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const sockets: Socket[] = [];
  const states = new Map<Socket, Snapshot>();
  const deliveries = new Map<string, number[]>();
  const seen = new Map<Socket, Set<string>>();
  let delayIndex = 0;
  const oneWayDelay = () => 50 + (++delayIndex % 3) * 25 + (delayIndex % 6) * 5;
  const cmd = async (s: Socket, type: CommandType, payload: Command['payload'] = {}): Promise<Reply> => {
    await sleep(oneWayDelay());
    const reply: Reply = await s.timeout(4000).emitWithAck('command', { protocol: PROTOCOL, type, payload, commandId: randomUUID() });
    await sleep(oneWayDelay());
    return reply;
  };
  const sync = async (s: Socket) => { const reply = await cmd(s, 'state.sync'); assert(reply.ok && reply.snapshot); return reply.snapshot; };
  const open = async (nickname: string) => {
    const s = io(`http://127.0.0.1:${address.port}`, { path: '/api/socket', addTrailingSlash: false, transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(s); seen.set(s, new Set());
    s.on('state', (snapshot: Snapshot) => {
      // Application delivery delays model latency/jitter; they are not browser or OS packet shaping.
      setTimeout(() => {
        const old = states.get(s);
        if (old && snapshot.revision < old.revision) return;
        states.set(s, snapshot);
        const result = snapshot.room?.result;
        if (result && !seen.get(s)!.has(result.id)) {
          seen.get(s)!.add(result.id);
          deliveries.set(result.id, [...(deliveries.get(result.id) || []), Date.now() - result.serverAt]);
        }
      }, oneWayDelay());
    });
    await new Promise<void>((resolve, reject) => { s.once('connect', resolve); s.once('connect_error', reject); });
    const reply = await cmd(s, 'session.enter', { nickname }); assert(reply.ok && reply.welcome); return s;
  };
  try {
    const a = await open('延迟甲'), b = await open('延迟乙'), c = await open('延迟丙'), d = await open('延迟丁');
    const [sa, sc] = await Promise.all([sync(a), sync(c)]);
    await Promise.all([cmd(a, 'lobby.ready', { ready: true }), cmd(c, 'lobby.ready', { ready: true })]);
    assert((await cmd(b, 'lobby.challenge', { targetId: sa.playerId })).ok);
    assert((await cmd(d, 'lobby.challenge', { targetId: sc.playerId })).ok);
    const start = async (x: Socket, y: Socket) => {
      let room = (await sync(x)).room!;
      const payload = { roomId: room.id, roundId: room.roundId };
      assert((await cmd(x, 'room.loaded', payload)).ok);
      assert((await cmd(y, 'room.loaded', payload)).ok);
      room = (await sync(x)).room!;
      assert.equal(room.goAt! - room.countdownStartAt!, 3000);
      await Promise.all([cmd(x, 'round.scheduleAck', { ...payload, scheduleId: room.scheduleId! }), cmd(y, 'round.scheduleAck', { ...payload, scheduleId: room.scheduleId! })]);
      return { payload, goAt: room.goAt!, deadlineAt: room.deadlineAt! };
    };
    const [first, other] = await Promise.all([start(a, b), start(c, d)]);
    await sleep(Math.max(0, first.goAt + 200 - Date.now()));
    await Promise.all([cmd(a, 'round.fire', first.payload), cmd(b, 'round.fire', first.payload)]);
    const [ra, rb] = await Promise.all([sync(a), sync(b)]);
    assert.equal(ra.room!.result?.reason, 'SHOT');
    assert.deepEqual(ra.room!.result, rb.room!.result);
    const resultId = ra.room!.result!.id;
    await sleep(Math.max(0, other.deadlineAt + 400 - Date.now()));
    const [rc, rd] = await Promise.all([sync(c), sync(d)]);
    assert.equal(rc.room!.result?.reason, 'NO_SHOT');
    assert.deepEqual(rc.room!.result, rd.room!.result);
    assert.notEqual(resultId, rc.room!.result!.id);
    assert.deepEqual((await sync(a)).room!.result, ra.room!.result);
    assert.equal(resultLogs.filter((e: any) => e.event === 'round.resolved' && e.result.id === resultId).length, 1);
    assert.equal(deliveries.get(resultId)?.length, 2);
    assert(deliveries.get(resultId)!.every(ms => ms >= 0 && ms < 1000));
    console.log(JSON.stringify({ modeledInputRTT: '100–200ms + 0–50ms jitter', shotDeliveriesMs: deliveries.get(resultId), resultLockedOnce: true, independentRoomTimedOut: true }));
  } finally { for (const s of sockets) s.disconnect(); await hub.close(); await authority.close(); }
});
