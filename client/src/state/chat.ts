import { batch, signal } from '@preact/signals';
import type { PendingMessage } from '@/features/chat/outbox';
import type { ChatMessage, ReactionSummary } from '@/types/protocol';

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

export const removeMessage = (channelId: string, messageId: string): void => {
  const existing = messages.value[channelId];
  if (!existing) return;
  messages.value = { ...messages.value, [channelId]: existing.filter((entry) => entry.id !== messageId) };
};

export const clearChannelMessages = (channelId: string): void => {
  const next = { ...messages.value };
  delete next[channelId];
  messages.value = next;
};
