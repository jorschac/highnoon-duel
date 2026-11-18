import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAuthority, type AuthorityResult, type InternalCommand, type RawRoom } from '../server/authority.js';

const EPOCH = 1_795_000_000_000;
function harness() {
  let now = EPOCH;
  let serial = 0;
  const authority = new MemoryAuthority({ now: () => now });
  const execute = (cmd: InternalCommand) => authority.execute(cmd);
  const set = (value: number) => { now = value; };
  const advance = (milliseconds: number) => { now += milliseconds; };
  const enter = (id: string, nickname = id, connectionId = `connection-${id}`) => execute({
    type: 'session.enter', playerId: id, nickname, connectionId, resumeHash: `hash-${id}`,
  });
  const user = (id: string, type: string, payload: Record<string, unknown> = {}, extra: Partial<InternalCommand> = {}) => execute({
    type, playerId: id, connectionId: `connection-${id}`, commandId: `command-${++serial}`, payload, ...extra,
  });
  const snapshot = () => execute({ type: 'snapshot' });
  const heartbeat = (ids: string[]) => execute({ type: 'heartbeat', connections: ids.map(id => ({ playerId: id, connectionId: `connection-${id}` })) });
  const roomAction = (id: string, type: string, room: RawRoom, extra: Partial<InternalCommand> = {}) => user(id, type, {
    roomId: room.id, roundId: room.roundId, scheduleId: room.scheduleId,
  }, extra);
  const pair = async (a = 'a', b = 'b', roomId = 'room-1', roundId = 'round-1') => {
    assert.equal((await enter(a)).ok, true);
    assert.equal((await enter(b)).ok, true);
    assert.equal((await user(b, 'lobby.ready', { ready: true })).ok, true);
    const result = await user(a, 'lobby.challenge', { targetId: b }, { newRoomId: roomId, newRoundId: roundId });
    assert.equal(result.ok, true);
    return result.state.rooms[roomId]!;
  };
  const schedule = async (room: RawRoom, ack = true) => {
    await roomAction(room.seats[0]!, 'room.loaded', room);
    const loaded = await roomAction(room.seats[1]!, 'room.loaded', room);
    const scheduled = loaded.state.rooms[room.id]!;
    if (ack) {
      await roomAction(room.seats[0]!, 'round.scheduleAck', scheduled);
      await roomAction(room.seats[1]!, 'round.scheduleAck', scheduled);
    }
    return scheduled;
  };
  return { authority, execute, set, advance, enter, user, snapshot, heartbeat, roomAction, pair, schedule };
}
function resultOf(result: AuthorityResult, room: RawRoom) { return result.state.rooms[room.id]!.result!; }

test('epoch milliseconds survive Fengari and authority time never goes backwards', async () => {
  const h = harness();
  assert.equal((await h.snapshot()).state.now, EPOCH);
  h.advance(1234);
  assert.equal((await h.snapshot()).state.now, EPOCH + 1234);
  h.set(EPOCH - 10_000);
  assert.equal((await h.snapshot()).state.now, EPOCH + 1234);
});

test('first valid gun wins; later gun and disconnect cannot change one locked result', async () => {
  const h = harness(); const room = await h.schedule(await h.pair());
  h.set(room.goAt!);
  const first = await h.roomAction('a', 'round.fire', room);
  const result = resultOf(first, room);
  assert.equal(result.reason, 'SHOT'); assert.equal(result.winnerId, 'a'); assert.equal(result.receiveSeq, 1);
  assert.match(result.id, /^room-1:round-1:/);
  assert.equal((await h.roomAction('b', 'round.fire', room)).code, 'NOT_PLAYING');
  await h.execute({ type: 'disconnected', playerId: 'a', connectionId: 'connection-a' });
  assert.deepEqual(resultOf(await h.snapshot(), room), result);
});

