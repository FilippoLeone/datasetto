import { describe, expect, it } from 'vitest';
import { clipTooBigReason, defaultPostTarget, postTargetLabel, postTargets } from './postClip';
import type { Channel } from '@/types/protocol';

const MB = 1024 * 1024;
const channel = (id: string, type: Channel['type'], extra: Partial<Channel> = {}): Channel => ({ id, name: id, type, count: 0, ...extra });

const all: Channel[] = [
  channel('lobby', 'voice'),
  channel('main-stream', 'stream'),
  channel('team-share', 'screenshare'),
  channel('general', 'text'),
  channel('dm-alice', 'dm', { dm: { peerId: 'a', peerName: 'alice', peerUsername: 'alice', peerAvatarUrl: null } }),
  channel('random', 'text'),
];

describe('post to chat targets', () => {
  it('offers the channels that carry chat: text first, then streams, then direct messages', () => {
    expect(postTargets(all).map((entry) => entry.id)).toEqual(['general', 'random', 'main-stream', 'dm-alice']);
    expect(postTargets([channel('lobby', 'voice')])).toEqual([]);
  });

  it('starts on the channel being read, else the last one posted to, else the first target', () => {
    const targets = postTargets(all);
    expect(defaultPostTarget(targets, 'random', 'general')).toBe('random');
    // A screenshare room is being read: it cannot take chat, so the last target wins.
    expect(defaultPostTarget(targets, 'team-share', 'dm-alice')).toBe('dm-alice');
    expect(defaultPostTarget(targets, 'team-share', null)).toBe('general');
    expect(defaultPostTarget(targets, undefined, 'gone')).toBe('general');
    expect(defaultPostTarget([], 'general')).toBeNull();
  });

  it('labels channels with # and people with @', () => {
    expect(postTargetLabel(channel('general', 'text'))).toBe('#general');
    expect(postTargetLabel(channel('main-stream', 'stream'))).toBe('#main-stream');
    expect(postTargetLabel(all[4])).toBe('@alice');
  });

  it('explains a clip over the video cap in both sizes', () => {
    expect(clipTooBigReason(10 * MB, 50 * MB)).toBeNull();
    expect(clipTooBigReason(50 * MB, 50 * MB)).toBeNull();
    expect(clipTooBigReason(50 * MB + 1, 50 * MB)).toBe('This clip is 50.0 MB; this server takes videos up to 50.0 MB.');
    expect(clipTooBigReason(45_000_000, 25 * MB)).toBe('This clip is 42.9 MB; this server takes videos up to 25.0 MB.');
  });
});
