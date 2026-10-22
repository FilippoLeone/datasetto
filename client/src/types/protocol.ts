/**
 * Wire types shared with the server (see server/src/types.ts and server/README.md).
 */

export type RoleName = 'superuser' | 'admin' | 'moderator' | 'streamer' | 'user';

export interface RolePermissions {
  canCreateChannels: boolean;
  canDeleteChannels: boolean;
  canEditChannels: boolean;
  canManageUsers: boolean;
  canAssignRoles: boolean;
  canRegenerateKeys: boolean;
  canStreamAnywhere: boolean;
  canModerate: boolean;
  canViewAllKeys: boolean;
  canDeleteAnyMessage: boolean;
  canBanUsers: boolean;
  canViewLogs: boolean;
  canManageChannelPermissions: boolean;
  canDisableAccounts: boolean;
}

export interface SessionInfo {
  token: string;
  expiresAt?: number | null;
}

export type AccountStatus = 'active' | 'disabled' | 'deleted';

export interface Account {
  id: string;
  username: string;
  displayName: string;
  roles: RoleName[];
  status: AccountStatus;
  email?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
  disabledAt?: number | null;
  disabledReason?: string | null;
  /** Set by an admin password reset: a new password must be chosen before anything else. */
  mustChangePassword?: boolean;
  lastSeenAt?: number | null;
  deletedAt?: number | null;
}

/** One live session of an account, as listed to admins (`admin:accounts:sessions`). */
export interface AdminSession {
  /** Prefix of the session's hash; addresses the session when revoking. */
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  userAgent: string | null;
  ip: string | null;
  /** A socket is currently connected with this session. */
  online: boolean;
  /** This is the admin's own session (cannot be revoked here). */
  current: boolean;
}

/** A connected user (one per socket). `id` is the socket id. */
export interface User {
  id: string;
  accountId: string;
  username: string;
  displayName: string;
  name?: string;
  roles: RoleName[];
  isSuperuser: boolean;
  avatarUrl?: string | null;
  voiceChannel?: string | null;
  currentChannel?: string | null;
  /** "Playing <title>": the game their desktop app reports (`presence:activity`), or null. */
  activity?: string | null;
}

/** Channel kinds users create; `dm` channels are one-to-one conversations made by the server. */
export type CreatableChannelType = 'text' | 'voice' | 'stream' | 'screenshare';
export type ChannelType = CreatableChannelType | 'dm';
export type ChannelPermissionAction = 'view' | 'chat' | 'voice' | 'stream' | 'manage';

export interface ChannelPermissionEntry {
  roles: string[];
  accounts: string[];
}

export type ChannelPermissions = Record<ChannelPermissionAction, ChannelPermissionEntry>;

export interface MinigameSummary {
  gameId: string;
  type: string;
  status: string;
  startedAt?: number | null;
  hostId?: string | null;
  hostName?: string | null;
  updatedAt?: number;
}

export type ChannelVisibility = 'public' | 'private';

