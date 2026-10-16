import { socketClient } from './client';
import type { ChannelPermissions, CreateChannelInput, LeaderboardEntry, MinigameType, UpdateChannelInput } from '@/types/protocol';

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
  requestStreamKey: (channelId: string) => emit('stream:key:request', { channelId }),
  regenerateStreamKey: (channelId: string) => emit('stream:key:regenerate', { channelId }),

  // chat
  sendMessage: (text: string) => emit('chat', text),
  deleteMessage: (channelId: string, messageId: string) => emit('chat:delete', { channelId, messageId }),

  // voice
  joinVoice: (channelId: string) => emit('voice:join', channelId),
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
  disableAccount: (accountId: string, reason?: string) => emit('admin:accounts:disable', { accountId, reason }),
  enableAccount: (accountId: string) => emit('admin:accounts:enable', { accountId }),
  unbanAccount: (accountId: string) => emit('admin:accounts:unban', { accountId }),
  listBans: () => emit('admin:bans:list'),
  getChannelPermissions: (channelId: string) => emit('admin:channels:getPermissions', { channelId }),
  updateChannelPermissions: (channelId: string, permissions: Partial<ChannelPermissions>) =>
    emit('admin:channels:updatePermissions', { channelId, permissions }),
  listChannelMembers: (channelId: string) => emit('admin:channels:members:list', { channelId }),
  addChannelMember: (channelId: string, accountId: string) => emit('admin:channels:members:add', { channelId, accountId }),
  removeChannelMember: (channelId: string, accountId: string) => emit('admin:channels:members:remove', { channelId, accountId }),

  /** Fresh TURN credentials for the signed-in user (answered with `turn:credentials`). */
    refreshTurn: () => emit('turn:refresh'),

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
