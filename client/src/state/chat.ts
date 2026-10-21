import { batch, signal } from '@preact/signals';
import type { PendingMessage } from '@/features/chat/outbox';
import type { ChatMessage, ReactionSummary, ReplyRef } from '@/types/protocol';

/** Kept per channel; matches the server's default retention so a jump can reach any message. */
const MAX_PER_CHANNEL = 2000;

/** Message history per channel, oldest first. */
export const messages = signal<Record<string, ChatMessage[]>>({});
/** Channels whose history has been received at least once. */
export const loadedChannels = signal<Record<string, boolean>>({});
/** Bumped every time a channel's history is replaced (a `chat:history` arrived). */
export const historyVersion = signal<Record<string, number>>({});
/** Channels where everything older than the loaded messages has been fetched (nothing more to load). */
export const historyExhausted = signal<Record<string, boolean>>({});
/** Channels with an older-history request in flight. */
export const historyLoading = signal<Record<string, boolean>>({});
/** A message the list should scroll to once it is rendered (set by a search result). */
export const scrollTarget = signal<{ channelId: string; messageId: string } | null>(null);
/** The message briefly highlighted after a jump. */
export const highlightedMessageId = signal<string | null>(null);
/** Our own messages not yet confirmed by the server, per channel, in send order (features/chat/outbox.ts). */
export const pendingMessages = signal<Record<string, PendingMessage[]>>({});

/** The message being edited in place: a stored one (by id) or a pending one (by client id). */
export type EditingTarget = { channelId: string; messageId: string; clientId?: undefined } | { channelId: string; clientId: string; messageId?: undefined };
export const editing = signal<EditingTarget | null>(null);
/** Per channel, the message the next sent message replies to (shown above the composer). */
export const replyTargets = signal<Record<string, ReplyRef>>({});

export const startEditing = (target: EditingTarget | null): void => {
  editing.value = target;
};

export const setReplyTarget = (channelId: string, target: ReplyRef | null): void => {
  const next = { ...replyTargets.value };
  if (target) next[channelId] = target;
  else delete next[channelId];
  replyTargets.value = next;
};

/** The quote a reply to this message would carry (what the server would put in `replyTo`). */
export const replyRefOf = (message: ChatMessage): ReplyRef => ({
  id: message.id,
  from: message.from,
  accountId: message.accountId ?? null,
  text: message.text.replace(/\s+/g, ' ').trim().slice(0, 200),
  deleted: message.deleted === true,
  pictures: message.attachments?.length ?? 0,
});

export const setPendingMessages = (entries: PendingMessage[]): void => {
  const next: Record<string, PendingMessage[]> = {};
  for (const entry of entries) (next[entry.channelId] ??= []).push(entry);
  pendingMessages.value = next;
};

export const setHistory = (channelId: string, history: ChatMessage[]): void => {
  batch(() => {
    messages.value = { ...messages.value, [channelId]: history.slice(-MAX_PER_CHANNEL) };
    loadedChannels.value = { ...loadedChannels.value, [channelId]: true };
    historyVersion.value = { ...historyVersion.value, [channelId]: (historyVersion.value[channelId] ?? 0) + 1 };
    // A fresh tail of history says nothing about what lies before it.
    if (historyExhausted.value[channelId]) {
      const next = { ...historyExhausted.value };
      delete next[channelId];
      historyExhausted.value = next;
    }
  });
};

export const appendMessage = (message: ChatMessage): void => {
  const existing = messages.value[message.channelId] ?? [];
  if (existing.some((entry) => entry.id === message.id)) return;
  const next = [...existing, message];
  if (next.length > MAX_PER_CHANNEL) next.splice(0, next.length - MAX_PER_CHANNEL);
  messages.value = { ...messages.value, [message.channelId]: next };
};

/** Put an older page (oldest first) in front of what is loaded, skipping duplicates. */
export const prependMessages = (channelId: string, older: ChatMessage[]): void => {
  const existing = messages.value[channelId] ?? [];
  const known = new Set(existing.map((entry) => entry.id));
  const fresh = older.filter((entry) => !known.has(entry.id));
  if (fresh.length === 0) return;
  messages.value = { ...messages.value, [channelId]: [...fresh, ...existing] };
};

export const setHistoryExhausted = (channelId: string, exhausted: boolean): void => {
  historyExhausted.value = { ...historyExhausted.value, [channelId]: exhausted };
};

export const setHistoryLoading = (channelId: string, loading: boolean): void => {
  historyLoading.value = { ...historyLoading.value, [channelId]: loading };
};

export const setReactions = (channelId: string, messageId: string, reactions: ReactionSummary[]): void => {
  const existing = messages.value[channelId];
  if (!existing?.some((entry) => entry.id === messageId)) return;
  messages.value = {
    ...messages.value,
    [channelId]: existing.map((entry) => (entry.id === messageId ? { ...entry, reactions } : entry)),
  };
};

/** Merge fields into one loaded message (a preview card arrived or was removed). */
export const updateMessage = (channelId: string, messageId: string, patch: Partial<ChatMessage>): void => {
  const existing = messages.value[channelId];
  if (!existing?.some((entry) => entry.id === messageId)) return;
  messages.value = {
    ...messages.value,
    [channelId]: existing.map((entry) => (entry.id === messageId ? { ...entry, ...patch } : entry)),
  };
};

export const removeMessage = (channelId: string, messageId: string): void => {
  const existing = messages.value[channelId];
  if (!existing) return;
  messages.value = { ...messages.value, [channelId]: existing.filter((entry) => entry.id !== messageId) };
};

/**
 * A message was deleted: it stays in place as a tombstone, and replies that quote
 * it now quote a deleted message. An edit of it in progress is dropped.
 */
export const markMessageDeleted = (channelId: string, messageId: string): void => {
  const existing = messages.value[channelId];
  if (!existing) return;
  batch(() => {
    messages.value = {
      ...messages.value,
      [channelId]: existing.map((entry) => {
        if (entry.id === messageId) {
          return { ...entry, text: '', deleted: true, edited: false, editedAt: null, reactions: [], attachments: [], preview: null, mentions: [], replyTo: null };
        }
        if (entry.replyTo?.id === messageId) return { ...entry, replyTo: { ...entry.replyTo, text: '', deleted: true, pictures: 0 } };
        return entry;
      }),
    };
    if (editing.value?.channelId === channelId && editing.value.messageId === messageId) editing.value = null;
    if (replyTargets.value[channelId]?.id === messageId) setReplyTarget(channelId, null);
  });
};

/** The author changed the text: replies quoting the message show the new text too. */
export const applyMessageEdit = (channelId: string, messageId: string, patch: Partial<ChatMessage>): void => {
  const existing = messages.value[channelId];
  if (!existing?.some((entry) => entry.id === messageId)) return;
  const quote = patch.text !== undefined ? patch.text.replace(/\s+/g, ' ').trim().slice(0, 200) : null;
  messages.value = {
    ...messages.value,
    [channelId]: existing.map((entry) => {
      if (entry.id === messageId) return { ...entry, ...patch };
      if (quote !== null && entry.replyTo?.id === messageId && !entry.replyTo.deleted) return { ...entry, replyTo: { ...entry.replyTo, text: quote } };
      return entry;
    }),
  };
  if (quote !== null && replyTargets.value[channelId]?.id === messageId) setReplyTarget(channelId, { ...replyTargets.value[channelId], text: quote });
};

export const clearChannelMessages = (channelId: string): void => {
  const next = { ...messages.value };
  delete next[channelId];
  messages.value = next;
};
