import { Redis } from 'ioredis';
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';
import type { Phase, ResultView } from '../shared/protocol.js';
import { AUTHORITY_SCRIPT } from './authority-script.js';

export interface RawPlayer {
  id: string; nickname: string; resumeHash: string; connectionId: string | null;
  lastSeen: number; online: boolean; ready: boolean; roomId: string | null; notice: string | null;
}
export interface RawRoom {
  id: string; roundId: string; seats: string[]; phase: Phase;
  loaded: Record<string, boolean>; ack: Record<string, boolean>; rematch: Record<string, boolean>;
  countdownStartAt: number | null; goAt: number | null; deadlineAt: number | null;
  loadDeadline: number; rematchDeadline: number | null; scheduleId: string | null;
  result: ResultView | null; revision: number;
}
export interface RawState {
  revision: number; now: number; seq: number;
  players: Record<string, RawPlayer>; rooms: Record<string, RawRoom>;
}
export interface AuthorityResult { ok: boolean; code?: string; playerId?: string; state: RawState }
export interface InternalCommand {
  type: string; commandId?: string; playerId?: string; connectionId?: string;
  nickname?: string; resumeHash?: string; newRoomId?: string; newRoundId?: string;
  payload?: Record<string, unknown>; connections?: { playerId: string; connectionId: string }[];
}
export interface Authority {
  execute(cmd: InternalCommand): Promise<AuthorityResult>;
  subscribe(listener: (state: RawState) => void): Promise<() => void>;
  close(): Promise<void>;
}
type Listener = (state: RawState) => void;
// Lua's C-shaped stack API is the sole untyped boundary. Neither gameplay nor
// transport depends on arbitrary JS evaluation inside the VM.
type LuaState = any;
const JSON_NULL = Object.freeze({ null: true });
function luaString(L: LuaState, index: number): string {
  const value = lua.lua_tolstring(L, index);
  if (!value) throw new Error('Expected a Lua string');
  return to_jsstring(value);
}
function pushJson(L: LuaState, value: unknown): void {
  if (value === null || value === undefined) { lua.lua_pushlightuserdata(L, JSON_NULL); return; }
  if (typeof value === 'boolean') { lua.lua_pushboolean(L, value); return; }
  if (typeof value === 'number') { lua.lua_pushnumber(L, value); return; }
  if (typeof value === 'string') { lua.lua_pushstring(L, to_luastring(value)); return; }
  if (typeof value !== 'object') throw new Error('Not a JSON value');
  lua.lua_newtable(L);
  const array = Array.isArray(value);
  if (array) {
    value.forEach((item, index) => { pushJson(L, item); lua.lua_rawseti(L, -2, index + 1); });
  } else {
    for (const [key, item] of Object.entries(value)) {
      pushJson(L, item); lua.lua_setfield(L, -2, to_luastring(key));
    }
  }
  lua.lua_newtable(L);
  lua.lua_pushstring(L, to_luastring(array ? 'array' : 'object'));
  lua.lua_setfield(L, -2, to_luastring('__json_kind'));
  lua.lua_setmetatable(L, -2);
}
function readJson(L: LuaState, index: number): unknown {
  const absolute = lua.lua_absindex(L, index);
  switch (lua.lua_type(L, absolute)) {
    case lua.LUA_TNIL: return null;
    case lua.LUA_TLIGHTUSERDATA:
      if (lua.lua_touserdata(L, absolute) === JSON_NULL) return null;
      throw new Error('Unsupported Lua userdata');
    case lua.LUA_TBOOLEAN: return lua.lua_toboolean(L, absolute);
    case lua.LUA_TNUMBER: return lua.lua_tonumber(L, absolute);
    case lua.LUA_TSTRING: return luaString(L, absolute);
    case lua.LUA_TTABLE: {
      let kind = '';
      if (lua.lua_getmetatable(L, absolute)) {
        lua.lua_getfield(L, -1, to_luastring('__json_kind'));
        if (lua.lua_type(L, -1) === lua.LUA_TSTRING) kind = luaString(L, -1);
        lua.lua_pop(L, 2);
      }
      const entries: [string | number, unknown][] = [];
      lua.lua_pushnil(L);
      while (lua.lua_next(L, absolute)) {
        const key = lua.lua_type(L, -2) === lua.LUA_TNUMBER
          ? lua.lua_tonumber(L, -2) as number : luaString(L, -2);
        entries.push([key, readJson(L, -1)]);
        lua.lua_pop(L, 1);
      }
      // cjson treats a formerly empty table populated with numeric indices as
      // an array. Its decoded empty-object marker must not override mutation.
      const array = kind === 'array' || (entries.length > 0 &&
        entries.every(([key]) => typeof key === 'number' && Number.isInteger(key) && key >= 1));
      if (array) {
        const result: unknown[] = [];
        for (const [key, value] of entries) result[Number(key) - 1] = value;
        return result;
      }
      const result: Record<string, unknown> = {};
      for (const [key, value] of entries) Object.defineProperty(result, String(key), {
        value, enumerable: true, writable: true, configurable: true,
      });
      return result;
    }
    default: throw new Error('Unsupported JSON value in Lua');
  }
}

