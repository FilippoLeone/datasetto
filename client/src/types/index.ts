/**
 * Core type definitions for Datasetto application
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
  createdAt?: number;
  lastSeenAt?: number;
  expiresAt?: number | null;
}

export type AccountStatus = 'active' | 'disabled';

export interface AccountProfileMetadata {
  [key: string]: unknown;
}

export interface Account {
  id: string;
  username: string;
  displayName: string;
  roles: RoleName[];
  status: AccountStatus;
  email?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  metadata?: AccountProfileMetadata;
  createdAt?: number;
  updatedAt?: number;
  disabledAt?: number | null;
  disabledReason?: string | null;
}

export interface User {
  id: string;
  accountId: string;
  username: string;
  displayName: string;
  name?: string;
  roles: RoleName[];
  isSuperuser: boolean;
  voiceChannel?: string | null;
  currentChannel?: string | null;
  avatarUrl?: string | null;
}

export type ChannelPermissionAction = 'view' | 'chat' | 'voice' | 'stream' | 'manage';

export interface ChannelPermissionEntry {
  roles: string[];
  accounts: string[];
}

export type ChannelPermissions = Record<ChannelPermissionAction, ChannelPermissionEntry>;

export interface Channel {
  id: string;
  name: string;
  type: 'text' | 'voice' | 'stream' | 'screenshare';
  count: number;
  groupId?: string | null;
  streamKey?: string;
  isLive?: boolean;
  liveStartedAt?: number | null;
  liveDisplayName?: string | null;
  liveAccountId?: string | null;
  voiceStartedAt?: number | null;
  voiceSessionId?: string | null;
  screenshareStartedAt?: number | null;
  screenshareHostName?: string | null;
  screenshareHostId?: string | null;
  screenshareViewerCount?: number;
  screenshareSession?: {
    hostId: string;
    displayName: string | null;
    startedAt: number;
    viewerCount: number;
  } | null;
  permissions?: ChannelPermissions;
  createdAt?: number;
  updatedAt?: number;
  currentMinigame?: {
    gameId: string;
    type: string;
    status: string;
    startedAt?: number | null;
    hostId?: string | null;
    hostName?: string | null;
    updatedAt?: number;
  } | null;
}

export interface ChannelGroup {
  id: string;
  name: string;
  type: 'text' | 'voice' | 'stream' | 'screenshare';
  collapsed?: boolean;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  from: string;
  fromId?: string;
  text: string;
  ts: number;
  roles?: RoleName[];
  isSuperuser?: boolean;
  edited?: boolean;
  deleted?: boolean;
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
  voiceBitrate: number; // Opus bitrate in bps (32000, 64000, 96000, 128000)
  dtx: boolean; // Discontinuous transmission (saves bandwidth when silent)
  latencyHint: 'interactive' | 'balanced' | 'playback'; // Audio latency mode
  vadThreshold: number; // Voice activity detection threshold (0.01-0.2)
}

export interface AppState {
  currentChannel: string;
  currentChannelType: 'text' | 'voice' | 'stream' | 'screenshare';
  activeVoiceChannelId: string | null;
  activeVoiceChannelName: string | null;
  streamingMode: boolean;
  account: Account | null;
  session: SessionInfo | null;
  settings: AudioSettings;
  users: User[];
  channels: Channel[];
  channelPermissions: Record<string, ChannelPermissions>;
  accounts: Account[];
  channelGroups: ChannelGroup[];
  connected: boolean;
  voiceConnected: boolean;
  muted: boolean;
  deafened: boolean;
  voiceSessionStartedAt?: number | null;
  voiceSessionId?: string | null;
  voiceMinigame?: VoiceMinigameState | null;
}

export interface WebRTCSignal {
  from?: string;
  to?: string;
  data: {
    sdp?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
  };
}

export interface ScreenshareSessionEvent {
  channelId: string;
  active: boolean;
  hostId: string | null;
  hostName: string | null;
  startedAt: number | null;
  viewerCount: number;
}

export interface VoicePeerEvent {
  id: string;
  name: string;
  muted: boolean;
  deafened: boolean;
}

export type VoiceMinigameStatus = 'running' | 'ended';

export interface VoiceMinigamePlayerState {
  id: string;
  name: string;
  color: string;
  score: number;
  alive: boolean;
  // Slither specific
  length?: number;
  thickness?: number;
  speed?: number;
  head?: { x: number; y: number };
  segments?: Array<{ x: number; y: number }>;
  // Pacman specific
  x?: number;
  y?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  powerupExpiresAt?: number;
  // Fighter specific
  vx?: number;
  vy?: number;
  facing?: 'left' | 'right';
  health?: number;
  isGrounded?: boolean;
  isAttacking?: boolean;
  attackType?: 'punch' | 'kick';
  isBlocking?: boolean;
  isStunned?: boolean;
  // Common
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
  radius?: number; // Slither
  isPowerup?: boolean; // Pacman
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
  type: 'slither' | 'pacman' | 'fighter';
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
  // Delta-compressed pellet data from server
  pelletData?: {
    full: boolean;
    pellets?: VoiceMinigamePellet[];  // When full=true
    added?: VoiceMinigamePellet[];    // When full=false
    removed?: string[];               // When full=false
    count?: number;                   // Total pellet count hint
  };
  // Reconstructed pellet array (populated by client)
  pellets: VoiceMinigamePellet[];
  players: VoiceMinigamePlayerState[];
  leaderboard: Array<{ id: string; name: string; score: number; length?: number }>;
  spectators: string[];
  tickIntervalMs: number;
  pacmanState?: PacmanState | null;
  fighterState?: FighterState | null;
}

export interface DeviceInfo {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
}

export type NotificationType = 'info' | 'success' | 'warning' | 'error';

export interface Notification {
  id: string;
  type: NotificationType;
  message: string;
  duration?: number;
}

export type EventMap = {
  'state:change': AppState;
  'user:update': User[];
  'channel:update': Channel[] | { channels: Channel[]; groups?: unknown[] };
  'chat:message': ChatMessage;
  'chat:history': ChatMessage[];
  'socket:connected': void;
  'socket:disconnected': { reason: string };
  'auth:success': {
    user: User;
    account: Account;
    session: SessionInfo;
    channels: Channel[];
    groups?: ChannelGroup[];
    isNewAccount?: boolean;
  };
  'auth:error': { message: string; code?: string };
  'auth:loggedOut': void;
  'account:updated': { account: Account; user?: User };
  'account:data': { account: Account; user?: User };
  'account:rolesUpdated': { account: Account; user?: User };
  'account:error': { message: string; code?: string };
  'stream:key': {
    channelId: string;
    channelName: string;
    streamKey: string;
    streamKeyChannel?: string;
    streamKeyToken?: string;
  };
  'stream:key:error': { channelId?: string | null; channelName?: string | null; message: string; code?: string };
  'admin:accounts:list': { accounts: Account[] };
  'admin:accounts:rolesUpdated': { account: Account };
  'admin:accounts:disabled': { account: Account };
  'admin:accounts:enabled': { account: Account };
  'admin:channels:permissions': { channelId: string; permissions: ChannelPermissions };
  'admin:channels:permissionsUpdated': { channelId: string; permissions: ChannelPermissions };
  'channel:permissionsUpdated': { channelId: string; permissions: ChannelPermissions };
  'admin:error': { message: string; code?: string };
  'voice:speaking': { id: string; speaking: boolean };
  'voice:stats': { peerId: string; quality: string; roundTripTime: number | null; packetLoss: number | null; jitter: number | null; bitrate: number | null; timestamp: number };
  'notification': Notification;
  'connection:status': { connected: boolean; reconnecting: boolean };
  'voice:joined': { channelId: string; peers: VoicePeerEvent[]; startedAt?: number | null; sessionId?: string | null };
  'error': Error;
  'voice:peer-join': VoicePeerEvent;
  'voice:peer-leave': { id: string };
  'voice:signal': { from: string; data: unknown };
  'voice:state': { id: string; muted: boolean; deafened: boolean };
  'voice:game:state': VoiceMinigameState;
  'voice:game:update': VoiceMinigameState;
  'voice:game:started': VoiceMinigameState;
  'voice:game:ended': { reason: string; state?: VoiceMinigameState | null };
  'voice:game:error': { message: string; code?: string };
  'screenshare:session': ScreenshareSessionEvent;
  'screenshare:signal': { from: string; data: unknown; channelId?: string | null };
  'screenshare:viewer:pending': { channelId: string; viewerId: string; viewerName: string };
  'screenshare:error': { channelId?: string | null; message: string; code?: string };
  // Video call events
  'video:camera:started': { stream: MediaStream };
  'video:camera:stopped': void;
  'video:screen:started': { stream: MediaStream };
  'video:screen:stopped': void;
  'video:remote:track': {
    peerId: string;
    streamType: 'camera' | 'screen';
    stream: MediaStream;
    track: MediaStreamTrack;
  };
  'video:remote:track:removed': { peerId: string; streamType: 'camera' | 'screen' };
  // Voice video state signaling (socket events)
  'voice:video:state': { id: string; type: 'camera' | 'screen'; enabled: boolean };
  [key: string]: unknown;
};

export type EventCallback<T = unknown> = (data: T) => void;
