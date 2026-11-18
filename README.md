# HIGH NOON · 正午决斗

两名真人在同一个大厅匹配，3 秒倒计时后点击开枪。一局固定两人，中央裁判先处理的有效开枪获胜。抢跑输，5 秒无人开枪平局，双方确认才重赛。

## 本地启动

需要 Node.js 22 和项目声明的 pnpm 10.29.2。依赖只装在本项目，不需要全局 Redis：

```bash
pnpm install --frozen-lockfile
pnpm dev
```

打开 `http://127.0.0.1:3030`。用正常与无痕窗口分别输入昵称，可以连接同一个真实 Node Socket.IO 服务。默认本地权威存储是内存，但裁判执行同一份 Lua 脚本；退出服务会清空大厅和房间。

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

`pnpm start` 运行构建后的页面，仍默认绑定回环地址。用 `PORT=另一个空闲端口 pnpm dev` 修改端口。启动服务不会自动读取 `.env`；复制 `.env.example` 后可在 shell 导出变量。不要提交真实密钥。

## 两台设备同 Wi-Fi

先启动本地游戏。另开终端运行：

```bash
LAN_HOST=本机局域网IP node --import tsx server/lan.ts
```

如果没有指定正确本机地址，该命令只显示可选地址并退出，不默认开放所有网卡。用第二台设备访问日志里的 `http://局域网IP:3031`。电脑、手机必须在同一网络，访客隔离或防火墙可能阻止访问。测试结束关闭入口。手机的 localhost 不是电脑。

## Vercel 部署

前端用 Vite 构建；`api/socket.ts` 是原生 WebSocket Function，Socket.IO 只用 WebSocket transport。Vercel 需要 Fluid compute。当前 Hobby 连接最长约 300 秒，客户端必须重连、重校时并取快照；活动局断线作废，不能补打一枪。

**云端必须配置真实共享 Redis**。多名玩家不保证在同一个 Function 实例，进程内存不能做跨实例裁判。环境变量设置为：

- `REDIS_URL`：本游戏专用的 Redis TLS 连接 URL，通常为 `rediss://...`。也兼容平台注入的 `KV_URL`。
- `REDIS_KEY`：可选专用 key 前缀。默认 Production 为 `highnoon:v1:production`，Preview 按分支隔离。
- `ALLOWED_ORIGINS`：可选实际游戏页面 Origin 的逗号列表；服务也独立检查连接是否来自同请求源。
- `TEST_CODE`：可选临时演示口令，仅存服务端。实际启用时需在客户端入口支持输入。

Redis 凭证必须作为服务端环境变量，不用 `VITE_` 前缀。无配置时联机服务和 `/api/health` 明确返回不可用，绝不切换成假联机。不要将本地 VM 模式当成 Redis 生产验证。

用户已授权通过 Vercel MCP 部署。本项目只创建独立私有 GitHub 仓库与 Vercel 项目，不覆盖其他项目。新增共享资源、费用、升级和第三方条款按用户单独授权处理。

## 为什么不会因时区产生恒胜

胜负不用玩家电脑时间、日期或时区；不比较不同 Function 的 `performance.now()`。裁判时间来自同一 Redis 的 TIME，输入顺序由同一个原子 Lua 执行顺序确定，结果锁定后不可翻转。客户端校时只用于共同信号的绘制，不用于补偿网络延迟或排胜负。

网络更快的一方可能更有利，这属于首版明确保留的限制。固定 3 秒信号不防自动点击脚本，不面向奖金或排位竞技。

## 验证边界

规则和真实 Socket.IO 自动客户端可以验证共享状态、唯一结果、竞争挑战、重赛与恢复。真实 Redis、多 Function 实例、两台设备、手机 Safari/Chrome、两名真人和公网访问各自需要实际证据。未经执行不会标为通过。实际进展见 `TODO.md` 和后续 `docs/验收记录.md`。

详细规则、UI 和原验收条款见 `plan.md` 与上一级 outputs/challenge-02 中已批准的验收方案。
