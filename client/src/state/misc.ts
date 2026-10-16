import { signal } from '@preact/signals';
import type {
  Account,
  BanRecord,
  ChannelMember,
  ChannelPermissions,
  InviteToken,
  ScreenshareSessionEvent,
  ServerSettings,
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
export const adminInvites = signal<InviteToken[]>([]);
export const adminSettings = signal<ServerSettings | null>(null);
/** The invite the admin just created, so its link can be shown and copied right away. */
export const lastCreatedInvite = signal<InviteToken | null>(null);
export const channelPermissions = signal<Record<string, ChannelPermissions>>({});
/** Members of private channels, keyed by channel id (admins only). */
export const channelMembers = signal<Record<string, ChannelMember[]>>({});

export const upsertAdminAccount = (next: Account): void => {
  const list = adminAccounts.value;
  const index = list.findIndex((entry) => entry.id === next.id);
  adminAccounts.value = index === -1 ? [...list, next] : list.map((entry, i) => (i === index ? next : entry));
};