test('same-clock simultaneous guns follow script execution order, not player identity', async () => {
  const h = harness(); const room = await h.schedule(await h.pair()); h.set(room.goAt!);
  const [first, second] = await Promise.all([
    h.roomAction('b', 'round.fire', room), h.roomAction('a', 'round.fire', room),
  ]);
  assert.equal(resultOf(first, room).winnerId, 'b');
  assert.equal(second.code, 'NOT_PLAYING');
  assert.deepEqual(resultOf(second, room), resultOf(first, room));
});

test('fire before start is refused; exact start and go-1 are false starts', async () => {
  for (const offset of [0, 2999]) {
    const h = harness(); const room = await h.schedule(await h.pair());
    h.set(room.countdownStartAt! - 1);
    assert.equal((await h.roomAction('a', 'round.fire', room)).code, 'NOT_PLAYING');
    h.set(room.countdownStartAt! + offset);
    const result = resultOf(await h.roomAction('a', 'round.fire', room), room);
    assert.equal(result.reason, 'FALSE_START'); assert.equal(result.winnerId, 'b'); assert.equal(result.loserId, 'a');
  }
});

test('explicit false start obeys authority countdown, not client-reported timing', async () => {
  const h = harness(); const room = await h.schedule(await h.pair());
  assert.equal((await h.roomAction('a', 'round.falseStart', room)).code, 'NOT_PLAYING');
  h.set(room.countdownStartAt!);
  assert.equal(resultOf(await h.roomAction('a', 'round.falseStart', room), room).reason, 'FALSE_START');
  const g = harness(); const later = await g.schedule(await g.pair()); g.set(later.goAt!);
  assert.equal((await g.roomAction('a', 'round.falseStart', later)).code, 'NOT_PLAYING');
  assert.equal((await g.snapshot()).state.rooms[later.id]!.result, null);
});

test('go is inclusive; deadline is exclusive even without any prior tick', async () => {
  for (const at of ['go', 'deadline-1', 'deadline'] as const) {
    const h = harness(); const room = await h.schedule(await h.pair());
    h.set(at === 'go' ? room.goAt! : room.deadlineAt! - (at === 'deadline-1' ? 1 : 0));
    const response = await h.roomAction('a', 'round.fire', room);
    assert.equal(resultOf(response, room).reason, at === 'deadline' ? 'NO_SHOT' : 'SHOT');
    if (at === 'deadline') { assert.equal(response.code, 'NOT_PLAYING'); assert.equal(resultOf(response, room).winnerId, null); }
  }
});

test('missing schedule acknowledgment invalidates exactly at start; loading expires at 10 seconds', async () => {
  const h = harness(); const room = await h.schedule(await h.pair(), false);
  await h.roomAction('a', 'round.scheduleAck', room);
  h.set(room.countdownStartAt!);
  const expired = await h.roomAction('b', 'round.scheduleAck', room);
  assert.equal(resultOf(expired, room).reason, 'SCHEDULE_TIMEOUT');
  assert.equal(resultOf(expired, room).winnerId, null);
  const g = harness(); const preparing = await g.pair(); g.set(preparing.loadDeadline);
  assert.equal(resultOf(await g.snapshot(), preparing).reason, 'LOAD_TIMEOUT');
});

test('schedule uses 1000ms advance notice, then a strict 3000ms countdown and 5000ms window', async () => {
  const h = harness(); const room = await h.schedule(await h.pair());
  assert.equal(room.countdownStartAt, EPOCH + 1000);
  assert.equal(room.goAt! - room.countdownStartAt!, 3000);
  assert.equal(room.deadlineAt! - room.goAt!, 5000);
  assert.equal(room.scheduleId, room.roundId);
  assert.equal((await h.user('a', 'round.scheduleAck', {
    roomId: room.id, roundId: room.roundId, scheduleId: 'forged',
  })).code, 'STALE_ROUND');
});

