import { z } from 'zod';
import { formatStreamKey } from '../../core/ids.js';
import { rolesHavePermission } from '../../core/roles.js';
import { channelTypeSchema, idSchema, optionalIdSchema, permissionsInputSchema } from '../../core/validation.js';
import { AppError, forbidden, notFound } from '../../errors.js';
import type { ChannelType } from '../../types.js';
import { handle, requirePermission, requireUser, type SocketContext } from '../context.js';
import { channelsPayload } from '../payloads.js';

const createChannelSchema = z.union([
  z.string().max(64),
  z.object({
    name: z.string().max(64),
    type: channelTypeSchema.optional(),
    groupId: optionalIdSchema.optional(),
    permissions: permissionsInputSchema.nullable().optional(),
  }),
]);

const streamKeyRequestSchema = z
  .object({
    channelId: z.string().max(128).optional().nullable(),
    channelName: z.string().max(64).optional().nullable(),
  })
  .partial();

export const registerChannelHandlers = (sctx: SocketContext): void => {
  const { app, socket } = sctx;

  handle(sctx, 'channels:list', { code: 'CHANNELS_LIST_FAILED' }, () => {
    socket.emit('channels:update', channelsPayload(app));
  });

  handle(sctx, 'channels:create', { schema: createChannelSchema, code: 'CHANNEL_CREATE_FAILED' }, (payload) => {
    const user = requirePermission(sctx, 'canCreateChannels', 'No permission to create channels');
    const input = typeof payload === 'string' ? { name: payload, type: 'text' as ChannelType } : payload;

    if (input.permissions && Object.keys(input.permissions).length > 0) {
      requirePermission(sctx, 'canManageChannelPermissions', 'No permission to configure channel permissions');
    }

    const channel = app.channels.create({
      name: input.name,
      type: (input.type ?? 'text') as ChannelType,
      groupId: input.groupId ?? null,
      permissions: input.permissions ?? null,
    });
    app.broadcast.channels();
    app.log.info({ channelId: channel.id, name: channel.name, type: channel.type, by: user.accountId }, 'channel created');
  });

  handle(sctx, 'channels:delete', { schema: idSchema, code: 'CHANNEL_DELETE_FAILED' }, (idOrName) => {
    const user = requirePermission(sctx, 'canDeleteChannels', 'No permission to delete channels');
    const channel = app.channels.resolve(idOrName);
    if (!channel) throw notFound('Channel');

    sctx.io.to(channel.id).emit('channel:deleted', { channelId: channel.id });
    sctx.io.in(channel.id).socketsLeave(channel.id);
    app.presence.forgetChannel(channel.id);
    app.channels.delete(channel.id);
    app.broadcast.channels();
    app.broadcast.users();
    app.log.info({ channelId: channel.id, name: channel.name, by: user.accountId }, 'channel deleted');
  });

  handle(sctx, 'channel:join', { schema: idSchema, code: 'CHANNEL_JOIN_FAILED' }, async (channelId) => {
    const user = requireUser(sctx);
    const channel = app.channels.get(channelId);
    if (!channel) throw notFound('Channel');

    const action = channel.type === 'voice' ? 'voice' : 'view';
    if (!app.channels.canAccess(channel, user, action)) {
      throw forbidden('No permission to access this channel');
    }

    const previous = sctx.currentChannel;
    if (previous && previous !== channel.id) {
      app.presence.leaveChannel(socket.id, previous);
      // Keep the socket.io room subscription when we are still in that voice room.
      if (previous !== sctx.voiceChannel) await socket.leave(previous);
      if (sctx.screenshareViewing === previous) {
        app.presence.removeScreenshareViewer(previous, socket.id);
        sctx.screenshareViewing = null;
        app.broadcast.screenshare(previous);
      }
    }

    await socket.join(channel.id);
    app.presence.joinChannel(socket.id, channel.id);
    sctx.currentChannel = channel.id;

    socket.emit('channel:joined', { channelId: channel.id, channelName: channel.name, channelType: channel.type });

    if (channel.type !== 'voice') {
      socket.emit('chat:history', app.messages.history(channel.id));
    }
    if (channel.type === 'screenshare') {
      app.broadcast.screenshare(channel.id, socket.id);
    }
    app.broadcast.channels();
  });

  handle(
    sctx,
    'stream:key:request',
    {
      schema: streamKeyRequestSchema,
      errorEvent: 'stream:key:error',
      code: 'STREAM_KEY_ERROR',
      errorExtras: (raw) => {
        const input = (raw ?? {}) as { channelId?: string | null; channelName?: string | null };
        return { channelId: input.channelId ?? null, channelName: input.channelName ?? null };
      },
    },
    (payload) => {
      const user = requireUser(sctx);
      const channel = app.channels.get(payload.channelId) ?? app.channels.getByName(payload.channelName);
      if (!channel || channel.type !== 'stream') {
        throw new AppError('Stream channel not found', 'STREAM_KEY_CHANNEL_NOT_FOUND', 404);
      }
      if (!channel.streamKey) throw new AppError('Stream key unavailable', 'STREAM_KEY_MISSING', 404);

      const globalAccess =
        user.isSuperuser || rolesHavePermission(user.roles, 'canViewAllKeys') || rolesHavePermission(user.roles, 'canStreamAnywhere');
      if (!globalAccess && !app.channels.canAccess(channel, user, 'stream')) {
        throw new AppError('You do not have access to this stream key', 'STREAM_KEY_FORBIDDEN', 403);
      }

      socket.emit('stream:key:response', {
        channelId: channel.id,
        channelName: channel.name,
        streamKey: formatStreamKey(channel.name, channel.streamKey),
        streamKeyChannel: channel.name,
        streamKeyToken: channel.streamKey,
      });
      app.log.info({ channelId: channel.id, accountId: user.accountId }, 'stream key provided');
    },
  );

  handle(
    sctx,
    'stream:key:regenerate',
    { schema: z.object({ channelId: idSchema }), errorEvent: 'stream:key:error', code: 'STREAM_KEY_ERROR' },
    (payload) => {
      const user = requirePermission(sctx, 'canRegenerateKeys', 'No permission to regenerate stream keys');
      const channel = app.channels.require(payload.channelId);
      const token = app.channels.regenerateStreamKey(channel.id);
      socket.emit('stream:key:response', {
        channelId: channel.id,
        channelName: channel.name,
        streamKey: formatStreamKey(channel.name, token),
        streamKeyChannel: channel.name,
        streamKeyToken: token,
      });
      app.log.info({ channelId: channel.id, accountId: user.accountId }, 'stream key regenerated');
    },
  );
};
