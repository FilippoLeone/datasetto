import type { AppContext } from '../context.js';
import type { AccountRecord, ChannelRecord, MentionRef, MessageRecord } from '../types.js';
import { MAX_MENTIONS_PER_MESSAGE } from './messages.js';
import type { PushNotification, PushSendSummary } from './push.js';

export type NotificationReason = 'dm' | 'mention';

const NAME_CHAR = /[\p{L}\p{N}_]/u;

/** Does `text` mention `@name`? Case-insensitive; the name must not continue into a longer word. */
export const mentionsName = (text: string, name: string): boolean => {
  if (!name) return false;
  const lower = text.toLowerCase();
  const needle = '@' + name.toLowerCase();
  let from = 0;
  for (;;) {
    const index = lower.indexOf(needle, from);
    if (index === -1) return false;
    const next = lower[index + needle.length];
    if (next === undefined || !NAME_CHAR.test(next)) return true;
    from = index + 1;
  }
};

/** Active accounts whose display name or username is @-mentioned in `text`. */
export const mentionedAccounts = (text: string, accounts: readonly AccountRecord[]): AccountRecord[] => {
  if (!text.includes('@')) return [];
  return accounts.filter((account) => account.status === 'active' && (mentionsName(text, account.displayName) || mentionsName(text, account.username)));
};

/**
 * The mentions stored with a message: each mentioned account with the name the text
 * uses for it (the display name when that matches, else the username), so clients can
 * highlight exactly that span, names with spaces included. At most MAX_MENTIONS_PER_MESSAGE.
 */
export const resolveMentions = (text: string, accounts: readonly AccountRecord[]): MentionRef[] =>
  mentionedAccounts(text, accounts)
    .slice(0, MAX_MENTIONS_PER_MESSAGE)
    .map((account) => ({ accountId: account.id, name: mentionsName(text, account.displayName) ? account.displayName : account.username }));

/** Where a notification takes the user: the app with the conversation selected. */
export const channelUrl = (channelId: string): string => '/app?channel=' + encodeURIComponent(channelId);

/** The text of a notification: the message, or what it carries when it has no text. */
export const notificationBody = (message: MessageRecord): string => {
  if (message.text) return message.text;
  const attachments = message.attachments ?? [];
  const count = attachments.length;
  if (count === 0) return '';
  const videos = attachments.filter((attachment) => attachment.kind === 'video').length;
  const noun = videos === count ? 'video' : videos === 0 ? 'picture' : 'file';
  return count === 1 ? 'Sent a ' + noun : 'Sent ' + count + ' ' + noun + 's';
};

export const buildNotification = (channel: ChannelRecord, message: MessageRecord, reason: NotificationReason): PushNotification => ({
  title: reason === 'dm' ? message.from : message.from + ' in #' + channel.name,
  body: notificationBody(message),
  url: channelUrl(channel.id),
  tag: 'channel:' + channel.id,
  channelId: channel.id,
});

export interface NotifiedRecipient {
  accountId: string;
  reason: NotificationReason;
  result: PushSendSummary;
}

export interface NotifyOptions {
  /**
   * Only these mentioned accounts are told (an edit that added mentions tells the
   * new ones only). Without it, everyone in `message.mentions` is a candidate.
   */
  mentionIds?: readonly string[];
}

/**
 * Push a notification to the people a message is for, when they are not looking at
 * the app: the other side of a direct message, or everyone @-mentioned (as stored
 * with the message) in a channel they may view. Recipients with an attending socket
 * (visible page) get nothing; the client shows the message itself. Each device only
 * gets what it asked for in its notification settings. Never throws.
 */
export const notifyMessageRecipients = async (app: AppContext, channel: ChannelRecord, message: MessageRecord, options: NotifyOptions = {}): Promise<NotifiedRecipient[]> => {
  if (!app.push.isEnabled()) return [];
  const candidates: Array<{ account: AccountRecord; reason: NotificationReason }> = [];
  try {
    if (channel.type === 'dm') {
      for (const accountId of app.channels.listMemberIds(channel.id)) {
        if (accountId === message.accountId) continue;
        const account = app.accounts.getById(accountId);
        if (account) candidates.push({ account, reason: 'dm' });
      }
    } else if (channel.type === 'text' || channel.type === 'stream') {
      const wanted = options.mentionIds ? new Set(options.mentionIds) : null;
      for (const mention of message.mentions ?? []) {
        if (mention.accountId === message.accountId) continue;
        if (wanted && !wanted.has(mention.accountId)) continue;
        const account = app.accounts.getById(mention.accountId);
        if (account) candidates.push({ account, reason: 'mention' });
      }
    }
  } catch (error) {
    app.log.error({ err: error, channelId: channel.id }, 'resolving notification recipients failed');
    return [];
  }

  const notified: NotifiedRecipient[] = [];
  for (const { account, reason } of candidates) {
    if (account.status !== 'active' || app.moderation.getBan(account.id)) continue;
    const subject = { accountId: account.id, roles: account.roles, isSuperuser: account.roles.includes('superuser') };
    // The recipient must be allowed to read where the message was posted.
    if (!app.channels.canAccess(channel, subject, 'view')) continue;
    if (app.presence.isAttending(account.id)) continue;
    try {
      const result = await app.push.send(account.id, buildNotification(channel, message, reason), channel.id, reason);
      notified.push({ accountId: account.id, reason, result });
    } catch (error) {
      app.log.error({ err: error, accountId: account.id, channelId: channel.id }, 'push notification failed');
    }
  }
  return notified;
};