test('competing challenges atomically lock only two different seats and clear readiness', async () => {
  const h = harness(); await h.enter('a'); await h.enter('b'); await h.enter('c');
  await h.user('b', 'lobby.ready', { ready: true });
  const [first, second] = await Promise.all([
    h.user('a', 'lobby.challenge', { targetId: 'b' }, { newRoomId: 'r1', newRoundId: 'n1' }),
    h.user('c', 'lobby.challenge', { targetId: 'b' }, { newRoomId: 'r2', newRoundId: 'n2' }),
  ]);
  assert.equal(first.ok, true); assert.equal(second.code, 'TARGET_UNAVAILABLE');
  const state = second.state;
  assert.deepEqual(state.rooms.r1!.seats, ['a', 'b']); assert.equal(Object.keys(state.rooms).length, 1);
  assert.equal(state.players.b!.ready, false); assert.equal(state.players.a!.ready, false);
  assert.equal((await h.user('c', 'lobby.challenge', { targetId: 'c' }, { newRoomId: 'r3', newRoundId: 'n3' })).code, 'SELF_CHALLENGE');
});

test('only both rematch confirmations create a new round; an old gun is rejected before dedup', async () => {
  const h = harness(); const room = await h.schedule(await h.pair()); h.set(room.goAt!);
  const shot = await h.roomAction('a', 'round.fire', room, { commandId: 'same-shot' });
  assert.equal(resultOf(shot, room).reason, 'SHOT');
  const first = await h.roomAction('a', 'room.rematch', room, { newRoundId: 'round-2' });
  assert.equal(first.state.rooms[room.id]!.phase, 'RESOLVED');
  const next = await h.roomAction('b', 'room.rematch', room, { newRoundId: 'round-2' });
  const fresh = next.state.rooms[room.id]!;
  assert.equal(fresh.roundId, 'round-2'); assert.equal(fresh.result, null); assert.equal(fresh.phase, 'PREPARING');
  assert.deepEqual(fresh.loaded, {}); assert.deepEqual(fresh.ack, {});
  assert.equal((await h.roomAction('a', 'round.fire', room, { commandId: 'same-shot' })).code, 'STALE_ROUND');
  const scheduled = await h.schedule(fresh); h.set(scheduled.goAt!);
  const second = resultOf(await h.roomAction('b', 'round.fire', scheduled), scheduled);
  assert.equal(second.winnerId, 'b'); assert.notEqual(second.id, resultOf(shot, room).id); assert.equal(second.receiveSeq, 2);
});

test('active disconnect locks a winnerless result, retained on resume; no immediate offline rematch', async () => {
  const h = harness(); const room = await h.schedule(await h.pair());
  const disconnected = await h.execute({ type: 'disconnected', playerId: 'b', connectionId: 'connection-b' });
  const locked = resultOf(disconnected, room);
  assert.equal(locked.reason, 'DISCONNECT'); assert.equal(locked.winnerId, null);
  assert.equal((await h.roomAction('a', 'room.rematch', room, { newRoundId: 'round-2' })).code, 'TARGET_UNAVAILABLE');
  assert.equal((await h.enter('b')).ok, true);
  h.set(room.goAt!);
  assert.equal((await h.roomAction('b', 'round.fire', room)).code, 'NOT_PLAYING');
  assert.deepEqual(resultOf(await h.snapshot(), room), locked);
  await h.roomAction('a', 'room.rematch', room, { newRoundId: 'round-2' });
  assert.equal((await h.roomAction('b', 'room.rematch', room, { newRoundId: 'round-2' })).state.rooms[room.id]!.roundId, 'round-2');
});

test('disconnect clears prior rematch acceptance, and stale connections cannot disconnect resumed player', async () => {
  const h = harness(); const room = await h.schedule(await h.pair()); h.set(room.goAt!);
  await h.roomAction('a', 'round.fire', room);
  await h.roomAction('b', 'room.rematch', room, { newRoundId: 'round-2' });
  await h.execute({ type: 'disconnected', playerId: 'b', connectionId: 'connection-b' });
  assert.equal((await h.enter('b', 'b', 'connection-new')).ok, true);
  assert.equal((await h.execute({ type: 'disconnected', playerId: 'b', connectionId: 'connection-b' })).code, 'NOT_JOINED');
  const first = await h.roomAction('a', 'room.rematch', room, { newRoundId: 'round-2' });
  assert.equal(first.state.rooms[room.id]!.phase, 'RESOLVED');
  const second = await h.roomAction('b', 'room.rematch', room, { newRoundId: 'round-2', connectionId: 'connection-new' });
  assert.equal(second.state.rooms[room.id]!.phase, 'PREPARING');
});

