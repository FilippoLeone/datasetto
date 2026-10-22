import { z } from 'zod';
import { RateLimiter } from '../../core/rateLimit.js';
import { AppError } from '../../errors.js';
import { sanitizeAccount } from '../../services/accounts.js';
import { AvatarService } from '../../services/avatars.js';
import { SessionService } from '../../services/sessions.js';
import type { PublicAccount } from '../../types.js';
import { handle, requireUser, type SocketContext } from '../context.js';
import { teardownSocket } from '../lifecycle.js';
import type { Arcade } from '../../arcade/index.js';
import { channelsPayload } from '../payloads.js';

// Shared across sockets: brute-force protection is per IP, not per connection.
const registerLimiter = new RateLimiter(5, 60_000);
const loginLimiter = new RateLimiter(10, 60_000);

const registerSchema = z.object({
  username: z.string().max(254),
  password: z.string().max(128),
  inviteCode: z.string().max(128).optional().nullable(),
  profile: z
    .object({
      displayName: z.string().max(50).optional().nullable(),
    })
    .partial()
    .optional(),
});

const loginSchema = z.object({
  username: z.string().max(254),
  password: z.string().max(128),
});

const sessionSchema = z.object({ token: z.string().min(1).max(256) });

const accountUpdateSchema = z.object({
  displayName: z.string().max(50).optional(),
  email: z.string().max(254).nullable().optional(),
  bio: z.string().max(500).nullable().optional(),
  avatarUrl: z.string().max(2048).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  currentPassword: z.string().max(128).optional(),
  newPassword: z.string().max(128).optional(),
});

const authSuccessPayload = (sctx: SocketContext, arcade: Arcade, account: PublicAccount, isNewAccount: boolean, expiresAt: number) => ({
  user: sctx.app.presence.exportUser(sctx.socket.id),
  account,
  session: { token: sctx.sessionToken, expiresAt },
  // TURN credentials are only ever sent to signed-in users (relay traffic is paid egress).
  ice: sctx.app.turn.iceConfig(),
  // Signed viewer ticket for pictures in chat (appended to /api/uploads/* URLs as ?t=).
  media: sctx.app.uploads.issueTicket(account.id),
  ...channelsPayload(sctx.app, requireUser(sctx)),
  // Arcade switches and table-lane versions (the same object as GET /api/config's `arcade`).
  arcade: arcade.publicConfig(),
  isNewAccount,
});

