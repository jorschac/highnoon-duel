import type { IncomingMessage, ServerResponse } from 'node:http';
import Redis from 'ioredis';
import { PROTOCOL } from '../shared/protocol.js';
export default async function health(_req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const url = process.env.REDIS_URL || process.env.KV_URL;
  if (!url) {
    res.statusCode = 503;
    res.end(JSON.stringify({ ok: false, protocol: PROTOCOL, reason: 'SHARED_REDIS_NOT_CONFIGURED' }));
    return;
  }
  const redis = new Redis(url, { lazyConnect: true, connectTimeout: 3000, commandTimeout: 3000, maxRetriesPerRequest: 0, retryStrategy: () => null });
  redis.on('error', () => {});
  try {
    await redis.ping();
    res.end(JSON.stringify({ ok: true, protocol: PROTOCOL, authority: 'shared-redis' }));
  } catch {
    res.statusCode = 503;
    res.end(JSON.stringify({ ok: false, protocol: PROTOCOL, reason: 'SHARED_REDIS_UNAVAILABLE' }));
  } finally { redis.disconnect(); }
}
