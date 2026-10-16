import { z } from 'zod';
import { ROLES, highestRoleLevel, isRoleName, roleLevel } from '../../core/roles.js';
import { idSchema, permissionsInputSchema } from '../../core/validation.js';
import { AppError, notFound } from '../../errors.js';
import { inviteStatus, MAX_INVITE_USES } from '../../services/invites.js';
import { settingsUpdateSchema } from '../../services/settings.js';
import type { InviteTokenRecord } from '../../types.js';
import { handle, requirePermission, type SocketContext } from '../context.js';

const rolesSchema = z.object({ accountId: idSchema, roles: z.array(z.string().max(32)).min(1).max(10) });
const accountSchema = z.object({ accountId: idSchema, reason: z.string().max(500).optional().nullable() });
const channelSchema = z.object({ channelId: idSchema });
const channelPermissionsSchema = z.object({ channelId: idSchema, permissions: permissionsInputSchema.nullable().optional() });
const channelMemberSchema = z.object({ channelId: idSchema, accountId: idSchema });
const inviteCreateSchema = z.object({
  maxUses: z.number().int().min(1).max(MAX_INVITE_USES).optional(),
  /** Absolute expiry (ms since epoch); null or omitted for never. */
  expiresAt: z.number().int().positive().nullable().optional(),
  note: z.string().max(200).nullable().optional(),
});
const inviteIdSchema = z.object({ inviteId: idSchema });
const accountUpdateSchema = z.object({ accountId: idSchema, displayName: z.string().max(50) });
const passwordResetSchema = z.object({ accountId: idSchema, temporaryPassword: z.string().max(128) });
const sessionRevokeSchema = z.object({ accountId: idSchema, sessionId: z.string().max(64).optional().nullable() });