export const registerAuthHandlers = (sctx: SocketContext, arcade: Arcade): void => {
  const { app, socket } = sctx;

  const assertNotBanned = (accountId: string) => {
    const ban = app.moderation.getBan(accountId);
    if (ban) {
      throw new AppError(ban.reason || 'You are banned from this server', 'BANNED', 403);
    }
  };

  /**
   * SINGLE_SESSION_PER_ACCOUNT: one login at a time. A sign-in with a different
   * session token ends the account's other logins: their tokens are revoked, so
   * a device that was offline (or a stale tab that reconnects by itself) cannot
   * take the account back without the password, and their live sockets are
   * told why and dropped. Sockets that carry the same token (another tab of
   * the same browser, a reload racing its old connection) are the same login
   * and stay connected.
   */
  const endOtherLogins = (accountId: string, tokenHash: string) => {
    if (!app.config.sessions.singlePerAccount) return;
    app.sessions.revokeAll(accountId, tokenHash);
    for (const socketId of app.presence.getSocketsByAccount(accountId)) {
      if (socketId === socket.id) continue;
      const older = sctx.io.sockets.sockets.get(socketId);
      if (!older) continue;
      const otherContext = older.data.ctx as SocketContext | undefined;
      if (otherContext?.sessionTokenHash === tokenHash) continue;
      older.emit('auth:error', {
        message: 'You signed in somewhere else, so this device was signed out. Sign in again here to take over.',
        code: 'SIGNED_IN_ELSEWHERE',
      });
      older.disconnect(true);
      app.log.info({ accountId, olderSocketId: socketId, newerSocketId: socket.id }, 'older connection replaced');
    }
  };

  const finalize = (account: PublicAccount, token: string, expiresAt: number, isNewAccount: boolean) => {
    if (sctx.user) {
      // Re-authenticating on a live socket: drop the previous identity first.
      app.presence.removeUser(socket.id);
    }
    const tokenHash = SessionService.hashToken(token);
    endOtherLogins(account.id, tokenHash);
    sctx.account = account;
    sctx.sessionToken = token;
    sctx.sessionTokenHash = tokenHash;
    sctx.user = app.presence.addUser(socket.id, account);
    app.accounts.touchLastSeen(account.id);

    socket.emit('auth:success', authSuccessPayload(sctx, arcade, account, isNewAccount, expiresAt));
    arcade.onAuthenticated(sctx);
    app.broadcast.users();
    app.broadcast.channels();
    app.runtime.bursts.record('authenticated', { socketId: socket.id, accountId: account.id, roles: account.roles, isNewAccount }, account.id);
  };

  handle(
    sctx,
    'auth:register',
    { schema: registerSchema, errorEvent: 'auth:error', code: 'REGISTRATION_FAILED', requireAuth: false, limiter: 'auth' },
    async (payload) => {
      if (sctx.user) throw new AppError('Already signed in', 'ALREADY_AUTHENTICATED', 409);
      if (!registerLimiter.hit(sctx.ip).allowed) {
        throw new AppError('Too many registration attempts. Please try again later.', 'RATE_LIMITED', 429);
      }
      const account = await app.accounts.register({
        username: payload.username,
        password: payload.password,
        displayName: payload.profile?.displayName ?? null,
        inviteCode: payload.inviteCode ?? null,
      });
      const session = app.sessions.create(account.id, { ip: sctx.ip, userAgent: sctx.userAgent });
      finalize(account, session.token, session.expiresAt, true);
    },
  );

  handle(
    sctx,
    'auth:login',
    { schema: loginSchema, errorEvent: 'auth:error', code: 'LOGIN_FAILED', requireAuth: false, limiter: 'auth' },
    async (payload) => {
      if (sctx.user) throw new AppError('Already signed in', 'ALREADY_AUTHENTICATED', 409);
      if (!loginLimiter.hit(sctx.ip).allowed) {
        throw new AppError('Too many login attempts. Please try again later.', 'RATE_LIMITED', 429);
      }
      const account = await app.accounts.authenticate(payload.username, payload.password);
      assertNotBanned(account.id);
      const session = app.sessions.create(account.id, { ip: sctx.ip, userAgent: sctx.userAgent });
      finalize(account, session.token, session.expiresAt, false);
    },
  );

  handle(
    sctx,
    'auth:session',
    { schema: sessionSchema, errorEvent: 'auth:error', code: 'SESSION_FAILED', requireAuth: false, limiter: 'auth' },
    (payload) => {
      const session = app.sessions.resume(payload.token);
      if (!session) throw new AppError('Your session has expired. Please sign in again.', 'SESSION_FAILED', 401);

      const record = app.accounts.getById(session.accountId);
      if (!record || record.status !== 'active') {
        app.sessions.revoke(payload.token);
        throw new AppError('Account is no longer active', 'ACCOUNT_DISABLED', 403);
      }
      try {
        assertNotBanned(record.id);
      } catch (error) {
        app.sessions.revoke(payload.token);
        throw error;
      }

      const account = sanitizeAccount(record);
      if (sctx.user && sctx.account?.id === account.id) {
        // Same account re-sending its token after a reconnect: confirm without side effects.
        sctx.sessionToken = payload.token;
        sctx.sessionTokenHash = SessionService.hashToken(payload.token);
        socket.emit('auth:success', authSuccessPayload(sctx, arcade, account, false, session.expiresAt));
        arcade.onAuthenticated(sctx);
        return;
      }
      finalize(account, payload.token, session.expiresAt, false);
    },
  );

  handle(sctx, 'turn:refresh', { code: 'TURN_REFRESH_FAILED', limiter: 'auth' }, () => {
    socket.emit('turn:credentials', app.turn.iceConfig());
  });

  handle(sctx, 'auth:logout', { errorEvent: 'auth:error', code: 'LOGOUT_FAILED', requireAuth: false }, () => {
    if (sctx.sessionToken) app.sessions.revoke(sctx.sessionToken);
    teardownSocket(sctx, arcade);
    socket.emit('auth:loggedOut');
  });

  handle(sctx, 'account:get', { errorEvent: 'account:error', code: 'ACCOUNT_FETCH_FAILED' }, () => {
    const user = requireUser(sctx);
    const record = app.accounts.getById(user.accountId);
    if (!record) throw new AppError('Account not found', 'NOT_FOUND', 404);
    sctx.account = sanitizeAccount(record);
    socket.emit('account:data', { account: sctx.account, user: app.presence.exportUser(socket.id) });
  });

  handle(
    sctx,
    'account:update',
    { schema: accountUpdateSchema, errorEvent: 'account:error', code: 'ACCOUNT_UPDATE_FAILED' },
    async (payload) => {
      const user = requireUser(sctx);

      if (payload.newPassword) {
        await app.accounts.changePassword(user.accountId, payload.currentPassword, payload.newPassword);
        app.sessions.revokeAll(user.accountId, sctx.sessionTokenHash);
        app.log.info({ accountId: user.accountId, forced: Boolean(sctx.account?.mustChangePassword) }, 'password changed');
      }

      // Switching to an external avatar URL (or none) discards the uploaded file.
      if (payload.avatarUrl !== undefined && !AvatarService.isLocalUrl(payload.avatarUrl)) app.avatars.remove(user.accountId);
      const previousAvatar = app.accounts.getById(user.accountId)?.avatarUrl ?? null;

      const updated = app.accounts.updateProfile(user.accountId, {
        displayName: payload.displayName,
        email: payload.email,
        bio: payload.bio,
        avatarUrl: payload.avatarUrl,
        metadata: payload.metadata,
      });

      sctx.account = updated;
      app.presence.syncAccount(updated);
      sctx.user = app.presence.getUser(socket.id);

      socket.emit('account:updated', { account: updated, user: app.presence.exportUser(socket.id) });
      app.broadcast.users();
      app.broadcast.channels();
      if ((updated.avatarUrl ?? null) !== previousAvatar) app.broadcast.avatar(updated.id, updated.avatarUrl ?? null);
    },
  );
};
