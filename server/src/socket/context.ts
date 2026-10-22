import type { Server, Socket } from 'socket.io';
import { ZodError, type ZodType } from 'zod';
import type { AppContext } from '../context.js';
import { RateLimiter } from '../core/rateLimit.js';
import { rolesHavePermission, type Permission } from '../core/roles.js';
import { AppError, errorMessage, isAppError, notAuthenticated } from '../errors.js';
import type { ConnectedUser, PublicAccount } from '../types.js';

export type LimiterKind = 'chat' | 'reaction' | 'signal' | 'generic' | 'auth' | 'search' | 'activity' | 'arcade' | 'arcadeAct' | 'spin' | 'arcadeProbe';

/** Full-text searches one socket may run per minute. */
export const SEARCHES_PER_MINUTE = 60;

/** `presence:activity` reports: one per socket per this many milliseconds. */
export const ACTIVITY_WINDOW_MS = 10_000;

/** Arcade table-lane budgets (docs/arcade/platform.md §13.3): lobby, ticket, invite, board and saves events. */
export const ARCADE_LIMIT = { events: 20, windowMs: 10_000 } as const;
/** Poker actions. */
export const ARCADE_ACT_LIMIT = { events: 4, windowMs: 1_000 } as const;
/** Glimmerhall spins and picks (the game also allows only one in flight). */
export const SPIN_LIMIT = { events: 2, windowMs: 1_000 } as const;
/** The chat-first probe. */
export const ARCADE_PROBE_LIMIT = { events: 1, windowMs: 2_000 } as const;

/** Per-connection state. One instance per socket, discarded on disconnect. */
export interface SocketContext {
  app: AppContext;
  io: Server;
  socket: Socket;
  ip: string;
  userAgent: string | null;
  user: ConnectedUser | null;
  account: PublicAccount | null;
  sessionToken: string | null;
  sessionTokenHash: string | null;
  /** Text/stream/screenshare channel currently open in the UI. */
  currentChannel: string | null;
  voiceChannel: string | null;
  screenshareHosting: string | null;
  screenshareViewing: string | null;
  limiters: Record<LimiterKind, RateLimiter>;
}

export const createSocketContext = (app: AppContext, io: Server, socket: Socket, ip: string): SocketContext => ({
  app,
  io,
  socket,
  ip,
  userAgent: typeof socket.handshake.headers['user-agent'] === 'string' ? socket.handshake.headers['user-agent'] : null,
  user: null,
  account: null,
  sessionToken: null,
  sessionTokenHash: null,
  currentChannel: null,
  voiceChannel: null,
  screenshareHosting: null,
  screenshareViewing: null,
  limiters: {
    chat: new RateLimiter(app.config.limits.maxMessagesPerMinute, 60_000, false),
    reaction: new RateLimiter(60, 60_000, false),
    signal: new RateLimiter(600, 10_000, false),
    generic: new RateLimiter(300, 10_000, false),
    auth: new RateLimiter(20, 60_000, false),
    search: new RateLimiter(SEARCHES_PER_MINUTE, 60_000, false),
    activity: new RateLimiter(1, ACTIVITY_WINDOW_MS, false),
    arcade: new RateLimiter(ARCADE_LIMIT.events, ARCADE_LIMIT.windowMs, false),
    arcadeAct: new RateLimiter(ARCADE_ACT_LIMIT.events, ARCADE_ACT_LIMIT.windowMs, false),
    spin: new RateLimiter(SPIN_LIMIT.events, SPIN_LIMIT.windowMs, false),
    arcadeProbe: new RateLimiter(ARCADE_PROBE_LIMIT.events, ARCADE_PROBE_LIMIT.windowMs, false),
  },
});

export const disposeSocketContext = (sctx: SocketContext): void => {
  for (const limiter of Object.values(sctx.limiters)) limiter.dispose();
};

export interface HandlerOptions<T> {
  /** Payload schema; the raw payload is passed through when omitted. */
  schema?: ZodType<T>;
  /** Event used to report failures to this socket. Defaults to `error`. */
  errorEvent?: string;
  /** Code reported when the handler throws a plain Error. */
  code: string;
  requireAuth?: boolean;
  limiter?: LimiterKind;
  /** Extra fields merged into the error payload (e.g. channelId). */
  errorExtras?: (payload: unknown) => Record<string, unknown>;
  /**
   * `arcade`: the Arcade table lane's quiet refusals. A limiter refusal acks `{ok: false, code: 'busy'}`,
   * a failure acks `{ok: false, code}`, and nothing is ever emitted on `error` (logged at debug level).
   */
  refusal?: 'arcade';
}

