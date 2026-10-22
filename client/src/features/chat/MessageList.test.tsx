import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MessageList } from './MessageList';
import { knownAvatars, rememberAvatar } from '@/state/avatars';
import { loadedChannels, messages, setHistory } from '@/state/chat';
import type { Channel, ChatMessage } from '@/types/protocol';

const host = document.createElement('div');
document.body.appendChild(host);

const channel: Channel = { id: 'ch-general', name: 'general', type: 'text', count: 0 };
const T0 = Date.UTC(2026, 9, 21, 18, 0, 0);
const ALICE_PIC = '/api/avatars/acct-alice.webp?v=1';
const BOB_PIC = 'https://pics.example/bob.png';

const message = (id: string, accountId: string, from: string, authorAvatarUrl: string | null, ts: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  channelId: channel.id,
  from,
  accountId,
  authorAvatarUrl,
  text: 'message ' + id,
  ts,
  ...extra,
});

/** The picture next to a message: the 40 px avatar in its gutter (absent on grouped follow-ups). */
const gutterPicture = (id: string): string | null => {
  const row = host.querySelector('[data-message-id="' + id + '"] .message-row');
  const img = row?.querySelector(':scope > div:first-child img');
  return img?.getAttribute('src') ?? null;
};
const quotePicture = (id: string): string | null => host.querySelector('[data-message-id="' + id + '"] .reply-quote img')?.getAttribute('src') ?? null;
const isGenerated = (src: string | null) => Boolean(src?.startsWith('data:image/svg+xml'));

beforeAll(() => {
  // jsdom has no element scrolling; the list only needs the calls to exist.
  if (!HTMLElement.prototype.scrollTo) HTMLElement.prototype.scrollTo = () => undefined;
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => undefined;
});

beforeEach(() => {
  knownAvatars.value = new Map();
  messages.value = {};
  loadedChannels.value = {};
});

afterEach(() => {
  render(null, host);
});

describe('MessageList author pictures', () => {
  const history = () => [
    message('m1', 'acct-alice', 'Alice', ALICE_PIC, T0),
    // Same author a minute later: grouped under the first, no avatar of its own.
    message('m2', 'acct-alice', 'Alice', ALICE_PIC, T0 + 60_000),
    message('m3', 'acct-bob', 'Bob', BOB_PIC, T0 + 120_000, {
      replyTo: { id: 'm1', from: 'Alice', accountId: 'acct-alice', avatarUrl: ALICE_PIC, text: 'message m1', deleted: false, pictures: 0 },
    }),
    message('m4', 'acct-carol', 'Carol', null, T0 + 180_000),
    // A deleted account: the server sends no picture.
    message('m5', 'acct-gone', 'Deleted user', null, T0 + 240_000),
  ];

  it('shows each author their own uploaded or linked picture, and the generated avatar otherwise', () => {
    setHistory(channel.id, history());
    act(() => render(<MessageList channel={channel} />, host));

    expect(gutterPicture('m1')).toContain(ALICE_PIC);
    expect(gutterPicture('m2')).toBeNull();
    expect(gutterPicture('m3')).toBe(BOB_PIC);
    expect(quotePicture('m3')).toContain(ALICE_PIC);
    expect(isGenerated(gutterPicture('m4'))).toBe(true);
    expect(isGenerated(gutterPicture('m5'))).toBe(true);
  });

  it('follows a picture change live, on old messages and reply quotes too, and falls back when it is removed', () => {
    setHistory(channel.id, history());
    act(() => render(<MessageList channel={channel} />, host));

    act(() => rememberAvatar('acct-alice', '/api/avatars/acct-alice.webp?v=2'));
    expect(gutterPicture('m1')).toContain('/api/avatars/acct-alice.webp?v=2');
    expect(quotePicture('m3')).toContain('/api/avatars/acct-alice.webp?v=2');

    act(() => rememberAvatar('acct-carol', 'https://pics.example/carol.png'));
    expect(gutterPicture('m4')).toBe('https://pics.example/carol.png');

    act(() => rememberAvatar('acct-bob', null));
    expect(isGenerated(gutterPicture('m3'))).toBe(true);
  });

  it('uses the newest picture the server sent even when the message itself is older', () => {
    // History fetched earlier carried v=1; a later message from the same author says v=3.
    setHistory(channel.id, [message('m1', 'acct-alice', 'Alice', ALICE_PIC, T0)]);
    act(() => render(<MessageList channel={channel} />, host));
    act(() => setHistory(channel.id, [message('m1', 'acct-alice', 'Alice', ALICE_PIC, T0), message('m9', 'acct-alice', 'Alice', '/api/avatars/acct-alice.webp?v=3', T0 + 3_600_000)]));
    expect(gutterPicture('m1')).toContain('v=3');
    expect(gutterPicture('m9')).toContain('v=3');
  });

  it('shows the generated avatar when a picture does not load', () => {
    setHistory(channel.id, [message('m1', 'acct-bob', 'Bob', BOB_PIC, T0)]);
    act(() => render(<MessageList channel={channel} />, host));
    const img = host.querySelector('[data-message-id="m1"] img') as HTMLImageElement;
    act(() => {
      img.dispatchEvent(new Event('error'));
    });
    expect(isGenerated(gutterPicture('m1'))).toBe(true);
    // A new picture gets its own chance to load.
    act(() => rememberAvatar('acct-bob', 'https://pics.example/bob-new.png'));
    expect(gutterPicture('m1')).toBe('https://pics.example/bob-new.png');
  });
});