export const registerAdminHandlers = (sctx: SocketContext): void => {
  const { app, socket, io } = sctx;
  const ERR = 'admin:error';

  const notifyAccountSockets = (accountId: string, event: string, build: (socketId: string) => unknown) => {
    for (const socketId of app.presence.getSocketsByAccount(accountId)) {
      io.to(socketId).emit(event, build(socketId));
    }
  };

  /** Disconnect every socket of an account with a reason the client treats as "sign in again". */
  const disconnectAccount = (accountId: string, code: string, message: string) => {
    for (const socketId of app.presence.getSocketsByAccount(accountId)) {
      const targetSocket = io.sockets.sockets.get(socketId);
      if (!targetSocket) continue;
      targetSocket.emit('auth:error', { message, code });
      targetSocket.disconnect(true);
    }
  };

  /** Shared guard for actions on another account: exists, not deleted, not me, not above me. */
  const requireManageableTarget = (actor: { accountId: string; roles: readonly string[]; isSuperuser: boolean }, accountId: string, what: string) => {
    const target = app.accounts.getById(accountId);
    if (!target) throw notFound('Account');
    if (target.status === 'deleted') throw new AppError('This account was deleted', 'ACCOUNT_DELETED', 410);
    if (target.id === actor.accountId) throw new AppError('You cannot ' + what + ' your own account', 'FORBIDDEN', 403);
    if (!actor.isSuperuser && highestRoleLevel(target.roles) >= highestRoleLevel(actor.roles)) {
      throw new AppError('You cannot ' + what + ' an account with equal or higher privileges', 'FORBIDDEN', 403);
    }
    return target;
  };

  handle(sctx, 'admin:accounts:list', { errorEvent: ERR, code: 'ACCOUNTS_LIST_FAILED' }, () => {
    requirePermission(sctx, 'canManageUsers', 'No permission to view accounts');
    socket.emit('admin:accounts:list', { accounts: app.accounts.listPublic() });
  });

  handle(sctx, 'admin:accounts:update', { schema: accountUpdateSchema, errorEvent: ERR, code: 'ACCOUNTS_UPDATE_FAILED' }, ({ accountId, displayName }) => {
    const actor = requirePermission(sctx, 'canManageUsers', 'No permission to edit accounts');
    const target = app.accounts.getById(accountId);
    if (!target) throw notFound('Account');
    if (target.status === 'deleted') throw new AppError('This account was deleted', 'ACCOUNT_DELETED', 410);
    if (target.id !== actor.accountId && !actor.isSuperuser && highestRoleLevel(target.roles) > highestRoleLevel(actor.roles)) {
      throw new AppError('You cannot edit an account with higher privileges than yours', 'FORBIDDEN', 403);
    }
    const updated = app.accounts.updateProfile(accountId, { displayName });
    app.presence.syncAccount(updated);
    if (sctx.account?.id === accountId) {
      sctx.account = updated;
      sctx.user = app.presence.getUser(socket.id);
    }
    notifyAccountSockets(accountId, 'account:updated', (socketId) => ({ account: updated, user: app.presence.exportUser(socketId), source: 'admin' }));
    socket.emit('admin:accounts:updated', { account: updated });
    app.broadcast.users();
    app.log.info({ accountId, by: actor.accountId }, 'account renamed by admin');
  });

  handle(sctx, 'admin:accounts:resetPassword', { schema: passwordResetSchema, errorEvent: ERR, code: 'PASSWORD_RESET_FAILED' }, async ({ accountId, temporaryPassword }) => {
    const actor = requirePermission(sctx, 'canManageUsers', 'No permission to reset passwords');
    requireManageableTarget(actor, accountId, 'reset the password of');
    const updated = await app.accounts.resetPassword(accountId, temporaryPassword);
    app.sessions.revokeAll(accountId);
    disconnectAccount(accountId, 'PASSWORD_RESET', 'An administrator reset your password. Sign in with the temporary password you were given.');
    socket.emit('admin:accounts:passwordReset', { account: updated });
    app.broadcast.users();
    app.log.warn({ accountId, by: actor.accountId }, 'password reset by admin');
  });

  handle(sctx, 'admin:accounts:delete', { schema: accountSchema, errorEvent: ERR, code: 'ACCOUNTS_DELETE_FAILED' }, ({ accountId }) => {
    const actor = requirePermission(sctx, 'canDisableAccounts', 'No permission to delete accounts');
    const target = requireManageableTarget(actor, accountId, 'delete');
    if ((target.roles.includes('admin') || target.roles.includes('superuser')) && app.accounts.countActiveAdmins(accountId) === 0) {
      throw new AppError('Cannot delete the last admin account', 'LAST_ADMIN', 409);
    }
    const deleted = app.accounts.softDelete(accountId);
    app.sessions.revokeAll(accountId);
    app.avatars.remove(accountId);
    app.channels.removeMemberEverywhere(accountId);
    app.moderation.unban(accountId);
    disconnectAccount(accountId, 'ACCOUNT_DELETED', 'This account was deleted by an administrator');
    socket.emit('admin:accounts:deleted', { account: deleted });
    app.broadcast.users();
    app.broadcast.channels();
    app.log.warn({ accountId, by: actor.accountId }, 'account deleted (soft)');
  });

  // ------------------------------------------------------------- sessions

  const sessionsPayload = (accountId: string) => {
    const online = new Set<string>();
    for (const socketId of app.presence.getSocketsByAccount(accountId)) {
      const hash = (io.sockets.sockets.get(socketId)?.data.ctx as SocketContext | undefined)?.sessionTokenHash;
      if (hash) online.add(hash);
    }
    return {
      accountId,
      sessions: app.sessions.listForAccount(accountId).map((session) => ({
        // The hash itself never leaves the server; a prefix is enough to address a session.
        id: session.tokenHash.slice(0, 16),
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        userAgent: session.userAgent,
        ip: session.ip,
        online: online.has(session.tokenHash),
        current: session.tokenHash === sctx.sessionTokenHash,
      })),
    };
  };

  handle(sctx, 'admin:accounts:sessions:list', { schema: accountSchema, errorEvent: ERR, code: 'SESSIONS_LIST_FAILED' }, ({ accountId }) => {
    requirePermission(sctx, 'canManageUsers', 'No permission to view sessions');
    app.accounts.requireById(accountId);
    socket.emit('admin:accounts:sessions', sessionsPayload(accountId));
  });

  handle(sctx, 'admin:accounts:sessions:revoke', { schema: sessionRevokeSchema, errorEvent: ERR, code: 'SESSIONS_REVOKE_FAILED' }, ({ accountId, sessionId }) => {
    const actor = requirePermission(sctx, 'canManageUsers', 'No permission to revoke sessions');
    const target = app.accounts.getById(accountId);
    if (!target) throw notFound('Account');
    if (target.id !== actor.accountId && !actor.isSuperuser && highestRoleLevel(target.roles) >= highestRoleLevel(actor.roles)) {
      throw new AppError('You cannot sign out an account with equal or higher privileges', 'FORBIDDEN', 403);
    }
    const hashes = app.sessions
      .listForAccount(accountId)
      .map((session) => session.tokenHash)
      .filter((hash) => !sessionId || hash.startsWith(sessionId));
    if (sessionId && hashes.length === 0) throw notFound('Session');
    for (const hash of hashes) {
      if (hash === sctx.sessionTokenHash) continue; // never cut the branch you sit on
      app.sessions.revokeByHash(hash);
      for (const socketId of app.presence.getSocketsByAccount(accountId)) {
        const targetSocket = io.sockets.sockets.get(socketId);
        const targetCtx = targetSocket?.data.ctx as SocketContext | undefined;
        if (!targetSocket || targetCtx?.sessionTokenHash !== hash) continue;
        targetSocket.emit('auth:error', { message: 'This session was signed out by an administrator', code: 'SESSION_REVOKED' });
        targetSocket.disconnect(true);
      }
    }
    socket.emit('admin:accounts:sessions', sessionsPayload(accountId));
    app.log.info({ accountId, revoked: hashes.length, by: actor.accountId }, 'sessions revoked by admin');
  });

  handle(sctx, 'admin:accounts:updateRoles', { schema: rolesSchema, errorEvent: ERR, code: 'ACCOUNTS_UPDATE_FAILED' }, ({ accountId, roles }) => {
    const actor = requirePermission(sctx, 'canAssignRoles', 'No permission to assign roles');
    const requested = Array.from(new Set(roles.map((role) => role.trim().toLowerCase()).filter(isRoleName)));
    if (requested.length === 0) throw new AppError('No valid roles provided', 'INVALID_ROLES', 400);

    const target = app.accounts.getById(accountId);
    if (!target) throw notFound('Account');
    if (target.status === 'deleted') throw new AppError('This account was deleted', 'ACCOUNT_DELETED', 410);

    if (!actor.isSuperuser) {
      const actorLevel = highestRoleLevel(actor.roles);
      if (highestRoleLevel(target.roles) > actorLevel) {
        throw new AppError('You cannot modify an account with higher privileges than yours', 'FORBIDDEN', 403);
      }
      for (const role of requested) {
        if (roleLevel(role) > actorLevel) {
          throw new AppError("You cannot assign the role '" + role + "' which is higher than your own", 'FORBIDDEN', 403);
        }
      }
      if (requested.includes('superuser')) throw new AppError('Only superusers can grant superuser', 'FORBIDDEN', 403);
    }

    const keepsAdmin = requested.includes('admin') || requested.includes('superuser');
    if (!keepsAdmin && app.accounts.countActiveAdmins(accountId) === 0) {
      throw new AppError('At least one admin account is required', 'LAST_ADMIN', 409);
    }

    const updated = app.accounts.assignRoles(accountId, requested);
    app.presence.syncAccount(updated);
    if (sctx.account?.id === accountId) {
      sctx.account = updated;
      sctx.user = app.presence.getUser(socket.id);
    }

    notifyAccountSockets(accountId, 'account:rolesUpdated', (socketId) => ({
      account: updated,
      user: app.presence.exportUser(socketId),
    }));
    socket.emit('admin:accounts:rolesUpdated', { account: updated });
    app.broadcast.users();
    app.log.info({ accountId, roles: requested, by: actor.accountId }, 'roles updated');
  });

  handle(sctx, 'admin:accounts:disable', { schema: accountSchema, errorEvent: ERR, code: 'ACCOUNTS_DISABLE_FAILED' }, ({ accountId, reason }) => {
    const actor = requirePermission(sctx, 'canDisableAccounts', 'No permission to disable accounts');
    const target = requireManageableTarget(actor, accountId, 'disable');
    if ((target.roles.includes('admin') || target.roles.includes('superuser')) && app.accounts.countActiveAdmins(accountId) === 0) {
      throw new AppError('Cannot disable the last admin account', 'LAST_ADMIN', 409);
    }

    const disabled = app.accounts.disable(accountId, reason ?? null);
    app.sessions.revokeAll(accountId);
    disconnectAccount(accountId, 'ACCOUNT_DISABLED', 'Account disabled by administrator');

    socket.emit('admin:accounts:disabled', { account: disabled });
    app.broadcast.users();
    app.broadcast.channels();
    app.log.warn({ accountId, by: actor.accountId, reason: reason ?? null }, 'account disabled');
  });

  handle(sctx, 'admin:accounts:enable', { schema: accountSchema, errorEvent: ERR, code: 'ACCOUNTS_ENABLE_FAILED' }, ({ accountId }) => {
    const actor = requirePermission(sctx, 'canDisableAccounts', 'No permission to enable accounts');
    if (app.accounts.getById(accountId)?.status === 'deleted') throw new AppError('This account was deleted', 'ACCOUNT_DELETED', 410);
    const enabled = app.accounts.enable(accountId);
    socket.emit('admin:accounts:enabled', { account: enabled });
    app.log.info({ accountId, by: actor.accountId }, 'account enabled');
  });

  handle(sctx, 'admin:accounts:unban', { schema: accountSchema, errorEvent: ERR, code: 'ACCOUNTS_UNBAN_FAILED' }, ({ accountId }) => {
    const actor = requirePermission(sctx, 'canBanUsers', 'No permission to manage bans');
    app.moderation.unban(accountId);
    socket.emit('admin:accounts:unbanned', { accountId });
    app.log.info({ accountId, by: actor.accountId }, 'account unbanned');
  });

  handle(sctx, 'admin:bans:list', { errorEvent: ERR, code: 'BANS_LIST_FAILED' }, () => {
    requirePermission(sctx, 'canBanUsers', 'No permission to view bans');
    socket.emit('admin:bans:list', { bans: app.moderation.listBans() });
  });

  /** Admin tools never touch direct messages. */
  const requireRegularChannel = (channelId: string) => {
    const channel = app.channels.require(channelId);
    if (channel.type === 'dm') throw new AppError('Direct messages cannot be managed', 'DM_IMMUTABLE', 400);
    return channel;
  };

  handle(sctx, 'admin:channels:getPermissions', { schema: channelSchema, errorEvent: ERR, code: 'CHANNEL_PERMISSIONS_FAILED' }, ({ channelId }) => {
    requirePermission(sctx, 'canManageChannelPermissions', 'No permission to view channel permissions');
    requireRegularChannel(channelId);
    socket.emit('admin:channels:permissions', { channelId, permissions: app.channels.getPermissions(channelId) });
  });

  handle(
    sctx,
    'admin:channels:updatePermissions',
    { schema: channelPermissionsSchema, errorEvent: ERR, code: 'CHANNEL_PERMISSIONS_UPDATE_FAILED' },
    ({ channelId, permissions }) => {
      const actor = requirePermission(sctx, 'canManageChannelPermissions', 'No permission to modify channel permissions');
      requireRegularChannel(channelId);
      const updated = app.channels.updatePermissions(channelId, permissions ?? {});
      // Only people who can see the channel learn about its permissions.
      app.broadcast.toChannelViewers(channelId, 'channels:permissionsUpdated', { channelId, permissions: updated });
      socket.emit('admin:channels:permissionsUpdated', { channelId, permissions: updated });
      app.broadcast.channels();
      app.log.info({ channelId, by: actor.accountId }, 'channel permissions updated');
    },
  );

  // ------------------------------------------------- private channel members

  const membersPayload = (channelId: string) => ({
    channelId,
    members: app.channels.listMembers(channelId).map((member) => {
      const account = app.accounts.getById(member.accountId);
      return {
        accountId: member.accountId,
        username: account?.username ?? null,
        displayName: account?.displayName ?? member.accountId,
        avatarUrl: account?.avatarUrl ?? null,
        addedBy: member.addedBy,
        joinedAt: member.joinedAt,
      };
    }),
  });

  handle(sctx, 'admin:channels:members:list', { schema: channelSchema, errorEvent: ERR, code: 'CHANNEL_MEMBERS_FAILED' }, ({ channelId }) => {
    requirePermission(sctx, 'canManageChannelPermissions', 'No permission to view channel members');
    requireRegularChannel(channelId);
    socket.emit('admin:channels:members', membersPayload(channelId));
  });

  handle(sctx, 'admin:channels:members:add', { schema: channelMemberSchema, errorEvent: ERR, code: 'CHANNEL_MEMBERS_FAILED' }, ({ channelId, accountId }) => {
    const actor = requirePermission(sctx, 'canManageChannelPermissions', 'No permission to manage channel members');
    const target = app.accounts.getById(accountId);
    if (!target) throw notFound('Account');
    app.channels.addMember(channelId, accountId, actor.accountId);
    socket.emit('admin:channels:members', membersPayload(channelId));
    app.broadcast.channels();
    app.log.info({ channelId, accountId, by: actor.accountId }, 'channel member added');
  });

  handle(sctx, 'admin:channels:members:remove', { schema: channelMemberSchema, errorEvent: ERR, code: 'CHANNEL_MEMBERS_FAILED' }, ({ channelId, accountId }) => {
    const actor = requirePermission(sctx, 'canManageChannelPermissions', 'No permission to manage channel members');
    const channel = app.channels.require(channelId);
    app.channels.removeMember(channelId, accountId);
    // A removed member who had the channel open is moved out of it.
    for (const socketId of app.presence.getSocketsByAccount(accountId)) {
      const targetSocket = io.sockets.sockets.get(socketId);
      const targetCtx = targetSocket?.data.ctx as SocketContext | undefined;
      if (!targetSocket || !targetCtx?.user || app.channels.canAccess(channel, targetCtx.user, 'view')) continue;
      targetSocket.emit('channel:deleted', { channelId: channel.id, reason: 'removed' });
      if (targetCtx.currentChannel === channel.id) {
        app.presence.leaveChannel(socketId, channel.id);
        targetCtx.currentChannel = null;
        if (targetCtx.voiceChannel !== channel.id) void targetSocket.leave(channel.id);
      }
    }
    socket.emit('admin:channels:members', membersPayload(channelId));
    app.broadcast.channels();
    app.broadcast.users();
    app.log.info({ channelId, accountId, by: actor.accountId }, 'channel member removed');
  });

  // -------------------------------------------------------------- settings

  handle(sctx, 'admin:settings:get', { errorEvent: ERR, code: 'SETTINGS_FAILED' }, () => {
    requirePermission(sctx, 'canManageChannelPermissions', 'No permission to view server settings');
    socket.emit('admin:settings', { settings: app.settings.all() });
  });

  handle(sctx, 'admin:settings:update', { schema: settingsUpdateSchema, errorEvent: ERR, code: 'SETTINGS_UPDATE_FAILED' }, (payload) => {
    const actor = requirePermission(sctx, 'canManageChannelPermissions', 'No permission to change server settings');
    const settings = app.settings.update(payload, actor.accountId);
    socket.emit('admin:settings', { settings, saved: true });
    app.log.info({ keys: Object.keys(payload), by: actor.accountId }, 'settings updated');
  });

  // --------------------------------------------------------------- invites

  const inviteView = (invite: InviteTokenRecord) => {
    const creator = invite.createdBy ? app.accounts.getById(invite.createdBy) : null;
    return {
      ...invite,
      status: inviteStatus(invite),
      createdByName: creator?.displayName ?? null,
      redeemedBy: app.invites.redeemedBy(invite.id),
    };
  };

  const emitInvites = () => socket.emit('admin:invites:list', { invites: app.invites.list().map(inviteView) });

  handle(sctx, 'admin:invites:list', { errorEvent: ERR, code: 'INVITES_LIST_FAILED' }, () => {
    requirePermission(sctx, 'canManageUsers', 'No permission to manage invites');
    emitInvites();
  });

  handle(sctx, 'admin:invites:create', { schema: inviteCreateSchema, errorEvent: ERR, code: 'INVITE_CREATE_FAILED' }, (payload) => {
    const actor = requirePermission(sctx, 'canManageUsers', 'No permission to create invites');
    const invite = app.invites.create({
      createdBy: actor.accountId,
      note: payload.note ?? null,
      maxUses: payload.maxUses ?? 1,
      expiresAt: payload.expiresAt ?? null,
    });
    socket.emit('admin:invites:created', { invite: inviteView(invite) });
    emitInvites();
    app.log.info({ inviteId: invite.id, maxUses: invite.maxUses, expiresAt: invite.expiresAt, by: actor.accountId }, 'invite created');
  });

  handle(sctx, 'admin:invites:revoke', { schema: inviteIdSchema, errorEvent: ERR, code: 'INVITE_REVOKE_FAILED' }, ({ inviteId }) => {
    const actor = requirePermission(sctx, 'canManageUsers', 'No permission to manage invites');
    app.invites.revoke(inviteId);
    emitInvites();
    app.log.info({ inviteId, by: actor.accountId }, 'invite revoked');
  });

  handle(sctx, 'admin:invites:delete', { schema: inviteIdSchema, errorEvent: ERR, code: 'INVITE_DELETE_FAILED' }, ({ inviteId }) => {
    const actor = requirePermission(sctx, 'canManageUsers', 'No permission to manage invites');
    if (!app.invites.delete(inviteId)) throw notFound('Invite');
    emitInvites();
    app.log.info({ inviteId, by: actor.accountId }, 'invite deleted');
  });

  void ROLES;
};