test('session restoration validates hash and lease, and payload identity cannot impersonate another player', async () => {
  const h = harness(); await h.enter('a'); await h.enter('b');
  assert.equal((await h.enter('a')).code, 'SESSION_IN_USE');
  await h.execute({ type: 'disconnected', playerId: 'a', connectionId: 'connection-a' });
  assert.equal((await h.execute({ type: 'session.enter', playerId: 'a', resumeHash: 'wrong', connectionId: 'evil' })).code, 'SESSION_EXPIRED');
  assert.equal((await h.enter('a', 'ignored', 'connection-new')).ok, true);
  assert.equal((await h.user('a', 'lobby.ready', { ready: true })).code, 'NOT_JOINED');
  const bound = await h.user('b', 'lobby.ready', { ready: true, playerId: 'a' });
  assert.equal(bound.state.players.b!.ready, true); assert.equal(bound.state.players.a!.ready, false);
});

test('heartbeat refreshes only matching connections without incrementing business revision or broadcasting', async () => {
  const h = harness(); let publications = 0;
  const unsubscribe = await h.authority.subscribe(() => { publications++; });
  await h.enter('a'); const before = await h.snapshot(); const count = publications;
  h.advance(14_999); await h.heartbeat(['a']);
  assert.equal((await h.snapshot()).state.revision, before.state.revision); assert.equal(publications, count);
  h.advance(14_999); assert.equal((await h.snapshot()).state.players.a!.online, true);
  h.advance(1); assert.equal((await h.snapshot()).state.players.a!.online, false);
  assert.equal(publications, count + 1); unsubscribe();
});

test('15-second lease invalidates active room and offline credentials expire at 60 seconds', async () => {
  const h = harness(); const room = await h.pair();
  h.advance(5000); await h.heartbeat(['a', 'b']);
  // Resolve manually before lease timeout so that load timeout isn't the cause.
  await h.roomAction('a', 'room.loaded', room);
  await h.roomAction('b', 'room.loaded', room);
  h.advance(15_000);
  const state = (await h.snapshot()).state;
  assert.equal(state.players.a!.online, false); assert.equal(state.rooms[room.id]!.result!.reason, 'DISCONNECT');
  h.advance(60_000);
  assert.equal((await h.execute({ type: 'session.enter', playerId: 'a', resumeHash: 'hash-a', connectionId: 'new' })).code, 'SESSION_EXPIRED');
  assert.equal((await h.snapshot()).state.players.a, undefined);
  assert.equal((await h.enter('a')).code, 'SESSION_EXPIRED');
  assert.equal((await h.enter('new-player')).ok, true);
});

test('result closes after 30 seconds; room.leave releases both immediately and preserves prior result', async () => {
  const h = harness(); const room = await h.schedule(await h.pair()); h.set(room.goAt!);
  await h.roomAction('a', 'round.fire', room);
  const leave = await h.roomAction('b', 'room.leave', room);
  assert.equal(leave.state.rooms[room.id], undefined);
  for (const id of ['a', 'b']) {
    assert.equal(leave.state.players[id]!.roomId, null); assert.equal(leave.state.players[id]!.ready, false);
    assert.ok(leave.state.players[id]!.notice);
  }
  const g = harness(); const other = await g.schedule(await g.pair()); g.set(other.goAt!);
  const resolved = await g.roomAction('a', 'round.fire', other);
  const deadline = resolved.state.rooms[other.id]!.rematchDeadline!;
  g.set(deadline - 1); assert.ok((await g.snapshot()).state.rooms[other.id]);
  g.set(deadline); const closed = await g.snapshot(); assert.equal(closed.state.rooms[other.id], undefined);
  assert.equal(closed.state.players.a!.roomId, null);
});

