import { z } from 'zod';
import { highestRoleLevel } from '../../core/roles.js';
import { idSchema } from '../../core/validation.js';
import { AppError, forbidden, notFound } from '../../errors.js';
import type { ConnectedUser } from '../../types.js';
import { handle, requirePermission, requireUser, type SocketContext } from '../context.js';
import { leaveVoiceRoom } from '../lifecycle.js';
import type { Minigames } from './minigame.js';

/**
 * `voice:join` takes the channel id, or an object with the client's media session
 * id (see VoiceParticipant.rtcSessionId) so peers can keep their connections
 * across the client's reconnect.
 */
const joinSchema = z.union([
  idSchema,
  z.object({
    channelId: idSchema,
    rtcSessionId: z.string().min(1).max(64).optional().nullable(),
    /** Peer connections the client still holds (account + their media session id), relayed in `voice:peer-join`. */
    holding: z.array(z.object({ accountId: z.string().max(128), rtcSessionId: z.string().max(64).nullable() })).max(64).optional(),
  }),
]);
const signalSchema = z.object({ to: idSchema, data: z.unknown().optional() });
const metadataSchema = z.object({ to: idSchema, metadata: z.unknown().optional() });
const stateSchema = z.object({ muted: z.boolean().optional(), deafened: z.boolean().optional() }).partial();
const videoStateSchema = z.object({ type: z.enum(['camera', 'screen']).optional(), enabled: z.boolean().optional() });
const targetSchema = z.object({
  targetSocketId: idSchema,
  targetName: z.string().max(100).optional(),
  duration: z.number().optional(),
  reason: z.string().max(500).optional(),
});

/** May `actor` moderate `target`? Never superusers; otherwise strictly higher role. */
export const canModerateTarget = (actor: ConnectedUser, target: ConnectedUser): boolean => {
  if (actor.id === target.id) return false;
  if (target.isSuperuser) return false;
  if (actor.isSuperuser) return true;
  return highestRoleLevel(actor.roles) > highestRoleLevel(target.roles);
};

