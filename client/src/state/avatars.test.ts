import { beforeEach, describe, expect, it } from 'vitest';
import { avatarOf, knownAvatars, rememberAvatar, rememberAvatars, rememberMessageAuthors, rememberOnlineAvatars } from './avatars';
import { appendMessage, messages, prependMessages, replyRefOf, setHistory } from './chat';
import type { ChatMessage, User } from '@/types/protocol';

const message = (id: string, accountId: string | null, authorAvatarUrl: string | null | undefined, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  channelId: 'ch-general',
  from: accountId ?? 'Guest',
  accountId,
  ...(authorAvatarUrl === undefined ? {} : { authorAvatarUrl }),
  text: 'hello',
  ts: 1_700_000_000_000,
  ...extra,
});

const online = (accountId: string, avatarUrl: string | null): User => ({ id: 's-' + accountId, accountId, username: accountId, displayName: accountId, roles: ['user'], isSuperuser: false, avatarUrl });

beforeEach(() => {
  knownAvatars.value = new Map();
  messages.value = {};
});

describe('author pictures by account', () => {
  it('prefers what it knows over the picture a payload carried, and keeps "no picture" as an answer', () => {
    expect(avatarOf('acct-a', '/from/payload.webp')).toBe('/from/payload.webp');
    expect(avatarOf(null, '/from/payload.webp')).toBe('/from/payload.webp');
    expect(avatarOf('acct-a')).toBeNull();

    rememberAvatar('acct-a', '/api/avatars/acct-a.webp?v=2');
    expect(avatarOf('acct-a', '/api/avatars/acct-a.webp?v=1')).toBe('/api/avatars/acct-a.webp?v=2');

    // Removed picture: null wins over a stale payload value, so the generated avatar shows.
    rememberAvatar('acct-a', null);
    expect(avatarOf('acct-a', '/api/avatars/acct-a.webp?v=1')).toBeNull();
  });

  it('skips entries without an account or without the field (older servers), and treats "" as no picture', () => {
    rememberAvatars([
      [null, '/x.webp'],
      ['acct-b', undefined],
      ['acct-c', ''],
    ]);
    expect(knownAvatars.value.has('acct-b')).toBe(false);
    expect(knownAvatars.value.get('acct-c')).toBeNull();
    expect(knownAvatars.value.size).toBe(1);
  });

  it('only replaces the map when a picture actually changed (presence updates are frequent)', () => {
    rememberOnlineAvatars([online('acct-a', 'https://pics.example/a.png'), online('acct-b', null)]);
    const first = knownAvatars.value;
    rememberOnlineAvatars([online('acct-a', 'https://pics.example/a.png'), online('acct-b', null)]);
    expect(knownAvatars.value).toBe(first);
    rememberOnlineAvatars([online('acct-a', 'https://pics.example/a2.png')]);
    expect(knownAvatars.value).not.toBe(first);
    expect(avatarOf('acct-a')).toBe('https://pics.example/a2.png');
    // Going offline does not forget the picture: their messages keep it.
    rememberOnlineAvatars([]);
    expect(avatarOf('acct-b')).toBeNull();
    expect(avatarOf('acct-a')).toBe('https://pics.example/a2.png');
  });

  it('learns authors and quoted authors from every way messages arrive', () => {
    rememberMessageAuthors([
      message('m1', 'acct-a', '/api/avatars/acct-a.webp?v=1', {
        replyTo: { id: 'm0', from: 'B', accountId: 'acct-b', avatarUrl: 'https://pics.example/b.png', text: 'hi', deleted: false, pictures: 0 },
      }),
    ]);
    expect(avatarOf('acct-a')).toBe('/api/avatars/acct-a.webp?v=1');
    expect(avatarOf('acct-b')).toBe('https://pics.example/b.png');

    setHistory('ch-general', [message('m2', 'acct-c', 'https://pics.example/c.png')]);
    expect(avatarOf('acct-c')).toBe('https://pics.example/c.png');

    appendMessage(message('m3', 'acct-c', '/api/avatars/acct-c.webp?v=9'));
    expect(avatarOf('acct-c')).toBe('/api/avatars/acct-c.webp?v=9');

    prependMessages('ch-general', [message('m0', 'acct-d', null)]);
    expect(knownAvatars.value.get('acct-d')).toBeNull();
    expect(messages.value['ch-general'].map((entry) => entry.id)).toEqual(['m0', 'm2', 'm3']);
  });

  it('carries the author picture into the quote of a reply being written', () => {
    expect(replyRefOf(message('m1', 'acct-a', '/api/avatars/acct-a.webp?v=1')).avatarUrl).toBe('/api/avatars/acct-a.webp?v=1');
    expect(replyRefOf(message('m2', 'acct-a', undefined)).avatarUrl).toBeNull();
  });
});
