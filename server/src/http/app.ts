import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { ZodError } from 'zod';
import type { AppContext } from '../context.js';
import { isAppError } from '../errors.js';
import { createOriginChecker } from './origins.js';
import { configRouter } from './routes/config.js';
import { healthRouter } from './routes/health.js';
import { releasesRouter } from './routes/releases.js';
import { streamRouter } from './routes/stream.js';
import { hlsRouter } from './routes/hls.js';
import { avatarsRouter } from './routes/avatars.js';
import { uploadsRouter } from './routes/uploads.js';
import { RateLimiter } from '../core/rateLimit.js';

export const createHttpApp = (ctx: AppContext): express.Express => {
  const app = express();
  const isAllowedOrigin = createOriginChecker(ctx.config.cors);

  app.disable('x-powered-by');
  app.set('trust proxy', ctx.config.server.trustProxy ? 1 : false);

  // The static site is served by Caddy; this process only serves JSON, so a
  // strict CSP here would only ever affect error pages.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) return callback(null, true);
        ctx.log.warn({ origin }, 'blocked request from disallowed origin');
        return callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 86400,
    }),
  );
  // Coarse per-IP ceiling for the HTTP API; the socket layer has its own buckets.
  const apiLimiter = new RateLimiter(300, 60_000);
  app.use('/api', (req, res, next) => {
    if (apiLimiter.hit(req.ip ?? 'unknown').allowed) return next();
    res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
  });

  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  app.use((req, res, next) => {
    if (req.path === '/health' || req.path === '/api/health') return next();
    const start = Date.now();
    res.on('finish', () => {
      ctx.log.debug({ method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start }, 'http');
    });
    next();
  });

  app.use(healthRouter(ctx));
  app.use('/api/config', configRouter(ctx));
  app.use(streamRouter(ctx));
  app.use(hlsRouter(ctx));
  app.use(avatarsRouter(ctx));
  app.use(uploadsRouter(ctx));
  app.use('/api/releases', releasesRouter(ctx));

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isAppError(error)) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    if (error instanceof ZodError) {
      res.status(400).json({ error: error.issues[0]?.message ?? 'Invalid request', code: 'VALIDATION_FAILED' });
      return;
    }
    const status = (error as { status?: number; statusCode?: number })?.status ?? (error as { statusCode?: number })?.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: 'Bad request', code: 'BAD_REQUEST' });
      return;
    }
    ctx.log.error({ err: error }, 'unhandled http error');
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  });

  return app;
};
