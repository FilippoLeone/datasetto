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
  type: 'text' | 'voice' | 'stream';
  count: number;
  groupId?: string | null;
  streamKey?: string;
  isLive?: boolean;
  voiceStartedAt?: number | null;
  voiceSessionId?: string | null;
  permissions?: ChannelPermissions;
  createdAt?: number;
  updatedAt?: number;
}

export interface ChannelGroup {
  id: string;
  name: string;
  type: 'text' | 'voice' | 'stream';
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
  currentChannelType: 'text' | 'voice' | 'stream';
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
}

export interface WebRTCSignal {
  from?: string;
  to?: string;
  data: {
    sdp?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
  };
}

export interface VoicePeerEvent {
  id: string;
  name: string;
  muted: boolean;
  deafened: boolean;
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
  'admin:accounts:list': { accounts: Account[] };
  'admin:accounts:rolesUpdated': { account: Account };
  'admin:accounts:disabled': { account: Account };
  'admin:accounts:enabled': { account: Account };
  'admin:channels:permissions': { channelId: string; permissions: ChannelPermissions };
  'admin:channels:permissionsUpdated': { channelId: string; permissions: ChannelPermissions };
  'channel:permissionsUpdated': { channelId: string; permissions: ChannelPermissions };
  'admin:error': { message: string; code?: string };
  'voice:speaking': { id: string; speaking: boolean };
  'notification': Notification;
  'connection:status': { connected: boolean; reconnecting: boolean };
  'voice:joined': { channelId: string; peers: VoicePeerEvent[]; startedAt?: number | null; sessionId?: string | null };
  'error': Error;
  'voice:peer-join': VoicePeerEvent;
  'voice:peer-leave': { id: string };
  'voice:signal': { from: string; data: unknown };
  'voice:state': { id: string; muted: boolean; deafened: boolean };
  [key: string]: unknown;
};

export type EventCallback<T = unknown> = (data: T) => void;
