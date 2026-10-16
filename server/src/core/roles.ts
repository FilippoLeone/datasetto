import type { RoleName } from '../types.js';

export type Permission =
  | 'canCreateChannels'
  | 'canDeleteChannels'
  | 'canEditChannels'
  | 'canManageUsers'
  | 'canAssignRoles'
  | 'canRegenerateKeys'
  | 'canStreamAnywhere'
  | 'canModerate'
  | 'canViewAllKeys'
  | 'canDeleteAnyMessage'
  | 'canBanUsers'
  | 'canViewLogs'
  | 'canManageChannelPermissions'
  | 'canDisableAccounts';

export type RoleDefinition = { level: number } & Record<Permission, boolean>;

const allTrue: Record<Permission, boolean> = {
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
};

const allFalse: Record<Permission, boolean> = Object.fromEntries(
  Object.keys(allTrue).map((key) => [key, false]),
) as Record<Permission, boolean>;

export const ROLES: Record<RoleName, RoleDefinition> = {
  superuser: { level: 5, ...allTrue },
  admin: { level: 4, ...allTrue },
  moderator: { level: 3, ...allFalse, canCreateChannels: true, canModerate: true, canDeleteAnyMessage: true },
  streamer: { level: 2, ...allFalse },
  user: { level: 1, ...allFalse },
};

export const ROLE_HIERARCHY: readonly RoleName[] = ['superuser', 'admin', 'moderator', 'streamer', 'user'];

export const isRoleName = (value: unknown): value is RoleName =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(ROLES, value);

/** Lowercase, dedupe and drop unknown roles. Falls back to ['user']. */
export const normalizeRoles = (input: unknown): RoleName[] => {
  const list = Array.isArray(input) ? input : [input];
  const roles = Array.from(
    new Set(
      list
        .filter((role): role is string => typeof role === 'string')
        .map((role) => role.trim().toLowerCase())
        .filter(isRoleName),
    ),
  ) as RoleName[];
  return roles.length > 0 ? roles : ['user'];
};

export const roleLevel = (role: string): number => (isRoleName(role) ? ROLES[role].level : 0);

export const highestRoleLevel = (roles: readonly string[]): number =>
  roles.reduce((max, role) => Math.max(max, roleLevel(role)), 0);

export const highestRole = (roles: readonly string[]): RoleName =>
  ROLE_HIERARCHY.find((role) => roles.includes(role)) ?? 'user';

export const rolesHavePermission = (roles: readonly string[], permission: Permission): boolean =>
  roles.some((role) => isRoleName(role) && ROLES[role][permission]);

export const isSuperuser = (roles: readonly string[]): boolean => roles.includes('superuser');
