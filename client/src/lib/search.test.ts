import { describe, expect, it } from 'vitest';
import { flattenGroups, groupResultsByChannel, searchableLength } from './search';
import type { SearchResult } from '@/types/protocol';

const hit = (id: string, channelId: string): SearchResult => ({
  id,
  channelId,
  channelName: channelId,
  channelType: 'text',
  authorId: 'a',
  authorName: 'A',
  authorAvatarUrl: null,
  roles: ['user'],
  isSuperuser: false,
  ts: 0,
  snippet: [{ text: id, match: false }],
});

describe('search helpers', () => {
  it('counts only letters and digits', () => {
    expect(searchableLength('')).toBe(0);
    expect(searchableLength('"" ()')).toBe(0);
    expect(searchableLength('a')).toBe(1);
    expect(searchableLength('héllo 42')).toBe(7);
  });

  it('groups by channel in order of first appearance and flattens back in that order', () => {
    const groups = groupResultsByChannel([hit('1', 'b'), hit('2', 'a'), hit('3', 'b'), hit('4', 'c')]);
    expect(groups.map((group) => group.channelId)).toEqual(['b', 'a', 'c']);
    expect(groups[0].results.map((result) => result.id)).toEqual(['1', '3']);
    expect(flattenGroups(groups).map((result) => result.id)).toEqual(['1', '3', '2', '4']);
    expect(groupResultsByChannel([])).toEqual([]);
  });
});
