/**
 * Shared server-side types. The wire format sent to clients is documented in
 * docs/PROTOCOL.md and mirrored by client/src/types/index.ts.
 */

/** Channel kinds users create. `dm` channels are created by the server for one-to-one conversations. */
export type CreatableChannelType = 'text' | 'voice' | 'stream' | 'screenshare';
export type ChannelType = CreatableChannelType | 'dm';
export const CHANNEL_TYPES: readonly CreatableChannelType[] = ['text', 'voice', 'stream', 'screenshare'];

export type RoleName = 'superuser' | 'admin' | 'moderator' | 'streamer' | 'user';

export type PermissionAction = 'view' | 'chat' | 'voice' | 'stream' | 'manage';
export const PERMISSION_ACTIONS: readonly PermissionAction[] = ['view', 'chat', 'voice', 'stream', 'manage'];

export interface PermissionEntry {
  roles: string[];
  accounts: string[];
}

export type ChannelPermissions = Record<PermissionAction, PermissionEntry>;

export type AccountStatus = 'active' | 'disabled';

export interface AccountRecord {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  bio: string | null;
  avatarUrl: string | null;
  roles: RoleName[];
  status: AccountStatus;
  passwordHash: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  disabledAt: number | null;
  disabledReason: string | null;
  /** Invite token that created the account, when one was used. */
  inviteTokenId: string | null;
}

export interface InviteTokenRecord {
  id: string;
  token: string;
  note: string | null;
  maxUses: number;
  uses: number;
  createdBy: string | null;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

/** Account as sent to clients (never includes the password hash). */
export type PublicAccount = Omit<AccountRecord, 'passwordHash'>;

export interface SessionRecord {
  tokenHash: string;
  accountId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  userAgent: string | null;
  ip: string | null;
}

export type ChannelVisibility = 'public' | 'private';
export const CHANNEL_VISIBILITIES: readonly ChannelVisibility[] = ['public', 'private'];

export interface ChannelRecord {
  id: string;
  name: string;
  type: ChannelType;
  groupId: string | null;
  topic: string | null;
  /** Private channels are only listed for their members (and admins). */
  visibility: ChannelVisibility;
  /** bcrypt hash of the join password of a private channel; never sent to clients. */
  joinPasswordHash: string | null;
  streamKey: string | null;
  permissions: ChannelPermissions;
  position: number;
  createdAt: number;
  updatedAt: number;
  /** When the newest message was posted; orders direct messages. */
  lastMessageAt: number | null;
}

export interface ChannelMemberRecord {
  channelId: string;
  accountId: string;
  addedBy: string | null;
  joinedAt: number;
}

export interface ChannelGroupRecord {
  id: string;
  name: string;
  type: CreatableChannelType;
  collapsed: boolean;
  position: number;
  createdAt: number;
}

/** One emoji on a message with everyone who added it (names for the hover list). */
export interface ReactionSummary {
  emoji: string;
  count: number;
  accountIds: string[];
  names: string[];
}

export interface MessageRecord {
  id: string;
  channelId: string;
  from: string;
  fromId: string | null;
  accountId: string | null;
  text: string;
  ts: number;
  roles: RoleName[];
  isSuperuser: boolean;
  edited: boolean;
  deleted: boolean;
  reactions: ReactionSummary[];
}

export interface BanRecord {
  accountId: string;
  reason: string | null;
  bannedBy: string | null;
  bannedAt: number;
  expiresAt: number | null;
}

/** A connected socket that has authenticated. */
export interface ConnectedUser {
  id: string; // socket id
  accountId: string;
  username: string;
  displayName: string;
  name: string;
  roles: RoleName[];
  isSuperuser: boolean;
  email: string | null;
  bio: string | null;
  avatarUrl: string | null;
  currentChannel: string | null;
  voiceChannel: string | null;
  connectedAt: number;
  lastActivity: number;
}

export interface VoiceParticipant {
  id: string;
  name: string;
  muted: boolean;
  deafened: boolean;
  joinedAt: number;
}

export interface VoiceRoom {
  channelId: string;
  sessionId: string;
  startedAt: number;
  participants: Map<string, VoiceParticipant>;
}

export interface ScreenshareSession {
  channelId: string;
  hostId: string;
  accountId: string | null;
  displayName: string | null;
  startedAt: number;
  viewers: Set<string>;
}

export interface ActiveStream {
  channelId: string;
  sessionId: string;
  accountId: string | null;
  displayName: string | null;
  clientId: string | null;
  sourceIp: string | null;
  startedAt: number;
}

export interface MinigameSummary {
  gameId: string;
  type: string;
  status: string;
  startedAt?: number | null;
  hostId?: string | null;
  hostName?: string | null;
  updatedAt?: number;
}

/** Channel as broadcast to clients (persistent data + live counters). */
export interface ChannelView {
  id: string;
  name: string;
  type: ChannelType;
  groupId: string | null;
  topic: string | null;
  visibility: ChannelVisibility;
  hasPassword: boolean;
  /** Members of a private channel; 0 for public channels. */
  memberCount: number;
  lastMessageAt: number | null;
  /** For `dm` channels: the other participant, as seen by the receiving user. */
  dm?: { peerId: string; peerName: string; peerUsername: string; peerAvatarUrl: string | null } | null;
  count: number;
  isLive: boolean;
  liveStartedAt: number | null;
  liveDisplayName: string | null;
  voiceStartedAt: number | null;
  voiceSessionId: string | null;
  currentMinigame: MinigameSummary | null;
  screenshareStartedAt?: number | null;
  screenshareHostName?: string | null;
  screenshareHostId?: string | null;
  screenshareViewerCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}
