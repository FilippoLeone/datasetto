import { z } from 'zod';
import { rolesHavePermission } from '../../core/roles.js';
import { emojiSchema, idSchema } from '../../core/validation.js';
import { AppError, forbidden, notFound } from '../../errors.js';
import { handle, requireUser, type SocketContext } from '../context.js';

const deleteSchema = z.object({ messageId: idSchema, channelId: idSchema });
const reactionSchema = z.object({ messageId: idSchema, channelId: idSchema, emoji: emojiSchema });

export const registerChatHandlers = (sctx: SocketContext): void => {
  const { app } = sctx;

  handle(sctx, 'chat', { schema: z.string().max(20_000), code: 'CHAT_FAILED', limiter: 'chat' }, (text) => {
    const user = requireUser(sctx);
    if (!sctx.currentChannel) throw new AppError('Join a channel first', 'NOT_IN_CHANNEL', 400);

    const channel = app.channels.get(sctx.currentChannel);
    if (!channel) throw notFound('Channel');
    if (channel.type !== 'text' && channel.type !== 'stream') {
      throw new AppError('This channel does not support chat', 'CHAT_NOT_SUPPORTED', 400);
    }
    if (!app.channels.canAccess(channel, user, 'chat')) {
      throw forbidden('No permission to send messages in this channel');
    }

    const message = app.messages.create(channel.id, user, text);
    // Everyone who can see the channel gets the message so unread badges and mentions work across channels.
    app.broadcast.toChannelViewers(channel.id, 'chat', message);
  });

  handle(sctx, 'chat:delete', { schema: deleteSchema, code: 'DELETE_FAILED' }, ({ messageId, channelId }) => {
    const user = requireUser(sctx);
    const channel = app.channels.get(channelId);
    if (!channel) throw notFound('Channel');

    const existing = app.messages.get(channel.id, messageId);
    if (!existing) throw notFound('Message');

    const isOwn = existing.accountId !== null && existing.accountId === user.accountId;
    const canModerate = user.isSuperuser || rolesHavePermission(user.roles, 'canDeleteAnyMessage');
    if (!isOwn && !canModerate) throw forbidden('No permission to delete this message');

    app.messages.delete(channel.id, messageId, user.displayName);
    app.broadcast.toChannelViewers(channel.id, 'chat:messageDeleted', { messageId, channelId: channel.id, deletedBy: user.displayName });
    app.log.info({ messageId, channelId: channel.id, by: user.accountId, own: isOwn }, 'message deleted');
  });

  // Reactions: anyone who can see the channel may react; everyone who can see it is told.
  const react = (added: boolean) => (payload: z.infer<typeof reactionSchema>) => {
    const user = requireUser(sctx);
    const channel = app.channels.get(payload.channelId);
    if (!channel) throw notFound('Channel');
    if (!app.channels.canAccess(channel, user, 'view')) throw forbidden('No permission to react in this channel');
    const reactions = added
      ? app.messages.addReaction(channel.id, payload.messageId, user.accountId, payload.emoji)
      : app.messages.removeReaction(channel.id, payload.messageId, user.accountId, payload.emoji);
    app.broadcast.toChannelViewers(channel.id, 'chat:reaction', {
      channelId: channel.id,
      messageId: payload.messageId,
      emoji: payload.emoji,
      accountId: user.accountId,
      displayName: user.displayName,
      added,
      reactions,
    });
  };
  handle(sctx, 'chat:react', { schema: reactionSchema, code: 'REACTION_FAILED', limiter: 'reaction' }, react(true));
  handle(sctx, 'chat:unreact', { schema: reactionSchema, code: 'REACTION_FAILED', limiter: 'reaction' }, react(false));

};