export const registerVoiceHandlers = (sctx: SocketContext, minigames: Minigames): void => {
  const { app, socket, io } = sctx;

  const requireSameVoiceTarget = (targetSocketId: string): ConnectedUser => {
    if (!sctx.voiceChannel) throw new AppError('Not in a voice channel', 'NOT_IN_VOICE', 400);
    const target = app.presence.getUser(targetSocketId);
    if (!target) throw notFound('Target user');
    if (target.voiceChannel !== sctx.voiceChannel) {
      throw new AppError('Target user is not in your voice channel', 'TARGET_NOT_IN_VOICE', 400);
    }
    return target;
  };

  const forceLeaveVoice = (targetSocketId: string, channelId: string, reason: 'left' | 'replaced' = 'left') => {
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    const accountId = app.presence.getUser(targetSocketId)?.accountId ?? null;
    app.presence.leaveVoice(targetSocketId);
    io.to(channelId).emit('voice:peer-leave', { id: targetSocketId, accountId, reason });
    minigames.handleVoiceMemberLeft(channelId, targetSocketId);
    if (targetSocket) {
      const targetUser = app.presence.getUser(targetSocketId);
      if (targetUser?.currentChannel !== channelId) void targetSocket.leave(channelId);
      const targetCtx = (targetSocket.data as { ctx?: SocketContext }).ctx;
      if (targetCtx) targetCtx.voiceChannel = null;
    }
  };

  handle(sctx, 'voice:join', { schema: joinSchema, code: 'VOICE_JOIN_FAILED' }, async (payload) => {
    const user = requireUser(sctx);
    const channelId = typeof payload === 'string' ? payload : payload.channelId;
    const rtcSessionId = typeof payload === 'string' ? null : (payload.rtcSessionId ?? null);
    const holding = typeof payload === 'string' ? undefined : payload.holding;

    const timeout = app.moderation.voiceTimeoutRemaining(user.accountId);
    if (timeout > 0) {
      const minutes = Math.ceil(timeout / 60_000);
      throw new AppError('You are timed out from voice for ' + minutes + ' more minute(s)', 'VOICE_TIMED_OUT', 403);
    }

    const channel = app.channels.get(channelId);
    if (!channel || channel.type !== 'voice') throw new AppError('Invalid voice channel', 'INVALID_VOICE_CHANNEL', 400);
    app.channels.requireAccess(channel, user, 'voice', 'No permission to join this voice channel');

    if (sctx.voiceChannel && sctx.voiceChannel !== channel.id) {
      leaveVoiceRoom(sctx, minigames);
    }

    // A reconnect's previous socket (not yet timed out) or a second tab of the same login
    // still holds a seat in this room: this socket takes it over. Peers are told it was
    // replaced, not that the person left, so they keep their media connection to them.
    for (const staleId of app.presence.voiceSeatsOfAccount(channel.id, user.accountId, socket.id)) {
      forceLeaveVoice(staleId, channel.id, 'replaced');
      io.to(staleId).emit('voice:replaced', { channelId: channel.id, bySocketId: socket.id });
      app.log.debug({ accountId: user.accountId, staleSocketId: staleId, socketId: socket.id, channelId: channel.id }, 'voice seat taken over');
    }

    const participant = app.presence.joinVoice(socket.id, channel.id, rtcSessionId);
    if (!participant) throw new AppError('Failed to join voice session', 'VOICE_JOIN_FAILED', 500);
    await socket.join(channel.id);
    sctx.voiceChannel = channel.id;

    // `holding` lets each existing member see whether the newcomer still has a connection to it
    // (keep it) or lost it (negotiate afresh), without an extra round trip.
    socket.to(channel.id).emit('voice:peer-join', {
      id: socket.id,
      accountId: participant.accountId,
      name: participant.name,
      muted: participant.muted,
      deafened: participant.deafened,
      rtcSessionId: participant.rtcSessionId,
      ...(holding ? { holding } : {}),
    });

    const room = app.presence.voiceRoom(channel.id);
    socket.emit('voice:joined', {
      channelId: channel.id,
      peers: app.presence.voicePeers(channel.id, socket.id),
      startedAt: room?.startedAt ?? null,
      sessionId: room?.sessionId ?? null,
    });

    const gameState = minigames.getState(channel.id);
    if (gameState) socket.emit('voice:game:state', gameState);

    app.broadcast.users();
    app.broadcast.channels();
  });

  handle(sctx, 'voice:leave', { code: 'VOICE_LEAVE_FAILED' }, () => {
    if (!sctx.voiceChannel) return;
    leaveVoiceRoom(sctx, minigames);
    app.broadcast.users();
    app.broadcast.channels();
  });

  handle(sctx, 'voice:signal', { schema: signalSchema, code: 'VOICE_SIGNAL_FAILED', limiter: 'signal' }, ({ to, data }) => {
    if (!sctx.voiceChannel || data === undefined) return;
    const target = app.presence.getUser(to);
    if (!target || target.voiceChannel !== sctx.voiceChannel) {
      app.log.debug({ from: socket.id, to }, 'dropped cross-channel voice signal');
      return;
    }
    socket.to(to).emit('voice:signal', { from: socket.id, data });
  });

  handle(sctx, 'voice:stream-metadata', { schema: metadataSchema, code: 'VOICE_SIGNAL_FAILED', limiter: 'signal' }, ({ to, metadata }) => {
    if (!sctx.voiceChannel) return;
    const target = app.presence.getUser(to);
    if (!target || target.voiceChannel !== sctx.voiceChannel) return;
    socket.to(to).emit('voice:stream-metadata', { from: socket.id, metadata });
  });

  handle(sctx, 'voice:state', { schema: stateSchema, code: 'VOICE_STATE_FAILED', limiter: 'signal' }, (payload) => {
    if (!sctx.voiceChannel) return;
    const state = { muted: Boolean(payload.muted), deafened: Boolean(payload.deafened) };
    app.presence.updateVoiceState(socket.id, state);
    socket.to(sctx.voiceChannel).emit('voice:state', { id: socket.id, ...state });
  });

  handle(sctx, 'voice:video:state', { schema: videoStateSchema, code: 'VOICE_STATE_FAILED', limiter: 'signal' }, (payload) => {
    if (!sctx.voiceChannel) return;
    socket.to(sctx.voiceChannel).emit('voice:video:state', {
      id: socket.id,
      type: payload.type === 'screen' ? 'screen' : 'camera',
      enabled: Boolean(payload.enabled),
    });
  });

  handle(sctx, 'voice:kick', { schema: targetSchema, code: 'VOICE_KICK_FAILED' }, ({ targetSocketId, targetName }) => {
    const actor = requirePermission(sctx, 'canModerate', 'No permission to kick users');
    const target = requireSameVoiceTarget(targetSocketId);
    if (!canModerateTarget(actor, target)) throw forbidden('You cannot kick this user');

    const channelId = sctx.voiceChannel as string;
    forceLeaveVoice(targetSocketId, channelId);
    io.to(targetSocketId).emit('voice:kicked', { by: actor.displayName, reason: 'You were kicked from the voice channel' });

    app.broadcast.users();
    app.broadcast.channels();
    app.log.info({ target: target.accountId, targetName, by: actor.accountId, channelId }, 'voice kick');
  });

  handle(sctx, 'voice:timeout', { schema: targetSchema, code: 'VOICE_TIMEOUT_FAILED' }, ({ targetSocketId, targetName, duration }) => {
    const actor = requirePermission(sctx, 'canModerate', 'No permission to timeout users');
    const target = requireSameVoiceTarget(targetSocketId);
    if (!canModerateTarget(actor, target)) throw forbidden('You cannot timeout this user');

    const channelId = sctx.voiceChannel as string;
    const applied = app.moderation.setVoiceTimeout(target.accountId, typeof duration === 'number' ? duration : 60_000);
    forceLeaveVoice(targetSocketId, channelId);

    const minutes = Math.ceil(applied / 60_000);
    io.to(targetSocketId).emit('voice:timeout', {
      by: actor.displayName,
      duration: applied,
      reason: 'You have been timed out from voice for ' + minutes + ' minute(s)',
    });

    app.broadcast.users();
    app.broadcast.channels();
    app.log.info({ target: target.accountId, targetName, by: actor.accountId, channelId, duration: applied }, 'voice timeout');
  });

  handle(sctx, 'user:ban', { schema: targetSchema, code: 'USER_BAN_FAILED' }, ({ targetSocketId, targetName, reason }) => {
    const actor = requirePermission(sctx, 'canBanUsers', 'No permission to ban users');
    const target = app.presence.getUser(targetSocketId);
    if (!target) throw notFound('Target user');
    if (!canModerateTarget(actor, target)) throw forbidden('You cannot ban this user');

    const safeReason = reason?.trim() || 'Banned by moderator';
    app.moderation.ban(target.accountId, safeReason, actor.displayName);
    app.sessions.revokeAll(target.accountId);

    for (const socketId of app.presence.getSocketsByAccount(target.accountId)) {
      const targetSocket = io.sockets.sockets.get(socketId);
      if (!targetSocket) continue;
      targetSocket.emit('user:banned', { by: actor.displayName, reason: safeReason });
      targetSocket.disconnect(true);
    }

    socket.emit('moderation:success', {
      action: 'ban',
      target: targetName ?? target.displayName,
      message: (targetName ?? target.displayName) + ' has been banned',
    });
    app.log.warn({ target: target.accountId, targetName, by: actor.accountId, reason: safeReason }, 'user banned');
  });

};
