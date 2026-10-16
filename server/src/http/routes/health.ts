import { Router } from 'express';
import type { AppContext } from '../../context.js';

export const healthRouter = (ctx: AppContext): Router => {
  const router = Router();

  const health = (_req: unknown, res: import('express').Response) => {
    res.json({
      status: 'ok',
      version: ctx.config.version,
      uptime: Math.round((Date.now() - ctx.startedAt) / 1000),
      timestamp: Date.now(),
    });
  };

  router.get('/health', health);
  router.get('/api/health', health);

  router.get('/api/stats', (_req, res) => {
    res.json({
      channels: ctx.channels.count(),
      users: ctx.presence.onlineCount(),
      messages: ctx.messages.count(),
      uptime: Math.round((Date.now() - ctx.startedAt) / 1000),
      timestamp: Date.now(),
    });
  });

  return router;
};
