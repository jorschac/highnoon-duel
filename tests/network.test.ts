import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { MemoryAuthority } from '../server/authority.js';
import { attachHub } from '../server/hub.js';
import { PROTOCOL, type Command, type CommandType, type Reply, type Snapshot } from '../shared/protocol.js';

test('real sockets: shared lobby, concurrent challenge, unique winner, 10 rematches, disconnect and resume', async () => {
  let now = 1794976800000;
  const authority = new MemoryAuthority({ now: () => now });
  const server = createServer();
  const hub = attachHub(server, authority, { log: () => {} });
  await hub.ready;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const sockets: Socket[] = [];
  const snapshots = new Map<Socket, Snapshot>();
  const open = async () => {
    const socket = io(origin, { path: '/api/socket', addTrailingSlash: false, transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(socket); socket.on('state', (s: Snapshot) => snapshots.set(socket, s));
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    assert.equal(socket.io.engine.transport.name, 'websocket');
    return socket;
  };
  const cmd = async (s: Socket, type: CommandType, payload: Command['payload'] = {}, id = randomUUID()): Promise<Reply> => {
    // Keep the fixture below the real 20/s input budget; do not weaken production limits.
    await new Promise(resolve => setTimeout(resolve, 60));
    return await s.timeout(3000).emitWithAck('command', { protocol: PROTOCOL, commandId: id, type, payload });
  };
  const sync = async (s: Socket) => { const r = await cmd(s, 'state.sync'); assert(r.ok && r.snapshot); return r.snapshot; };
  try {
    const a = await open(), b = await open(), c = await open(), d = await open();
    const wa = (await cmd(a, 'session.enter', { nickname: '甲' })).welcome!;
    const wb = (await cmd(b, 'session.enter', { nickname: '乙' })).welcome!;
    const wc = (await cmd(c, 'session.enter', { nickname: '丙' })).welcome!;
    await cmd(d, 'session.enter', { nickname: '<img src=x>' });
    assert.equal((await sync(a)).players.length, 4);
    const readyId = randomUUID();
    assert((await cmd(a, 'lobby.ready', { ready: true }, readyId)).ok);
    assert((await cmd(a, 'lobby.ready', { ready: true }, readyId)).ok);
    assert((await sync(b)).players.find(p => p.id === wa.playerId)?.ready);
    const challengeResults = await Promise.all([cmd(b, 'lobby.challenge', { targetId: wa.playerId }), cmd(c, 'lobby.challenge', { targetId: wa.playerId })]);
    assert.equal(challengeResults.filter(r => r.ok).length, 1);
    const opponent = challengeResults[0].ok ? b : c;
    const spare = opponent === b ? c : b;
    const opponentId = opponent === b ? wb.playerId : wc.playerId;
    assert.equal((await sync(a)).room!.players.length, 2);
    assert.equal((await sync(spare)).room, null);
    const load = async (s1: Socket, s2: Socket) => {
      let room = (await sync(s1)).room!;
      const payload = { roomId: room.id, roundId: room.roundId };
      assert((await cmd(s1, 'room.loaded', payload)).ok);
      assert((await cmd(s2, 'room.loaded', payload)).ok);
      room = (await sync(s1)).room!;
      assert.equal(room.goAt! - room.countdownStartAt!, 3000);
      assert((await cmd(s1, 'round.scheduleAck', { ...payload, scheduleId: room.scheduleId! })).ok);
      assert((await cmd(s2, 'round.scheduleAck', { ...payload, scheduleId: room.scheduleId! })).ok);
      return { ...payload, goAt: room.goAt! };
    };
    let round = await load(a, opponent);
    now = round.goAt;
    const shotPayload = { roomId: round.roomId, roundId: round.roundId };
    const [r1, r2] = await Promise.all([cmd(a, 'round.fire', shotPayload), cmd(opponent, 'round.fire', shotPayload)]);
    assert(r1.ok || r2.ok);
    let sa = await sync(a), sb = await sync(opponent);
    assert(sa.room!.result?.winnerId);
    assert.deepEqual(sa.room!.result, sb.room!.result);
    const firstResult = sa.room!.result!;
    assert((firstResult.winnerId === wa.playerId && firstResult.loserId === opponentId) || (firstResult.winnerId === opponentId && firstResult.loserId === wa.playerId));
    const serialized = JSON.stringify(sa);
    assert(!serialized.includes('resumeHash')); assert(!serialized.includes(wa.resumeToken));
    assert(!serialized.includes('connectionId'));
    // An unrelated room cannot affect the first match.
    assert((await cmd(spare, 'lobby.ready', { ready: true })).ok);
    const spareId = (await sync(spare)).playerId;
    assert((await cmd(d, 'lobby.challenge', { targetId: spareId })).ok);
    await load(spare, d);
    assert.deepEqual((await sync(a)).room!.result, firstResult);
    for (let i = 0; i < 10; i++) {
      const oldRound = round;
      assert((await cmd(a, 'room.rematch', shotPayloadFor(round))).ok);
      assert.equal((await sync(a)).room!.phase, 'RESOLVED');
      assert((await cmd(opponent, 'room.rematch', shotPayloadFor(round))).ok);
      round = await load(a, opponent);
      assert.notEqual(round.roundId, oldRound.roundId);
      assert.equal((await cmd(a, 'round.fire', shotPayloadFor(oldRound))).code, 'STALE_ROUND');
      now = round.goAt;
      assert((await cmd(i % 2 ? a : opponent, 'round.fire', shotPayloadFor(round))).ok);
      sa = await sync(a); sb = await sync(opponent);
      assert.deepEqual(sa.room!.result, sb.room!.result);
      // Keep all connections fresh during accelerated time in this deterministic test.
      await authority.execute({ type: 'heartbeat', connections: sockets.filter(s => s.connected).map(s => ({ playerId: snapshots.get(s)!.playerId, connectionId: s.id! })) });
    }
    const settled = (await sync(a)).room!.result!;
    opponent.disconnect();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual((await sync(a)).room!.result, settled);
    const reconnect = await open();
    const creds = opponent === b ? wb : wc;
    const restored = await cmd(reconnect, 'session.enter', { playerId: creds.playerId, resumeToken: creds.resumeToken });
    assert(restored.ok); assert.equal(restored.snapshot!.playerId, creds.playerId);
    const duplicate = await open();
    assert.equal((await cmd(duplicate, 'session.enter', { playerId: creds.playerId, resumeToken: creds.resumeToken })).code, 'SESSION_IN_USE');
    assert((await cmd(a, 'room.leave', shotPayloadFor(round))).ok);
    assert.equal((await sync(a)).room, null);
    assert.equal((await sync(reconnect)).room, null);
    const invalid = await duplicate.timeout(3000).emitWithAck('command', { protocol: 'old-v0', commandId: randomUUID(), type: 'session.enter' });
    assert.equal(invalid.code, 'INCOMPATIBLE');
  } finally {
    for (const s of sockets) s.disconnect();
    await hub.close(); await authority.close();
  }
});
function shotPayloadFor(round: { roomId: string; roundId: string }) { return { roomId: round.roomId, roundId: round.roundId }; }
