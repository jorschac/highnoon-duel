import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { PROTOCOL, ERROR_MESSAGES, type Command, type CommandType, type Reply, type SessionCredentials, type Snapshot, type Welcome } from '../shared/protocol';

const STORAGE_KEY = 'highnoon.session.v1';
function readCredentials(): SessionCredentials | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    return value && typeof value.playerId === 'string' && typeof value.resumeToken === 'string' ? value : null;
  } catch { return null; }
}
function storeCredentials(value: SessionCredentials | null) {
  try { value ? sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value)) : sessionStorage.removeItem(STORAGE_KEY); } catch { /* Private storage may be unavailable. */ }
}
function commandId() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
export type LinkStatus = 'connecting' | 'connected' | 'syncing' | 'online' | 'offline';

export function useGame() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<LinkStatus>('connecting');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [clockReady, setClockReady] = useState(false);
  const [foreground, setForeground] = useState(!document.hidden);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const socket = useRef<Socket | null>(null);
  const credentials = useRef(readCredentials());
  const snapshotRef = useRef<Snapshot | null>(null);
  const authenticated = useRef(false);
  const epoch = useRef(0);
  const offset = useRef(0);
  const calibration = useRef(0);
  const calibrating = useRef<string | null>(null);
  const lastNotice = useRef('');

  const acceptSnapshot = useCallback((next: Snapshot) => {
    if (!next || next.protocol !== PROTOCOL) return;
    const previous = snapshotRef.current;
    if (previous && (next.revision < previous.revision ||
      (next.revision === previous.revision && next.serverNow < previous.serverNow))) return;
    // Equal revisions may carry a per-player room cancellation notice.
    if (next.notice && next.notice !== lastNotice.current) {
      lastNotice.current = next.notice;
      setNotice(next.notice);
    } else if (!next.notice) lastNotice.current = '';
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const acceptWelcome = useCallback((welcome: Welcome) => {
    credentials.current = { playerId: welcome.playerId, resumeToken: welcome.resumeToken };
    storeCredentials(credentials.current);
    authenticated.current = true;
    setIdentityError(null);
    acceptSnapshot(welcome.snapshot);
  }, [acceptSnapshot]);

  const send = useCallback((type: CommandType, payload?: Command['payload'], quiet = false): Promise<Reply | null> => {
    const current = socket.current;
    if (!current?.connected) {
      if (!quiet) setError('连接已断开，操作没有发送。恢复连接后请重新确认。');
      return Promise.resolve(null);
    }
    const sentEpoch = epoch.current;
    const command: Command = { protocol: PROTOCOL, commandId: commandId(), type, ...(payload ? { payload } : {}) };
    return new Promise(resolve => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        if (!quiet && sentEpoch === epoch.current) setError('未收到服务器确认，正在同步；不会自动重发开枪。');
        // An uncertain acknowledgement is recovered by reading state, never replaying input.
        if (type !== 'state.sync' && type !== 'clock.ping' && current.connected && sentEpoch === epoch.current && authenticated.current) {
          current.emit('command', { protocol: PROTOCOL, commandId: commandId(), type: 'state.sync' } satisfies Command, (reply: Reply) => {
            if (sentEpoch === epoch.current && reply?.snapshot) acceptSnapshot(reply.snapshot);
          });
        }
        resolve(null);
      }, type === 'clock.ping' ? 1800 : 3500);
      current.emit('command', command, (reply: Reply) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (sentEpoch !== epoch.current) { resolve(null); return; }
        if (reply?.welcome) acceptWelcome(reply.welcome);
        if (reply?.snapshot) acceptSnapshot(reply.snapshot);
        if (!reply?.ok && !quiet) {
          const code = reply?.code || '';
          setError(ERROR_MESSAGES[code] || reply?.message || '操作未完成，请稍后再试。');
          if (code === 'SESSION_EXPIRED' || code === 'SESSION_IN_USE') {
            authenticated.current = false;
            setIdentityError(code);
            setStatus('connected');
            setClockReady(false);
          }
        }
        resolve(reply || null);
      });
    });
  }, [acceptSnapshot, acceptWelcome]);

  const calibrate = useCallback(async () => {
    if (document.hidden || !socket.current?.connected || !authenticated.current) return false;
    const generation = calibration.current;
    const sentEpoch = epoch.current;
    const key = `${generation}:${sentEpoch}`;
    if (calibrating.current === key) return false;
    calibrating.current = key;
    const samples: { rtt: number; offset: number }[] = [];
    for (let i = 0; i < 7; i++) {
      if (document.hidden || generation !== calibration.current || sentEpoch !== epoch.current) break;
      const start = performance.now();
      const reply = await send('clock.ping', undefined, true);
      const end = performance.now();
      if (reply?.ok && Number.isFinite(reply.serverNow)) samples.push({ rtt: end - start, offset: reply.serverNow - (start + end) / 2 });
    }
    if (calibrating.current === key) calibrating.current = null;
    if (samples.length < 5 || document.hidden || generation !== calibration.current || sentEpoch !== epoch.current || !socket.current?.connected) return false;
    const selected = samples.sort((a, b) => a.rtt - b.rtt).slice(0, 5);
    offset.current = selected.reduce((sum, sample) => sum + sample.offset, 0) / selected.length;
    setClockReady(true);
    setStatus('online');
    return true;
  }, [send]);

  const synchronize = useCallback(async () => {
    if (!authenticated.current) return;
    setStatus('syncing');
    const sentEpoch = epoch.current;
    const reply = await send('state.sync');
    if (reply?.ok && sentEpoch === epoch.current && socket.current?.connected && authenticated.current) {
      setStatus('online');
      await calibrate();
    }
  }, [send, calibrate]);

  const enter = useCallback(async (nickname: string) => {
    setError('');
    setStatus('syncing');
    const reply = await send('session.enter', { nickname });
    if ((reply?.ok || reply === null) && authenticated.current) await synchronize();
    else if (socket.current?.connected) setStatus('connected');
    return authenticated.current;
  }, [send, synchronize]);

  useEffect(() => {
    const current = io({ path: '/api/socket', transports: ['websocket'], addTrailingSlash: false, reconnection: true });
    socket.current = current;
    current.on('state', acceptSnapshot);
    current.on('welcome', acceptWelcome);
    current.on('connect', async () => {
      epoch.current += 1;
      setConnectionEpoch(epoch.current);
      authenticated.current = false;
      calibration.current += 1;
      setClockReady(false);
      setError('');
      setStatus('connected');
      // Resume only on a new connection. No automatic takeover of another window.
      if (credentials.current) {
        setStatus('syncing');
        const reply = await send('session.enter', credentials.current);
        if ((reply?.ok || reply === null) && authenticated.current) await synchronize();
        else if (current.connected) setStatus('connected');
      }
    });
    current.on('disconnect', () => {
      epoch.current += 1;
      authenticated.current = false;
      calibration.current += 1;
      setClockReady(false);
      setStatus('offline');
    });
    current.on('connect_error', () => {
      setStatus('offline');
      setError('暂时无法连接联机裁判，请稍候。没有离线对局或缓存开枪。');
    });
    current.on('service.error', () => {
      calibration.current += 1;
      setClockReady(false);
      setStatus('syncing');
      setError(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
    });
    return () => { epoch.current += 1; calibration.current += 1; current.removeAllListeners(); current.disconnect(); socket.current = null; };
  }, [acceptSnapshot, acceptWelcome, send, synchronize]);

  useEffect(() => {
    const onVisibility = () => {
      setForeground(!document.hidden);
      calibration.current += 1;
      setClockReady(false);
      if (!document.hidden && authenticated.current && socket.current?.connected) void synchronize();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(() => { void calibrate(); }, 5000);
    return () => { document.removeEventListener('visibilitychange', onVisibility); window.clearInterval(timer); };
  }, [synchronize, calibrate]);

  const newIdentity = useCallback(() => {
    credentials.current = null;
    storeCredentials(null);
    authenticated.current = false;
    snapshotRef.current = null;
    setSnapshot(null);
    setIdentityError(null);
    setError('');
    setClockReady(false);
    socket.current?.disconnect();
    setStatus('connecting');
    socket.current?.connect();
  }, []);

  const reconnect = useCallback(() => {
    setError('');
    calibration.current += 1;
    setClockReady(false);
    if (authenticated.current && socket.current?.connected) void synchronize();
    else { socket.current?.disconnect(); socket.current?.connect(); }
  }, [synchronize]);

  return { snapshot, status, error, setError, notice, setNotice, identityError, clockReady, foreground, connectionEpoch, enter, send, newIdentity, reconnect,
    serverNow: useCallback(() => performance.now() + offset.current, []),
    canAct: status === 'online' && foreground && clockReady && !identityError,
  };
}
