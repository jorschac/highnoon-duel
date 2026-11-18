export const PROTOCOL = 'highnoon-v1' as const;
export const RULES = {
  countdownMs: 3000, noticeMs: 1000, fireWindowMs: 5000,
  loadTimeoutMs: 10000, rematchTimeoutMs: 30000, resumeMs: 60000,
  leaseMs: 15000, maxPlayers: 20, maxRooms: 10,
} as const;
export type Phase = 'PREPARING' | 'SCHEDULED' | 'COUNTDOWN' | 'DUEL' | 'RESOLVED';
export type ResultReason = 'SHOT' | 'FALSE_START' | 'NO_SHOT' | 'DISCONNECT' | 'LEFT' | 'LOAD_TIMEOUT' | 'SCHEDULE_TIMEOUT';
export interface PlayerView { id: string; nickname: string; online: boolean; ready: boolean; roomId?: string | null }
export interface ResultView {
  id: string; roundId: string; winnerId: string | null; loserId: string | null;
  shooterId: string | null; reason: ResultReason; serverAt: number; receiveSeq: number;
}
export interface RoomView {
  id: string; roundId: string; phase: Phase; players: PlayerView[];
  loaded: Record<string, boolean>; rematch: Record<string, boolean>;
  countdownStartAt: number | null; goAt: number | null; deadlineAt: number | null;
  loadDeadline: number; rematchDeadline: number | null; scheduleId: string | null;
  result: ResultView | null; revision: number;
}
export interface Snapshot {
  protocol: typeof PROTOCOL; revision: number; serverNow: number; playerId: string;
  players: PlayerView[]; room: RoomView | null; notice: string | null; rules: typeof RULES;
}
export interface SessionCredentials { playerId: string; resumeToken: string }
export interface Welcome extends SessionCredentials { snapshot: Snapshot }
export type CommandType = 'session.enter' | 'lobby.ready' | 'lobby.challenge' | 'room.loaded' |
  'round.scheduleAck' | 'round.fire' | 'round.falseStart' | 'room.rematch' | 'room.leave' |
  'state.sync' | 'clock.ping';
export interface Command {
  protocol: typeof PROTOCOL; commandId: string; type: CommandType;
  payload?: { nickname?: string; playerId?: string; resumeToken?: string; ready?: boolean;
    targetId?: string; roomId?: string; roundId?: string; scheduleId?: string; testCode?: string };
}
export interface Reply {
  ok: boolean; code?: string; message?: string; serverNow: number;
  snapshot?: Snapshot; welcome?: Welcome;
}
export const ERROR_MESSAGES: Record<string, string> = {
  INVALID_MESSAGE: '消息格式不正确。', INCOMPATIBLE: '版本已更新，请刷新页面。',
  NOT_JOINED: '请先进入大厅。', SESSION_EXPIRED: '会话已过期或服务已重启，请重新进入大厅。',
  SESSION_IN_USE: '该身份已在另一个窗口使用，请选择新玩家身份。',
  LOBBY_FULL: '大厅已满，请稍后再来。', ROOMS_FULL: '对局已满，请稍后再试。',
  TARGET_UNAVAILABLE: '对方已进入对局或取消就绪，请选择其他玩家。',
  SELF_CHALLENGE: '不能挑战自己。', ALREADY_IN_ROOM: '你已经在一局对决中。',
  NOT_IN_ROOM: '当前不在对局中。', STALE_ROUND: '这条输入来自旧轮次，已忽略。',
  NOT_PLAYING: '当前还不能开枪。', NOT_RESOLVED: '请等待本局结束。',
  RATE_LIMITED: '操作太频繁，请稍后重试。', SERVICE_UNAVAILABLE: '联机服务暂不可用，请重新连接。',
  TEST_CODE_REQUIRED: '测试口令不正确。',
};
