import { z } from 'zod';
import { idSchema } from '../../core/validation.js';
import { AppError, notFound } from '../../errors.js';
import { handle, requireUser, type SocketContext } from '../context.js';

const channelPayload = z.object({ channelId: idSchema.optional().nullable() }).partial().nullable().optional();
const signalSchema = z.object({ to: idSchema, data: z.unknown().optional(), channelId: idSchema.optional().nullable() });

const extras = (raw: unknown) => ({
  channelId: (raw as { channelId?: string } | null | undefined)?.channelId ?? null,
});

export const registerScreenshareHandlers = (sctx: SocketContext): void => {
  const { app, socket, io } = sctx;

  const resolveChannel = (payload: { channelId?: string | null } | null | undefined, fallback: string | null) => {
    const channelId = payload?.channelId ?? fallback;
    if (!channelId) throw new AppError('Channel ID is required', 'CHANNEL_REQUIRED', 400);
    const channel = app.channels.get(channelId);
    if (!channel || channel.type !== 'screenshare') throw new AppError('Not a screenshare channel', 'NOT_SCREENSHARE', 400);
    return channel;
  };

  handle(
    sctx,
    'screenshare:start',
    { schema: channelPayload, errorEvent: 'screenshare:error', code: 'SCREENSHARE_START_FAILED', errorExtras: extras },
    (payload) => {
      const user = requireUser(sctx);
      const channel = resolveChannel(payload, sctx.currentChannel);
      app.channels.requireAccess(channel, user, 'stream', 'No permission to share screen in this channel');

      try {
        app.presence.startScreenshare(channel.id, {
          hostId: socket.id,
          accountId: user.accountId,
          displayName: user.displayName,
        });
      } catch (error) {
        throw new AppError('Channel already has an active screenshare', 'SCREENSHARE_BUSY', 409);
      }
      sctx.screenshareHosting = channel.id;
      app.broadcast.screenshare(channel.id);
      app.broadcast.channels();
    },
  );

  handle(
    sctx,
    'screenshare:stop',
    { schema: channelPayload, errorEvent: 'screenshare:error', code: 'SCREENSHARE_STOP_FAILED', errorExtras: extras },
    (payload) => {
      const channelId = payload?.channelId ?? sctx.screenshareHosting;
      if (!channelId) throw new AppError('Channel ID is required', 'CHANNEL_REQUIRED', 400);
      const session = app.presence.getScreenshare(channelId);
      if (!session || session.hostId !== socket.id) throw new AppError('Not hosting this screenshare', 'NOT_HOST', 403);

      app.presence.stopScreenshare(channelId);
      sctx.screenshareHosting = null;
      app.broadcast.screenshare(channelId);
      app.broadcast.channels();
    },
  );

  handle(
    sctx,
    'screenshare:viewer:join',
    { schema: channelPayload, errorEvent: 'screenshare:error', code: 'SCREENSHARE_VIEWER_FAILED', errorExtras: extras },
    (payload) => {
      const user = requireUser(sctx);
      const channel = resolveChannel(payload, sctx.currentChannel);
      app.channels.requireAccess(channel, user, 'view', 'No permission to watch this channel');
      const session = app.presence.getScreenshare(channel.id);

      if (!session) {
        app.broadcast.screenshare(channel.id, socket.id);
        return;
      }
      if (session.hostId === socket.id || sctx.screenshareViewing === channel.id) return;

      sctx.screenshareViewing = channel.id;
      app.presence.addScreenshareViewer(channel.id, socket.id);
      app.broadcast.screenshare(channel.id);
      app.broadcast.channels();

      io.to(session.hostId).emit('screenshare:viewer:pending', {
        channelId: channel.id,
        viewerId: socket.id,
        viewerName: user.displayName,
      });
    },
  );

  handle(sctx, 'screenshare:viewer:leave', { schema: channelPayload, errorEvent: 'screenshare:error', code: 'SCREENSHARE_VIEWER_FAILED' }, (payload) => {
    const channelId = payload?.channelId ?? sctx.screenshareViewing;
    if (!channelId) return;
    app.presence.removeScreenshareViewer(channelId, socket.id);
    if (sctx.screenshareViewing === channelId) sctx.screenshareViewing = null;
    app.broadcast.screenshare(channelId);
    app.broadcast.channels();
  });

  handle(sctx, 'screenshare:signal', { schema: signalSchema, code: 'SCREENSHARE_SIGNAL_FAILED', limiter: 'signal' }, ({ to, data, channelId }) => {
    if (data === undefined) return;
    const target = app.presence.getUser(to);
    if (!target) return;
    // Only relay between a host and viewers of the same screenshare session.
    const sessionId = channelId ?? sctx.screenshareHosting ?? sctx.screenshareViewing;
    const session = sessionId ? app.presence.getScreenshare(sessionId) : null;
    if (session) {
      const involved = (id: string) => id === session.hostId || session.viewers.has(id);
      if (!involved(socket.id) || !involved(to)) return;
    }
    socket.to(to).emit('screenshare:signal', { from: socket.id, data, channelId: channelId ?? null });
  });

  void notFound;
};