export class MemoryAuthority implements Authority {
  private readonly store = new Map<string, string>();
  private readonly listeners = new Set<Listener>();
  private readonly now: () => number;
  private closed = false;
  private readonly key = 'highnoon:local:state';
  constructor(options: { now?: () => number } = {}) { this.now = options.now ?? Date.now; }

  async execute(cmd: InternalCommand): Promise<AuthorityResult> {
    if (this.closed) throw new Error('Authority is closed');
    // No await inside this operation: an entire Lua invocation is one atomic
    // turn. Publications are delivered only after EVAL has returned.
    const publications: string[] = [];
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    const callback = (fn: (state: LuaState) => number) => (state: LuaState): number => {
      try { return fn(state); }
      catch (error) {
        lua.lua_pushstring(state, to_luastring(error instanceof Error ? error.message : String(error)));
        return lua.lua_error(state) as number;
      }
    };
    lua.lua_newtable(L);
    lua.lua_pushcfunction(L, callback((state) => {
      const operation = luaString(state, 1).toUpperCase();
      if (operation === 'GET') {
        const value = this.store.get(luaString(state, 2));
        if (value === undefined) lua.lua_pushnil(state); else lua.lua_pushstring(state, to_luastring(value));
      } else if (operation === 'SET') {
        this.store.set(luaString(state, 2), luaString(state, 3));
        lua.lua_pushstring(state, to_luastring('OK'));
      } else if (operation === 'TIME') {
        const milliseconds = Math.floor(this.now());
        if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error('Invalid authority clock');
        pushJson(state, [String(Math.floor(milliseconds / 1000)), String((milliseconds % 1000) * 1000)]);
      } else if (operation === 'PUBLISH') {
        if (luaString(state, 2) !== `${this.key}:events`) throw new Error('Unexpected publish channel');
        publications.push(luaString(state, 3)); lua.lua_pushinteger(state, this.listeners.size);
      } else throw new Error(`Unsupported Redis primitive: ${operation}`);
      return 1;
    }));
    lua.lua_setfield(L, -2, to_luastring('call'));
    lua.lua_setglobal(L, to_luastring('redis'));
    lua.lua_newtable(L);
    lua.lua_pushlightuserdata(L, JSON_NULL); lua.lua_setfield(L, -2, to_luastring('null'));
    lua.lua_pushcfunction(L, callback((state) => {
      pushJson(state, JSON.parse(luaString(state, 1))); return 1;
    }));
    lua.lua_setfield(L, -2, to_luastring('decode'));
    lua.lua_pushcfunction(L, callback((state) => {
      lua.lua_pushstring(state, to_luastring(JSON.stringify(readJson(state, 1)))); return 1;
    }));
    lua.lua_setfield(L, -2, to_luastring('encode'));
    lua.lua_setglobal(L, to_luastring('cjson'));
    pushJson(L, [this.key]); lua.lua_setglobal(L, to_luastring('KEYS'));
    pushJson(L, [JSON.stringify(cmd)]); lua.lua_setglobal(L, to_luastring('ARGV'));
    let result: AuthorityResult;
    try {
      const loaded = lauxlib.luaL_loadstring(L, to_luastring(AUTHORITY_SCRIPT));
      if (loaded !== lua.LUA_OK) throw new Error(luaString(L, -1));
      const status = lua.lua_pcall(L, 0, 1, 0);
      if (status !== lua.LUA_OK) throw new Error(luaString(L, -1));
      result = JSON.parse(luaString(L, -1)) as AuthorityResult;
    } finally { lua.lua_close(L); }
    for (const json of publications) this.deliver(json);
    return result;
  }
  private deliver(json: string): void {
    for (const listener of this.listeners) {
      // A throwing subscriber must not turn an already committed command into
      // an apparent failure, and subscribers never share mutable snapshots.
      try { listener(JSON.parse(json) as RawState); } catch { /* isolated observer */ }
    }
  }
  async subscribe(listener: Listener): Promise<() => void> {
    if (this.closed) throw new Error('Authority is closed');
    this.listeners.add(listener);
    try {
      const { state } = await this.execute({ type: 'snapshot' });
      if (this.listeners.has(listener)) listener(state);
    } catch (error) { this.listeners.delete(listener); throw error; }
    return () => { this.listeners.delete(listener); };
  }
  async close(): Promise<void> { this.closed = true; this.listeners.clear(); this.store.clear(); }
}