test('leaving an unresolved room locks LEFT once and publishes only the fully released state', async () => {
  const h = harness(); const room = await h.pair();
  const publications: AuthorityResult['state'][] = [];
  await h.authority.subscribe(state => { publications.push(state); });
  const before = publications.length;
  const leave = await h.roomAction('a', 'room.leave', room, { commandId: 'leave' });
  assert.equal(leave.state.seq, 1);
  assert.equal(leave.state.rooms[room.id], undefined);
  assert.equal(publications.length, before + 1);
  assert.equal(publications.at(-1)!.players.a!.roomId, null);
  assert.equal(publications.at(-1)!.players.b!.roomId, null);
  assert.equal((await h.roomAction('a', 'room.leave', room, { commandId: 'leave' })).code, 'NOT_IN_ROOM');
});

test('resume is valid at offline+59999ms but refused at exactly offline+60000ms', async () => {
  for (const offset of [59_999, 60_000]) {
    const h = harness(); await h.enter('a');
    await h.execute({ type: 'disconnected', playerId: 'a', connectionId: 'connection-a' });
    h.advance(offset);
    const resumed = await h.enter('a');
    assert.equal(resumed.ok, offset < 60_000);
    if (offset === 60_000) assert.equal(resumed.code, 'SESSION_EXPIRED');
  }
});

test('commands deduplicate business effects; per-player cache remains bounded at 64', async () => {
  const h = harness(); const room = await h.schedule(await h.pair()); h.set(room.goAt!);
  const first = await h.roomAction('a', 'round.fire', room, { commandId: 'gun' });
  const duplicate = await h.roomAction('a', 'round.fire', room, { commandId: 'gun' });
  assert.equal(duplicate.ok, true); assert.equal(duplicate.state.revision, first.state.revision);
  assert.deepEqual(resultOf(duplicate, room), resultOf(first, room));
  for (let i = 0; i < 80; i++) await h.user('a', 'state.sync');
  const internal = (await h.snapshot()).state as unknown as { _commands: Record<string, unknown[]> };
  assert.equal(internal._commands.a!.length, 64);
});

test('capacity is 20 players and at most 10 two-seat rooms', async () => {
  const h = harness();
  for (let i = 0; i < 20; i++) assert.equal((await h.enter(`p${i}`)).ok, true);
  assert.equal((await h.enter('overflow')).code, 'LOBBY_FULL');
  for (let i = 0; i < 10; i++) {
    const a = `p${2 * i}`; const b = `p${2 * i + 1}`;
    await h.user(b, 'lobby.ready', { ready: true });
    assert.equal((await h.user(a, 'lobby.challenge', { targetId: b }, { newRoomId: `r${i}`, newRoundId: `n${i}` })).ok, true);
  }
  const state = (await h.snapshot()).state;
  assert.equal(Object.keys(state.rooms).length, 10);
  for (const room of Object.values(state.rooms)) assert.equal(new Set(room.seats).size, 2);
});

test('rooms and MemoryAuthority instances are isolated', async () => {
  const h = harness(); const first = await h.schedule(await h.pair('a', 'b', 'r1', 'n1'));
  const second = await h.schedule(await h.pair('c', 'd', 'r2', 'n2'));
  h.set(first.goAt!);
  const shot = await h.roomAction('a', 'round.fire', first);
  assert.equal(shot.state.rooms.r1!.result!.winnerId, 'a'); assert.equal(shot.state.rooms.r2!.result, null);
  assert.equal((await h.user('c', 'round.fire', { roomId: first.id, roundId: first.roundId })).code, 'STALE_ROUND');
  assert.equal(resultOf(await h.roomAction('d', 'round.fire', second), second).winnerId, 'd');
  const separate = harness(); assert.deepEqual((await separate.snapshot()).state.players, {});
});

test('nickname UTF-8 validation rejects invisible/control/oversized inputs and accepts Chinese', async () => {
  const h = harness();
  for (const nickname of ['', ' '.repeat(3), '\n', '\u200b', 'x'.repeat(17), '中'.repeat(17)]) {
    assert.equal((await h.enter('invalid', nickname)).code, 'INVALID_MESSAGE');
  }
  assert.equal((await h.enter('valid', '西部牛仔')).ok, true);
});
