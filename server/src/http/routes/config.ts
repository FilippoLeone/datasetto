import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { ACCEPTED_IMAGE_TYPES, ACCEPTED_VIDEO_TYPES } from '../../services/uploads.js';

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
        // Invite links (/app?invite=TOKEN) work whenever registration is not closed.
        acceptsInviteLinks: ctx.config.registration.mode !== 'closed',
      },
      urls: {
        rtmp: ctx.config.publicUrls.rtmp,
        hls: ctx.config.publicUrls.hls,
      },
      ice,
      limits: {
        maxMessageLength: ctx.config.limits.maxMessageLength,
        passwordMinLength: ctx.config.security.passwordMinLength,
        // Messages sent with `chat:history` on join; fewer than this means the channel's start is on screen.
        chatHistoryLimit: ctx.config.limits.chatHistoryLimit,
      },
      // Pictures and videos in chat: size per file (one cap per kind), files per message, accepted MIME types
      // (checked by signature server side).
      uploads: {
        maxBytes: ctx.config.uploads.maxBytes,
        videoMaxBytes: ctx.config.uploads.videoMaxBytes,
        maxFilesPerMessage: ctx.config.uploads.maxFilesPerMessage,
        acceptedTypes: ACCEPTED_IMAGE_TYPES,
        videoTypes: ACCEPTED_VIDEO_TYPES,
      },
      linkPreviews: { enabled: ctx.config.linkPreviews.enabled },
      // Web Push: off without VAPID keys; the public key is what browsers subscribe with.
      push: { enabled: ctx.push.isEnabled(), publicKey: ctx.push.publicKey() },
    });
  });

  return router;
};
