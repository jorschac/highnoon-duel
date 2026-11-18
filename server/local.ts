import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { MemoryAuthority, RedisAuthority } from './authority.js';
import { attachHub } from './hub.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT || 3030);
const host = process.env.HOST || '127.0.0.1';
const production = process.argv.includes('--production');
const app = express();
app.disable('x-powered-by');
app.get('/api/health', (_req, res) => res.json({ ok: true, protocol: 'highnoon-v1', authority: process.env.REDIS_URL ? 'redis' : 'local-lua', persistent: Boolean(process.env.REDIS_URL) }));
const server = createServer(app);
const authority = process.env.REDIS_URL
  ? new RedisAuthority(process.env.REDIS_URL, process.env.REDIS_KEY || 'highnoon:v1:local')
  : new MemoryAuthority();
const hub = attachHub(server, authority, { testCode: process.env.TEST_CODE, allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',').filter(Boolean) });
if (production) {
  app.use(express.static(path.join(root, 'dist'), { index: 'index.html', dotfiles: 'deny' }));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ root, server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  app.use(vite.middlewares);
}
await hub.ready;
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve()); });
console.log(`HIGH NOON local: http://${host}:${port} (${process.env.REDIS_URL ? 'shared Redis authority' : 'single-process Lua authority; restart clears rooms'})`);
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  void hub.close().then(() => authority.close()).finally(() => process.exit(0));
});
