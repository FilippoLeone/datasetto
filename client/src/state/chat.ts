import { signal } from '@preact/signals';
import type { ChatMessage, ReactionSummary } from '@/types/protocol';

const MAX_PER_CHANNEL = 500;

/** Message history per channel, oldest first. */
export const messages = signal<Record<string, ChatMessage[]>>({});
/** Channels whose history has been received at least once. */
export const loadedChannels = signal<Record<string, boolean>>({});

export const setHistory = (channelId: string, history: ChatMessage[]): void => {
  messages.value = { ...messages.value, [channelId]: history.slice(-MAX_PER_CHANNEL) };
  loadedChannels.value = { ...loadedChannels.value, [channelId]: true };
};

export const appendMessage = (message: ChatMessage): void => {
  const existing = messages.value[message.channelId] ?? [];
  if (existing.some((entry) => entry.id === message.id)) return;
  const next = [...existing, message];
  if (next.length > MAX_PER_CHANNEL) next.splice(0, next.length - MAX_PER_CHANNEL);
  messages.value = { ...messages.value, [message.channelId]: next };
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
