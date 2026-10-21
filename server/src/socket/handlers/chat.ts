import { z } from 'zod';
import { rolesHavePermission } from '../../core/roles.js';
import { emojiSchema, idSchema } from '../../core/validation.js';
import { AppError, forbidden, notFound } from '../../errors.js';
import { extractFirstUrl, previewView } from '../../services/linkPreviews.js';
import { notifyMessageRecipients, resolveMentions } from '../../services/messageNotifications.js';
import type { ChannelRecord, ChannelType, MessageRecord } from '../../types.js';
import { handle, requireUser, type SocketContext } from '../context.js';

/**
 * `chat` takes the text alone, or an object with the text and/or the ids of pictures
 * uploaded through POST /api/uploads, the channel (so a message queued while offline
 * lands where it was typed, whatever channel is open now), the message it replies to
 * and a client-side id that is echoed back for matching the pending copy.
 */
const chatSchema = z.union([
  z.string().max(20_000),
  z.object({
    text: z.string().max(20_000).optional().nullable(),
    attachmentIds: z.array(idSchema).max(50).optional().nullable(),
    channelId: idSchema.optional().nullable(),
    clientId: z.string().min(1).max(64).optional().nullable(),
    replyToId: idSchema.optional().nullable(),
  }),
]);
const editSchema = z.object({ messageId: idSchema, channelId: idSchema, text: z.string().max(20_000) });
const deleteSchema = z.object({ messageId: idSchema, channelId: idSchema });
const membersSchema = z.object({ channelId: idSchema });
/** Channel kinds that carry chat (and so can be replied in and have mentionable members). */
const CHAT_TYPES: ReadonlySet<ChannelType> = new Set<ChannelType>(['text', 'stream', 'dm']);
/** Longest member list `channel:members` answers with (a friend group is far smaller). */
const MAX_MEMBERS_LISTED = 500;
const previewRemoveSchema = z.object({ messageId: idSchema, channelId: idSchema });
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

  /**
   * Fetch the preview card for the message's first link in the background and tell
   * everyone who can see the channel once it is there. The cache answers at once
   * when the URL was seen recently; failures are cached too and produce nothing.
   */
  const fetchPreviewLater = (channel: ChannelRecord, message: MessageRecord, url: string) => {
    void app.linkPreviews.previewFor(url).then((record) => {
      const preview = previewView(record);
      if (!preview) return;
      // The author may have removed it or deleted the message while we were fetching.
      if (app.messages.previewUrlOf(channel.id, message.id) !== url) return;
      app.broadcast.toChannelViewers(channel.id, 'chat:messageUpdated', { channelId: channel.id, messageId: message.id, preview });
    });
  };

  handle(sctx, 'chat', { schema: chatSchema, code: 'CHAT_FAILED', limiter: 'chat' }, (payload, ack) => {
    const user = requireUser(sctx);
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

    const text = typeof payload === 'string' ? payload : (payload.text ?? '');
    const attachmentIds = typeof payload === 'string' ? [] : (payload.attachmentIds ?? []);
    if (attachmentIds.length > app.config.uploads.maxFilesPerMessage) {
      throw new AppError('At most ' + app.config.uploads.maxFilesPerMessage + ' pictures per message', 'TOO_MANY_ATTACHMENTS', 400);
    }
    const previewUrl = app.config.linkPreviews.enabled && channel.linkPreviews ? extractFirstUrl(text) : null;
    // A reply quotes a message of the same channel that still exists.
    const replyToId = typeof payload === 'string' ? null : (payload.replyToId ?? null);
    if (replyToId) {
      const original = app.messages.get(channel.id, replyToId);
      if (!original || original.deleted) throw new AppError('The message you are replying to is not available any more', 'REPLY_TARGET_MISSING', 404);
    }
    const mentions = resolveMentions(text, app.accounts.list());

    let message = app.messages.create(channel.id, user, text, { allowEmpty: attachmentIds.length > 0, previewUrl, replyToId, mentions });
    message = app.messages.attach(message, attachmentIds);
    app.channels.touchActivity(channel.id, message.ts);
    if (channel.type === 'dm') {
      // Whoever had closed the conversation gets it back in their list, with this message in it.
      for (const accountId of app.channels.listMemberIds(channel.id)) {
        if (app.channels.reopenDm(channel.id, accountId)) app.broadcast.channelsTo(accountId);
      }
    }

    let pending: string | null = null;
    if (previewUrl) {
      const cached = app.linkPreviews.cached(previewUrl);
      if (cached && app.linkPreviews.isFresh(cached)) message = { ...message, preview: previewView(cached) };
      else pending = previewUrl;
    }
    // Everyone who can see the channel gets the message so unread badges and mentions work across channels.
    // The sender's client id rides along (not stored) so its pending copy can be swapped for the real one.
    app.broadcast.toChannelViewers(channel.id, 'chat', clientId ? { ...message, clientId } : message);
    if (pending) fetchPreviewLater(channel, message, pending);
    // The other side of a DM and @-mentioned people who are not looking at the app get a push.
    void notifyMessageRecipients(app, channel, message);
    if (ack) ack({ success: true, messageId: message.id, channelId: channel.id, clientId, ts: message.ts });
  });

  /**
   * `chat:edit {channelId, messageId, text}`: the author replaces the text of their
   * own message. Everyone who can see the channel gets `chat:messageUpdated` with the
   * new text, the edit time and the mentions; people the edit newly mentions are
   * notified like for a new message. Answered through the acknowledgement.
   */
  handle(sctx, 'chat:edit', { schema: editSchema, code: 'EDIT_FAILED', limiter: 'chat' }, ({ messageId, channelId, text }, ack) => {
    const user = requireUser(sctx);
    const channel = app.channels.get(channelId);
    if (!channel) throw notFound('Channel');
    if (!app.channels.canAccess(channel, user, 'chat')) throw forbidden('No permission to send messages in this channel');
    const existing = app.messages.get(channel.id, messageId);
    if (!existing || existing.deleted) throw notFound('Message');
    if (existing.accountId === null || existing.accountId !== user.accountId) throw forbidden('Only the author can edit a message');

    const previewUrl = app.config.linkPreviews.enabled && channel.linkPreviews ? extractFirstUrl(text) : null;
    const mentions = resolveMentions(text, app.accounts.list());
    const message = app.messages.edit(channel.id, messageId, text, { previewUrl, mentions });

    // The card of a fresh cached link is on the message already; a new or stale link is fetched.
    // A card the author took off stays off while the link is the same (previewUrlOf answers null then).
    const pending = previewUrl && !message.preview && app.messages.previewUrlOf(channel.id, messageId) === previewUrl ? previewUrl : null;
    app.broadcast.toChannelViewers(channel.id, 'chat:messageUpdated', {
      channelId: channel.id,
      messageId,
      text: message.text,
      edited: true,
      editedAt: message.editedAt,
      mentions: message.mentions,
      preview: message.preview,
    });
    if (pending) fetchPreviewLater(channel, message, pending);
    const before = new Set(existing.mentions.map((mention) => mention.accountId));
    const added = message.mentions.map((mention) => mention.accountId).filter((accountId) => !before.has(accountId));
    if (added.length > 0) void notifyMessageRecipients(app, channel, message, { mentionIds: added });
    app.log.info({ messageId, channelId: channel.id, by: user.accountId }, 'message edited');
    if (ack) ack({ success: true, messageId, channelId: channel.id, editedAt: message.editedAt });
  });

  /**
   * `channel:members {channelId}` (acknowledgement): the people who can read the
   * channel, for the composer's @mention autocomplete. A conversation lists its two
   * participants; a private channel its members (and the admins who see it); a
   * public channel everyone with an active account.
   */
  handle(sctx, 'channel:members', { schema: membersSchema, code: 'MEMBERS_FAILED' }, ({ channelId }, ack) => {
    const user = requireUser(sctx);
    const channel = app.channels.get(channelId);
    if (!channel) throw notFound('Channel');
    if (!CHAT_TYPES.has(channel.type)) throw new AppError('This channel does not support chat', 'CHAT_NOT_SUPPORTED', 400);
    if (!app.channels.canAccess(channel, user, 'view')) throw forbidden('No permission to access this channel');
    const members = app.accounts
      .list()
      .filter((account) => account.status === 'active' && !app.moderation.getBan(account.id))
      .filter((account) => app.channels.canAccess(channel, { accountId: account.id, roles: account.roles, isSuperuser: account.roles.includes('superuser') }, 'view'))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }))
      .slice(0, MAX_MEMBERS_LISTED)
      .map((account) => ({ accountId: account.id, username: account.username, displayName: account.displayName, avatarUrl: account.avatarUrl, roles: account.roles }));
    const response = { success: true as const, channelId: channel.id, members };
    if (ack) ack(response);
    else sctx.socket.emit('channel:members', response);
  });

  // The author takes the link card off their own message (moderators may too).
  handle(sctx, 'chat:preview:remove', { schema: previewRemoveSchema, code: 'PREVIEW_REMOVE_FAILED' }, ({ messageId, channelId }) => {
    const user = requireUser(sctx);
    const channel = app.channels.get(channelId);
    if (!channel) throw notFound('Channel');
    if (!app.channels.canAccess(channel, user, 'view')) throw forbidden('No permission to access this channel');
    const existing = app.messages.get(channel.id, messageId);
    if (!existing || existing.deleted) throw notFound('Message');
    const isOwn = existing.accountId !== null && existing.accountId === user.accountId;
    const canModerate = user.isSuperuser || rolesHavePermission(user.roles, 'canDeleteAnyMessage');
    if (!isOwn && !canModerate) throw forbidden('Only the author can remove the preview');
    app.messages.removePreview(channel.id, messageId);
    app.broadcast.toChannelViewers(channel.id, 'chat:messageUpdated', { channelId: channel.id, messageId, preview: null });
  });

  // A fresh media ticket (file URLs carry it as `?t=`); the client renews before it expires.
  handle(sctx, 'media:ticket', { code: 'MEDIA_TICKET_FAILED', limiter: 'auth' }, (_payload, ack) => {
    const user = requireUser(sctx);
    const ticket = app.uploads.issueTicket(user.accountId);
    if (ack) ack({ success: true, ...ticket });
    else sctx.socket.emit('media:ticket', ticket);
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
