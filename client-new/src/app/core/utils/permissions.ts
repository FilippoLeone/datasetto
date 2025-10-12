/**
 * Permission checking utilities
 */
import { RoleName, RolePermissions, ChannelPermissions, ChannelPermissionAction, User } from '../models';

/**
 * Default permissions for each role
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<RoleName, RolePermissions> = {
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
    canDisableAccounts: false,
  },
  moderator: {
    canCreateChannels: false,
    canDeleteChannels: false,
    canEditChannels: false,
    canManageUsers: false,
    canAssignRoles: false,
    canRegenerateKeys: false,
    canStreamAnywhere: false,
    canModerate: true,
    canViewAllKeys: false,
    canDeleteAnyMessage: true,
    canBanUsers: true,
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

/**
 * Check if user has a specific permission
 */
export function hasPermission(user: User | null, permission: keyof RolePermissions): boolean {
  if (!user) return false;
  if (user.isSuperuser) return true;

  // Check if any of the user's roles grant this permission
  return user.roles.some(role => {
    const rolePerms = DEFAULT_ROLE_PERMISSIONS[role];
    return rolePerms && rolePerms[permission];
  });
}

/**
 * Check if user has any of the specified roles
 */
export function hasRole(user: User | null, roles: RoleName | RoleName[]): boolean {
  if (!user) return false;
  if (user.isSuperuser) return true;

  const roleArray = Array.isArray(roles) ? roles : [roles];
  return user.roles.some(role => roleArray.includes(role));
}

/**
 * Check if user can perform action on a channel based on channel permissions
 */
export function canPerformChannelAction(
  user: User | null,
  action: ChannelPermissionAction,
  channelPermissions?: ChannelPermissions
): boolean {
  if (!user) return false;
  if (user.isSuperuser) return true;

  // If no specific permissions, allow basic actions
  if (!channelPermissions) {
    return action === 'view' || action === 'chat';
  }

  const actionPerms = channelPermissions[action];
  if (!actionPerms) return false;

  // Check if user's role is allowed
  const hasRolePermission = user.roles.some(role => actionPerms.roles.includes(role));
  
  // Check if user's account is explicitly allowed
  const hasAccountPermission = actionPerms.accounts.includes(user.accountId);

  return hasRolePermission || hasAccountPermission;
}

/**
 * Get highest role from user's roles
 */
export function getHighestRole(user: User | null): RoleName | null {
  if (!user) return null;
  if (user.isSuperuser) return 'superuser';

  const roleHierarchy: RoleName[] = ['admin', 'moderator', 'streamer', 'user'];
  
  for (const role of roleHierarchy) {
    if (user.roles.includes(role)) {
      return role;
    }
  }

  return 'user';
}

/**
 * Check if user is admin or higher
 */
export function isAdmin(user: User | null): boolean {
  return hasRole(user, ['superuser', 'admin']);
}

/**
 * Check if user is moderator or higher
 */
export function isModerator(user: User | null): boolean {
  return hasRole(user, ['superuser', 'admin', 'moderator']);
}
