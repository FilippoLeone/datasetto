import { computed, signal } from '@preact/signals';
import { ROLE_ORDER, primaryRole } from '@/lib/format';
import type { User } from '@/types/protocol';

/** Everyone currently connected (one entry per socket). */
export const users = signal<User[]>([]);

export const usersById = computed(() => {
  const map = new Map<string, User>();
  for (const user of users.value) map.set(user.id, user);
  return map;
});

/** Sorted by role, then name; de-duplicated per account for display. */
export const sortedUsers = computed<User[]>(() => {
  const seen = new Set<string>();
  const unique: User[] = [];
  for (const user of users.value) {
    if (seen.has(user.accountId)) continue;
    seen.add(user.accountId);
    unique.push(user);
  }
  return unique.sort((a, b) => {
    const roleDiff = ROLE_ORDER.indexOf(primaryRole(a.roles)) - ROLE_ORDER.indexOf(primaryRole(b.roles));
    if (roleDiff !== 0) return roleDiff;
    return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
  });
});

export const onlineCount = computed(() => sortedUsers.value.length);

export const usersInVoice = (channelId: string): User[] =>
  users.value.filter((user) => user.voiceChannel === channelId);

export const displayNameFor = (socketId: string, fallback = 'Unknown'): string =>
  usersById.value.get(socketId)?.displayName ?? fallback;
