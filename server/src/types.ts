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

export type AccountStatus = 'active' | 'disabled' | 'deleted';

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
  /** Set by an admin password reset: the next sign-in must set a new password first. */
  mustChangePassword: boolean;
  /** Last authenticated activity (sign-in, reconnect, disconnect). */
  lastSeenAt: number | null;
  deletedAt: number | null;
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
  /** Fetch a preview card for the first link of each message (on by default). */
  linkPreviews: boolean;
}

export interface ChannelMemberRecord {
  channelId: string;
  accountId: string;
  addedBy: string | null;
  joinedAt: number;
  /** When this member closed the conversation (DMs only); null while it is in their list. */
  closedAt: number | null;
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

/** An uploaded picture as stored (`message_attachments`). */
export interface AttachmentRecord {
  id: string;
  /** Null until the upload is bound to a message. */
  messageId: string | null;
  accountId: string;
  kind: 'image';
  fileName: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  storedName: string;
  previewName: string | null;
  previewWidth: number | null;
  previewHeight: number | null;
  createdAt: number;
}

/** An attachment as sent to clients: URLs are server-relative and need the viewer's media ticket. */
export interface AttachmentView {
  id: string;
  kind: 'image';
  fileName: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  url: string;
  previewUrl: string;
  previewWidth: number | null;
  previewHeight: number | null;
}

/** What the first link of a message pointed at (Open Graph or title/description). */
export interface LinkPreviewView {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

/** Someone a message @-mentions: the account and the name as it appears in the text. */
export interface MentionRef {
  accountId: string;
  name: string;
}

/** The message a reply quotes, as much of it as the quote shows. */
export interface ReplyRef {
  id: string;
  /** Null when the original is gone (pruned). */
  from: string | null;
  accountId: string | null;
  /** First part of the original's text; empty when it was deleted or carried only pictures. */
  text: string;
  /** The original was deleted (or is gone): the quote says so instead of showing text. */
  deleted: boolean;
  /** Pictures on the original, so the quote can say "picture" for an image-only message. */
  pictures: number;
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
  /** When the author last edited the text; null when never. */
  editedAt: number | null;
  /** A tombstone: the row stays in history as "message deleted", with nothing else on it. */
  deleted: boolean;
  reactions: ReactionSummary[];
  attachments: AttachmentView[];
  /** The link preview card, once fetched and unless the author removed it. */
  preview: LinkPreviewView | null;
  /** Accounts @-mentioned in the text (resolved when sent or edited). */
  mentions: MentionRef[];
  /** The message this one replies to, or null. */
  replyTo: ReplyRef | null;
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
  /** The page behind this socket says it is visible (default) or hidden. */
  visible: boolean;
  /** When `visible` was last reported (the client heartbeats while visible). */
  visibleAt: number;
  /** Title of the game the desktop app reports as running (`presence:activity`), or null. */
  activity: string | null;
}

/** What a device wants to be told about (Notifications settings); both on by default. */
export interface NotificationPreferences {
  mentions: boolean;
  dms: boolean;
}

/** A Web Push subscription as listed to its owner (keys are never sent back). */
export interface PushSubscriptionView {
  id: string;
  endpoint: string;
  userAgent: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  preferences: NotificationPreferences;
}

export interface VoiceParticipant {
  id: string;
  accountId: string;
  name: string;
  muted: boolean;
  deafened: boolean;
  joinedAt: number;
  /**
   * The client's id for its current set of peer connections. It survives a
   * reconnect, so peers can tell "same person, same media session, new socket"
   * (keep the connection) from "they rebuilt" (negotiate afresh).
   */
  rtcSessionId: string | null;
}

export interface VoiceRoom {
  channelId: string;
  sessionId: string;
  startedAt: number;
  participants: Map<string, VoiceParticipant>;
}

/** A peer connection a client still holds: who, and which media session of theirs. */
export interface HeldConnection {
  accountId: string;
  rtcSessionId: string | null;
}

export interface ScreenshareViewer {
  /** Socket id; changes when the viewer reconnects (the seat follows the account). */
  id: string;
  accountId: string;
  displayName: string;
  rtcSessionId: string | null;
  /** What the viewer said it still holds when it (re)joined. */
  holding: HeldConnection[];
}

export interface ScreenshareSession {
  channelId: string;
  /** The host's socket id; a reconnecting host takes the seat over with a new one. */
  hostId: string;
  accountId: string | null;
  displayName: string | null;
  startedAt: number;
  /** The host's media session id (see VoiceParticipant.rtcSessionId). */
  rtcSessionId: string | null;
  /** Whether viewers may save clips of this share on their own device (the host's choice; nothing is recorded here). */
  allowClips: boolean;
  viewers: Map<string, ScreenshareViewer>;
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
  linkPreviews: boolean;
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
