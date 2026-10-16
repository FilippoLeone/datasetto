import { z } from 'zod';
import { formatStreamKey } from '../../core/ids.js';
import { rolesHavePermission } from '../../core/roles.js';
import {
  channelNameSchema,
  channelTypeSchema,
  channelVisibilitySchema,
  idSchema,
  optionalIdSchema,
  permissionsInputSchema,
} from '../../core/validation.js';
import { AppError, forbidden, notFound } from '../../errors.js';
import { ChannelService } from '../../services/channels.js';
import type { ChannelVisibility, CreatableChannelType } from '../../types.js';
import { handle, requirePermission, requireUser, type SocketContext } from '../context.js';
import { channelsPayload } from '../payloads.js';

const createChannelSchema = z.union([
  z.string().max(64),
  z.object({
    name: z.string().max(64),
    type: channelTypeSchema.optional(),
    groupId: optionalIdSchema.optional(),
    permissions: permissionsInputSchema.nullable().optional(),
    topic: z.string().max(200).nullable().optional(),
    visibility: channelVisibilitySchema.optional(),
    password: z.string().max(128).nullable().optional(),
  }),
]);

const joinPrivateSchema = z.object({ name: channelNameSchema, password: z.string().min(1).max(128) });

const updateChannelSchema = z.object({
  channelId: idSchema,
  topic: z.string().max(200).nullable().optional(),
  visibility: channelVisibilitySchema.optional(),
  /** New password, `null` to remove it, omit to keep the current one. */
  password: z.string().max(128).nullable().optional(),
  linkPreviews: z.boolean().optional(),
});

const streamKeyRequestSchema = z
  .object({
    channelId: z.string().max(128).optional().nullable(),
    channelName: z.string().max(64).optional().nullable(),
  })
  .partial();

