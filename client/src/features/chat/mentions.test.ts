import { describe, expect, it } from 'vitest';
import { insertMention, mentionQueryAt, mergeCandidates, rankMentionCandidates } from './mentions';
import type { MentionCandidate } from '@/types/protocol';

const person = (displayName: string, username = displayName.toLowerCase().replace(/\s+/g, '') + '@example.com', accountId = username): MentionCandidate => ({
  accountId,
  username,
  displayName,
  avatarUrl: null,
  roles: ['user'],
});

const people = [person('Alice'), person('Bob'), person('Bob Smith'), person('Émile'), person('Zed', 'alpha@example.com')];

describe('mentionQueryAt', () => {
  it('finds the mention being typed at the caret', () => {
    expect(mentionQueryAt('hi @bo', 6)).toEqual({ start: 3, end: 6, query: 'bo' });
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, end: 1, query: '' });
    expect(mentionQueryAt('hey @Bob Sm', 11)).toEqual({ start: 4, end: 11, query: 'Bob Sm' });
    // The caret decides: text after it is not part of the query.
    expect(mentionQueryAt('@bo and more', 3)).toEqual({ start: 0, end: 3, query: 'bo' });
  });

  it('does not treat addresses, finished names or long text as a mention', () => {
    expect(mentionQueryAt('mail bob@example', 16)).toBeNull();
    expect(mentionQueryAt('no at sign', 10)).toBeNull();
    expect(mentionQueryAt('@Bob Smith is here', 18)).toBeNull();
    expect(mentionQueryAt('@ nothing', 9)).toBeNull();
    expect(mentionQueryAt('@bob\nnext line', 14)).toBeNull();
    expect(mentionQueryAt('@' + 'x'.repeat(60), 61)).toBeNull();
  });
});

describe('rankMentionCandidates', () => {
  it('lists everyone for an empty query and ranks prefix matches first', () => {
    expect(rankMentionCandidates(people, '').map((p) => p.displayName)).toEqual(['Alice', 'Bob', 'Bob Smith', 'Émile', 'Zed']);
    expect(rankMentionCandidates(people, 'bo').map((p) => p.displayName)).toEqual(['Bob', 'Bob Smith']);
    // Username prefix after display-name prefix; a later word of the name after that; substrings last.
    expect(rankMentionCandidates(people, 'al').map((p) => p.displayName)).toEqual(['Alice', 'Zed']);
    expect(rankMentionCandidates(people, 'smi').map((p) => p.displayName)).toEqual(['Bob Smith']);
    expect(rankMentionCandidates(people, 'ic').map((p) => p.displayName)).toEqual(['Alice']);
    expect(rankMentionCandidates(people, 'emile').map((p) => p.displayName)).toEqual(['Émile']);
    expect(rankMentionCandidates(people, 'nobody')).toEqual([]);
    expect(rankMentionCandidates(people, '', 2)).toHaveLength(2);
  });
});

describe('insertMention', () => {
  it('replaces the typed part with the display name and a space, caret after it', () => {
    const query = mentionQueryAt('hey @bo, ok?', 7)!;
    expect(insertMention('hey @bo, ok?', query, person('Bob Smith'))).toEqual({ text: 'hey @Bob Smith , ok?', caret: 15 });
    expect(insertMention('@', { start: 0, end: 1, query: '' }, person('Alice'))).toEqual({ text: '@Alice ', caret: 7 });
  });
});

describe('mergeCandidates', () => {
  it('keeps the first entry per account', () => {
    const merged = mergeCandidates([person('Bob')], [person('Bob', 'bob@example.com'), person('Carol')]);
    expect(merged.map((p) => p.displayName)).toEqual(['Bob', 'Carol']);
  });
});
