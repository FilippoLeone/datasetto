import { batch } from '@preact/signals';
import { socketClient } from './client';
import { api } from './api';
import { sounds } from '@/services/sounds';
import { notifyDesktop } from '@/services/native/desktop';
import { account, authError, authStatus, clearSession, connectionStatus, isAuthenticated, sessionToken, setAuthenticated, socketId, updateAccount } from '@/state/session';
import {
  channelsById,
  defaultChannelId,
  markRead,
  markUnread,
  rememberSelection,
  selectedChannelId,
  setChannels,
} from '@/state/channels';
import { appendMessage, removeMessage, setHistory } from '@/state/chat';
import { users } from '@/state/presence';
import { closeModal, modal, toast } from '@/state/ui';
import {
  adminAccounts,
  adminBans,
  channelPermissions,
  minigameState,
  setScreenshareSession,
  streamKeys,
  upsertAdminAccount,
} from '@/state/misc';
import { containsMention } from '@/lib/text';
import { serverConfig } from '@/services/ServerConfigService';
import type {
  Account,
  BanRecord,
  Channel,
  ChannelGroup,
  ChannelPermissions,
  ChatMessage,
  IceConfigPayload,
  ScreenshareSessionEvent,
  ServerError,
  SessionInfo,
  StreamKeyResponse,
  User,
  VoiceMinigameState,
} from '@/types/protocol';

interface AuthSuccess {
  ice?: IceConfigPayload;
  user: User;
  account: Account;
  session: SessionInfo;
  channels: Channel[];
  groups?: ChannelGroup[];
  isNewAccount?: boolean;
}

const SESSION_ENDING_CODES = new Set(['SESSION_FAILED', 'ACCOUNT_DISABLED', 'BANNED']);

let installed = false;