export type Ack = (response: unknown) => void;

/** Lower-case refusal code for the Arcade's `{ok: false, code}` acks. */
export const arcadeRefusalCode = (error: unknown): string => {
  if (error instanceof ZodError) return 'invalid';
  if (isAppError(error)) {
    if (error.code === 'NOT_AUTHENTICATED') return 'auth';
    if (error.code === 'PASSWORD_CHANGE_REQUIRED') return 'password';
    return error.code.toLowerCase();
  }
  return 'error';
};

/** The only events a user with a temporary password may use until they set a new one. */
const PASSWORD_CHANGE_EXEMPT = new Set(['account:update', 'account:get', 'auth:logout', 'auth:session', 'auth:login', 'auth:register', 'turn:refresh']);

export const requireUser = (sctx: SocketContext): ConnectedUser => {
  if (!sctx.user) throw notAuthenticated();
  return sctx.user;
};

export const requirePermission = (sctx: SocketContext, permission: Permission, message = 'No permission'): ConnectedUser => {
  const user = requireUser(sctx);
  if (!user.isSuperuser && !rolesHavePermission(user.roles, permission)) {
    throw new AppError(message, 'FORBIDDEN', 403);
  }
  return user;
};

export const toErrorPayload = (error: unknown, fallbackCode: string): { message: string; code: string } => {
  if (isAppError(error)) return { message: error.message, code: error.code };
  if (error instanceof ZodError) {
    return { message: error.issues[0]?.message ?? 'Invalid request', code: 'VALIDATION_FAILED' };
  }
  return { message: errorMessage(error), code: fallbackCode };
};

/**
 * Register a socket event handler with validation, auth, rate limiting and
 * uniform error reporting. Handlers can be async; rejections are reported
 * on `errorEvent` instead of crashing the connection.
 */
export const handle = <T = unknown>(
  sctx: SocketContext,
  event: string,
  options: HandlerOptions<T>,
  fn: (payload: T, ack: Ack | null) => void | Promise<void>,
): void => {
  const { socket, app } = sctx;

  socket.on(event, async (...args: unknown[]) => {
    const ack = typeof args[args.length - 1] === 'function' ? (args.pop() as Ack) : null;
    const raw = args[0];

    const limiter = sctx.limiters[options.limiter ?? 'generic'];
    const verdict = limiter.hit(event);
    if (!verdict.allowed && options.refusal === 'arcade') {
      app.log.debug({ event, socketId: socket.id }, 'arcade request refused: busy');
      ack?.({ ok: false, code: 'busy' });
      return;
    }
    if (!verdict.allowed) {
      const message = 'You are doing that too fast. Try again in a moment.';
      // A request that waits for an acknowledgement gets its refusal there instead of timing out.
      if (ack) {
        ack({ success: false, error: message, code: 'RATE_LIMITED' });
      } else if (verdict.remaining === 0 && options.limiter !== 'signal') {
        socket.emit(options.errorEvent ?? 'error', {
          message,
          code: 'RATE_LIMITED',
          ...(options.errorExtras ? options.errorExtras(raw) : {}),
        });
      }
      return;
    }

    try {
      if (options.requireAuth !== false && !sctx.user) {
        throw notAuthenticated();
      }
      if (sctx.account?.mustChangePassword && !PASSWORD_CHANGE_EXEMPT.has(event)) {
        throw new AppError('Set a new password before continuing', 'PASSWORD_CHANGE_REQUIRED', 403);
      }
      const payload = options.schema ? options.schema.parse(raw) : (raw as T);
      app.presence.touch(socket.id);
      await fn(payload, ack);
    } catch (error) {
      if (options.refusal === 'arcade') {
        const code = arcadeRefusalCode(error);
        if (code === 'error') app.log.error({ err: error, event, socketId: socket.id }, 'arcade handler failed');
        else app.log.debug({ event, socketId: socket.id, code }, 'arcade request refused');
        ack?.({ ok: false, code });
        return;
      }
      const payload = { ...toErrorPayload(error, options.code), ...(options.errorExtras ? options.errorExtras(raw) : {}) };
      if (!isAppError(error) && !(error instanceof ZodError)) {
        app.log.error({ err: error, event, socketId: socket.id }, 'socket handler failed');
      } else {
        app.log.debug({ event, socketId: socket.id, code: payload.code, message: payload.message }, 'socket request rejected');
      }
      if (ack) {
        ack({ success: false, error: payload.message, code: payload.code });
      } else {
        socket.emit(options.errorEvent ?? 'error', payload);
      }
    }
  });
};
