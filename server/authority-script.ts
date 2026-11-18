// This exact source runs in Redis EVAL and in the local Fengari VM.
export const AUTHORITY_SCRIPT = String.raw`
local NULL = cjson.null
local cmd = cjson.decode(ARGV[1])
local stored = redis.call('GET', KEYS[1])
local s = stored and cjson.decode(stored) or {
  revision=0, now=0, seq=0, players={}, rooms={}, _commands={}, _expired={}
}
-- Bounded tombstones prevent a recently removed UUID being restored as a
-- freshly minted session. Older missing IDs are rejected when nickname is absent.
s._expired = s._expired or {}
local t = redis.call('TIME')
-- A float operand is essential: Fengari Lua integers are signed 32 bit.
local now = math.max(tonumber(t[1]) * 1000.0 + math.floor(tonumber(t[2]) / 1000.0), s.now)
s.now = now
local changed = false
local function present(v) return v ~= nil and v ~= NULL end
local function dirty(r)
  changed = true
  if r then r.revision = r.revision + 1 end
end
local function resolve(r, reason, winner, loser, shooter)
  if present(r.result) then return end
  s.seq = s.seq + 1
  r.result = {id=r.id..':'..r.roundId..':'..tostring(s.seq), roundId=r.roundId,
    winnerId=winner or NULL, loserId=loser or NULL, shooterId=shooter or NULL,
    reason=reason, serverAt=now, receiveSeq=s.seq}
  r.phase = 'RESOLVED'
  r.rematchDeadline = now + 30000.0
  r.rematch = {}
  dirty(r)
end
local function closeRoom(r, notice)
  for _, id in ipairs(r.seats) do
    local p = s.players[id]
    if p and p.roomId == r.id then
      p.roomId = NULL; p.ready = false; p.notice = notice
    end
  end
  s.rooms[r.id] = nil
  dirty()
end
local function offline(p, at)
  if not p.online then return end
  p.online = false; p.ready = false; p.connectionId = NULL; p.offlineAt = at
  local r = present(p.roomId) and s.rooms[p.roomId] or nil
  if r and not present(r.result) then resolve(r, 'DISCONNECT') end
  if r and present(r.result) then r.rematch = {}; dirty(r) end
  dirty()
end
-- Maintenance precedes user input. Boundaries are judged against TIME, never
-- against whether a delayed interval happened to update the phase already.
for _, p in pairs(s.players) do
  if p.online and now - p.lastSeen >= 15000.0 then offline(p, p.lastSeen + 15000.0) end
end
for _, r in pairs(s.rooms) do
  if not present(r.result) then
    if r.phase == 'PREPARING' and now >= r.loadDeadline then
      resolve(r, 'LOAD_TIMEOUT')
    elseif present(r.countdownStartAt) and now >= r.countdownStartAt then
      if not (r.ack[r.seats[1]] and r.ack[r.seats[2]]) then
        resolve(r, 'SCHEDULE_TIMEOUT')
      elseif now >= r.deadlineAt then
        resolve(r, 'NO_SHOT')
      elseif now >= r.goAt and r.phase ~= 'DUEL' then
        r.phase = 'DUEL'; dirty(r)
      elseif now < r.goAt and r.phase ~= 'COUNTDOWN' then
        r.phase = 'COUNTDOWN'; dirty(r)
      end
    end
  end
  if present(r.result) and now >= r.rematchDeadline then
    closeRoom(r, '重赛等待已结束，已返回大厅。')
  end
end
for id, p in pairs(s.players) do
  if not p.online and present(p.offlineAt) and now - p.offlineAt >= 60000.0 then
    local r = present(p.roomId) and s.rooms[p.roomId] or nil
    if r then closeRoom(r, '对方的会话已过期，已返回大厅。') end
    s.players[id] = nil; s._commands[id] = nil; dirty()
    s._expired[#s._expired+1] = id
    if #s._expired > 64 then table.remove(s._expired,1) end
  end
end
local function count(map) local n=0; for _ in pairs(map) do n=n+1 end; return n end
local function expiredId(id)
  for _, old in ipairs(s._expired) do if old == id then return true end end
  return false
end
local function validString(v) return type(v)=='string' and #v>0 end
local function validNickname(v)
  if type(v) ~= 'string' then return false end
  -- Redis embeds Lua 5.1 (without utf8); validate UTF-8 explicitly so both
  -- environments execute identical source, including codepoint length limits.
  local i = 1
  local length = 0
  local visible = false
  while i <= #v do
    local first = string.byte(v,i)
    local cp = first
    local width = 1
    local minimum = 0
    if first >= 194 and first <= 223 then cp=first-192; width=2; minimum=128
    elseif first >= 224 and first <= 239 then cp=first-224; width=3; minimum=2048
    elseif first >= 240 and first <= 244 then cp=first-240; width=4; minimum=65536
    elseif first >= 128 then return false end
    for offset=1,width-1 do
      local continuation=string.byte(v,i+offset)
      if not continuation or continuation < 128 or continuation > 191 then return false end
      cp=cp*64+continuation-128
    end
    if cp < minimum or cp > 1114111 or (cp >= 55296 and cp <= 57343) then return false end
    length=length+1
    if length > 16 then return false end
    if cp < 32 or (cp >= 127 and cp <= 159) or cp == 173 or cp == 6158 or
       (cp >= 8203 and cp <= 8207) or (cp >= 8234 and cp <= 8238) or
       (cp >= 8288 and cp <= 8297) or cp == 65279 then return false end
    if cp ~= 32 and cp ~= 160 and cp ~= 12288 then visible = true end
    i=i+width
  end
  return length > 0 and visible
end
local code = nil
local playerId = nil
local p = nil
local cacheable = false
local duplicate = nil
local payload = cmd.payload or {}
local function reject(c) code = c end
local function resetRound(r, roundId)
  r.roundId = roundId; r.phase = 'PREPARING'; r.loaded = {}; r.ack = {}; r.rematch = {}
  r.countdownStartAt = NULL; r.goAt = NULL; r.deadlineAt = NULL
  r.loadDeadline = now + 10000.0; r.rematchDeadline = NULL
  r.scheduleId = NULL; r.result = NULL
  for _, id in ipairs(r.seats) do s.players[id].notice = NULL end
  dirty(r)
end
if cmd.type == 'session.enter' then
  if not (validString(cmd.playerId) and validString(cmd.connectionId) and validString(cmd.resumeHash)) then
    reject('INVALID_MESSAGE')
  else
    p = s.players[cmd.playerId]
    if p then
      if p.resumeHash ~= cmd.resumeHash then reject('SESSION_EXPIRED')
      elseif p.online then reject('SESSION_IN_USE')
      elseif now - p.offlineAt >= 60000.0 then reject('SESSION_EXPIRED')
      else
        p.online = true; p.connectionId = cmd.connectionId; p.lastSeen = now; p.offlineAt = NULL
        p.ready = false; playerId = p.id; dirty()
      end
    elseif not validNickname(cmd.nickname) then
      reject(cmd.nickname == nil and 'SESSION_EXPIRED' or 'INVALID_MESSAGE')
    elseif expiredId(cmd.playerId) then reject('SESSION_EXPIRED')
    elseif count(s.players) >= 20 then reject('LOBBY_FULL')
    else
      p = {id=cmd.playerId, nickname=cmd.nickname, resumeHash=cmd.resumeHash,
        connectionId=cmd.connectionId, lastSeen=now, online=true, ready=false,
        roomId=NULL, notice=NULL, offlineAt=NULL}
      s.players[p.id] = p; playerId=p.id; dirty()
    end
  end
elseif cmd.type == 'heartbeat' then
  for _, connection in ipairs(cmd.connections or {}) do
    local current = s.players[connection.playerId]
    if current and current.online and current.connectionId == connection.connectionId then
      current.lastSeen = now
    end
  end
elseif cmd.type == 'snapshot' or cmd.type == 'tick' then
  -- Internal operations do not require a user's connection binding.
else
  p = s.players[cmd.playerId or '']
  if not p or not p.online or p.connectionId ~= cmd.connectionId then reject('NOT_JOINED')
  elseif cmd.type == 'disconnected' then offline(p, now)
  else
    playerId = p.id
    local r = present(p.roomId) and s.rooms[p.roomId] or nil
    local isRoomCommand = string.sub(cmd.type or '',1,6)=='round.' or
      cmd.type=='room.loaded' or cmd.type=='room.rematch' or cmd.type=='room.leave'
    -- Round freshness precedes the idempotency cache, so replaying an old
    -- command can never be mistaken for an accepted input to a new round.
    if isRoomCommand and (not r) then reject('NOT_IN_ROOM')
    elseif isRoomCommand and (payload.roundId ~= r.roundId or payload.roomId ~= r.id) then reject('STALE_ROUND')
    else
      cacheable = validString(cmd.commandId)
      local history = s._commands[p.id]
      if cacheable and history then
        for _, item in ipairs(history) do
          if item.id == cmd.commandId then duplicate=item; break end
        end
      end
      if duplicate then
        if present(duplicate.code) then code=duplicate.code end
      elseif cmd.type == 'lobby.ready' then
        if r then reject('ALREADY_IN_ROOM')
        elseif type(payload.ready) ~= 'boolean' then reject('INVALID_MESSAGE')
        elseif p.ready ~= payload.ready or present(p.notice) then
          p.ready=payload.ready; p.notice=NULL; dirty()
        end
      elseif cmd.type == 'lobby.challenge' then
        local target = s.players[payload.targetId or '']
        if payload.targetId == p.id then reject('SELF_CHALLENGE')
        elseif r then reject('ALREADY_IN_ROOM')
        elseif not target or not target.online or not target.ready or present(target.roomId) then reject('TARGET_UNAVAILABLE')
        elseif count(s.rooms) >= 10 then reject('ROOMS_FULL')
        elseif not validString(cmd.newRoomId) or not validString(cmd.newRoundId) or s.rooms[cmd.newRoomId] then reject('INVALID_MESSAGE')
        else
          r={id=cmd.newRoomId, seats={p.id,target.id}, revision=0}
          s.rooms[r.id]=r
          p.roomId=r.id; target.roomId=r.id; p.ready=false; target.ready=false
          resetRound(r, cmd.newRoundId)
        end
      elseif cmd.type == 'room.loaded' then
        if r.phase ~= 'PREPARING' then reject('NOT_PLAYING')
        elseif not r.loaded[p.id] then
          r.loaded[p.id]=true; dirty(r)
          if r.loaded[r.seats[1]] and r.loaded[r.seats[2]] then
            r.phase='SCHEDULED'; r.countdownStartAt=now+1000.0
            r.goAt=r.countdownStartAt+3000.0; r.deadlineAt=r.goAt+5000.0
            r.scheduleId=r.roundId; dirty(r)
          end
        end
      elseif cmd.type == 'round.scheduleAck' then
        if payload.scheduleId ~= r.scheduleId then reject('STALE_ROUND')
        elseif r.phase ~= 'SCHEDULED' or now >= r.countdownStartAt then reject('NOT_PLAYING')
        elseif not r.ack[p.id] then r.ack[p.id]=true; dirty(r) end
      elseif cmd.type == 'round.fire' or cmd.type == 'round.falseStart' then
        if present(r.result) then reject('NOT_PLAYING')
        elseif not present(r.countdownStartAt) or now < r.countdownStartAt then reject('NOT_PLAYING')
        elseif now < r.goAt then
          local other = r.seats[1] == p.id and r.seats[2] or r.seats[1]
          resolve(r,'FALSE_START',other,p.id,p.id)
        elseif cmd.type == 'round.falseStart' then reject('NOT_PLAYING')
        elseif now < r.deadlineAt then
          local other = r.seats[1] == p.id and r.seats[2] or r.seats[1]
          resolve(r,'SHOT',p.id,other,p.id)
        else reject('NOT_PLAYING') end
      elseif cmd.type == 'room.rematch' then
        if not present(r.result) then reject('NOT_RESOLVED')
        elseif not (s.players[r.seats[1]].online and s.players[r.seats[2]].online) then reject('TARGET_UNAVAILABLE')
        elseif not validString(cmd.newRoundId) or cmd.newRoundId == r.roundId then reject('INVALID_MESSAGE')
        elseif not r.rematch[p.id] then
          r.rematch[p.id]=true; dirty(r)
          if r.rematch[r.seats[1]] and r.rematch[r.seats[2]] then resetRound(r, cmd.newRoundId) end
        end
      elseif cmd.type == 'room.leave' then
        if not present(r.result) then resolve(r,'LEFT') end
        closeRoom(r,'对局已结束，已返回大厅。')
      elseif cmd.type == 'state.sync' or cmd.type == 'clock.ping' then
        -- Accepted for adapters which don't map these to snapshot.
      else reject('INVALID_MESSAGE') end
    end
  end
end
if cacheable and not duplicate then
  local history=s._commands[p.id] or {}
  history[#history+1]={id=cmd.commandId, code=code or NULL}
  if #history > 64 then table.remove(history,1) end
  s._commands[p.id]=history
end
if changed then s.revision = s.revision + 1 end
-- Persist heartbeats, command cache and the monotonic TIME floor even if no
-- business revision changed; publishing is limited to actual business changes.
local json = cjson.encode(s)
redis.call('SET',KEYS[1],json)
if changed then redis.call('PUBLISH',KEYS[1]..':events',json) end
local answer={ok=code==nil,state=s}
if code then answer.code=code end
if playerId then answer.playerId=playerId end
return cjson.encode(answer)
`;
