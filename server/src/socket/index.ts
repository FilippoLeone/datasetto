import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { AppContext, Broadcaster } from '../context.js';
import { createOriginChecker } from '../http/origins.js';
import { createArcade, type Arcade } from '../arcade/index.js';
import { createSocketContext, disposeSocketContext, type SocketContext } from './context.js';
import { registerAdminHandlers } from './handlers/admin.js';
import { registerAuthHandlers } from './handlers/auth.js';
import { registerChannelHandlers } from './handlers/channels.js';
import { registerChatHandlers } from './handlers/chat.js';
import { registerPresenceHandlers } from './handlers/presence.js';
import { registerPushHandlers } from './handlers/push.js';
import { registerScreenshareHandlers } from './handlers/screenshare.js';
import { registerSearchHandlers } from './handlers/search.js';
import { registerVoiceHandlers } from './handlers/voice.js';
import { teardownSocket } from './lifecycle.js';
import { channelsPayload } from './payloads.js';

export interface SocketServer {
  io: Server;
  arcade: Arcade;
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
    maxHttpBufferSize: 256_000,
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
    // One account's list changed for them alone (a conversation closed or reopened): every tab of theirs, nobody else.
    channelsTo: (accountId) => {
      for (const socketId of ctx.presence.getSocketsByAccount(accountId)) {
        const socket = io.sockets.sockets.get(socketId);
        const sctx = socket?.data.ctx as SocketContext | undefined;
        if (!socket || !sctx?.user) continue;
        socket.emit('channels:update', channelsPayload(ctx, sctx.user));
      }
    },
    users: coalesce(() => io.emit('user:update', ctx.presence.exportUsers())),
    screenshare: (channelId, targetSocketId = null, extra = {}) => {
      const payload = { ...ctx.presence.screenshareView(channelId), ...extra };
      if (targetSocketId) io.to(targetSocketId).emit('screenshare:session', payload);
      else io.to(channelId).emit('screenshare:session', payload);
    },
    notifyChannel: (channelId, notification) => {
      io.to(channelId).emit('notification', notification);
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
    toAccount: (accountId, event, payload) => {
      for (const socketId of ctx.presence.getSocketsByAccount(accountId)) {
        const socket = io.sockets.sockets.get(socketId);
        if (!socket) continue;
        const sctx = socket.data.ctx as SocketContext | undefined;
        if (sctx && event === 'account:updated' && payload && typeof payload === 'object' && 'account' in payload) {
          sctx.account = (payload as { account: SocketContext['account'] }).account;
          sctx.user = ctx.presence.getUser(socketId);
          socket.emit(event, { ...(payload as object), user: ctx.presence.exportUser(socketId) });
          continue;
        }
        socket.emit(event, payload);
      }
    },
  };
  ctx.broadcast = broadcaster;

  const arcade = createArcade(ctx, httpServer, io);

  ctx.runtime.connectedSockets = () => io.engine.clientsCount;

  // Per-IP connection cap. Counts are decremented on disconnect.
  const connectionsPerIp = new Map<string, number>();
  io.use((socket, next) => {
    // A deploy in progress: the client gets `connect_error` and backs off; the next container takes it.
    if (ctx.runtime.shuttingDown) return next(new Error('Server is restarting'));
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
    // One line per reconnect wave (after a deploy every client comes back within a second or two).
    ctx.runtime.bursts.record('socket connected', { socketId: socket.id, ip, transport: socket.conn.transport.name }, ip);

    registerAuthHandlers(sctx, arcade);
    registerChannelHandlers(sctx);
    registerChatHandlers(sctx);
    registerSearchHandlers(sctx);
    registerVoiceHandlers(sctx, arcade);
    registerScreenshareHandlers(sctx);
    registerAdminHandlers(sctx);
    registerPushHandlers(sctx);
    registerPresenceHandlers(sctx);
    arcade.register(sctx);

    socket.on('disconnect', (reason) => {
      const remaining = (connectionsPerIp.get(ip) ?? 1) - 1;
      if (remaining <= 0) connectionsPerIp.delete(ip);
      else connectionsPerIp.set(ip, remaining);

      try {
        teardownSocket(sctx, arcade);
      } catch (error) {
        ctx.log.error({ err: error, socketId: socket.id }, 'disconnect cleanup failed');
      } finally {
        disposeSocketContext(sctx);
      }
      ctx.runtime.bursts.record('socket disconnected', { socketId: socket.id, reason }, reason);
    });
  });

  return { io, arcade };
};
