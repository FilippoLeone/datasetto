import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { AppContext, Broadcaster } from '../context.js';
import { createOriginChecker } from '../http/origins.js';
import { MinigameManager } from '../minigames/MinigameManager.js';
import { createSocketContext, disposeSocketContext, type SocketContext } from './context.js';
import { registerAdminHandlers } from './handlers/admin.js';
import { registerAuthHandlers } from './handlers/auth.js';
import { registerChannelHandlers } from './handlers/channels.js';
import { registerChatHandlers } from './handlers/chat.js';
import { registerMinigameHandlers, type Minigames } from './handlers/minigame.js';
import { registerScreenshareHandlers } from './handlers/screenshare.js';
import { registerVoiceHandlers } from './handlers/voice.js';
import { teardownSocket } from './lifecycle.js';
import { channelsPayload } from './payloads.js';

export interface SocketServer {
  io: Server;
  minigames: Minigames;
}


/** Run `fn` at most once per event-loop turn, however often it is requested. */
const coalesce = (fn: () => void): (() => void) => {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      fn();
    });
  };
};

const resolveClientIp = (socket: Socket, trustProxy: boolean): string => {
  if (trustProxy) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
    if (first && first.trim()) return first.trim();
    const real = socket.handshake.headers['x-real-ip'];
    if (typeof real === 'string' && real.trim()) return real.trim();
  }
  return socket.handshake.address || 'unknown';
};

export const createSocketServer = (httpServer: HttpServer, ctx: AppContext): SocketServer => {
  const isAllowedOrigin = createOriginChecker(ctx.config.cors);

  const io = new Server(httpServer, {
    path: '/socket.io/',
    serveClient: false,
    cors: {
      origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
      credentials: true,
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
    allowUpgrades: true,
    allowEIO3: false,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    connectTimeout: 20_000,
    maxHttpBufferSize: 1_000_000,
  });

  const broadcaster: Broadcaster = {
    // Each user gets the channels they are allowed to view.
    channels: coalesce(() => {
      for (const socket of io.sockets.sockets.values()) {
        const sctx = socket.data.ctx as SocketContext | undefined;
        if (!sctx?.user) continue;
        socket.emit('channels:update', channelsPayload(ctx, sctx.user));
      }
    }),
    users: coalesce(() => io.emit('user:update', ctx.presence.exportUsers())),
    screenshare: (channelId, targetSocketId = null) => {
      const payload = ctx.presence.screenshareView(channelId);
      if (targetSocketId) io.to(targetSocketId).emit('screenshare:session', payload);
      else io.to(channelId).emit('screenshare:session', payload);
    },
    toChannelViewers: (channelId, event, payload) => {
      const channel = ctx.channels.get(channelId);
      if (!channel) return;
      for (const socket of io.sockets.sockets.values()) {
        const sctx = socket.data.ctx as SocketContext | undefined;
        if (!sctx?.user) continue;
        if (!ctx.channels.canAccess(channel, sctx.user, 'view')) continue;
        socket.emit(event, payload);
      }
    },
  };
  ctx.broadcast = broadcaster;

  const minigames = new MinigameManager({
    io,
    channelManager: {
      setChannelMinigame: (channelId: string, meta: Record<string, unknown> | null) =>
        ctx.presence.setMinigame(channelId, meta as never),
      clearChannelMinigame: (channelId: string) => ctx.presence.setMinigame(channelId, null),
      getChannel: (channelId: string) => ctx.channels.get(channelId),
    },
    leaderboard: ctx.leaderboard,
    onChannelUpdate: () => broadcaster.channels(),
  }) as unknown as Minigames;

  // Per-IP connection cap. Counts are decremented on disconnect.
  const connectionsPerIp = new Map<string, number>();
  io.use((socket, next) => {
    const ip = resolveClientIp(socket, ctx.config.server.trustProxy);
    const current = connectionsPerIp.get(ip) ?? 0;
    if (current >= ctx.config.security.maxConnectionsPerIp) {
      ctx.log.warn({ ip }, 'connection refused: too many connections from ip');
      return next(new Error('Too many connections'));
    }
    connectionsPerIp.set(ip, current + 1);
    socket.data.ip = ip;
    next();
  });

  io.engine.on('connection_error', (err: { code: number; message: string }) => {
    ctx.log.debug({ code: err.code, message: err.message }, 'engine.io connection error');
  });

  io.on('connection', (socket) => {
    const ip = (socket.data.ip as string) ?? 'unknown';
    const sctx: SocketContext = createSocketContext(ctx, io, socket, ip);
    socket.data.ctx = sctx;
    ctx.log.info({ socketId: socket.id, ip, transport: socket.conn.transport.name }, 'socket connected');

    registerAuthHandlers(sctx, minigames);
    registerChannelHandlers(sctx);
    registerChatHandlers(sctx);
    registerVoiceHandlers(sctx, minigames);
    registerScreenshareHandlers(sctx);
    registerAdminHandlers(sctx);
    registerMinigameHandlers(sctx, minigames);

    socket.on('disconnect', (reason) => {
      const remaining = (connectionsPerIp.get(ip) ?? 1) - 1;
      if (remaining <= 0) connectionsPerIp.delete(ip);
      else connectionsPerIp.set(ip, remaining);

      try {
        teardownSocket(sctx, minigames);
      } catch (error) {
        ctx.log.error({ err: error, socketId: socket.id }, 'disconnect cleanup failed');
      } finally {
        disposeSocketContext(sctx);
      }
      ctx.log.info({ socketId: socket.id, reason }, 'socket disconnected');
    });
  });

  return { io, minigames };
};