export const registerChannelHandlers = (sctx: SocketContext): void => {
  const { app, socket } = sctx;

  handle(sctx, 'channels:list', { code: 'CHANNELS_LIST_FAILED' }, () => {
    socket.emit('channels:update', channelsPayload(app, requireUser(sctx)));
  });

  handle(sctx, 'channels:create', { schema: createChannelSchema, code: 'CHANNEL_CREATE_FAILED' }, async (payload) => {
    const user = requirePermission(sctx, 'canCreateChannels', 'No permission to create channels');
    const input = typeof payload === 'string' ? { name: payload, type: 'text' as CreatableChannelType } : payload;

    if (input.permissions && Object.keys(input.permissions).length > 0) {
      requirePermission(sctx, 'canManageChannelPermissions', 'No permission to configure channel permissions');
    }
    const visibility = (input.visibility ?? 'public') as ChannelVisibility;
    if (input.password && visibility !== 'private') {
      throw new AppError('Only private channels can have a join password', 'PASSWORD_ON_PUBLIC_CHANNEL', 400);
    }
    const joinPasswordHash = input.password ? await ChannelService.hashPassword(input.password) : null;
    const type = (input.type ?? 'text') as CreatableChannelType;

    const channel = app.channels.create({
      name: input.name,
      type,
      groupId: input.groupId ?? null,
      // Explicit permissions win; otherwise the admin-defined template for this kind, else the server default.
      permissions: input.permissions && Object.keys(input.permissions).length > 0 ? input.permissions : app.settings.channelPermissionTemplate(type),
      topic: input.topic ?? null,
      visibility,
      joinPasswordHash,
      creatorAccountId: user.accountId,
    });
    socket.emit('channels:created', { channelId: channel.id, channelName: channel.name, channelType: channel.type });
    app.broadcast.channels();
    app.log.info(
      { channelId: channel.id, name: channel.name, type: channel.type, visibility: channel.visibility, by: user.accountId },
      'channel created',
    );
  });

  handle(sctx, 'channels:update', { schema: updateChannelSchema, code: 'CHANNEL_UPDATE_FAILED' }, async (payload) => {
    const user = requirePermission(sctx, 'canEditChannels', 'No permission to edit channels');
    const channel = app.channels.require(payload.channelId);
    const visibility = (payload.visibility ?? channel.visibility) as ChannelVisibility;
    if (payload.password && visibility !== 'private') {
      throw new AppError('Only private channels can have a join password', 'PASSWORD_ON_PUBLIC_CHANNEL', 400);
    }
    const joinPasswordHash =
      payload.password === undefined ? undefined : payload.password === null ? null : await ChannelService.hashPassword(payload.password);
    const updated = app.channels.update(channel.id, { topic: payload.topic, visibility, joinPasswordHash, linkPreviews: payload.linkPreviews });
    if (updated.visibility === 'private' && channel.visibility === 'public') {
      // Whoever locks a channel keeps access to it.
      app.channels.addMember(updated.id, user.accountId, user.accountId);
    }
    socket.emit('channels:updated', { channelId: updated.id });
    app.broadcast.channels();
    app.log.info({ channelId: channel.id, visibility: updated.visibility, by: user.accountId }, 'channel updated');
  });

  // Password guesses share the auth limiter (20 per minute per socket).
  handle(sctx, 'channels:joinPrivate', { schema: joinPrivateSchema, code: 'CHANNEL_JOIN_FAILED', limiter: 'auth' }, async ({ name, password }) => {
    const user = requireUser(sctx);
    const channel = await app.channels.joinWithPassword(name, user.accountId, password);
    socket.emit('channels:privateJoined', { channelId: channel.id, channelName: channel.name, channelType: channel.type });
    app.broadcast.channels();
    app.log.info({ channelId: channel.id, accountId: user.accountId }, 'joined private channel with password');
  });

  handle(sctx, 'channels:delete', { schema: idSchema, code: 'CHANNEL_DELETE_FAILED' }, (idOrName) => {
    const user = requirePermission(sctx, 'canDeleteChannels', 'No permission to delete channels');
    const channel = app.channels.resolve(idOrName);
    if (!channel) throw notFound('Channel');
    if (channel.type === 'dm') throw new AppError('Direct messages cannot be deleted', 'DM_IMMUTABLE', 400);

    sctx.io.to(channel.id).emit('channel:deleted', { channelId: channel.id });
    sctx.io.in(channel.id).socketsLeave(channel.id);
    app.presence.forgetChannel(channel.id);
    // Rows cascade with the channel; the pictures on disk go with them.
    app.uploads.deleteForChannel(channel.id);
    app.channels.delete(channel.id);
    app.broadcast.channels();
    app.broadcast.users();
    app.log.info({ channelId: channel.id, name: channel.name, by: user.accountId }, 'channel deleted');
  });

  handle(sctx, 'dm:open', { schema: z.object({ accountId: idSchema }), code: 'DM_OPEN_FAILED' }, ({ accountId }) => {
    const user = requireUser(sctx);
    const target = app.accounts.getById(accountId);
    if (!target || target.status !== 'active') throw notFound('Account');
    const channel = app.channels.openDm(user.accountId, target.id);
    socket.emit('dm:opened', { channelId: channel.id, peerId: target.id, peerName: target.displayName });
    app.broadcast.channels();
  });

  // Hide a conversation from the caller's sidebar. History and membership stay; the other side notices nothing.
  handle(sctx, 'dm:close', { schema: z.object({ channelId: idSchema }), code: 'DM_CLOSE_FAILED' }, ({ channelId }) => {
    const user = requireUser(sctx);
    const channel = app.channels.get(channelId);
    if (!channel) throw notFound('Channel');
    app.channels.closeDm(channel.id, user.accountId);
    socket.emit('dm:closed', { channelId: channel.id });
    // Every tab of this account drops it.
    app.broadcast.channelsTo(user.accountId);
  });

  handle(sctx, 'channel:join', { schema: idSchema, code: 'CHANNEL_JOIN_FAILED' }, async (channelId) => {
    const user = requireUser(sctx);
    const channel = app.channels.get(channelId);
    if (!channel) throw notFound('Channel');

    if (!app.channels.canAccess(channel, user, 'view') || (channel.type === 'voice' && !app.channels.canAccess(channel, user, 'voice'))) {
      throw forbidden('No permission to access this channel');
    }
    // Going to a conversation one had closed (a search result, a deep link) brings it back; the channel broadcast below carries it.
    if (channel.type === 'dm') app.channels.reopenDm(channel.id, user.accountId);

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

      // Seeing the channel is always required; the stream right can come from the channel or from a global role.
      if (!app.channels.canAccess(channel, user, 'view')) {
        throw new AppError('You do not have access to this stream key', 'STREAM_KEY_FORBIDDEN', 403);
      }
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
