import { describe, expect, it } from 'vitest';
import { initialShareState, isSharePending, reduceShare, SHARE_DEFAULTS, type ShareEvent, type ShareState } from './screenshareRejoin';

const run = (events: ShareEvent[], start: ShareState = initialShareState) => {
  let state = start;
  const effects = [];
  for (const event of events) {
    const step = reduceShare(state, event);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
};

describe('screenshare rejoin state machine', () => {
  it('lets a presenter restart hosting after the socket comes back and settle when the server confirms', () => {
    const { state, effects } = run([
      { type: 'started', role: 'host', channelId: 'share' },
      { type: 'socketLost', at: 1_000 },
      { type: 'authenticated', at: 4_000 },
    ]);
    expect(state).toMatchObject({ role: 'host', phase: 'rejoining', channelId: 'share', attempts: 1, suspendedAt: 1_000 });
    expect(isSharePending(state)).toBe(true);
    expect(effects).toEqual([{ type: 'restartHosting', channelId: 'share' }]);
    const settled = reduceShare(state, { type: 'settled', at: 4_200 });
    expect(settled.state).toMatchObject({ phase: 'active', attempts: 0, suspendedAt: null });
    expect(isSharePending(settled.state)).toBe(false);
    // A presenter ignores room-level events meant for viewers.
    expect(reduceShare(settled.state, { type: 'sessionInactive', at: 5_000 }).state.phase).toBe('active');
  });

  it('lets a viewer rejoin, and wait for a presenter who is still away', () => {
    const watching = run([{ type: 'started', role: 'viewer', channelId: 'share', hostAccountId: 'alice', hostRtcSessionId: 'a1' }]).state;
    const back = run([{ type: 'socketLost', at: 1_000 }, { type: 'authenticated', at: 3_000 }], watching);
    expect(back.state.phase).toBe('rejoining');
    expect(back.effects).toEqual([{ type: 'rejoinViewer', channelId: 'share' }]);

    // The join found no presenter: wait, keeping the picture.
    const waiting = reduceShare(back.state, { type: 'sessionInactive', at: 3_100 });
    expect(waiting.state).toMatchObject({ phase: 'waiting-host', waitingSince: 3_100, suspendedAt: null, attempts: 1 });
    expect(waiting.effects).toEqual([]);
    expect(reduceShare(waiting.state, { type: 'tick', at: 3_100 + SHARE_DEFAULTS.hostGraceMs - 1 }).effects).toEqual([]);

    // The same presenter is back: join again; the seat confirmation settles it.
    const returned = reduceShare(waiting.state, { type: 'sessionActive', at: 9_000, hostAccountId: 'alice', hostRtcSessionId: 'a1' });
    expect(returned.state).toMatchObject({ phase: 'rejoining', attempts: 2 });
    expect(returned.effects).toEqual([{ type: 'rejoinViewer', channelId: 'share' }]);
    const seated = reduceShare(returned.state, { type: 'settled', at: 9_100, hostAccountId: 'alice', hostRtcSessionId: 'a1' });
    expect(seated.state).toMatchObject({ phase: 'active', attempts: 0, waitingSince: null });

    // The presenter's own socket blipped while ours was fine: inactive, then active again with the same account.
    const blip = run([{ type: 'sessionInactive', at: 20_000 }, { type: 'sessionActive', at: 22_000, hostAccountId: 'alice', hostRtcSessionId: 'a1' }], seated.state);
    expect(blip.state.phase).toBe('rejoining');
    expect(blip.effects).toEqual([{ type: 'rejoinViewer', channelId: 'share' }]);
  });

  it('gives up when the presenter stays away, when someone else presents, on a refusal and after too long offline', () => {
    const waiting = run([{ type: 'started', role: 'viewer', channelId: 'share', hostAccountId: 'alice', hostRtcSessionId: 'a1' }, { type: 'sessionInactive', at: 0 }]).state;
    const gone = reduceShare(waiting, { type: 'tick', at: SHARE_DEFAULTS.hostGraceMs });
    expect(gone.state.phase).toBe('abandoned');
    expect(gone.effects).toEqual([{ type: 'giveUp', reason: 'host-gone', code: null }]);
    const other = reduceShare(waiting, { type: 'sessionActive', at: 5_000, hostAccountId: 'carol', hostRtcSessionId: 'c1' });
    expect(other.effects).toEqual([{ type: 'giveUp', reason: 'new-host', code: null }]);
    const late = reduceShare(waiting, { type: 'sessionActive', at: SHARE_DEFAULTS.hostGraceMs + 1, hostAccountId: 'alice', hostRtcSessionId: 'a1' });
    expect(late.effects).toEqual([{ type: 'giveUp', reason: 'host-gone', code: null }]);

    const active = run([{ type: 'started', role: 'viewer', channelId: 'share', hostAccountId: 'alice', hostRtcSessionId: 'a1' }]).state;
    const replaced = reduceShare(active, { type: 'sessionActive', at: 1, hostAccountId: 'carol', hostRtcSessionId: 'c1' });
    expect(replaced.effects).toEqual([{ type: 'giveUp', reason: 'new-host', code: null }]);
    // The same presenter with a new media session keeps the room; the connection is rebuilt by the next offer.
    const recaptured = reduceShare(active, { type: 'sessionActive', at: 1, hostAccountId: 'alice', hostRtcSessionId: 'a2' });
    expect(recaptured.state).toMatchObject({ phase: 'active', hostRtcSessionId: 'a2' });
    expect(recaptured.effects).toEqual([]);

    const hosting = run([{ type: 'started', role: 'host', channelId: 'share' }, { type: 'socketLost', at: 0 }, { type: 'authenticated', at: 1_000 }]).state;
    const busy = reduceShare(hosting, { type: 'refused', at: 1_100, code: 'SCREENSHARE_BUSY' });
    expect(busy.effects).toEqual([{ type: 'giveUp', reason: 'refused', code: 'SCREENSHARE_BUSY' }]);
    expect(reduceShare(busy.state, { type: 'authenticated', at: 2_000 }).effects).toEqual([]);

    const offline = run([{ type: 'started', role: 'host', channelId: 'share' }, { type: 'socketLost', at: 0 }]).state;
    expect(reduceShare(offline, { type: 'tick', at: SHARE_DEFAULTS.maxSuspendedMs - 1 }).effects).toEqual([]);
    expect(reduceShare(offline, { type: 'tick', at: SHARE_DEFAULTS.maxSuspendedMs }).effects).toEqual([{ type: 'giveUp', reason: 'timeout', code: null }]);
    expect(reduceShare(offline, { type: 'authenticated', at: SHARE_DEFAULTS.maxSuspendedMs + 1 }).effects).toEqual([{ type: 'giveUp', reason: 'timeout', code: null }]);
  });

  it('keeps the attempt budget across flaps and ends cleanly on stop', () => {
    let state = run([{ type: 'started', role: 'viewer', channelId: 'share', hostAccountId: 'alice', hostRtcSessionId: 'a1' }, { type: 'socketLost', at: 0 }]).state;
    for (let i = 0; i < SHARE_DEFAULTS.maxAttempts; i += 1) {
      const step = reduceShare(state, { type: 'authenticated', at: 1_000 * (i + 1) });
      expect(step.effects).toEqual([{ type: 'rejoinViewer', channelId: 'share' }]);
      state = reduceShare(step.state, { type: 'socketLost', at: 1_000 * (i + 1) + 500 }).state;
      expect(state).toMatchObject({ phase: 'suspended', attempts: i + 1, suspendedAt: 0 });
    }
    const exhausted = reduceShare(state, { type: 'authenticated', at: 10_000 });
    expect(exhausted.effects).toEqual([{ type: 'giveUp', reason: 'attempts', code: null }]);
    expect(reduceShare(exhausted.state, { type: 'stopped' }).state).toEqual(initialShareState);
    expect(reduceShare(initialShareState, { type: 'authenticated', at: 1 })).toEqual({ state: initialShareState, effects: [] });
  });
});
