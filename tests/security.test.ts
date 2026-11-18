import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { io, type Socket } from 'socket.io-client';
import { MemoryAuthority } from '../server/authority.js';
import { attachHub } from '../server/hub.js';
import { PROTOCOL, type CommandType, type Command, type Reply } from '../shared/protocol.js';

test('transport rejects foreign Origin, double enter, expired credentials, bad protocol, and flood', async () => {
  let now = 1794976800000;
  const authority = new MemoryAuthority({ now: () => now });
  const server = createServer();
  const hub = attachHub(server, authority, { production: true, log: () => {} });
  await hub.ready;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const sockets: Socket[] = [];
  const open = async (requestOrigin = origin, fail = false) => {
    const s = io(origin, { path: '/api/socket', addTrailingSlash: false, transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: { Origin: requestOrigin } });
    sockets.push(s);
    await new Promise<void>((resolve, reject) => {
      s.once('connect', () => fail ? reject(new Error('Unexpected foreign-origin success')) : resolve());
      s.once('connect_error', () => fail ? resolve() : reject(new Error('Same-origin connection failed')));
    });
    return s;
  };
  const cmd = async (s: Socket, type: CommandType, payload: Command['payload'] = {}): Promise<Reply> => s.timeout(3000).emitWithAck('command', { protocol: PROTOCOL, type, payload, commandId: randomUUID() });
  try {
    await open('https://unrelated.example', true);
    const s = await open();
    const entries = await Promise.all([cmd(s, 'session.enter', { nickname: '第一次' }), cmd(s, 'session.enter', { nickname: '不应重复' })]);
    assert.equal(entries.filter(r => r.ok).length, 1);
    assert.equal(entries.filter(r => r.code === 'SESSION_IN_USE').length, 1);
    const credentials = entries.find(r => r.ok)!.welcome!;
    const state = await authority.execute({ type: 'snapshot' });
    assert.equal(Object.keys(state.state.players).length, 1);
    const malformed = await s.timeout(3000).emitWithAck('command', { protocol: 'fake', type: 'round.fire', commandId: randomUUID() });
    assert.equal(malformed.code, 'INCOMPATIBLE');
    const floodSocket = await open();
    const flood = await Promise.all(Array.from({ length: 55 }, () => cmd(floodSocket, 'clock.ping')));
    assert(flood.some(r => r.code === 'RATE_LIMITED'));
    now += 90000;
    await authority.execute({ type: 'snapshot' });
    s.disconnect();
    const restore = await open();
    const restored = await cmd(restore, 'session.enter', { playerId: credentials.playerId, resumeToken: credentials.resumeToken });
    assert.equal(restored.code, 'SESSION_EXPIRED');
    assert(!restored.ok);
    assert.equal(Object.keys((await authority.execute({ type: 'snapshot' })).state.players).length, 0);
  } finally { for (const s of sockets) s.disconnect(); await hub.close(); await authority.close(); }
});
