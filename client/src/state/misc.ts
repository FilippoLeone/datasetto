import { signal } from '@preact/signals';
import type {
  Account,
  BanRecord,
  ChannelPermissions,
  ScreenshareSessionEvent,
  StreamKeyResponse,
  VoiceMinigameState,
} from '@/types/protocol';

/** Stream keys fetched for channels the user may stream to, keyed by channel id. */
export const streamKeys = signal<Record<string, StreamKeyResponse>>({});

/** Live screenshare sessions keyed by channel id. */
export const screenshareSessions = signal<Record<string, ScreenshareSessionEvent>>({});

export const setScreenshareSession = (session: ScreenshareSessionEvent): void => {
  screenshareSessions.value = { ...screenshareSessions.value, [session.channelId]: session };
};

/** Current minigame in the voice channel the user is in. */
export const minigameState = signal<VoiceMinigameState | null>(null);

// Admin data --------------------------------------------------------------------

export const adminAccounts = signal<Account[]>([]);
export const adminBans = signal<BanRecord[]>([]);
export const channelPermissions = signal<Record<string, ChannelPermissions>>({});

export const upsertAdminAccount = (next: Account): void => {
  const list = adminAccounts.value;
  const index = list.findIndex((entry) => entry.id === next.id);
  adminAccounts.value = index === -1 ? [...list, next] : list.map((entry, i) => (i === index ? next : entry));
};
