import { batch, effect } from '@preact/signals';
import { socketClient } from './client';
import { api } from './api';
import { selectChannel } from '@/features/channels/channelActions';
import { outbox } from '@/features/chat/outboxService';
import { sounds } from '@/services/sounds';
import { notifyDesktop } from '@/services/native/desktop';
import { syncPushSubscription } from '@/services/pushNotifications';
import { createVisibilityHeartbeat } from '@/services/visibilityHeartbeat';
import {
  account,
  authError,
  authStatus,
  clearSession,
  connectionStatus,
  isAuthenticated,
  reconnectAttempt,
  reconnectNextAt,
  reconnectWaitingFor,
  serverRestarting,
  sessionToken,
  setAuthenticated,
  socketId,
  suspendSession,
  updateAccount,
} from '@/state/session';
import {
  channelsById,
  defaultChannelId,
  markRead,
  markUnread,
  pendingChannelId,
  rememberSelection,
  selectedChannelId,
  setChannels,
} from '@/state/channels';
import { appendMessage, removeMessage, setHistory, setReactions } from '@/state/chat';
import { users } from '@/state/presence';
import { closeModal, modal, toast } from '@/state/ui';
import {
  adminAccounts,
  adminBans,
  adminInvites,
  adminServerInfo,
  adminSessions,
  adminSettings,
  adminUsage,
  channelMembers,
  lastCreatedInvite,
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
  AdminSession,
  AdminUsage,
  BanRecord,
  Channel,
  ChannelGroup,
  ChannelMember,
  ChannelPermissions,
  ChatMessage,
  IceConfigPayload,
  InviteToken,
  ReactionEvent,
  ScreenshareSessionEvent,
  ServerInfo,
  ServerRestartingEvent,
  ServerSettings,
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

const SESSION_ENDING_CODES = new Set(['SESSION_FAILED', 'ACCOUNT_DISABLED', 'ACCOUNT_DELETED', 'BANNED', 'PASSWORD_RESET', 'SESSION_REVOKED']);

let installed = false;

/**
 * Tells the server whether this page is visible, so direct messages and mentions are
 * pushed to the user's devices only while no window of theirs shows the app. Reports
 * are only worth sending on a live, signed-in socket (a disconnected socket would queue them).
 */
const heartbeat = createVisibilityHeartbeat({
  send: (visible) => {
    if (socketClient.connected && isAuthenticated.value) api.reportVisibility(visible);
  },
});

/** Wire every server event into the stores. Call once before connecting. */
export const installSocketBindings = (): void => {
  if (installed) return;
  installed = true;

  effect(() => {
    if (isAuthenticated.value) heartbeat.start();
    else heartbeat.stop();
  });

  socketClient.on('connect', () => {
    batch(() => {
      connectionStatus.value = 'connected';
      socketId.value = socketClient.id;
      serverRestarting.value = null;
    });
    // The server keeps auth per socket, so every (re)connect re-presents the same token:
    // the server treats it as the same login (no other device is signed out by it).
    const token = sessionToken.value;
    if (token) {
      if (authStatus.value !== 'authenticated') authStatus.value = 'resuming';
      api.resumeSession(token);
    }
  });

  socketClient.on<string>('disconnect', () => {
    batch(() => {
      connectionStatus.value = navigator.onLine === false ? 'offline' : 'reconnecting';
      socketId.value = null;
    });
  });

  socketClient.on('connect_error', () => {
    if (connectionStatus.value === 'connected') connectionStatus.value = 'reconnecting';
  });

  // The banner shows the attempt count and the next try; "offline" when the browser says so.
  socketClient.onReconnectState((state) => {
    batch(() => {
      reconnectAttempt.value = state.attempt;
      reconnectNextAt.value = state.nextAt;
      reconnectWaitingFor.value = state.waitingFor;
      if (!socketClient.connected && connectionStatus.value !== 'connecting') {
        connectionStatus.value = state.waitingFor === 'network' ? 'offline' : 'reconnecting';
      }
    });
  });
  if (typeof window !== 'undefined') {
    window.addEventListener('offline', () => {
      if (!socketClient.connected) connectionStatus.value = 'offline';
    });
  }

  // A deploy: the server says goodbye with the time the next container needs. The socket client
  // already paces the first reconnect by it; this only drives the banner text.
  socketClient.on<ServerRestartingEvent>('server:restarting', (notice) => {
    serverRestarting.value = { expectedWaitMs: notice.expectedWaitMs, at: Date.now() };
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

    // Every (re)connect starts as "visible" on the server: say what this page really is.
    heartbeat.pulse();
    // This browser's push subscription follows the login (no-op unless notifications are on here).
    void syncPushSubscription();

    // A notification click or /app?channel=<id> asked for a channel: it wins over the remembered one.
    const wanted = pendingChannelId.value;
    if (wanted && channelsById.value.has(wanted)) {
      pendingChannelId.value = null;
      rememberSelection(wanted);
    }
    // (Re)join the channel the UI is showing so the server sends history and counts us.
    // Not while a temporary password is in force: the server refuses everything but the password change.
    const target = selectedChannelId.value && channelsById.value.has(selectedChannelId.value) ? selectedChannelId.value : defaultChannelId();
    if (target && !payload.account.mustChangePassword) {
      rememberSelection(target);
      api.joinChannel(target);
    }
    // Messages typed while the socket was down go out now, in order (the voice manager rejoins its room the same way).
    outbox.flush();

    if (!wasAuthenticated) {
      const name = payload.account.displayName || payload.account.username;
      if (payload.isNewAccount) toast.success('Welcome, ' + name + '! Your account is ready.');
      else if (authStatus.value === 'authenticated') toast.success('Signed in as ' + name);
      sounds.play('success', 0.5);
    }
  });

  socketClient.on<ServerError>('auth:error', (payload) => {
    const code = payload.code ?? '';
    if (code === 'SIGNED_IN_ELSEWHERE') {
      // Another device took over. Stay signed out here (no automatic resume) but keep the saved token.
      const message = payload.message || 'You signed in somewhere else, so this device was signed out.';
      suspendSession();
      authError.value = message;
      toast.warning(message, 8000);
      sounds.play('disconnect', 0.4);
      return;
    }
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

  socketClient.on<{ account: Account; source?: string }>('account:updated', ({ account: next, source }) => {
    updateAccount(next);
    if (source !== 'avatar') toast.success('Profile updated');
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

  socketClient.on<{ channelId: string; reason?: string }>('channel:deleted', ({ channelId, reason }) => {
    if (selectedChannelId.value === channelId) {
      const next = defaultChannelId(channelId);
      rememberSelection(next);
      if (next) api.joinChannel(next);
    }
    toast.info(reason === 'removed' ? 'You were removed from a private channel' : 'Channel was deleted');
  });

  // The channel we just created or joined becomes the selection once the list that contains it arrives.
  const selectWhenListed = (channelId: string) => {
    if (channelsById.value.has(channelId)) {
      selectChannel(channelId);
      return;
    }
    const stop = effect(() => {
      if (!channelsById.value.has(channelId)) return;
      stop();
      selectChannel(channelId);
    });
    window.setTimeout(stop, 5000);
  };

  socketClient.on<{ channelId: string; channelName: string }>('channels:created', ({ channelId, channelName }) => {
    toast.success('#' + channelName + ' created');
    selectWhenListed(channelId);
  });
  socketClient.on<{ channelId: string; channelName: string }>('channels:privateJoined', ({ channelId, channelName }) => {
    toast.success('You joined #' + channelName);
    if (modal.value?.type === 'joinPrivateChannel') closeModal();
    selectWhenListed(channelId);
  });
  socketClient.on<{ channelId: string }>('channels:updated', () => toast.success('Channel settings saved'));
  socketClient.on<{ channelId: string; peerName: string }>('dm:opened', ({ channelId }) => selectWhenListed(channelId));

  socketClient.on<{ channelId: string; permissions: ChannelPermissions }>('channels:permissionsUpdated', (payload) => {
    channelPermissions.value = { ...channelPermissions.value, [payload.channelId]: payload.permissions };
  });

  // ----------------------------------------------------------------- chat

  socketClient.on<ChatMessage>('chat', (message) => {
    appendMessage(message);
    const own = message.accountId && message.accountId === account.value?.id;
    // Our own message came back: its pending copy leaves the list in the same render.
    if (own && message.clientId) outbox.confirm(message.clientId);
    const viewing = selectedChannelId.value === message.channelId && document.visibilityState === 'visible';
    if (own) return;
    if (!viewing) markUnread(message.channelId);
    sounds.play('message', viewing ? 0.25 : 0.4);
    const me = account.value;
    const channel = channelsById.value.get(message.channelId);
    if (channel?.type === 'dm') {
      // Every direct message counts as a mention of its recipient.
      if (!viewing) void notifyDesktop('Message from ' + message.from, message.text);
      return;
    }
    if (me && containsMention(message.text, [me.displayName, me.username])) {
      void notifyDesktop(message.from + ' in #' + (channel?.name ?? 'chat'), message.text);
    }
  });

  socketClient.on<ChatMessage[]>('chat:history', (history) => {
    const channelId = history[0]?.channelId ?? selectedChannelId.value;
    if (channelId) setHistory(channelId, history);
  });

  socketClient.on<{ messageId: string; channelId: string }>('chat:messageDeleted', ({ channelId, messageId }) => {
    removeMessage(channelId, messageId);
  });

  socketClient.on<ReactionEvent>('chat:reaction', (event) => {
    setReactions(event.channelId, event.messageId, event.reactions);
  });

  // ------------------------------------------------------------- presence

  socketClient.on<User[]>('user:update', (list) => {
    users.value = Array.isArray(list) ? list : [];
  });

  // ----------------------------------------------------- generic feedback

  socketClient.on<ServerError | undefined>('error', (payload) => {
    if (!payload || payload.code === 'NOT_AUTHENTICATED') return;
    // The password screen already explains this one.
    if (payload.code === 'PASSWORD_CHANGE_REQUIRED') return;
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
  socketClient.on<{ account: Account }>('admin:accounts:updated', ({ account: next }) => {
    upsertAdminAccount(next);
    toast.success('Renamed to ' + next.displayName);
  });
  socketClient.on<{ account: Account }>('admin:accounts:passwordReset', ({ account: next }) => {
    upsertAdminAccount(next);
    toast.success('Temporary password set for ' + next.displayName + '; they must change it at the next sign-in');
  });
  socketClient.on<{ account: Account }>('admin:accounts:deleted', ({ account: next }) => {
    upsertAdminAccount(next);
    toast.success('Account deleted');
  });
  socketClient.on<{ accountId: string; sessions: AdminSession[] }>('admin:accounts:sessions', (payload) => {
    adminSessions.value = { ...adminSessions.value, [payload.accountId]: payload };
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
  socketClient.on<AdminUsage>('admin:usage', (usage) => {
    adminUsage.value = usage;
  });
  socketClient.on<ServerInfo>('admin:server:info', (info) => {
    adminServerInfo.value = info;
  });
  socketClient.on<{ settings: ServerSettings; saved?: boolean }>('admin:settings', ({ settings, saved }) => {
    adminSettings.value = settings;
    if (saved) toast.success('Server settings saved');
  });
  socketClient.on<{ invites: InviteToken[] }>('admin:invites:list', ({ invites }) => {
    adminInvites.value = invites;
  });
  socketClient.on<{ invite: InviteToken }>('admin:invites:created', ({ invite }) => {
    lastCreatedInvite.value = invite;
    toast.success('Invite created');
  });
  socketClient.on<{ channelId: string; permissions: ChannelPermissions }>('admin:channels:permissions', (payload) => {
    channelPermissions.value = { ...channelPermissions.value, [payload.channelId]: payload.permissions };
  });
  socketClient.on<{ channelId: string; permissions: ChannelPermissions }>('admin:channels:permissionsUpdated', (payload) => {
    channelPermissions.value = { ...channelPermissions.value, [payload.channelId]: payload.permissions };
    toast.success('Channel permissions saved');
  });
  socketClient.on<{ channelId: string; members: ChannelMember[] }>('admin:channels:members', (payload) => {
    channelMembers.value = { ...channelMembers.value, [payload.channelId]: payload.members };
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
