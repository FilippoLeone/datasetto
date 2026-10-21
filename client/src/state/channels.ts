import { batch, computed, signal } from '@preact/signals';
import { Storage } from '@/lib/storage';
import type { Channel, ChannelGroup, ChannelType } from '@/types/protocol';

const LAST_CHANNEL_KEY = 'datasetto.lastChannel';

export const channels = signal<Channel[]>([]);
export const groups = signal<ChannelGroup[]>([]);
/** Channel open in the main area (text, stream, screenshare or a voice channel's page). */
export const selectedChannelId = signal<string | null>(Storage.get<string | null>(LAST_CHANNEL_KEY, null));
/** The channel that was open before the current one (where closing a conversation takes you back). */
export const previousChannelId = signal<string | null>(null);
/** Unread message counts per text channel. */
export const unread = signal<Record<string, number>>({});
/** How many of the unread messages per channel @-mention us (the badge turns into an @ badge). */
export const mentions = signal<Record<string, number>>({});
/** A channel to open as soon as it is listed: from `/app?channel=<id>` (notification click) or the service worker. */
export const pendingChannelId = signal<string | null>(null);

/** Read `?channel=<id>` from the page URL once at boot and drop it from the address bar. */
export const captureChannelFromUrl = (): void => {
  try {
    const url = new URL(window.location.href);
    const channelId = url.searchParams.get('channel')?.trim();
    if (!channelId) return;
    pendingChannelId.value = channelId.slice(0, 128);
    url.searchParams.delete('channel');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch {
    /* non-standard location (file://) */
  }
};
export const collapsedGroups = signal<Record<ChannelType, boolean>>({
  text: false,
  voice: false,
  stream: false,
  screenshare: false,
  dm: false,
  ...Storage.get<Partial<Record<ChannelType, boolean>>>('datasetto.collapsedGroups', {}),
});

export const channelsById = computed(() => {
  const map = new Map<string, Channel>();
  for (const channel of channels.value) map.set(channel.id, channel);
  return map;
});

export const selectedChannel = computed<Channel | null>(() =>
  selectedChannelId.value ? (channelsById.value.get(selectedChannelId.value) ?? null) : null,
);

export const channelsByType = computed<Record<ChannelType, Channel[]>>(() => {
  const result: Record<ChannelType, Channel[]> = { text: [], voice: [], stream: [], screenshare: [], dm: [] };
  for (const channel of channels.value) result[channel.type]?.push(channel);
  // Conversations with the latest activity first.
  result.dm.sort((a, b) => (b.lastMessageAt ?? b.createdAt ?? 0) - (a.lastMessageAt ?? a.createdAt ?? 0));
  return result;
});

/** Display name of a channel: the other person for a DM, the channel name otherwise. */
export const channelLabel = (channel: Channel): string => (channel.type === 'dm' ? (channel.dm?.peerName ?? 'Direct message') : channel.name);

export const liveChannels = computed(() => channels.value.filter((channel) => channel.type === 'stream' && channel.isLive));

export const totalUnread = computed(() => Object.values(unread.value).reduce((sum, count) => sum + count, 0));
export const totalMentions = computed(() => Object.values(mentions.value).reduce((sum, count) => sum + count, 0));

export const setChannels = (next: Channel[], nextGroups?: ChannelGroup[]): void => {
  batch(() => {
    channels.value = next;
    if (nextGroups) groups.value = nextGroups;
    // Drop a selection that no longer exists.
    if (selectedChannelId.value && !next.some((channel) => channel.id === selectedChannelId.value)) {
      selectedChannelId.value = null;
    }
  });
};

/**
 * Pick a sensible default channel: the remembered one, else the first text channel.
 * `exclude` skips a channel that is going away but is still in the list (deleted or
 * closed to us; the refreshed list arrives a moment later).
 */
export const defaultChannelId = (exclude: string | null = null): string | null => {
  const remembered = selectedChannelId.value;
  if (remembered && remembered !== exclude && channelsById.value.has(remembered)) return remembered;
  const candidates = [...channelsByType.value.text, ...channels.value].filter((channel) => channel.id !== exclude);
  return candidates[0]?.id ?? null;
};

export const rememberSelection = (channelId: string | null): void => {
  const current = selectedChannelId.value;
  if (current && current !== channelId) previousChannelId.value = current;
  selectedChannelId.value = channelId;
  if (channelId) Storage.set(LAST_CHANNEL_KEY, channelId);
};

export const markUnread = (channelId: string): void => {
  unread.value = { ...unread.value, [channelId]: (unread.value[channelId] ?? 0) + 1 };
};

/** An unread message in this channel mentions us. */
export const markMention = (channelId: string): void => {
  mentions.value = { ...mentions.value, [channelId]: (mentions.value[channelId] ?? 0) + 1 };
};

export const markRead = (channelId: string): void => {
  batch(() => {
    if (unread.value[channelId]) {
      const next = { ...unread.value };
      delete next[channelId];
      unread.value = next;
    }
    if (mentions.value[channelId]) {
      const next = { ...mentions.value };
      delete next[channelId];
      mentions.value = next;
    }
  });
};

export const toggleGroup = (type: ChannelType): void => {
  const next = { ...collapsedGroups.value, [type]: !collapsedGroups.value[type] };
  collapsedGroups.value = next;
  Storage.set('datasetto.collapsedGroups', next);
};
