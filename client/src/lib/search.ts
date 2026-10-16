import type { SearchResult } from '@/types/protocol';

/** Letters and digits a query must contain before it is sent (the server indexes words only). */
export const MIN_SEARCH_CHARS = 2;

/** Number of letters and digits in a query: what the server can actually match. */
export const searchableLength = (query: string): number => (query.match(/[\p{L}\p{N}]/gu) ?? []).length;

export interface ResultGroup {
  channelId: string;
  results: SearchResult[];
}

/**
 * Group hits by channel, in the order each channel first appears (hits come
 * newest first, so channels with the most recent match come first).
 */
export const groupResultsByChannel = (results: readonly SearchResult[]): ResultGroup[] => {
  const groups: ResultGroup[] = [];
  const byChannel = new Map<string, ResultGroup>();
  for (const result of results) {
    let group = byChannel.get(result.channelId);
    if (!group) {
      group = { channelId: result.channelId, results: [] };
      byChannel.set(result.channelId, group);
      groups.push(group);
    }
    group.results.push(result);
  }
  return groups;
};

/** Position of a result in the grouped order (what the arrow keys walk through). */
export const flattenGroups = (groups: readonly ResultGroup[]): SearchResult[] => groups.flatMap((group) => group.results);
