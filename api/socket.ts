import { createServer } from 'node:http';
import { RedisAuthority, type Authority } from '../server/authority.js';
import { attachHub } from '../server/hub.js';

const unavailable: Authority = {
  execute: async () => { throw new Error('RedisConfigurationMissing'); },
  subscribe: async () => { throw new Error('RedisConfigurationMissing'); },
  close: async () => {},
};
const url = process.env.REDIS_URL || process.env.KV_URL;
const namespace = process.env.REDIS_KEY || `highnoon:v1:${process.env.VERCEL_ENV === 'production' ? 'production' : `preview:${(process.env.VERCEL_GIT_COMMIT_REF || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')}`}`;
const authority = url ? new RedisAuthority(url, namespace) : unavailable;
const server = createServer((_req, res) => {
  res.writeHead(url ? 426 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ ok: false, code: url ? 'WEBSOCKET_REQUIRED' : 'SERVICE_UNAVAILABLE' }));
});
attachHub(server, authority, {
  production: true,
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean),
  testCode: process.env.TEST_CODE,
});
export default server;
