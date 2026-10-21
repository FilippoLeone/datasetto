import { api } from '@/services/socket/api';
import { users } from '@/state/presence';
import { mergeCandidates } from './mentions';
import type { Channel, MentionCandidate } from '@/types/protocol';

/** The server's member list is asked for again after this long. */
const TTL_MS = 60_000;

const cache = new Map<string, { at: number; list: MentionCandidate[] }>();
const inFlight = new Map<string, Promise<MentionCandidate[]>>();

/** Everyone online right now, as candidates (they can be mentioned in any public channel). */
const online = (): MentionCandidate[] =>
  users.value.map((user) => ({ accountId: user.accountId, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl ?? null, roles: user.roles }));

/** Only a public channel is open to whoever is online; a conversation or private channel has a fixed list. */
const openToEveryone = (channel: Channel): boolean => channel.type !== 'dm' && channel.visibility !== 'private';

/** What is known without asking the server: the cached list, plus the people online for a public channel. */
export const knownMentionCandidates = (channel: Channel): MentionCandidate[] => {
  const cached = cache.get(channel.id)?.list ?? [];
  return openToEveryone(channel) ? mergeCandidates(cached, online()) : cached;
};

/**
 * The people who can read the channel: from the server (cached for a minute, one
 * request at a time per channel) merged with whoever is online now for a public
 * channel, so someone who just signed up shows up at once.
 */
export const loadMentionCandidates = async (channel: Channel): Promise<MentionCandidate[]> => {
  const cached = cache.get(channel.id);
  if (!cached || Date.now() - cached.at >= TTL_MS) {
    let pending = inFlight.get(channel.id);
    if (!pending) {
      pending = api
        .listMentionableMembers(channel.id)
        .then((response): MentionCandidate[] => (response.success && response.members ? response.members : []))
        .catch((): MentionCandidate[] => [])
        .finally(() => inFlight.delete(channel.id));
      inFlight.set(channel.id, pending);
    }
    const list: MentionCandidate[] = await pending;
    if (list.length > 0) cache.set(channel.id, { at: Date.now(), list });
  }
  return knownMentionCandidates(channel);
};
