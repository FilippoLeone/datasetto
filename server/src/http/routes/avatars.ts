import express, { Router, type Request } from 'express';
import type { AppContext } from '../../context.js';
import { RateLimiter } from '../../core/rateLimit.js';
import { AppError } from '../../errors.js';
import { sanitizeAccount } from '../../services/accounts.js';
import { avatarContentType, MAX_AVATAR_BYTES } from '../../services/avatars.js';
import type { PublicAccount } from '../../types.js';

const bearerToken = (req: Request): string | null => {
  const header = req.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
};

/**
 * Profile pictures.
 * - `POST /api/avatars` (Bearer session token, body = raw PNG or WebP bytes) stores the
 *   image under DATA_DIR/avatars and points the account's avatarUrl at it.
 * - `DELETE /api/avatars` removes it (the account falls back to the generated avatar).
 * - `GET /api/avatars/:file` serves the files with a one-year immutable cache; the URL
 *   carries a version query so a new upload gets a new URL.
 */
export const avatarsRouter = (ctx: AppContext): Router => {
  const router = Router();
  const uploadLimiter = new RateLimiter(10, 60_000);

  const requireAccount = (req: Request): PublicAccount => {
    const session = ctx.sessions.resume(bearerToken(req));
    const record = session ? ctx.accounts.getById(session.accountId) : null;
    if (!session || !record || record.status !== 'active' || ctx.moderation.getBan(record.id)) {
      throw new AppError('Sign in to change your avatar', 'NOT_AUTHENTICATED', 401);
    }
    return sanitizeAccount(record);
  };

  const announce = (account: PublicAccount) => {
    ctx.presence.syncAccount(account);
    // `source` lets the client skip its generic "profile updated" toast; it shows its own.
    ctx.broadcast.toAccount(account.id, 'account:updated', { account, user: null, source: 'avatar' });
    ctx.broadcast.users();
  };

  router.get('/api/avatars/:file', (req, res) => {
    const file = ctx.avatars.resolveFile(String(req.params.file ?? ''));
    if (!file) {
      res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
      return;
    }
    res.sendFile(file.path, {
      headers: { 'Content-Type': avatarContentType(file.format), 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' },
      dotfiles: 'deny',
    }, (error) => {
      if (error && !res.headersSent) res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    });
  });

  router.post(
    '/api/avatars',
    express.raw({ type: ['image/png', 'image/webp', 'application/octet-stream'], limit: MAX_AVATAR_BYTES }),
    (req, res) => {
      if (!uploadLimiter.hit(req.ip ?? 'unknown').allowed) {
        res.status(429).json({ error: 'Too many uploads', code: 'RATE_LIMITED' });
        return;
      }
      const account = requireAccount(req);
      if (!Buffer.isBuffer(req.body)) {
        throw new AppError('Send the image bytes as image/png or image/webp', 'AVATAR_FORMAT', 415);
      }
      const url = ctx.avatars.save(account.id, req.body);
      const updated = ctx.accounts.updateProfile(account.id, { avatarUrl: url });
      announce(updated);
      ctx.log.info({ accountId: account.id, bytes: req.body.length }, 'avatar uploaded');
      res.setHeader('Cache-Control', 'no-store');
      res.json({ avatarUrl: url, account: updated });
    },
  );

  router.delete('/api/avatars', (req, res) => {
    const account = requireAccount(req);
    ctx.avatars.remove(account.id);
    const updated = ctx.accounts.updateProfile(account.id, { avatarUrl: null });
    announce(updated);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ avatarUrl: null, account: updated });
  });

  return router;
};
