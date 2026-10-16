import { mergeRolePermissions } from '@/lib/permissions';
import type { Account, ChannelPermissionAction, ChannelPermissions, ChannelVisibility } from '@/types/protocol';

export interface AccessContext {
  permissions: ChannelPermissions;
  visibility: ChannelVisibility;
  /** Account ids that are members of a private channel. */
  memberIds: ReadonlySet<string>;
}

/**
 * Mirror of the server's `ChannelService.canAccess`, used for the live
 * "who can…" preview in the permissions editor. Superusers always pass;
 * private channels admit members and admins who manage permissions;
 * then the action's roles (`*` = everyone) or the account overrides apply.
 */
export const accountCanAccess = (account: Pick<Account, 'id' | 'roles' | 'status'>, action: ChannelPermissionAction, context: AccessContext): boolean => {
  if (account.status === 'disabled') return false;
  if (account.roles.includes('superuser')) return true;
  if (context.visibility === 'private') {
    const manages = mergeRolePermissions(account.roles).canManageChannelPermissions;
    if (!manages && !context.memberIds.has(account.id)) return false;
  }
  const entry = context.permissions[action];
  if (!entry) return true;
  if (entry.roles.includes('*')) return true;
  if (account.roles.some((role) => entry.roles.includes(role))) return true;
  return entry.accounts.includes(account.id);
};

/** Accounts allowed to perform `action`, in the order given. */
export const accountsWithAccess = <T extends Pick<Account, 'id' | 'roles' | 'status'>>(accounts: readonly T[], action: ChannelPermissionAction, context: AccessContext): T[] =>
  accounts.filter((account) => accountCanAccess(account, action, context));