export class RedisAuthority implements Authority {
  private readonly client: Redis;
  private readonly subscriber: Redis;
  private readonly listeners = new Set<Listener>();
  private readonly channel: string;
  private closed = false;
  private subscription: Promise<void> | null = null;
  private deliveredRevision = -1;
  private deliveredNow = -1;
  constructor(url: string, private readonly key: string) {
    if (!url || !key) throw new Error('Redis URL and dedicated state key are required');
    this.channel = `${key}:events`;
    this.client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
    this.subscriber = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2, autoResubscribe: false });
    // Runtime outages surface through execute/subscribe; listeners prevent
    // ioredis from treating transient connection errors as unhandled events.
    this.client.on('error', () => {});
    this.subscriber.on('error', () => {});
    this.subscriber.on('message', (channel: string, json: string) => {
      if (channel === this.channel) this.deliver(json);
    });
    this.subscriber.on('ready', () => {
      if (!this.closed && this.listeners.size > 0) {
        // Subscribe before snapshot: re-established instances cannot miss the
        // authoritative state changed during an interrupted pub/sub interval.
        void this.resubscribe().catch(() => { /* retried on the next ready */ });
      }
    });
  }
  async execute(cmd: InternalCommand): Promise<AuthorityResult> {
    if (this.closed) throw new Error('Authority is closed');
    const result = await this.client.eval(AUTHORITY_SCRIPT, 1, this.key, JSON.stringify(cmd));
    if (typeof result !== 'string') throw new Error('Unexpected Redis EVAL response');
    return JSON.parse(result) as AuthorityResult;
  }
  private deliver(json: string): void {
    let state: RawState;
    try { state = JSON.parse(json) as RawState; } catch { return; }
    // EVAL replies and pub/sub use different connections. A reconnect snapshot
    // must not overwrite a newer publication that happened to arrive first.
    if (state.revision < this.deliveredRevision ||
        (state.revision === this.deliveredRevision && state.now < this.deliveredNow)) return;
    this.deliveredRevision = state.revision;
    this.deliveredNow = state.now;
    for (const listener of this.listeners) {
      try { listener(structuredClone(state)); } catch { /* isolated observer */ }
    }
  }
  private resubscribe(): Promise<void> {
    if (this.subscription) return this.subscription;
    const work = (async () => {
      await this.subscriber.subscribe(this.channel);
      const { state } = await this.execute({ type: 'snapshot' });
      if (!this.closed) this.deliver(JSON.stringify(state));
    })();
    this.subscription = work;
    void work.finally(() => { if (this.subscription === work) this.subscription = null; }).catch(() => {});
    return work;
  }
  async subscribe(listener: Listener): Promise<() => void> {
    if (this.closed) throw new Error('Authority is closed');
    this.listeners.add(listener);
    try { await this.resubscribe(); }
    catch (error) { this.listeners.delete(listener); throw error; }
    return () => { this.listeners.delete(listener); };
  }
  async close(): Promise<void> {
    this.closed = true; this.listeners.clear();
    this.subscriber.disconnect(); this.client.disconnect();
  }
}