export interface Channel {
  id: string;
  name: string;
  type: ChannelType;
  groupId?: string | null;
  topic?: string | null;
  /** Private channels are listed only for members and admins. */
  visibility?: ChannelVisibility;
  /** A private channel that can be joined with a password. */
  hasPassword?: boolean;
  /** Members of a private channel (0 for public ones). */
  memberCount?: number;
  lastMessageAt?: number | null;
  /** Preview cards for links posted here (on unless an admin switched it off). */
  linkPreviews?: boolean;
  /** For `dm` channels: the other participant. */
  dm?: { peerId: string; peerName: string; peerUsername: string; peerAvatarUrl: string | null } | null;
  count: number;
  isLive?: boolean;
  liveStartedAt?: number | null;
  liveDisplayName?: string | null;
  voiceStartedAt?: number | null;
  voiceSessionId?: string | null;
  currentMinigame?: MinigameSummary | null;
  screenshareStartedAt?: number | null;
  screenshareHostName?: string | null;
  screenshareHostId?: string | null;
  screenshareViewerCount?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface ChannelGroup {
  id: string;
  name: string;
  type: CreatableChannelType;
  collapsed?: boolean;
}

/** `channels:create` payload. */
export interface CreateChannelInput {
  name: string;
  type: CreatableChannelType;
  topic?: string | null;
  visibility?: ChannelVisibility;
  /** Join password for a private channel. */
  password?: string | null;
}

/** `channels:update` payload (admins). `password: null` removes the password. */
export interface UpdateChannelInput {
  topic?: string | null;
  visibility?: ChannelVisibility;
  password?: string | null;
  linkPreviews?: boolean;
}

/** One member of a private channel, as listed to admins. */
export interface ChannelMember {
  accountId: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  addedBy: string | null;
  joinedAt: number;
}

/** One emoji on a message and everyone who added it. */
export interface ReactionSummary {
  emoji: string;
  count: number;
  accountIds: string[];
  names: string[];
}

/** A picture on a message. URLs are server-relative and need the media ticket (`lib/media.ts`). */
export interface Attachment {
  id: string;
  /** A picture with a resized preview, or a WebM video (a posted clip) served as it came. */
  kind: 'image' | 'video';
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

/** The card for the first link of a message. */
export interface LinkPreview {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

/** Someone a message @-mentions: the account and the name as written after the @. */
export interface MentionRef {
  accountId: string;
  name: string;
}

/** The message a reply quotes. */
export interface ReplyRef {
  id: string;
  /** Null when the original is gone for good (pruned). */
  from: string | null;
  accountId: string | null;
  /** The original author's current profile picture (absent from older servers). */
  avatarUrl?: string | null;
  /** The start of the original's text; empty when deleted or picture-only. */
  text: string;
  deleted: boolean;
  /** Pictures on the original. */
  pictures: number;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  from: string;
  fromId?: string | null;
  accountId?: string | null;
  /**
   * The author's profile picture as it is now (null: none, or the account was deleted;
   * absent from older servers). Render through `avatarOf` (state/avatars.ts), which
   * also follows later changes.
   */
  authorAvatarUrl?: string | null;
  text: string;
  ts: number;
  roles?: RoleName[];
  isSuperuser?: boolean;
  edited?: boolean;
  editedAt?: number | null;
  /** A tombstone: shown as "message deleted" in place, with nothing else. */
  deleted?: boolean;
  reactions?: ReactionSummary[];
  /** Echo of the sender's queue id (only on the sender's own messages, never stored). */
  clientId?: string | null;
  attachments?: Attachment[];
  preview?: LinkPreview | null;
  /** Accounts the text @-mentions, resolved by the server. */
  mentions?: MentionRef[];
  /** The message this one replies to. */
  replyTo?: ReplyRef | null;
}

/** `chat:messageUpdated`: the author edited the text, or a preview card arrived for / was removed from a message. */
export interface MessageUpdatedEvent {
  channelId: string;
  messageId: string;
  text?: string;
  edited?: boolean;
  editedAt?: number | null;
  mentions?: MentionRef[];
  preview?: LinkPreview | null;
}

/** Acknowledgement of `chat:edit`. */
export interface EditAck {
  success: boolean;
  messageId?: string;
  channelId?: string;
  editedAt?: number | null;
  error?: string;
  code?: string;
}

/** One person who can read a channel, for the composer's @mention autocomplete (`channel:members`). */
export interface MentionCandidate {
  accountId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  roles: RoleName[];
}

/** `channel:members` answer. */
export interface ChannelMembersResponse {
  success: boolean;
  channelId?: string;
  members?: MentionCandidate[];
  error?: string;
  code?: string;
}

/** What this device wants to be notified about (both on by default). */
export interface NotificationPreferences {
  mentions: boolean;
  dms: boolean;
}

/** Signed viewer ticket for pictures (`auth:success` `media`, `media:ticket`). */
export interface MediaTicket {
  ticket: string;
  expiresAt: number;
}

/** `chat:history:before` answer: the page of history older than a known message. */
export interface OlderHistoryResponse {
  success: boolean;
  error?: string;
  code?: string;
  channelId?: string;
  messages?: ChatMessage[];
  hasMore?: boolean;
}

/** One piece of a search snippet; `match` parts are the terms that hit. */
export interface SnippetPart {
  text: string;
  match: boolean;
}

/** One hit of the `search` event. */
export interface SearchResult {
  id: string;
  channelId: string;
  channelName: string;
  channelType: ChannelType;
  authorId: string | null;
  authorName: string;
  authorAvatarUrl: string | null;
  roles: RoleName[];
  isSuperuser: boolean;
  ts: number;
  snippet: SnippetPart[];
}

/** `search` payload. */
export interface SearchParams {
  query: string;
  channelId?: string | null;
  authorId?: string | null;
  limit?: number;
  offset?: number;
}

/** `search` answer (over the acknowledgement). */
export interface SearchResponse {
  success: boolean;
  error?: string;
  code?: string;
  query?: string;
  results?: SearchResult[];
  total?: number;
  hasMore?: boolean;
  limit?: number;
  offset?: number;
}

/** `chat:reaction`: someone added or removed an emoji; `reactions` is the message's full list afterwards. */
export interface ReactionEvent {
  channelId: string;
  messageId: string;
  emoji: string;
  accountId: string;
  displayName: string;
  added: boolean;
  reactions: ReactionSummary[];
}

/**
 * Microphone noise suppression: the browser's own processing (`standard`), or a neural model
 * running in the client that also removes keyboard typing and chewing (`strong`).
 */
export type NoiseSuppressionLevel = 'off' | 'standard' | 'strong';

export interface AudioSettings {
  echoCancel: boolean;
  noiseSuppressionLevel: NoiseSuppressionLevel;
  /** `strong` only: how much noise the model may remove while you speak, in dB (6..40). */
  strongSuppressionDb: number;
  noiseReducerLevel: number;
  autoGain: boolean;
  micGain: number;
  outputVol: number;
  pttEnable: boolean;
  /** Push-to-talk shortcut as stored by lib/shortcut.ts (`Ctrl+Shift+KeyV`, or a bare `KeyboardEvent.code`). */
  pttKey: string;
  /** Desktop app: show the always-on-top voice overlay while in a voice channel. */
  overlayEnabled: boolean;
  /** Desktop app: corner of the primary display the overlay sits in. */
  overlayCorner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  micDeviceId?: string;
  spkDeviceId?: string;
  voiceBitrate: number;
  dtx: boolean;
  latencyHint: 'interactive' | 'balanced' | 'playback';
  vadThreshold: number;
  /** Screen share preset (resolution, frame rate, bitrate) for rooms and voice channels. */
  screenQuality: ScreenQuality;
  /** Clips: how many seconds of what you watch are kept on your device for the Clip button. */
  clipSeconds: ClipSeconds;
  /** Clips: mix the voice chat (the friends you hear) into clips of a share or stream. */
  clipIncludeVoice: boolean;
  /** Clips: the in-app shortcut that saves a clip (lib/shortcut.ts form, `Alt+KeyC`). Empty for none. */
  clipShortcut: string;
  /** Whether friends may save clips of the screens you share (sent with the share's metadata; nothing is recorded). */
  shareClipsAllowed: boolean;
}

/** Length of the rolling clip buffer, in seconds. */
export type ClipSeconds = 15 | 30 | 60;

/**
 * Screen share quality presets; see services/screenCapture.ts for the numbers.
 * The `native*` presets keep the captured display's own resolution.
 */
export type ScreenQuality = '720p30' | '1080p60' | 'native60' | 'native120';

export interface DeviceInfo {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
}

export interface VoicePeerEvent {
  id: string;
  /** Who is behind the socket; stable across their reconnects. */
  accountId?: string;
  name: string;
  muted: boolean;
  deafened: boolean;
  /** Their media session: unchanged while they keep their peer connections, new when they rebuilt. */
  rtcSessionId?: string | null;
  /** On a (re)join: the connections they still hold, so we know whether ours to them is still wanted. */
  holding?: HeldPeerConnection[];
}

/** One peer connection a client still holds: who, and which media session of theirs. */
export interface HeldPeerConnection {
  accountId: string;
  rtcSessionId: string | null;
}

export interface VoicePeerLeaveEvent {
  id: string;
  accountId?: string | null;
  /** `replaced`: the same person took the seat over with a new socket (keep the media connection). */
  reason?: 'left' | 'replaced';
}

/** Sent to every socket right before a graceful shutdown (a deploy). */
export interface ServerRestartingEvent {
  expectedWaitMs: number;
  reason?: string;
  at?: number;
}

/** Acknowledgement of a `chat` emit. */
export interface ChatAck {
  success: boolean;
  messageId?: string;
  channelId?: string;
  clientId?: string | null;
  ts?: number;
  error?: string;
  code?: string;
}

export interface VoiceJoinedEvent {
  channelId: string;
  peers: VoicePeerEvent[];
  startedAt?: number | null;
  sessionId?: string | null;
}

export interface VoiceSignalEvent {
  from: string;
  data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
}

export interface ScreenshareSessionEvent {
  channelId: string;
  active: boolean;
  hostId: string | null;
  /** Who presents; stable across the host's reconnects while `hostId` changes. */
  hostAccountId?: string | null;
  hostName: string | null;
  /** The host's media session id: our connection to them is still good while it stays the same. */
  rtcSessionId?: string | null;
  startedAt: number | null;
  viewerCount: number;
  /** Whether the host lets viewers save clips of the share on their own device; absent from older servers (allowed). */
  allowClips?: boolean;
  /** When `active` is false: a deliberate stop (`host`) or the host's socket going away (`disconnect`). */
  endedBy?: 'host' | 'disconnect' | null;
}

export interface ScreenshareSignalEvent {
  from: string;
  data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
  channelId?: string | null;
}

/** To the host: a viewer took a seat (or is back on a new socket). */
export interface ScreenshareViewerPendingEvent {
  channelId: string;
  viewerId: string;
  viewerAccountId?: string;
  viewerName: string;
  rtcSessionId?: string | null;
  holding?: HeldPeerConnection[];
}

/** To a viewer: its seat is confirmed, with the presenter's identity. */
export interface ScreenshareViewerSeatedEvent {
  channelId: string;
  hostId: string;
  hostAccountId: string | null;
  hostName: string | null;
  rtcSessionId: string | null;
}

/** To a socket whose host or viewer seat another socket of the same account took over. */
export interface ScreenshareReplacedEvent {
  channelId: string;
  role: 'host' | 'viewer';
  bySocketId: string;
}

export interface StreamKeyResponse {
  channelId: string;
  channelName: string;
  streamKey: string;
  streamKeyChannel?: string;
  streamKeyToken?: string;
}

export interface ServerError {
  message: string;
  code?: string;
  channelId?: string | null;
  channelName?: string | null;
}

export interface BanRecord {
  accountId: string;
  reason: string | null;
  bannedBy: string | null;
  bannedAt: number;
  expiresAt: number | null;
}

export type InviteStatus = 'active' | 'revoked' | 'expired' | 'exhausted';

/** Invite token as listed to admins (`admin:invites:list`). */
export interface InviteToken {
  id: string;
  token: string;
  note: string | null;
  maxUses: number;
  uses: number;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  status: InviteStatus;
  redeemedBy: Array<{ accountId: string; username: string; displayName: string; createdAt: number }>;
}

/** Admin-editable server settings (`admin:settings`). */
export interface ServerSettings {
  /** Permission template applied to new channels of each kind; absent kinds use the server default. */
  channelPermissionTemplates: Partial<Record<CreatableChannelType, ChannelPermissions>>;
}

/** `admin:settings:update` payload; a template set to null clears it. */
export interface ServerSettingsUpdate {
  channelPermissionTemplates?: Partial<Record<CreatableChannelType, Partial<ChannelPermissions> | null>>;
}

export interface MonthlyUsage {
  month: string;
  hlsEgressBytes: number;
  streamSeconds: number;
  updatedAt: number;
}

/** `admin:usage`: streaming traffic and what is live (admins). */
export interface AdminUsage {
  currentMonth: MonthlyUsage;
  months: MonthlyUsage[];
  budgetBytes: number;
  maxViewers: number;
  maxBitrateKbps: number;
  online: number;
  liveStreams: Array<{ channelId: string; channelName: string; displayName: string | null; startedAt: number; viewerCount: number }>;
}

/** `admin:server:info`: the running configuration, read-only (superusers). */
export interface ServerInfo {
  version: string;
  env: string;
  startedAt: number;
  uptimeSeconds: number;
  node: string;
  registration: { mode: 'open' | 'invite' | 'closed'; inviteCodeSet: boolean; adminEmails: string[] };
  sessions: { ttlDays: number; singlePerAccount: boolean };
  security: { passwordMinLength: number; maxConnectionsPerIp: number; trustProxy: boolean };
  limits: { maxChannels: number; maxMessageLength: number; chatHistoryLimit: number; messageRetentionPerChannel: number; maxMessagesPerMinute: number };
  streaming: { maxViewers: number; maxBitrateKbps: number; monthlyEgressBytes: number; watchdog: boolean; ticketSecretSet: boolean };
  turn: { enabled: boolean; urls: string[]; stunUrls: string[]; credentialTtlSeconds: number };
  push: { enabled: boolean; subject: string | null; subscriptions: number };
  urls: { rtmp: string | null; hls: string | null };
  cors: string[];
  storage: { dataDir: string; databasePath: string };
  counts: { accounts: number; channels: number; messages: number; online: number; invites: number };
}

// ------------------------------------------------------------ push notifications

/** `push:subscribe` payload: `PushSubscription.toJSON()` plus this browser's user agent. */
export interface PushSubscriptionPayload {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
  /** This device's notification choices; the server pushes only what it asked for. */
  preferences?: NotificationPreferences;
}

/** One of the account's subscriptions as the server lists them (never the keys). */
export interface PushSubscriptionInfo {
  id: string;
  endpoint: string;
  userAgent: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  preferences?: NotificationPreferences;
}

/** Acknowledgement of a `push:*` request. */
export type PushAck<T = object> = ({ success: true } & T) | { success: false; error: string; code?: string };

/** `admin:invites:create` payload. */
export interface CreateInviteInput {
  maxUses?: number;
  expiresAt?: number | null;
  note?: string | null;
}

// ---------------------------------------------------------------- minigames

export type VoiceMinigameStatus = 'running' | 'ended';
export type MinigameType = 'slither' | 'pacman' | 'fighter';

export interface VoiceMinigamePlayerState {
  id: string;
  name: string;
  color: string;
  score: number;
  alive: boolean;
  length?: number;
  thickness?: number;
  speed?: number;
  head?: { x: number; y: number };
  segments?: Array<{ x: number; y: number }>;
  x?: number;
  y?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  powerupExpiresAt?: number;
  vx?: number;
  vy?: number;
  facing?: 'left' | 'right';
  health?: number;
  isGrounded?: boolean;
  isAttacking?: boolean;
  attackType?: 'punch' | 'kick';
  isBlocking?: boolean;
  isStunned?: boolean;
  respawning: boolean;
  respawnInMs: number;
  lastInputAt?: number;
  joinedAt?: number;
}

export interface VoiceMinigamePellet {
  id: string;
  x: number;
  y: number;
  value: number;
  color: string;
  radius?: number;
  isPowerup?: boolean;
}

export interface PacmanState {
  phase: 'setup' | 'live' | 'overtime' | 'reset';
  phaseStartedAt: number;
  phaseEndsAt: number | null;
  speedMultiplier: number;
  round: number;
  initialPellets: number;
  pelletsRemaining: number;
}

export interface FighterState {
  phase: 'waiting' | 'fighting' | 'round_over' | 'game_over';
  round: number;
  roundEndsAt: number;
}

export interface VoiceMinigameState {
  gameId: string;
  channelId: string;
  type: MinigameType;
  status: VoiceMinigameStatus;
  hostId: string;
  hostName: string;
  startedAt: number;
  updatedAt: number;
  sequence: number;
  world: {
    width: number;
    height: number;
    map?: number[][];
    mapId?: string;
    mapName?: string;
    tileSize?: number;
    wrapRows?: number[];
  };
  pelletData?: {
    full: boolean;
    pellets?: VoiceMinigamePellet[];
    added?: VoiceMinigamePellet[];
    removed?: string[];
    count?: number;
  };
  pellets: VoiceMinigamePellet[];
  players: VoiceMinigamePlayerState[];
  leaderboard: Array<{ id: string; name: string; score: number; length?: number }>;
  spectators: string[];
  tickIntervalMs: number;
  pacmanState?: PacmanState | null;
  fighterState?: FighterState | null;
}

export interface LeaderboardEntry {
  name: string;
  score: number;
}

// ----------------------------------------------------- service event maps

export type NotificationType = 'info' | 'success' | 'warning' | 'error';

export interface Notification {
  id: string;
  type: NotificationType;
  message: string;
  duration?: number;
}

/**
 * What a voice participant says about a stream it sends, relayed by the server
 * (`voice:stream-metadata`). `allowClips` rides along with a screen: whether the
 * sharer lets friends save clips of it on their device (absent: allowed).
 */
export interface StreamMetadata {
  streamId: string;
  type: 'camera' | 'screen';
  allowClips?: boolean;
}

/** Events emitted by the media services (VoiceService, AudioService). */
export type EventMap = {
  'voice:offer': { peerId: string; offer: RTCSessionDescriptionInit };
  'voice:answer': { peerId: string; answer: RTCSessionDescriptionInit };
  'voice:ice-candidate': { peerId: string; candidate: RTCIceCandidateInit };
  'voice:send-stream-metadata': { to: string; metadata: StreamMetadata };
  /** A friend's voice stream arrived or went (the clip mixer follows them). */
  'voice:remote-audio': { peerId: string; stream: MediaStream | null };
  'voice:speaking': { id: string; speaking: boolean };
  'voice:stats': {
    peerId: string;
    quality: string;
    roundTripTime: number | null;
    packetLoss: number | null;
    jitter: number | null;
    bitrate: number | null;
    timestamp: number;
  };
  'video:camera:started': { stream: MediaStream };
  'video:camera:stopped': void;
  'video:screen:started': { stream: MediaStream; hasAudio: boolean };
  'video:screen:stopped': void;
  'video:remote:track': { peerId: string; streamType: 'camera' | 'screen'; stream: MediaStream; track: MediaStreamTrack };
  'video:remote:track:removed': { peerId: string; streamType: 'camera' | 'screen' };
  /** The sharer said whether their screen may be clipped (`voice:stream-metadata`). */
  'video:remote:clips': { peerId: string; allowed: boolean };
  notification: Notification;
  [key: string]: unknown;
};

/** STUN/TURN servers handed to a signed-in user; TURN credentials are short-lived. */
export interface IceConfigPayload {
  servers: RTCIceServer[];
  ttlSeconds: number | null;
  expiresAt: number | null;
}
