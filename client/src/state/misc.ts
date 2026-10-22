import { signal } from '@preact/signals';
import type {
  Account,
  AdminSession,
  AdminUsage,
  BanRecord,
  ChannelMember,
  ChannelPermissions,
  InviteToken,
  ScreenshareSessionEvent,
  ServerInfo,
  ServerSettings,
  StreamKeyResponse,
} from '@/types/protocol';

/** Stream keys fetched for channels the user may stream to, keyed by channel id. */
export const streamKeys = signal<Record<string, StreamKeyResponse>>({});

/** Live screenshare sessions keyed by channel id. */
export const screenshareSessions = signal<Record<string, ScreenshareSessionEvent>>({});

export const setScreenshareSession = (session: ScreenshareSessionEvent): void => {
  screenshareSessions.value = { ...screenshareSessions.value, [session.channelId]: session };
};

// Admin data --------------------------------------------------------------------

export const adminAccounts = signal<Account[]>([]);
export const adminBans = signal<BanRecord[]>([]);
export const adminInvites = signal<InviteToken[]>([]);
export const adminSettings = signal<ServerSettings | null>(null);
export const adminUsage = signal<AdminUsage | null>(null);
export const adminServerInfo = signal<ServerInfo | null>(null);
/** Sessions per account, loaded on demand in the admin panel. */
export const adminSessions = signal<Record<string, { accountId: string; sessions: AdminSession[] }>>({});
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