/** Wire every server event into the stores. Call once before connecting. */
export const installSocketBindings = (): void => {
  if (installed) return;
  installed = true;

  socketClient.on('connect', () => {
    batch(() => {
      connectionStatus.value = 'connected';
      socketId.value = socketClient.id;
    });
    // The server keeps auth per socket, so every (re)connect re-presents the token.
    const token = sessionToken.value;
    if (token) {
      if (authStatus.value !== 'authenticated') authStatus.value = 'resuming';
      api.resumeSession(token);
    }
  });

  socketClient.on<string>('disconnect', () => {
    connectionStatus.value = 'reconnecting';
    socketId.value = null;
  });

  socketClient.on('connect_error', () => {
    connectionStatus.value = 'reconnecting';
  });

  // ---------------------------------------------------------------- auth

  socketClient.on<AuthSuccess>('auth:success', (payload) => {
    const wasAuthenticated = authStatus.value === 'authenticated';
    batch(() => {
      setAuthenticated(payload.account, payload.session.token);
      setChannels(payload.channels, payload.groups);
      serverConfig.applyIce(payload.ice);
      if (modal.value?.type === 'auth') closeModal();
    });

    // (Re)join the channel the UI is showing so the server sends history and counts us.
    const target = selectedChannelId.value && channelsById.value.has(selectedChannelId.value) ? selectedChannelId.value : defaultChannelId();
    if (target) {
      rememberSelection(target);
      api.joinChannel(target);
    }

    if (!wasAuthenticated) {
      const name = payload.account.displayName || payload.account.username;
      if (payload.isNewAccount) toast.success('Welcome, ' + name + '! Your account is ready.');
      else if (authStatus.value === 'authenticated') toast.success('Signed in as ' + name);
      sounds.play('success', 0.5);
    }
  });

  socketClient.on<ServerError>('auth:error', (payload) => {
    const code = payload.code ?? '';
    if (SESSION_ENDING_CODES.has(code)) {
      const message = payload.message || 'Your session ended. Please sign in again.';
      clearSession();
      // Keep the reason visible on the sign-in form after the toast is gone.
      authError.value = message;
      toast.error(message);
      return;
    }
    authStatus.value = 'anonymous';
    authError.value = payload.message || 'Authentication failed';
    sounds.play('error', 0.4);
  });

  socketClient.on<IceConfigPayload>('turn:credentials', (ice) => serverConfig.applyIce(ice));
  serverConfig.setIceRefresher(() => {
    if (isAuthenticated.value) api.refreshTurn();
  });

  socketClient.on('auth:loggedOut', () => {
    clearSession();
    toast.info('Signed out');
  });

  socketClient.on<{ account: Account }>('account:updated', ({ account: next }) => {
    updateAccount(next);
    toast.success('Profile updated');
  });
  socketClient.on<{ account: Account }>('account:data', ({ account: next }) => updateAccount(next));
  socketClient.on<{ account: Account }>('account:rolesUpdated', ({ account: next }) => {
    updateAccount(next);
    toast.info('Your roles were updated: ' + next.roles.join(', '));
  });
  socketClient.on<ServerError>('account:error', (payload) => toast.error(payload.message));

  // ------------------------------------------------------------ channels

  socketClient.on<{ channels: Channel[]; groups?: ChannelGroup[] }>('channels:update', (payload) => {
    const previous = selectedChannelId.value;
    setChannels(payload.channels, payload.groups);
    // The current channel was removed or hidden from us: fall back to a channel we can still see.
    if (previous && selectedChannelId.value === null && isAuthenticated.value) {
      const next = defaultChannelId();
      rememberSelection(next);
      if (next) api.joinChannel(next);
    }
  });

  socketClient.on<{ channelId: string }>('channel:joined', ({ channelId }) => markRead(channelId));

  socketClient.on<{ channelId: string }>('channel:deleted', ({ channelId }) => {
    if (selectedChannelId.value === channelId) {
      const next = defaultChannelId();
      rememberSelection(next);
      if (next) api.joinChannel(next);
    }
    toast.info('Channel was deleted');
  });

  socketClient.on<{ channelId: string; permissions: ChannelPermissions }>('channels:permissionsUpdated', (payload) => {
    channelPermissions.value = { ...channelPermissions.value, [payload.channelId]: payload.permissions };
  });

  // ----------------------------------------------------------------- chat

  socketClient.on<ChatMessage>('chat', (message) => {
    appendMessage(message);
    const own = message.accountId && message.accountId === account.value?.id;
    const viewing = selectedChannelId.value === message.channelId && document.visibilityState === 'visible';
    if (own) return;
    if (!viewing) markUnread(message.channelId);
    sounds.play('message', viewing ? 0.25 : 0.4);
    const me = account.value;
    if (me && containsMention(message.text, [me.displayName, me.username])) {
      const channelName = channelsById.value.get(message.channelId)?.name ?? 'chat';
      void notifyDesktop(message.from + ' in #' + channelName, message.text);
    }
  });

  socketClient.on<ChatMessage[]>('chat:history', (history) => {
    const channelId = history[0]?.channelId ?? selectedChannelId.value;
    if (channelId) setHistory(channelId, history);
  });

  socketClient.on<{ messageId: string; channelId: string }>('chat:messageDeleted', ({ channelId, messageId }) => {
    removeMessage(channelId, messageId);
  });

  // ------------------------------------------------------------- presence

  socketClient.on<User[]>('user:update', (list) => {
    users.value = Array.isArray(list) ? list : [];
  });

  // ----------------------------------------------------- generic feedback

  socketClient.on<ServerError | undefined>('error', (payload) => {
    if (!payload || payload.code === 'NOT_AUTHENTICATED') return;
    toast.error(payload.message || 'Request failed');
  });

  socketClient.on<{ type?: 'info' | 'success' | 'warning' | 'error'; message?: string }>('notification', (payload) => {
    if (payload?.message) toast[payload.type ?? 'info'](payload.message);
  });

  socketClient.on<{ by: string; reason?: string }>('user:banned', (payload) => {
    clearSession();
    toast.error(payload.reason || 'You have been banned from this server', 0);
  });

  socketClient.on<{ message?: string }>('moderation:success', (payload) => {
    if (payload?.message) toast.success(payload.message);
  });

  // -------------------------------------------------------------- streams

  socketClient.on<StreamKeyResponse>('stream:key:response', (payload) => {
    streamKeys.value = { ...streamKeys.value, [payload.channelId]: payload };
  });
  socketClient.on<ServerError>('stream:key:error', (payload) => toast.error(payload.message));

  socketClient.on<ScreenshareSessionEvent>('screenshare:session', (payload) => setScreenshareSession(payload));
  socketClient.on<ServerError>('screenshare:error', (payload) => toast.error(payload.message));

  // ---------------------------------------------------------------- admin

  socketClient.on<{ accounts: Account[] }>('admin:accounts:list', ({ accounts }) => {
    adminAccounts.value = accounts;
  });
  socketClient.on<{ account: Account }>('admin:accounts:rolesUpdated', ({ account: next }) => {
    upsertAdminAccount(next);
    toast.success('Roles updated for ' + next.displayName);
  });
  socketClient.on<{ account: Account }>('admin:accounts:disabled', ({ account: next }) => {
    upsertAdminAccount(next);
    toast.success(next.displayName + ' disabled');
  });
  socketClient.on<{ account: Account }>('admin:accounts:enabled', ({ account: next }) => {
    upsertAdminAccount(next);
    toast.success(next.displayName + ' enabled');
  });
  socketClient.on<{ accountId: string }>('admin:accounts:unbanned', ({ accountId }) => {
    adminBans.value = adminBans.value.filter((ban) => ban.accountId !== accountId);
    toast.success('Ban lifted');
  });
  socketClient.on<{ bans: BanRecord[] }>('admin:bans:list', ({ bans }) => {
    adminBans.value = bans;
  });
  socketClient.on<{ channelId: string; permissions: ChannelPermissions }>('admin:channels:permissions', (payload) => {
    channelPermissions.value = { ...channelPermissions.value, [payload.channelId]: payload.permissions };
  });
  socketClient.on<{ channelId: string; permissions: ChannelPermissions }>('admin:channels:permissionsUpdated', (payload) => {
    channelPermissions.value = { ...channelPermissions.value, [payload.channelId]: payload.permissions };
    toast.success('Channel permissions saved');
  });
  socketClient.on<ServerError>('admin:error', (payload) => toast.error(payload.message));

  // ------------------------------------------------------------ minigames

  socketClient.on<VoiceMinigameState>('voice:game:state', (state) => {
    minigameState.value = state;
  });
  socketClient.on<VoiceMinigameState>('voice:game:update', (state) => {
    minigameState.value = state;
  });
  socketClient.on<VoiceMinigameState>('voice:game:started', (state) => {
    minigameState.value = state;
    toast.info(state.hostName + ' started ' + state.type);
  });
  socketClient.on<{ reason: string }>('voice:game:ended', () => {
    minigameState.value = null;
  });
  socketClient.on<ServerError>('voice:game:error', (payload) => toast.error(payload.message));
};
