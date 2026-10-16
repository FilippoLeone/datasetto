import { batch, computed, signal } from '@preact/signals';
import { Storage } from '@/lib/storage';
import type { Channel, ChannelGroup, ChannelType } from '@/types/protocol';

const LAST_CHANNEL_KEY = 'datasetto.lastChannel';

export const channels = signal<Channel[]>([]);
export const groups = signal<ChannelGroup[]>([]);
/** Channel open in the main area (text, stream, screenshare or a voice channel's page). */
export const selectedChannelId = signal<string | null>(Storage.get<string | null>(LAST_CHANNEL_KEY, null));
/** Unread message counts per text channel. */
export const unread = signal<Record<string, number>>({});
export const collapsedGroups = signal<Record<ChannelType, boolean>>(
  Storage.get('datasetto.collapsedGroups', { text: false, voice: false, stream: false, screenshare: false }),
);

export const channelsById = computed(() => {
  const map = new Map<string, Channel>();
  for (const channel of channels.value) map.set(channel.id, channel);
  return map;
});

export const selectedChannel = computed<Channel | null>(() =>
  selectedChannelId.value ? (channelsById.value.get(selectedChannelId.value) ?? null) : null,
);

export const channelsByType = computed<Record<ChannelType, Channel[]>>(() => {
  const result: Record<ChannelType, Channel[]> = { text: [], voice: [], stream: [], screenshare: [] };
  for (const channel of channels.value) result[channel.type]?.push(channel);
  return result;
});

export const liveChannels = computed(() => channels.value.filter((channel) => channel.type === 'stream' && channel.isLive));

export const totalUnread = computed(() => Object.values(unread.value).reduce((sum, count) => sum + count, 0));

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
  selectedChannelId.value = channelId;
  if (channelId) Storage.set(LAST_CHANNEL_KEY, channelId);
};

export const markUnread = (channelId: string): void => {
  unread.value = { ...unread.value, [channelId]: (unread.value[channelId] ?? 0) + 1 };
};

export const markRead = (channelId: string): void => {
  if (!unread.value[channelId]) return;
  const next = { ...unread.value };
  delete next[channelId];
  unread.value = next;
};

export const toggleGroup = (type: ChannelType): void => {
  const next = { ...collapsedGroups.value, [type]: !collapsedGroups.value[type] };
  collapsedGroups.value = next;
  Storage.set('datasetto.collapsedGroups', next);
};
