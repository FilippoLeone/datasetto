import { signal } from '@preact/signals';
import type { ChatMessage, User } from '@/types/protocol';

/**
 * Everyone's current profile picture, by account id: the latest the server told us,
 * from messages (`authorAvatarUrl`, `replyTo.avatarUrl`), the online list and
 * `user:avatar` (a picture changed). `null` means "no picture" (the generated avatar).
 *
 * Message rows, conversations, search hits and the mention list look pictures up
 * here by account, so a change shows everywhere at once and old messages never keep
 * a stale picture.
 */
export const knownAvatars = signal<ReadonlyMap<string, string | null>>(new Map());

type Entry = readonly [accountId: string | null | undefined, avatarUrl: string | null | undefined];

/**
 * Record pictures, newest information last. Entries without an account, or without a
 * picture field at all (`undefined`: an older server), are skipped. The map is only
 * replaced when something changed, so the many presence updates do not re-render chat.
 */
export const rememberAvatars = (entries: Iterable<Entry>): void => {
  let next: Map<string, string | null> | null = null;
  // peek: a write from inside an effect must not subscribe it to the map.
  const current = knownAvatars.peek();
  for (const [accountId, avatarUrl] of entries) {
    if (!accountId || avatarUrl === undefined) continue;
    const value = avatarUrl || null;
    const map = next ?? current;
    if (map.has(accountId) && map.get(accountId) === value) continue;
    next ??= new Map(current);
    next.set(accountId, value);
  }
  if (next) knownAvatars.value = next;
};

export const rememberAvatar = (accountId: string | null | undefined, avatarUrl: string | null | undefined): void => rememberAvatars([[accountId, avatarUrl]]);

/** Authors (and quoted authors) of a batch of messages. */
export const rememberMessageAuthors = (list: readonly ChatMessage[]): void => {
  const entries: Entry[] = [];
  for (const message of list) {
    if (message.replyTo) entries.push([message.replyTo.accountId, message.replyTo.avatarUrl]);
    entries.push([message.accountId, message.authorAvatarUrl]);
  }
  rememberAvatars(entries);
};

/** Everyone online, from a presence list (`user:update`). */
export const rememberOnlineAvatars = (list: readonly User[]): void => rememberAvatars(list.map((user) => [user.accountId, user.avatarUrl] as const));

/**
 * The picture to show for an account: what we know now, else the one the payload in
 * hand carried (a search hit, a conversation, a mention candidate). Reading this in a
 * component re-renders it when the picture changes.
 */
export const avatarOf = (accountId: string | null | undefined, fallback?: string | null): string | null => {
  const known = knownAvatars.value;
  if (accountId && known.has(accountId)) return known.get(accountId) ?? null;
  return fallback ?? null;
};
