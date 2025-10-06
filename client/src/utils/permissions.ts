import type { RolePermissions, RoleName } from '@/types';

const BASE_PERMISSIONS: RolePermissions = {
  canCreateChannels: false,
  canDeleteChannels: false,
  canEditChannels: false,
  canManageUsers: false,
  canAssignRoles: false,
  canRegenerateKeys: false,
  canStreamAnywhere: false,
  canModerate: false,
  canViewAllKeys: false,
  canDeleteAnyMessage: false,
  canBanUsers: false,
  canViewLogs: false,
  canManageChannelPermissions: false,
  canDisableAccounts: false,
};

export const ROLE_PERMISSIONS: Record<RoleName, RolePermissions> = {
  superuser: {
    canCreateChannels: true,
    canDeleteChannels: true,
    canEditChannels: true,
    canManageUsers: true,
    canAssignRoles: true,
    canRegenerateKeys: true,
    canStreamAnywhere: true,
    canModerate: true,
    canViewAllKeys: true,
    canDeleteAnyMessage: true,
    canBanUsers: true,
    canViewLogs: true,
    canManageChannelPermissions: true,
    canDisableAccounts: true,
  },
  admin: {
    canCreateChannels: true,
    canDeleteChannels: true,
    canEditChannels: true,
    canManageUsers: true,
    canAssignRoles: true,
    canRegenerateKeys: true,
    canStreamAnywhere: true,
    canModerate: true,
    canViewAllKeys: true,
    canDeleteAnyMessage: true,
    canBanUsers: true,
    canViewLogs: true,
    canManageChannelPermissions: true,
    canDisableAccounts: true,
  },
  moderator: {
    canCreateChannels: true,
    canDeleteChannels: false,
    canEditChannels: false,
    canManageUsers: false,
    canAssignRoles: false,
    canRegenerateKeys: false,
    canStreamAnywhere: false,
    canModerate: true,
    canViewAllKeys: false,
    canDeleteAnyMessage: true,
    canBanUsers: false,
    canViewLogs: false,
    canManageChannelPermissions: false,
    canDisableAccounts: false,
  },
  streamer: {
    canCreateChannels: false,
    canDeleteChannels: false,
    canEditChannels: false,
    canManageUsers: false,
    canAssignRoles: false,
    canRegenerateKeys: false,
    canStreamAnywhere: false,
    canModerate: false,
    canViewAllKeys: false,
    canDeleteAnyMessage: false,
    canBanUsers: false,
    canViewLogs: false,
    canManageChannelPermissions: false,
    canDisableAccounts: false,
  },
  user: {
    canCreateChannels: false,
    canDeleteChannels: false,
    canEditChannels: false,
    canManageUsers: false,
    canAssignRoles: false,
    canRegenerateKeys: false,
    canStreamAnywhere: false,
    canModerate: false,
    canViewAllKeys: false,
    canDeleteAnyMessage: false,
    canBanUsers: false,
    canViewLogs: false,
    canManageChannelPermissions: false,
    canDisableAccounts: false,
  },
};

export function mergeRolePermissions(roles: RoleName[] = []): RolePermissions {
  const accumulator: RolePermissions = { ...BASE_PERMISSIONS };

  roles.forEach((role) => {
    const definition = ROLE_PERMISSIONS[role] ?? BASE_PERMISSIONS;
    (Object.keys(definition) as Array<keyof RolePermissions>).forEach((key) => {
      accumulator[key] = accumulator[key] || definition[key];
    });
  });

  return accumulator;
}

export function hasPermission(permissions: RolePermissions | null | undefined, key: keyof RolePermissions): boolean {
  if (!permissions) {
    return false;
  }
  return Boolean(permissions[key]);
}
