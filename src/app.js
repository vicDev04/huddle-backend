import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import jwt from 'jsonwebtoken';
import { pool } from './db.js';
import { ApiError } from './errors.js';
import { verifyToken } from './token.js';
import authRoutes from './routes/auth.js';
import groupRoutes from './routes/groups.js';
import playRoutes from './routes/play.js';
import boardRoutes from './routes/boards.js';
import adminRoutes from './routes/admin.js';


const ORIGINS = new Set((process.env.FRONTEND_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean));

export async function buildApp({ logger = false } = {}) {
  const app = Fastify({ logger, trustProxy: true, bodyLimit: 64 * 1024 });

  // CORS: exact string match so non-http schemes like capacitor:// work.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    reply.header('Vary', 'Origin');
    if (origin && ORIGINS.has(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      reply.header('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return reply.code(204).send();
  });

  if (process.env.DISABLE_RATE_LIMIT !== 'true') {
    await app.register(rateLimit, {
      global: true,
      allowList: (req) => req.method === 'OPTIONS',
      max: (req) => (req.url.startsWith('/api/auth') ? 10 : 120),
      timeWindow: '1 minute',
      keyGenerator: (req) => {
        if (req.url.startsWith('/api/auth')) return 'ip:' + req.ip;
        const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
        const sub = tok && jwt.decode(tok)?.sub;
        return sub ? 'u:' + sub : 'ip:' + req.ip;
      },
      errorResponseBuilder: () => ({ statusCode: 429, error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down' } }),
    });
  }

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    if (err.statusCode === 429) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down' } });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: { code: 'BAD_REQUEST', message: err.message } });
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } }));

  app.decorate('auth', async (req) => {
    const tok = (req.headers.authorization || '').match(/^Bearer (.+)$/)?.[1];
    let sub;
    try { sub = tok && verifyToken(tok); } catch { sub = null; }
    if (!sub) throw new ApiError(401, 'UNAUTHORIZED', 'Please log in');
    const { rowCount } = await pool.query('select 1 from users where id = $1', [sub]);
    if (!rowCount) throw new ApiError(401, 'UNAUTHORIZED', 'Please log in');
    req.userId = sub;
  });

  app.get('/api/health', async () => ({ ok: true }));
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(groupRoutes, { prefix: '/api' });
  await app.register(playRoutes, { prefix: '/api' });
  await app.register(boardRoutes, { prefix: '/api' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  return app;
}

