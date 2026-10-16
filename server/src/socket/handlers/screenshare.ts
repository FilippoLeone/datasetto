import { z } from 'zod';
import { idSchema } from '../../core/validation.js';
import { AppError } from '../../errors.js';
import type { ScreenshareViewer } from '../../types.js';
import { handle, requireUser, type SocketContext } from '../context.js';

/** Peer connections the client still holds (account + their media session id). */
const holdingSchema = z.array(z.object({ accountId: z.string().max(128), rtcSessionId: z.string().max(64).nullable() })).max(64);

const channelPayload = z.object({ channelId: idSchema.optional().nullable() }).partial().nullable().optional();
/**
 * `screenshare:start` and `screenshare:viewer:join` take the channel plus, from a
 * client that keeps its connections across reconnects, its media session id and
 * what it still holds (see VoiceParticipant.rtcSessionId for the idea).
 */
const seatPayload = z
  .object({
    channelId: idSchema.optional().nullable(),
    rtcSessionId: z.string().min(1).max(64).optional().nullable(),
    holding: holdingSchema.optional().nullable(),
  })
  .partial()
  .nullable()
  .optional();
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

  const contextOf = (socketId: string): SocketContext | null => {
    const other = io.sockets.sockets.get(socketId);
    return (other?.data as { ctx?: SocketContext } | undefined)?.ctx ?? null;
  };

  /** Tell the host about a seated viewer: who, their media session, what they hold. */
  const announceViewer = (hostId: string, channelId: string, viewer: ScreenshareViewer) => {
    io.to(hostId).emit('screenshare:viewer:pending', {
      channelId,
      viewerId: viewer.id,
      viewerAccountId: viewer.accountId,
      viewerName: viewer.displayName,
      rtcSessionId: viewer.rtcSessionId,
      holding: viewer.holding,
    });
  };

  handle(
    sctx,
    'screenshare:start',
    { schema: seatPayload, errorEvent: 'screenshare:error', code: 'SCREENSHARE_START_FAILED', errorExtras: extras },
    (payload) => {
      const user = requireUser(sctx);
      const channel = resolveChannel(payload, sctx.currentChannel);
      app.channels.requireAccess(channel, user, 'stream', 'No permission to share screen in this channel');

      let started: ReturnType<typeof app.presence.startScreenshare>;
      try {
        started = app.presence.startScreenshare(channel.id, {
          hostId: socket.id,
          accountId: user.accountId,
          displayName: user.displayName,
          rtcSessionId: payload?.rtcSessionId === undefined ? undefined : (payload.rtcSessionId ?? null),
        });
      } catch {
        throw new AppError('Channel already has an active screenshare', 'SCREENSHARE_BUSY', 409);
      }
      const { session, previousHostId } = started;
      if (previousHostId) {
        // The same person is back on a new socket (or opened a second window): the old socket is out.
        const previous = contextOf(previousHostId);
        if (previous && previous.screenshareHosting === channel.id) previous.screenshareHosting = null;
        io.to(previousHostId).emit('screenshare:replaced', { channelId: channel.id, role: 'host', bySocketId: socket.id });
        app.log.debug({ accountId: user.accountId, previousHostId, socketId: socket.id, channelId: channel.id }, 'screenshare host seat taken over');
      }
      sctx.screenshareHosting = channel.id;
      app.broadcast.screenshare(channel.id);
      app.broadcast.channels();
      // Viewers already seated (a host back after a reconnect): the host decides per viewer whether
      // its connection survived or needs a fresh offer.
      for (const viewer of session.viewers.values()) announceViewer(socket.id, channel.id, viewer);
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
      // A deliberate stop: viewers end at once instead of waiting for the presenter to come back.
      app.broadcast.screenshare(channelId, null, { endedBy: 'host' });
      app.broadcast.channels();
    },
  );

  handle(
    sctx,
    'screenshare:viewer:join',
    { schema: seatPayload, errorEvent: 'screenshare:error', code: 'SCREENSHARE_VIEWER_FAILED', errorExtras: extras },
    (payload) => {
      const user = requireUser(sctx);
      const channel = resolveChannel(payload, sctx.currentChannel);
      app.channels.requireAccess(channel, user, 'view', 'No permission to watch this channel');
      const session = app.presence.getScreenshare(channel.id);

      if (!session) {
        // Nobody is presenting (yet): the viewer keeps whatever it holds and waits for the next session.
        if (sctx.screenshareViewing === channel.id) sctx.screenshareViewing = null;
        app.broadcast.screenshare(channel.id, socket.id);
        return;
      }
      if (session.hostId === socket.id) return;

      const { seated, replacedViewerId } = app.presence.addScreenshareViewer(channel.id, {
        id: socket.id,
        accountId: user.accountId,
        displayName: user.displayName,
        rtcSessionId: payload?.rtcSessionId ?? null,
        holding: payload?.holding ?? [],
      });
      if (!seated) return;
      if (replacedViewerId) {
        const previous = contextOf(replacedViewerId);
        if (previous && previous.screenshareViewing === channel.id) previous.screenshareViewing = null;
        io.to(replacedViewerId).emit('screenshare:replaced', { channelId: channel.id, role: 'viewer', bySocketId: socket.id });
      }
      sctx.screenshareViewing = channel.id;
      app.broadcast.screenshare(channel.id);
      app.broadcast.channels();

      socket.emit('screenshare:viewer:seated', {
        channelId: channel.id,
        hostId: session.hostId,
        hostAccountId: session.accountId,
        hostName: session.displayName,
        rtcSessionId: session.rtcSessionId,
      });
      announceViewer(session.hostId, channel.id, session.viewers.get(socket.id)!);
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
};
