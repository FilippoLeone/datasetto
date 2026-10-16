import { socketClient } from './client';
import type {
  ChatAck,
  ChannelPermissions,
  HeldPeerConnection,
  CreateChannelInput,
  CreateInviteInput,
  LeaderboardEntry,
  MinigameType,
  OlderHistoryResponse,
  SearchParams,
  SearchResponse,
  PushAck,
  PushSubscriptionInfo,
  PushSubscriptionPayload,
  ServerSettingsUpdate,
  UpdateChannelInput,
} from '@/types/protocol';

const emit = (event: string, payload?: unknown): void => socketClient.emit(event, payload);

/** Typed client-to-server messages. Responses arrive as events handled in bindings.ts. */
export const api = {
  // auth
  register: (payload: { username: string; password: string; displayName?: string; inviteCode?: string }) =>
    emit('auth:register', {
      username: payload.username,
      password: payload.password,
      inviteCode: payload.inviteCode || undefined,
      profile: { displayName: payload.displayName || undefined },
    }),
  login: (username: string, password: string) => emit('auth:login', { username, password }),
  resumeSession: (token: string) => emit('auth:session', { token }),
  logout: () => emit('auth:logout'),
  getAccount: () => emit('account:get'),
  updateAccount: (payload: {
    displayName?: string;
    email?: string | null;
    bio?: string | null;
    avatarUrl?: string | null;
    currentPassword?: string;
    newPassword?: string;
  }) => emit('account:update', payload),

  // channels
  listChannels: () => emit('channels:list'),
  joinChannel: (channelId: string) => emit('channel:join', channelId),
  createChannel: (input: CreateChannelInput) =>
    emit('channels:create', {
      name: input.name,
      type: input.type,
      groupId: null,
      topic: input.topic || null,
      visibility: input.visibility ?? 'public',
      password: input.visibility === 'private' && input.password ? input.password : null,
    }),
  updateChannel: (channelId: string, input: UpdateChannelInput) => emit('channels:update', { channelId, ...input }),
  /** Become a member of a private channel by name and password (answered with `channels:privateJoined`). */
  joinPrivateChannel: (name: string, password: string) => emit('channels:joinPrivate', { name, password }),
  deleteChannel: (channelId: string) => emit('channels:delete', channelId),
  /** Open (or reuse) the one-to-one conversation with an account (answered with `dm:opened`). */
  openDm: (accountId: string) => emit('dm:open', { accountId }),
  requestStreamKey: (channelId: string) => emit('stream:key:request', { channelId }),
  regenerateStreamKey: (channelId: string) => emit('stream:key:regenerate', { channelId }),

  // chat
  /**
   * Send one message and wait for the server's acknowledgement. The channel is named so a
   * message queued while offline lands where it was typed; the client id comes back in the
   * echoed `chat` event (features/chat/outbox.ts matches the pending copy with it).
   */
  sendMessage: (channelId: string, text: string, clientId: string) =>
    socketClient.request<ChatAck>('chat', { text, channelId, clientId }, 10_000),
  deleteMessage: (channelId: string, messageId: string) => emit('chat:delete', { channelId, messageId }),
  addReaction: (channelId: string, messageId: string, emoji: string) => emit('chat:react', { channelId, messageId, emoji }),
  removeReaction: (channelId: string, messageId: string, emoji: string) => emit('chat:unreact', { channelId, messageId, emoji }),
  /** The page of history older than `beforeMessageId` (oldest first) and whether more exists. */
  loadOlderMessages: (channelId: string, beforeMessageId: string, limit?: number) =>
    socketClient.request<OlderHistoryResponse>('chat:history:before', { channelId, beforeMessageId, limit }),
  /** Full-text search over the channels this user may read. */
  search: (params: SearchParams) => socketClient.request<SearchResponse>('search', params),

  // voice
  /**
   * Join (or, after a reconnect, rejoin) a voice room. `rtcSessionId` tells peers whether our
   * connections survived; `holding` lists the ones we still have, so a peer we lost offers afresh.
   */
  joinVoice: (channelId: string, rtcSessionId: string | null = null, holding: HeldPeerConnection[] = []) =>
    emit('voice:join', rtcSessionId ? { channelId, rtcSessionId, holding } : channelId),
  leaveVoice: () => emit('voice:leave'),
  sendVoiceSignal: (to: string, data: unknown) => emit('voice:signal', { to, data }),
  sendStreamMetadata: (to: string, metadata: unknown) => emit('voice:stream-metadata', { to, metadata }),
  setVoiceState: (muted: boolean, deafened: boolean) => emit('voice:state', { muted, deafened }),
  setVideoState: (type: 'camera' | 'screen', enabled: boolean) => emit('voice:video:state', { type, enabled }),
  kickFromVoice: (targetSocketId: string, targetName: string) => emit('voice:kick', { targetSocketId, targetName }),
  timeoutFromVoice: (targetSocketId: string, targetName: string, duration: number) =>
    emit('voice:timeout', { targetSocketId, targetName, duration }),
  banUser: (targetSocketId: string, targetName: string, reason?: string) =>
    emit('user:ban', { targetSocketId, targetName, reason }),

  // screenshare rooms
  startScreenshare: (channelId: string) => emit('screenshare:start', { channelId }),
  stopScreenshare: (channelId: string) => emit('screenshare:stop', { channelId }),
  joinScreenshareViewer: (channelId: string) => emit('screenshare:viewer:join', { channelId }),
  leaveScreenshareViewer: (channelId: string) => emit('screenshare:viewer:leave', { channelId }),
  sendScreenshareSignal: (to: string, data: unknown, channelId: string | null) =>
    emit('screenshare:signal', { to, data, channelId }),

  // admin
  listAccounts: () => emit('admin:accounts:list'),
  updateRoles: (accountId: string, roles: string[]) => emit('admin:accounts:updateRoles', { accountId, roles }),
  adminUpdateAccount: (accountId: string, displayName: string) => emit('admin:accounts:update', { accountId, displayName }),
  resetAccountPassword: (accountId: string, temporaryPassword: string) => emit('admin:accounts:resetPassword', { accountId, temporaryPassword }),
  deleteAccount: (accountId: string) => emit('admin:accounts:delete', { accountId }),
  listAccountSessions: (accountId: string) => emit('admin:accounts:sessions:list', { accountId }),
  /** Revoke one session (by id) or, without an id, every session of the account. */
  revokeAccountSessions: (accountId: string, sessionId?: string) => emit('admin:accounts:sessions:revoke', { accountId, sessionId: sessionId ?? null }),
  disableAccount: (accountId: string, reason?: string) => emit('admin:accounts:disable', { accountId, reason }),
  enableAccount: (accountId: string) => emit('admin:accounts:enable', { accountId }),
  unbanAccount: (accountId: string) => emit('admin:accounts:unban', { accountId }),
  listBans: () => emit('admin:bans:list'),
  getChannelPermissions: (channelId: string) => emit('admin:channels:getPermissions', { channelId }),
  updateChannelPermissions: (channelId: string, permissions: Partial<ChannelPermissions>) =>
    emit('admin:channels:updatePermissions', { channelId, permissions }),
  getSettings: () => emit('admin:settings:get'),
  getUsage: () => emit('admin:usage:get'),
  getServerInfo: () => emit('admin:server:info'),
  updateSettings: (input: ServerSettingsUpdate) => emit('admin:settings:update', input),
  listInvites: () => emit('admin:invites:list'),
  createInvite: (input: CreateInviteInput) => emit('admin:invites:create', input),
  revokeInvite: (inviteId: string) => emit('admin:invites:revoke', { inviteId }),
  deleteInvite: (inviteId: string) => emit('admin:invites:delete', { inviteId }),
  listChannelMembers: (channelId: string) => emit('admin:channels:members:list', { channelId }),
  addChannelMember: (channelId: string, accountId: string) => emit('admin:channels:members:add', { channelId, accountId }),
  removeChannelMember: (channelId: string, accountId: string) => emit('admin:channels:members:remove', { channelId, accountId }),

  /** Fresh TURN credentials for the signed-in user (answered with `turn:credentials`). */
  refreshTurn: () => emit('turn:refresh'),

  // push notifications (answered through the acknowledgement) and presence
  subscribePush: (subscription: PushSubscriptionPayload) =>
    socketClient.request<PushAck<{ subscription: PushSubscriptionInfo; subscriptions: PushSubscriptionInfo[] }>>('push:subscribe', subscription),
  unsubscribePush: (endpoint: string) => socketClient.request<PushAck<{ removed: boolean; subscriptions: PushSubscriptionInfo[] }>>('push:unsubscribe', { endpoint }),
  listPushSubscriptions: () => socketClient.request<PushAck<{ enabled: boolean; subscriptions: PushSubscriptionInfo[] }>>('push:list'),
  sendPushTest: () => socketClient.request<PushAck<{ sent: number; failed: number; dropped: number }>>('push:test'),
  /** Visibility heartbeat: the server pushes only to people none of whose pages is visible. */
  reportVisibility: (visible: boolean) => emit('presence:visibility', { visible }),

  // minigames
  startGame: (type: MinigameType) => emit('voice:game:start', { type }),
  joinGame: () => emit('voice:game:join'),
  leaveGame: () => emit('voice:game:leave'),
  endGame: () => emit('voice:game:end'),
  sendGameInput: (payload: unknown) => emit('voice:game:input', payload),
  leaderboard: (type: MinigameType) =>
    socketClient.request<{ success: boolean; leaderboard?: LeaderboardEntry[]; error?: string }>('voice:game:leaderboard', {
      type,
    }),
};
