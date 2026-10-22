import { socketClient } from './client';
import type {
  ChatAck,
  ChannelMembersResponse,
  ChannelPermissions,
  EditAck,
  HeldPeerConnection,
  CreateChannelInput,
  CreateInviteInput,
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
  /** Hide a conversation from the sidebar until a message arrives in it or it is opened again (answered with `dm:closed` and a fresh list). */
  closeDm: (channelId: string) => emit('dm:close', { channelId }),
  requestStreamKey: (channelId: string) => emit('stream:key:request', { channelId }),
  regenerateStreamKey: (channelId: string) => emit('stream:key:regenerate', { channelId }),

  // chat
  /**
   * Send one message and wait for the server's acknowledgement. The channel is named so a
   * message queued while offline lands where it was typed; the client id comes back in the
   * echoed `chat` event (features/chat/outbox.ts matches the pending copy with it). Pictures
   * uploaded through `services/uploads.ts` ride along as attachment ids.
   */
  sendMessage: (channelId: string, text: string, clientId: string, attachmentIds: string[] = [], replyToId: string | null = null) =>
    socketClient.request<ChatAck>('chat', { text, channelId, clientId, attachmentIds, replyToId }, 10_000),
  /** Replace the text of one of our own messages (answered through the acknowledgement; viewers get `chat:messageUpdated`). */
  editMessage: (channelId: string, messageId: string, text: string) => socketClient.request<EditAck>('chat:edit', { channelId, messageId, text }, 10_000),
  deleteMessage: (channelId: string, messageId: string) => emit('chat:delete', { channelId, messageId }),
  /** The people who can read a channel, for the @mention autocomplete. */
  listMentionableMembers: (channelId: string) => socketClient.request<ChannelMembersResponse>('channel:members', { channelId }),
  /** Take the link card off a message (own messages, or any with the delete-any-message right). */
  removePreview: (channelId: string, messageId: string) => emit('chat:preview:remove', { channelId, messageId }),
  /** A fresh media ticket for picture URLs (answered through the acknowledgement). */
  requestMediaTicket: () => socketClient.request<{ success: boolean; ticket?: string; expiresAt?: number; error?: string }>('media:ticket'),
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

  // screenshare rooms (`rtcSessionId` and `holding`: see joinVoice)
  startScreenshare: (channelId: string, rtcSessionId: string | null = null, holding: HeldPeerConnection[] = [], allowClips = true) =>
    emit('screenshare:start', { channelId, rtcSessionId, holding, allowClips }),
  stopScreenshare: (channelId: string) => emit('screenshare:stop', { channelId }),
  /** Host only: let viewers clip the running share or not. */
  updateScreenshare: (channelId: string, allowClips: boolean) => emit('screenshare:update', { channelId, allowClips }),
  joinScreenshareViewer: (channelId: string, rtcSessionId: string | null = null, holding: HeldPeerConnection[] = []) =>
    emit('screenshare:viewer:join', { channelId, rtcSessionId, holding }),
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
  /** "Playing <title>" for everyone's member list (desktop app); null when no listed game runs. One per 10 s. */
  setActivity: (title: string | null) => emit('presence:activity', { title }),
};
