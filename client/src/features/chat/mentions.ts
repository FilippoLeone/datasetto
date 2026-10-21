/**
 * The composer's @mention autocomplete: finding the mention being typed at the
 * caret, ranking the people who can read the channel against it, and inserting
 * the chosen name. Pure functions; MentionAutocomplete.tsx draws the list.
 */
import type { MentionCandidate } from '@/types/protocol';

/** The partial mention at the caret: where the @ is and what follows it. */
export interface MentionQuery {
  /** Index of the @ in the text. */
  start: number;
  /** Index of the caret (end of the query). */
  end: number;
  /** What was typed after the @. */
  query: string;
}

/** Names longer than this are not what the user is typing a mention for. */
const MAX_QUERY_LENGTH = 50;
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * The mention being typed at `caret`, or null. The @ must start a word (so
 * addresses are not mentions), the query runs to the caret and may hold one
 * space (display names often do), but no newline.
 */
export const mentionQueryAt = (text: string, caret: number): MentionQuery | null => {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  if (at > 0 && WORD_CHAR.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > MAX_QUERY_LENGTH || query.includes('\n')) return null;
  // "@a b c" has gone past a name with one space in it; "@ x" never started one.
  if (query.startsWith(' ') || (query.match(/ /g) ?? []).length > 1) return null;
  return { start: at, end: caret, query };
};

const fold = (value: string): string => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Candidates matching the query, best first: display names that start with it,
 * then usernames that start with it, then names that contain it; ties by name.
 * An empty query lists everyone. At most `limit` entries.
 */
export const rankMentionCandidates = (candidates: readonly MentionCandidate[], query: string, limit = 8): MentionCandidate[] => {
  const needle = fold(query.trim());
  const scored: Array<{ candidate: MentionCandidate; score: number }> = [];
  for (const candidate of candidates) {
    const name = fold(candidate.displayName);
    const username = fold(candidate.username);
    let score: number;
    if (!needle) score = 0;
    else if (name.startsWith(needle)) score = 0;
    else if (username.startsWith(needle)) score = 1;
    else if (name.split(/\s+/).some((word) => word.startsWith(needle))) score = 2;
    else if (name.includes(needle) || username.includes(needle)) score = 3;
    else continue;
    scored.push({ candidate, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.candidate.displayName.localeCompare(b.candidate.displayName, undefined, { sensitivity: 'base' }))
    .slice(0, limit)
    .map((entry) => entry.candidate);
};

/** The text with the mention at `query` replaced by "@Name " and where the caret lands. */
export const insertMention = (text: string, query: MentionQuery, candidate: MentionCandidate): { text: string; caret: number } => {
  const mention = '@' + candidate.displayName + ' ';
  const next = text.slice(0, query.start) + mention + text.slice(query.end);
  return { text: next, caret: query.start + mention.length };
};

/** Merge the server's list with the people online (who may have joined since), de-duplicated by account. */
export const mergeCandidates = (...lists: Array<readonly MentionCandidate[]>): MentionCandidate[] => {
  const byId = new Map<string, MentionCandidate>();
  for (const list of lists) for (const candidate of list) if (!byId.has(candidate.accountId)) byId.set(candidate.accountId, candidate);
  return Array.from(byId.values());
};
