import { z } from 'zod';
import { ROLES, highestRoleLevel, isRoleName, roleLevel } from '../../core/roles.js';
import { idSchema, permissionsInputSchema } from '../../core/validation.js';
import { AppError, notFound } from '../../errors.js';
import { handle, requirePermission, type SocketContext } from '../context.js';

const rolesSchema = z.object({ accountId: idSchema, roles: z.array(z.string().max(32)).min(1).max(10) });
const accountSchema = z.object({ accountId: idSchema, reason: z.string().max(500).optional().nullable() });
const channelSchema = z.object({ channelId: idSchema });
const channelPermissionsSchema = z.object({ channelId: idSchema, permissions: permissionsInputSchema.nullable().optional() });
const channelMemberSchema = z.object({ channelId: idSchema, accountId: idSchema });

export const registerAdminHandlers = (sctx: SocketContext): void => {
  const { app, socket, io } = sctx;
  const ERR = 'admin:error';

  const notifyAccountSockets = (accountId: string, event: string, build: (socketId: string) => unknown) => {
    for (const socketId of app.presence.getSocketsByAccount(accountId)) {
      io.to(socketId).emit(event, build(socketId));
    }
  };

  handle(sctx, 'admin:accounts:list', { errorEvent: ERR, code: 'ACCOUNTS_LIST_FAILED' }, () => {
    requirePermission(sctx, 'canManageUsers', 'No permission to view accounts');
    socket.emit('admin:accounts:list', { accounts: app.accounts.listPublic() });
  });

  handle(sctx, 'admin:accounts:updateRoles', { schema: rolesSchema, errorEvent: ERR, code: 'ACCOUNTS_UPDATE_FAILED' }, ({ accountId, roles }) => {
    const actor = requirePermission(sctx, 'canAssignRoles', 'No permission to assign roles');
    const requested = Array.from(new Set(roles.map((role) => role.trim().toLowerCase()).filter(isRoleName)));
    if (requested.length === 0) throw new AppError('No valid roles provided', 'INVALID_ROLES', 400);

    const target = app.accounts.getById(accountId);
    if (!target) throw notFound('Account');

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
    const target = app.accounts.getById(accountId);
    if (!target) throw notFound('Account');
    if (target.id === actor.accountId) throw new AppError('You cannot disable your own account', 'FORBIDDEN', 403);
    if (!actor.isSuperuser && highestRoleLevel(target.roles) >= highestRoleLevel(actor.roles)) {
      throw new AppError('You cannot disable an account with equal or higher privileges', 'FORBIDDEN', 403);
    }
    if ((target.roles.includes('admin') || target.roles.includes('superuser')) && app.accounts.countActiveAdmins(accountId) === 0) {
      throw new AppError('Cannot disable the last admin account', 'LAST_ADMIN', 409);
    }

    const disabled = app.accounts.disable(accountId, reason ?? null);
    app.sessions.revokeAll(accountId);
    for (const socketId of app.presence.getSocketsByAccount(accountId)) {
      const targetSocket = io.sockets.sockets.get(socketId);
      if (!targetSocket) continue;
      targetSocket.emit('auth:error', { message: 'Account disabled by administrator', code: 'ACCOUNT_DISABLED' });
      targetSocket.disconnect(true);
    }

    socket.emit('admin:accounts:disabled', { account: disabled });
    app.broadcast.users();
    app.broadcast.channels();
    app.log.warn({ accountId, by: actor.accountId, reason: reason ?? null }, 'account disabled');
  });

  handle(sctx, 'admin:accounts:enable', { schema: accountSchema, errorEvent: ERR, code: 'ACCOUNTS_ENABLE_FAILED' }, ({ accountId }) => {
    const actor = requirePermission(sctx, 'canDisableAccounts', 'No permission to enable accounts');
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

  handle(sctx, 'admin:channels:getPermissions', { schema: channelSchema, errorEvent: ERR, code: 'CHANNEL_PERMISSIONS_FAILED' }, ({ channelId }) => {
    requirePermission(sctx, 'canManageChannelPermissions', 'No permission to view channel permissions');
    socket.emit('admin:channels:permissions', { channelId, permissions: app.channels.getPermissions(channelId) });
  });

  handle(
    sctx,
    'admin:channels:updatePermissions',
    { schema: channelPermissionsSchema, errorEvent: ERR, code: 'CHANNEL_PERMISSIONS_UPDATE_FAILED' },
    ({ channelId, permissions }) => {
      const actor = requirePermission(sctx, 'canManageChannelPermissions', 'No permission to modify channel permissions');
      const updated = app.channels.updatePermissions(channelId, permissions ?? {});
      io.emit('channels:permissionsUpdated', { channelId, permissions: updated });
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
    app.channels.require(channelId);
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

  void ROLES;
};
