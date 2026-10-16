import { computed, signal } from '@preact/signals';
import { Storage } from '@/lib/storage';
import { hasPermission, mergeRolePermissions } from '@/lib/permissions';
import type { Account, RolePermissions } from '@/types/protocol';

const AUTH_KEY = 'datasetto.auth.v2';
const LEGACY_AUTH_KEY = 'rtmpdisc.auth.v1';

interface PersistedAuth {
  token: string | null;
  account: Account | null;
}

const loadPersisted = (): PersistedAuth => {
  const current = Storage.get<PersistedAuth | null>(AUTH_KEY, null);
  if (current && typeof current === 'object') return { token: current.token ?? null, account: current.account ?? null };
  // Migrate the previous client's storage so nobody has to log in again.
  const legacy = Storage.get<{ account?: Account | null; session?: { token?: string } | null } | null>(LEGACY_AUTH_KEY, null);
  if (legacy?.session?.token) {
    const migrated = { token: legacy.session.token, account: legacy.account ?? null };
    Storage.set(AUTH_KEY, migrated);
    Storage.remove(LEGACY_AUTH_KEY);
    return migrated;
  }
  return { token: null, account: null };
};

const persisted = loadPersisted();

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';
export type AuthStatus = 'anonymous' | 'resuming' | 'pending' | 'authenticated';

export const account = signal<Account | null>(persisted.account);
export const sessionToken = signal<string | null>(persisted.token);
export const connectionStatus = signal<ConnectionStatus>('connecting');
export const authStatus = signal<AuthStatus>(persisted.token ? 'resuming' : 'anonymous');
export const socketId = signal<string | null>(null);
/** Last auth error shown in the auth dialog. */
export const authError = signal<string | null>(null);

export const permissions = computed<RolePermissions>(() => mergeRolePermissions(account.value?.roles ?? []));
export const isAuthenticated = computed(() => authStatus.value === 'authenticated' && account.value !== null);
export const isSuperuser = computed(() => account.value?.roles.includes('superuser') ?? false);
export const canManage = computed(
  () => hasPermission(permissions.value, 'canManageUsers') || hasPermission(permissions.value, 'canManageChannelPermissions'),
);

export const can = (key: keyof RolePermissions): boolean => hasPermission(permissions.value, key);

const persist = (): void => {
  Storage.set(AUTH_KEY, { token: sessionToken.value, account: account.value } satisfies PersistedAuth);
};

export const setAuthenticated = (nextAccount: Account, token: string): void => {
  account.value = nextAccount;
  sessionToken.value = token;
  authStatus.value = 'authenticated';
  authError.value = null;
  persist();
};

export const updateAccount = (nextAccount: Account): void => {
  account.value = nextAccount;
  persist();
};

/** Forget the session locally (logout, ban, expired token). */
export const clearSession = (): void => {
  account.value = null;
  sessionToken.value = null;
  authStatus.value = 'anonymous';
  Storage.remove(AUTH_KEY);
};
