import { Router } from 'express';
import type { AppContext } from '../../context.js';

/**
 * Public runtime configuration for clients, fetched at boot. Deliberately
 * contains no TURN credentials: relaying through our server costs money, so
 * those are only handed to authenticated sockets (auth:success / turn:refresh).
 */
export const configRouter = (ctx: AppContext): Router => {
  const router = Router();

  router.get('/', (_req, res) => {
    const ice = ctx.turn.stunOnly();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      version: ctx.config.version,
      serverTime: Date.now(),
      registration: {
        mode: ctx.config.registration.mode,
        requiresInvite: ctx.config.registration.mode === 'invite',
      },
      urls: {
        rtmp: ctx.config.publicUrls.rtmp,
        hls: ctx.config.publicUrls.hls,
      },
      ice,
      limits: {
        maxMessageLength: ctx.config.limits.maxMessageLength,
        passwordMinLength: ctx.config.security.passwordMinLength,
      },
    });
  });

  return router;
};
