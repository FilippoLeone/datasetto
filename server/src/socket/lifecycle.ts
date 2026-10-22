import type { SocketContext } from './context.js';
import type { Arcade } from '../arcade/index.js';

/**
 * Remove a socket from its voice room, notifying peers and the Arcade (which starts that
 * account's seat grace rules). Shared by voice:leave, voice:join (room switch), kicks and disconnect.
 */
export const leaveVoiceRoom = (sctx: SocketContext, arcade: Arcade): string | null => {
  const { app, socket } = sctx;
  const channelId = app.presence.leaveVoice(socket.id) ?? sctx.voiceChannel;
  sctx.voiceChannel = null;
  if (!channelId) return null;

  // While the process shuts down every socket goes within milliseconds; a "left" here would make
  // the peers still connected drop their media connection to someone who is only reconnecting.
  if (!app.runtime.shuttingDown) {
    socket.to(channelId).emit('voice:peer-leave', { id: socket.id, accountId: sctx.user?.accountId ?? null, reason: 'left' });
  }
  if (sctx.currentChannel !== channelId) {
    void socket.leave(channelId);
  }
  if (sctx.user) arcade.onVoiceLeft(sctx.user.accountId, channelId);
  return channelId;
};

/** Stop hosting / viewing screenshares this socket is involved in. */
export const leaveScreenshares = (sctx: SocketContext): void => {
  const { app, socket } = sctx;
  const { hosting, viewing } = app.presence.screensharesInvolving(socket.id);

  // While the process shuts down nothing is broadcast: the presenter and the viewers keep
  // their media connections and put the room back together on the next process.
  for (const channelId of hosting) {
    app.presence.stopScreenshare(channelId);
    // The host's socket went away (maybe only for a moment): viewers keep the picture and wait a while.
    if (!app.runtime.shuttingDown) app.broadcast.screenshare(channelId, null, { endedBy: 'disconnect' });
  }
  for (const channelId of viewing) {
    app.presence.removeScreenshareViewer(channelId, socket.id);
    if (!app.runtime.shuttingDown) app.broadcast.screenshare(channelId);
  }
  sctx.screenshareHosting = null;
  sctx.screenshareViewing = null;
};

/**
 * Forget everything about the authenticated user behind this socket. Used on
 * disconnect, logout and when a socket re-authenticates as another account.
 */
export const teardownSocket = (sctx: SocketContext, arcade: Arcade): void => {
  const { app, socket } = sctx;
  if (!sctx.user) return;

  if (sctx.currentChannel) {
    app.presence.leaveChannel(socket.id, sctx.currentChannel);
    sctx.currentChannel = null;
  }
  leaveVoiceRoom(sctx, arcade);
  leaveScreenshares(sctx);
  arcade.onSocketGone(sctx);

  app.presence.removeUser(socket.id);
  app.accounts.touchLastSeen(sctx.user.accountId);
  sctx.user = null;
  sctx.account = null;
  sctx.sessionToken = null;
  sctx.sessionTokenHash = null;

  if (app.runtime.shuttingDown) return;
  app.broadcast.users();
  app.broadcast.channels();
};
