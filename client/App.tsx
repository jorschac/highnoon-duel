import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResultReason, RoomView } from '../shared/protocol';
import { WesternScene } from './WesternScene';
import { useGame } from './useGame';
import './styles.css';

const REASONS: Record<ResultReason, string> = {
  SHOT: '中央裁判先处理的有效开枪获胜。',
  FALSE_START: '倒计时结束前开枪，抢跑判负。',
  NO_SHOT: '开枪信号后 5 秒内无人开枪，本局平局。',
  DISCONNECT: '活动轮次有玩家断线，本局作废。',
  LEFT: '有玩家离开对局，本局作废。',
  LOAD_TIMEOUT: '双方未在规定时间内完成加载，本局作废。',
  SCHEDULE_TIMEOUT: '双方未确认同一倒计时计划，本局作废。',
};
const LINK_LABEL = { connecting: '正在连接', connected: '已连接 · 待入场', syncing: '重新同步中', online: '已连接', offline: '连接中断' };
function SunBadge({ className = '' }: { className?: string }) {
  return <svg className={`sun-badge ${className}`} viewBox="0 0 100 100" aria-hidden="true"><path d="M50 2 61 24 84 14 77 39 98 50 77 61 84 86 61 76 50 98 39 76 16 86 23 61 2 50 23 39 16 14 39 24Z" fill="currentColor"/><circle cx="50" cy="50" r="24" fill="none" stroke="var(--paper)" strokeWidth="3"/><circle cx="50" cy="50" r="19" fill="none" stroke="var(--paper)" strokeWidth="1"/></svg>;
}
function Avatar({ nickname, self = false }: { nickname: string; self?: boolean }) {
  return <span className={`player-avatar ${self ? 'avatar-self' : ''}`} aria-hidden="true"><span className="avatar-hat"/><span className="avatar-face"/><span className="avatar-coat"/><span className="avatar-letter">{nickname.slice(0, 1)}</span></span>;
}
function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}
function useSound() {
  const [enabled, setEnabled] = useState(false);
  const context = useRef<AudioContext | null>(null);
  const toggle = () => {
    if (!enabled) {
      try { context.current ??= new AudioContext(); void context.current.resume(); setEnabled(true); } catch { setEnabled(false); }
    } else setEnabled(false);
  };
  const play = (shot = false) => {
    const audio = context.current;
    if (!enabled || !audio) return;
    void audio.resume();
    const oscillator = audio.createOscillator(), gain = audio.createGain();
    oscillator.type = shot ? 'sawtooth' : 'triangle';
    oscillator.frequency.setValueAtTime(shot ? 170 : 460, audio.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(shot ? 45 : 220, audio.currentTime + 0.09);
    gain.gain.setValueAtTime(shot ? 0.1 : 0.055, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + (shot ? 0.14 : 0.07));
    oscillator.connect(gain); gain.connect(audio.destination);
    oscillator.start(); oscillator.stop(audio.currentTime + 0.16);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  };
  useEffect(() => () => { void context.current?.close(); }, []);
  return { enabled, toggle, play };
}

function countdown(room: RoomView, serverNow: number) {
  if (room.phase === 'RESOLVED') return { value: '已裁决', subtitle: '胜负已锁定', live: false };
  if (room.phase === 'PREPARING') return { value: '就位', subtitle: '等待双方完成场景加载与校时', live: false };
  if (room.phase === 'SCHEDULED') return { value: '准备', subtitle: '正在确认共同的三秒倒计时', live: false };
  if (room.phase === 'DUEL' || (room.phase === 'COUNTDOWN' && room.goAt !== null && serverNow >= room.goAt)) return { value: '开枪！', subtitle: '现在点击开枪 · 一发定胜负', live: true };
  return { value: String(Math.min(3, Math.max(1, Math.ceil(((room.goAt ?? serverNow + 3000) - serverNow) / 1000)))), subtitle: '等待信号', live: false };
}

export default function App() {
  const game = useGame();
  const { snapshot, status, canAct, foreground, clockReady, send } = game;
  const self = snapshot?.players.find(player => player.id === snapshot.playerId);
  const room = snapshot?.room ?? null;
  const [nickname, setNickname] = useState('');
  const [entering, setEntering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [firedRound, setFiredRound] = useState<string | null>(null);
  const firing = useRef<string | null>(null);
  const [now, setNow] = useState(0);
  const [overlayResult, setOverlayResult] = useState<string | null>(null);
  const [sceneReadyKey, setSceneReadyKey] = useState('');
  const loadedKeys = useRef(new Set<string>());
  const scheduleKeys = useRef(new Set<string>());
  const prefersReduced = useReducedMotion();
  const [manualReduced, setManualReduced] = useState(false);
  const reducedMotion = prefersReduced || manualReduced;
  const sound = useSound();
  const sceneKey = room?.id ?? 'lobby';
  const sceneReady = useCallback(() => setSceneReadyKey(sceneKey), [sceneKey]);

  useEffect(() => {
    if (!room) return;
    setNow(game.serverNow());
    const timer = window.setInterval(() => { if (!document.hidden) setNow(game.serverNow()); }, 50);
    return () => window.clearInterval(timer);
  }, [room?.roundId, game.serverNow, clockReady]);
  useEffect(() => { firing.current = null; setFiredRound(null); setOverlayResult(null); }, [room?.roundId]);
  useEffect(() => {
    if (!room?.result) return;
    const id = room.result.id;
    const timer = window.setTimeout(() => setOverlayResult(id), 400);
    return () => window.clearTimeout(timer);
  }, [room?.result?.id]);
  useEffect(() => {
    if (!game.notice) return;
    const timer = window.setTimeout(() => game.setNotice(''), 6500);
    return () => window.clearTimeout(timer);
  }, [game.notice, game.setNotice]);
  useEffect(() => {
    if (!room || !self || !canAct || sceneReadyKey !== room.id || room.phase !== 'PREPARING' || room.loaded[self.id]) return;
    const key = `${game.connectionEpoch}:${room.id}:${room.roundId}`;
    if (loadedKeys.current.has(key)) return;
    loadedKeys.current.add(key);
    void send('room.loaded', { roomId: room.id, roundId: room.roundId });
  }, [room, self, canAct, sceneReadyKey, game.connectionEpoch, send]);
  useEffect(() => {
    if (!room || !canAct || room.phase !== 'SCHEDULED' || !room.scheduleId) return;
    const key = `${game.connectionEpoch}:${room.id}:${room.roundId}:${room.scheduleId}`;
    if (scheduleKeys.current.has(key)) return;
    scheduleKeys.current.add(key);
    void send('round.scheduleAck', { roomId: room.id, roundId: room.roundId, scheduleId: room.scheduleId });
  }, [room, canAct, game.connectionEpoch, send]);

  const action = async (type: 'lobby.ready' | 'lobby.challenge' | 'room.leave' | 'room.rematch', payload: Parameters<typeof send>[1]) => {
    if (busy || !canAct) return;
    setBusy(true); game.setError(''); sound.play();
    await send(type, payload); setBusy(false);
  };
  const signal = room ? countdown(room, now) : null;
  const shotSent = !!room && firedRound === room.roundId;
  const canFire = !!room && canAct && !shotSent && !room.result && (room.phase === 'COUNTDOWN' || room.phase === 'DUEL');
  const fire = () => {
    if (!room || !canFire || firing.current === room.roundId) return;
    firing.current = room.roundId;
    setFiredRound(room.roundId); game.setError(''); sound.play(true);
    // No replay, no client-side result: the local draw is only tactile feedback.
    // The identical click command is judged by authority time, never by this display clock.
    void send('round.fire', { roomId: room.id, roundId: room.roundId });
  };
  const needsIdentity = !snapshot || !!game.identityError;
  const result = room?.result;
  const isVoid = !!result && ['DISCONNECT', 'LEFT', 'LOAD_TIMEOUT', 'SCHEDULE_TIMEOUT'].includes(result.reason);
  const won = !!result && result.winnerId === snapshot?.playerId;
  const lost = !!result && result.loserId === snapshot?.playerId;
  const resultTitle = isVoid ? '本局作废' : won ? '你赢了' : lost ? '你输了' : '平局';
  const otherPlayers = snapshot?.players.filter(player => player.id !== snapshot.playerId) ?? [];
  const rematchCount = room ? room.players.filter(player => room.rematch[player.id]).length : 0;
  const meConfirmed = self ? !!room?.rematch[self.id] : false;
  const nicknameLength = (name: string) => Array.from(new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(name)).length;

  return <div className={`app ${reducedMotion ? 'reduce-motion' : ''}`}>
    <header className="masthead">
      <a className="brand" href="#main" aria-label="HIGH NOON 正午决斗"><SunBadge/><span><strong>HIGH NOON</strong><span className="brand-cn">正 午 决 斗</span></span></a>
      <div className="header-tools"><span className={`connection ${status === 'online' || status === 'connected' ? 'connection-ok' : ''}`} role="status"><i/>{LINK_LABEL[status]}</span><div className="preferences"><button type="button" onClick={sound.toggle} aria-pressed={sound.enabled}>声音：{sound.enabled ? '开' : '关'}</button><button type="button" onClick={() => setManualReduced(value => !value)} aria-pressed={reducedMotion} disabled={prefersReduced}>减少动态：{reducedMotion ? '开' : '关'}</button></div></div>
    </header>
    <main id="main">
      {(game.error || (snapshot && status !== 'online' && !game.identityError)) && <div className="error-strip" role="alert"><span>{game.error || '连接尚未完成同步，当前不能开枪。'}</span>{!game.identityError && <button className="retry-sync" type="button" onClick={game.reconnect}>重新同步</button>}<button type="button" onClick={() => game.setError('')} aria-label="关闭错误提示">×</button></div>}
      {game.identityError && <div className="identity-warning"><strong>{game.identityError === 'SESSION_IN_USE' ? '这个身份正在另一个窗口中使用' : '原身份已过期'}</strong><p>不会接管或重发原对局输入。清除当前窗口凭证后，可以用新身份进入大厅。</p><button className="button button-outline" onClick={game.newIdentity}>清除凭证，建立新身份</button></div>}
      {!room || needsIdentity ? <div className="lobby-layout">
        <section className="frontier-poster" aria-labelledby="poster-title"><div className="edition"><span>THE FRONTIER CHRONICLE</span><span>EST. HIGH NOON</span></div><h1 id="poster-title">正午，只留<br/><em>一个快枪手。</em></h1><p className="poster-deck">两个真人 · 三秒倒计时 · 一发定胜负</p><div className="poster-scene"><WesternScene players={[]} drawn={false} result={null} reducedMotion={reducedMotion} lobby/><div className="poster-stamp"><SunBadge/><span>公平裁判<br/><small>SERVER AUTHORITY</small></span></div></div><div className="poster-bottom"><span>等信号，别抢跑。</span><span>★</span></div></section>
        <section className="lobby-panel" aria-labelledby="lobby-title"><div className="section-kicker">真人在线 / LIVE FRONTIER</div><div className="lobby-heading"><h2 id="lobby-title">决斗大厅</h2><span>{snapshot && !needsIdentity ? `${snapshot.players.length} 人在镇上` : '欢迎来到荒野'}</span></div><p className="lobby-intro">进入就绪状态接受挑战，或选择已就绪的玩家。</p>
          {needsIdentity ? <form className="entry-form" onSubmit={async event => {
            event.preventDefault();
            const name = nickname.trim();
            if (!name || nicknameLength(name) > 16 || /[\u0000-\u001f\u007f]/.test(name)) { game.setError('请输入 1–16 个可见字符的昵称。'); return; }
            if (entering || game.identityError) return;
            setEntering(true); sound.play(); await game.enter(name); setEntering(false);
          }}><span className="entry-label">先留下你的名字</span><label htmlFor="nickname">牛仔昵称</label><input id="nickname" name="nickname" autoComplete="nickname" placeholder="例如：荒野来客" value={nickname} onChange={event => setNickname(event.target.value)} maxLength={32} disabled={entering || !!game.identityError}/><p className="field-help">1–16 个可见字符。不需要账号，仅此窗口保存身份。</p><button className="button button-primary entry-submit" disabled={entering || status !== 'connected' || !!game.identityError}>{entering ? '正在进入…' : '进入决斗大厅'}<span aria-hidden="true">→</span></button><div className="entry-rule"><span>01</span> 等待严格三秒倒计时<span>02</span> 看到“开枪”再点击</div></form> : <>
            {self && <div className="self-row"><Avatar nickname={self.nickname} self/><div className="player-name"><strong>{self.nickname}</strong><span>你的身份 · {self.ready ? '已就绪，接受一次挑战' : '尚未就绪'}</span></div><button className={`button ${self.ready ? 'button-outline' : 'button-primary'}`} disabled={!canAct || busy} onClick={() => void action('lobby.ready', { ready: !self.ready })}>{self.ready ? '取消就绪' : '进入就绪'}</button></div>}
            <div className="list-label"><span>镇上的牛仔</span><span>状态 / 操作</span></div>
            <div className="players-list">{otherPlayers.length ? otherPlayers.map(player => {
              const available = player.online && player.ready && !player.roomId;
              const label = !player.online ? '离线' : player.roomId ? '对局中' : player.ready ? '已就绪' : '未就绪';
              return <div className="player-row" key={player.id}><Avatar nickname={player.nickname}/><strong className="row-name">{player.nickname}</strong><span className={`player-status ${available ? 'ready' : ''}`}><i/>{label}</span><button className="button button-outline" disabled={!available || !canAct || busy} onClick={() => void action('lobby.challenge', { targetId: player.id })}>{available ? '挑战' : player.roomId ? '对局中' : '等待就绪'}</button></div>;
            }) : <div className="empty-lobby"><SunBadge/><h3>荒野静候第二位牛仔</h3><p>暂无其他真人玩家。邀请朋友在另一个设备<br className="desktop-break"/>打开同一个网址，加入这座小镇。</p><span>没有机器人，只有真正的对手。</span></div>}</div>
            {!clockReady && status === 'online' && <p className="sync-note" role="status">{foreground ? '正在完成低延迟时钟校准，请稍候…' : '页面在后台，回到前台后重新校时。'}</p>}
          </>}
          <div className="rules-line"><span>★</span><p><strong>3 秒倒计时</strong> · 点击开枪 · 裁判先处理的有效开枪获胜</p><span>★</span></div><p className="rule-fine">抢跑判负；5 秒无人开枪则平局。网络断线不补枪，活动轮次作废。</p>
        </section>
      </div> : <section className="duel" aria-label="双人对决">
        <div className="duel-top">{room.players.map((player, index) => <div key={player.id} className={`duelist-banner duelist-${index} ${player.id === snapshot?.playerId ? 'duelist-self' : ''}`}><Avatar nickname={player.nickname} self={player.id === snapshot?.playerId}/><div><strong>{player.nickname}{player.id === snapshot?.playerId && <small>（你）</small>}</strong><span className={player.online ? 'online-label' : ''}>{player.online ? '在线' : '已断线'}{room.phase === 'PREPARING' && (room.loaded[player.id] ? ' · 已就位' : ' · 加载中')}</span></div></div>)}<span className="duel-versus">★ 双人决斗 ★</span></div>
        <div className="arena"><WesternScene players={room.players} selfId={snapshot?.playerId} drawn={shotSent} result={room.result} reducedMotion={reducedMotion} onReady={sceneReady}/>
          {!room.result && <div className={`countdown ${signal?.live && canAct ? 'signal-go' : ''}`} aria-live="polite" aria-atomic="true"><strong>{!canAct ? status !== 'online' ? '同步中' : !foreground ? '已暂停' : '校时中' : signal?.value}</strong><span>{!canAct ? '保持连接后重新同步，当前不能开枪' : signal?.subtitle}</span></div>}
          {result && overlayResult === result.id && <div className="result-overlay"><section className={`result-sheet ${won ? 'result-win' : ''}`} aria-labelledby="result-title"><div className="result-ornament">— ★ —</div>{won && <div className="winner-seal"><SunBadge/><span>胜者</span></div>}<p className="section-kicker">中央裁判 · 最终裁决</p><h2 id="result-title">{resultTitle}</h2><p className="result-players">{result.reason === 'SHOT' ? <>{room.players.find(player => player.id === result.shooterId)?.nickname ?? '牛仔'} 击中了 {room.players.find(player => player.id === result.loserId)?.nickname ?? '对手'}</> : result.reason === 'FALSE_START' ? <>{room.players.find(player => player.id === result.loserId)?.nickname ?? '玩家'} 抢跑</> : '这一轮，没有人需要再拔枪。'}</p><p className="result-reason">{REASONS[result.reason]}</p><button className="button button-primary" disabled={!canAct || busy || meConfirmed} onClick={() => void action('room.rematch', { roomId: room.id, roundId: room.roundId })}>{meConfirmed ? '已确认，等待对方' : '再来一局'}</button><button className="button button-outline" disabled={!canAct || busy} onClick={() => void action('room.leave', { roomId: room.id, roundId: room.roundId })}>返回大厅</button><p className="rematch-status" role="status">{rematchCount}/2 已确认 · 双方确认才开始新一轮</p>{room.rematchDeadline && <p className="result-expiry">等待期限剩余 {Math.max(0, Math.ceil((room.rematchDeadline - now) / 1000))} 秒</p>}</section></div>}
        </div>
        <div className="fire-controls"><button type="button" className={`button fire-button ${signal?.live ? 'fire-go' : ''}`} disabled={!canFire} onClick={fire}>{shotSent ? '已发送 · 等待裁决' : room.result ? '本局已结束' : '开 枪'}</button><p className={signal?.live ? 'fire-instruction go-instruction' : 'fire-instruction'}>{shotSent ? '输入已送往服务器，本轮不能再次开枪。' : room.phase === 'PREPARING' || room.phase === 'SCHEDULED' ? '双方就位与确认后，开始严格 3 秒倒计时。' : room.result ? '结果由服务器锁定，不受迟到输入影响。' : signal?.live ? '信号已到，点击开枪！' : '倒计时结束前开枪，抢跑判负。'}</p>{!room.result && <button className="leave-link" disabled={busy || !canAct} onClick={() => void action('room.leave', { roomId: room.id, roundId: room.roundId })}>离开本局</button>}</div>
      </section>}
    </main>
    <footer className="site-footer"><span>HIGH NOON · 正午决斗</span><span>同一中央裁判 · 双方同步结算 · 不做延迟补偿</span></footer>
    {game.notice && <div className="notice-toast" role="status"><span>{game.notice}</span><button onClick={() => game.setNotice('')} aria-label="关闭通知">×</button></div>}
  </div>;
}
