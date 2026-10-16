import { describe, expect, it } from 'vitest';
import { reconcilePeers, type KnownPeer } from './peerReconcile';

const known = (id: string, accountId: string, rtcSessionId: string | null, health: KnownPeer['health'] = 'connected'): KnownPeer => ({ id, accountId, rtcSessionId, health });
const me = { accountId: 'alice', rtcSessionId: 'alice-rtc' };

describe('peer reconciliation after a reconnect', () => {
  it('keeps working connections to the same people on their new socket ids and asks for an ICE restart only when broken', () => {
    const mine = [known('s-bob-1', 'bob', 'bob-rtc'), known('s-carol-1', 'carol', 'carol-rtc', 'broken')];
    const room = [
      { id: 's-bob-2', accountId: 'bob', rtcSessionId: 'bob-rtc' },
      { id: 's-carol-2', accountId: 'carol', rtcSessionId: 'carol-rtc' },
    ];
    expect(reconcilePeers(mine, room, me)).toEqual([
      { action: 'rekey', from: 's-bob-1', to: 's-bob-2', restartIce: false },
      { action: 'rekey', from: 's-carol-1', to: 's-carol-2', restartIce: true },
    ]);
  });

  it('rebuilds when the other side rebuilt (new media session), when we have nothing, or when ours is gone', () => {
    const mine = [known('s-bob-1', 'bob', 'bob-rtc'), known('s-dave-1', 'dave', 'dave-rtc', 'missing'), known('s-erin-1', 'erin', null)];
    const room = [
      { id: 's-bob-2', accountId: 'bob', rtcSessionId: 'bob-rtc-2' },
      { id: 's-carol-1', accountId: 'carol', rtcSessionId: 'carol-rtc' },
      { id: 's-dave-2', accountId: 'dave', rtcSessionId: 'dave-rtc' },
      { id: 's-erin-2', accountId: 'erin', rtcSessionId: 'erin-rtc' },
    ];
    expect(reconcilePeers(mine, room, me)).toEqual([
      { action: 'rebuild', from: 's-bob-1', to: 's-bob-2' },
      { action: 'rebuild', from: null, to: 's-carol-1' },
      { action: 'rebuild', from: 's-dave-1', to: 's-dave-2' },
      { action: 'rebuild', from: 's-erin-1', to: 's-erin-2' },
    ]);
  });

  it('rebuilds when a rejoining peer says it no longer holds its connection to us, keeps it when it does', () => {
    const mine = [known('s-bob-1', 'bob', 'bob-rtc')];
    const lost = [{ id: 's-bob-2', accountId: 'bob', rtcSessionId: 'bob-rtc', holding: [{ accountId: 'carol', rtcSessionId: 'carol-rtc' }] }];
    expect(reconcilePeers(mine, lost, me, { partial: true })).toEqual([{ action: 'rebuild', from: 's-bob-1', to: 's-bob-2' }]);
    const held = [{ id: 's-bob-2', accountId: 'bob', rtcSessionId: 'bob-rtc', holding: [{ accountId: 'alice', rtcSessionId: 'alice-rtc' }] }];
    expect(reconcilePeers(mine, held, me, { partial: true })).toEqual([{ action: 'rekey', from: 's-bob-1', to: 's-bob-2', restartIce: false }]);
    // Held, but for a media session of ours that no longer exists: they will not answer on the old one.
    const oldSession = [{ id: 's-bob-2', accountId: 'bob', rtcSessionId: 'bob-rtc', holding: [{ accountId: 'alice', rtcSessionId: 'alice-rtc-old' }] }];
    expect(reconcilePeers(mine, oldSession, me, { partial: true })).toEqual([{ action: 'rebuild', from: 's-bob-1', to: 's-bob-2' }]);
    // An older client that says nothing about what it holds is given the benefit of the doubt.
    expect(reconcilePeers(mine, [{ id: 's-bob-2', accountId: 'bob', rtcSessionId: 'bob-rtc' }], me, { partial: true })[0].action).toBe('rekey');
  });

  it('skips our own stale seat, keeps unchanged ids, and marks people missing from the room as stale', () => {
    const mine = [known('s-bob-1', 'bob', 'bob-rtc'), known('s-carol-1', 'carol', 'carol-rtc')];
    const room = [
      { id: 's-alice-old', accountId: 'alice', rtcSessionId: 'alice-rtc' },
      { id: 's-bob-1', accountId: 'bob', rtcSessionId: 'bob-rtc' },
    ];
    expect(reconcilePeers(mine, room, me)).toEqual([
      { action: 'keep', id: 's-bob-1' },
      { action: 'stale', id: 's-carol-1' },
    ]);
    // A single peer-join event says nothing about who else is there.
    expect(reconcilePeers(mine, [{ id: 's-bob-2', accountId: 'bob', rtcSessionId: 'bob-rtc' }], me, { partial: true })).toEqual([
      { action: 'rekey', from: 's-bob-1', to: 's-bob-2', restartIce: false },
    ]);
    // A fresh join: nothing known, everyone is new.
    expect(reconcilePeers([], room, me)).toEqual([{ action: 'rebuild', from: null, to: 's-bob-1' }]);
  });

  it('prefers the live entry when two of ours carry the same account and leaves the other stale', () => {
    const mine = [known('s-bob-old', 'bob', 'bob-rtc', 'missing'), known('s-bob-1', 'bob', 'bob-rtc')];
    expect(reconcilePeers(mine, [{ id: 's-bob-2', accountId: 'bob', rtcSessionId: 'bob-rtc' }], me)).toEqual([
      { action: 'rekey', from: 's-bob-1', to: 's-bob-2', restartIce: false },
      { action: 'stale', id: 's-bob-old' },
    ]);
  });
});
