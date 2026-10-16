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

export type AccountStatus = 'active' | 'disabled';

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

export interface ChatMessage {
  id: string;
  channelId: string;
  from: string;
  fromId?: string | null;
  accountId?: string | null;
  text: string;
  ts: number;
  roles?: RoleName[];
  isSuperuser?: boolean;
  edited?: boolean;
  deleted?: boolean;
  reactions?: ReactionSummary[];
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

export interface AudioSettings {
  echoCancel: boolean;
  noiseSuppression: boolean;
  noiseReducerLevel: number;
  autoGain: boolean;
  micGain: number;
  outputVol: number;
  pttEnable: boolean;
  pttKey: string;
  micDeviceId?: string;
  spkDeviceId?: string;
  voiceBitrate: number;
  dtx: boolean;
  latencyHint: 'interactive' | 'balanced' | 'playback';
  vadThreshold: number;
  /** Screen share preset (resolution, frame rate, bitrate) for rooms and voice channels. */
  screenQuality: ScreenQuality;
}

/** Screen share quality presets; see services/screenCapture.ts for the numbers. */
export type ScreenQuality = '720p30' | '1080p60';

export interface DeviceInfo {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
}

export interface VoicePeerEvent {
  id: string;
  name: string;
  muted: boolean;
  deafened: boolean;
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
  hostName: string | null;
  startedAt: number | null;
  viewerCount: number;
}

export interface ScreenshareSignalEvent {
  from: string;
  data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
  channelId?: string | null;
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

/** Events emitted by the media services (VoiceService, AudioService). */
export type EventMap = {
  'voice:offer': { peerId: string; offer: RTCSessionDescriptionInit };
  'voice:answer': { peerId: string; answer: RTCSessionDescriptionInit };
  'voice:ice-candidate': { peerId: string; candidate: RTCIceCandidateInit };
  'voice:send-stream-metadata': { to: string; metadata: { streamId: string; type: 'camera' | 'screen' } };
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
  notification: Notification;
  [key: string]: unknown;
};

/** STUN/TURN servers handed to a signed-in user; TURN credentials are short-lived. */
export interface IceConfigPayload {
  servers: RTCIceServer[];
  ttlSeconds: number | null;
  expiresAt: number | null;
}
