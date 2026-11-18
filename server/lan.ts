import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
const host = process.env.LAN_HOST;
const localIPs = Object.values(os.networkInterfaces()).flat().filter(Boolean).filter(i => i!.family === 'IPv4' && !i!.internal).map(i => i!.address);
if (!host || !localIPs.includes(host)) {
  console.error(`请设置 LAN_HOST 为本机一个明确的局域网地址，可选：${localIPs.join(', ') || '无'}`);
  process.exit(1);
}
const targetPort = Number(process.env.GAME_PORT || 3030);
const port = Number(process.env.LAN_PORT || 3031);
if (![port, targetPort].every(p => Number.isInteger(p) && p >= 1024 && p <= 65535) || port === targetPort) throw new Error('InvalidPort');
const server = http.createServer((req, res) => {
  const proxy = http.request({ hostname: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-host': req.headers.host || '' } }, upstream => {
    res.writeHead(upstream.statusCode || 502, upstream.headers); upstream.pipe(res);
  });
  proxy.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('游戏服务未启动'); });
  req.pipe(proxy);
});
server.on('upgrade', (req, socket, head) => {
  // Only the fixed game upstream is reachable; this is not a generic TCP proxy.
  if (!req.url?.startsWith('/api/socket') && !req.url?.startsWith('/?token=')) { socket.destroy(); return; }
  const upstream = net.connect(targetPort, '127.0.0.1', () => {
    const headers = Object.entries({ ...req.headers, 'x-forwarded-host': req.headers.host || '' }).flatMap(([key, value]) => Array.isArray(value) ? value.map(v => `${key}: ${v}`) : [`${key}: ${value}`]);
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    upstream.pipe(socket); socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
});
server.listen(port, host, () => console.log(`局域网测试入口：http://${host}:${port}；仅转发本机游戏 ${targetPort}，结束时 Ctrl+C 关闭。`));
