import { z } from 'zod';
import { rolesHavePermission } from '../../core/roles.js';
import { emojiSchema, idSchema } from '../../core/validation.js';
import { AppError, forbidden, notFound } from '../../errors.js';
import { notifyMessageRecipients } from '../../services/messageNotifications.js';
import { handle, requireUser, type SocketContext } from '../context.js';

/**
 * `chat` takes the text, or an object naming the channel (so a message queued
 * while offline lands where it was typed, whatever channel is open now) and a
 * client-side id that is echoed back for matching the pending copy.
 */
const chatSchema = z.union([
  z.string().max(20_000),
  z.object({ text: z.string().max(20_000), channelId: idSchema.optional().nullable(), clientId: z.string().min(1).max(64).optional().nullable() }),
]);
const deleteSchema = z.object({ messageId: idSchema, channelId: idSchema });
/** Largest page of older history one request may ask for. */
export const MAX_HISTORY_PAGE = 200;
const historyBeforeSchema = z.object({
  channelId: idSchema,
  beforeMessageId: idSchema,
  limit: z.number().int().min(1).max(MAX_HISTORY_PAGE).optional().nullable(),
});
const reactionSchema = z.object({ messageId: idSchema, channelId: idSchema, emoji: emojiSchema });

export const registerChatHandlers = (sctx: SocketContext): void => {
  const { app } = sctx;

  handle(sctx, 'chat', { schema: chatSchema, code: 'CHAT_FAILED', limiter: 'chat' }, (payload, ack) => {
    const user = requireUser(sctx);
    const text = typeof payload === 'string' ? payload : payload.text;
    const clientId = typeof payload === 'string' ? null : (payload.clientId ?? null);
    const channelId = (typeof payload === 'string' ? null : payload.channelId) ?? sctx.currentChannel;
    if (!channelId) throw new AppError('Join a channel first', 'NOT_IN_CHANNEL', 400);

    const channel = app.channels.get(channelId);
    if (!channel) throw notFound('Channel');
    if (channel.type !== 'text' && channel.type !== 'stream' && channel.type !== 'dm') {
      throw new AppError('This channel does not support chat', 'CHAT_NOT_SUPPORTED', 400);
    }
    if (!app.channels.canAccess(channel, user, 'chat')) {
      throw forbidden('No permission to send messages in this channel');
    }

    const message = app.messages.create(channel.id, user, text);
    app.channels.touchActivity(channel.id, message.ts);
    // Everyone who can see the channel gets the message so unread badges and mentions work across channels.
    // The sender's client id rides along (not stored) so its pending copy can be swapped for the real one.
    app.broadcast.toChannelViewers(channel.id, 'chat', clientId ? { ...message, clientId } : message);
    // The other side of a DM and @-mentioned people who are not looking at the app get a push.
    void notifyMessageRecipients(app, channel, message);
    if (ack) ack({ success: true, messageId: message.id, channelId: channel.id, clientId, ts: message.ts });
  });

  /**
   * `chat:history:before {channelId, beforeMessageId, limit?}`: the page of history
   * older than a message the client already has. Answered through the
   * acknowledgement when one is given, else with `chat:history:older`.
   */
  handle(sctx, 'chat:history:before', { schema: historyBeforeSchema, code: 'HISTORY_FAILED' }, ({ channelId, beforeMessageId, limit }, ack) => {
    const user = requireUser(sctx);
    const channel = app.channels.get(channelId);
    if (!channel) throw notFound('Channel');
    if (!app.channels.canAccess(channel, user, 'view')) throw forbidden('No permission to access this channel');
    const page = app.messages.historyBefore(channel.id, beforeMessageId, limit ?? undefined);
    const response = { success: true as const, channelId: channel.id, messages: page.messages, hasMore: page.hasMore };
    if (ack) ack(response);
    else sctx.socket.emit('chat:history:older', response);
  });

  handle(sctx, 'chat:delete', { schema: deleteSchema, code: 'DELETE_FAILED' }, ({ messageId, channelId }) => {
    const user = requireUser(sctx);
    const channel = app.channels.get(channelId);
    if (!channel) throw notFound('Channel');
    if (!app.channels.canAccess(channel, user, 'view')) throw forbidden('No permission to access this channel');

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
