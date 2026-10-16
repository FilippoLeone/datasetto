import { describe, expect, it } from 'vitest';
import { initialRejoinState, isRejoinPending, reduceRejoin, REJOIN_DEFAULTS, type RejoinEvent, type RejoinState } from './voiceRejoin';

const run = (events: RejoinEvent[], start: RejoinState = initialRejoinState) => {
  let state = start;
  const effects = [];
  for (const event of events) {
    const step = reduceRejoin(state, event);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
};

describe('voice rejoin state machine', () => {
  it('rejoins the same channel after the socket comes back and settles once the server confirms', () => {
    const { state, effects } = run([
      { type: 'joined', channelId: 'lobby' },
      { type: 'socketLost', at: 1_000 },
      { type: 'authenticated', at: 4_000 },
    ]);
    expect(state).toMatchObject({ phase: 'rejoining', channelId: 'lobby', attempts: 1, suspendedAt: 1_000 });
    expect(isRejoinPending(state)).toBe(true);
    expect(effects).toEqual([{ type: 'rejoin', channelId: 'lobby', attempt: 1 }]);

    const settled = reduceRejoin(state, { type: 'joined', channelId: 'lobby' });
    expect(settled.state).toEqual({ phase: 'active', channelId: 'lobby', attempts: 0, suspendedAt: null, retryAt: null });
    expect(settled.effects).toEqual([]);
    expect(isRejoinPending(settled.state)).toBe(false);
  });

  it('ignores sign-ins while not in a call and ends cleanly when the user leaves', () => {
    expect(reduceRejoin(initialRejoinState, { type: 'authenticated', at: 1 })).toEqual({ state: initialRejoinState, effects: [] });
    expect(reduceRejoin(initialRejoinState, { type: 'socketLost', at: 1 }).state.phase).toBe('idle');
    const { state } = run([{ type: 'joined', channelId: 'lobby' }, { type: 'socketLost', at: 1_000 }, { type: 'left' }]);
    expect(state).toEqual(initialRejoinState);
    // A sign-in while the call is up (a second auth:success on the same socket) changes nothing.
    const active = run([{ type: 'joined', channelId: 'lobby' }, { type: 'authenticated', at: 5 }]);
    expect(active.state.phase).toBe('active');
    expect(active.effects).toEqual([]);
  });

  it('retries a transient refusal after a delay and gives up on a permanent one', () => {
    const base = run([{ type: 'joined', channelId: 'lobby' }, { type: 'socketLost', at: 0 }, { type: 'authenticated', at: 1_000 }]).state;
    const transient = reduceRejoin(base, { type: 'joinFailed', at: 1_500, code: 'TIMEOUT' });
    expect(transient.state).toMatchObject({ phase: 'suspended', attempts: 1, retryAt: 1_500 + REJOIN_DEFAULTS.retryDelayMs });
    expect(transient.effects).toEqual([]);
    const early = reduceRejoin(transient.state, { type: 'tick', at: 2_000 });
    expect(early.effects).toEqual([]);
    const due = reduceRejoin(transient.state, { type: 'tick', at: 4_500 });
    expect(due.state).toMatchObject({ phase: 'rejoining', attempts: 2, retryAt: null });
    expect(due.effects).toEqual([{ type: 'rejoin', channelId: 'lobby', attempt: 2 }]);

    const refused = reduceRejoin(base, { type: 'joinFailed', at: 1_500, code: 'VOICE_TIMED_OUT' });
    expect(refused.state.phase).toBe('abandoned');
    expect(refused.effects).toEqual([{ type: 'giveUp', reason: 'refused', code: 'VOICE_TIMED_OUT' }]);
    // Abandoned stays abandoned until the user leaves or joins again.
    expect(reduceRejoin(refused.state, { type: 'authenticated', at: 9_000 }).effects).toEqual([]);
    expect(reduceRejoin(refused.state, { type: 'joined', channelId: 'lobby' }).state.phase).toBe('active');
  });

  it('stops after the attempt budget and 90 s away, keeping the clock across flaps', () => {
    let state = run([{ type: 'joined', channelId: 'lobby' }, { type: 'socketLost', at: 0 }]).state;
    const effects = [];
    for (let i = 0; i < REJOIN_DEFAULTS.maxAttempts; i += 1) {
      const step = reduceRejoin(state, { type: 'authenticated', at: 1_000 * (i + 1) });
      effects.push(...step.effects);
      state = step.state;
      expect(state.phase).toBe('rejoining');
      // The socket flaps before the server answers: back to waiting, attempts kept, clock kept.
      state = reduceRejoin(state, { type: 'socketLost', at: 1_000 * (i + 1) + 500 }).state;
      expect(state).toMatchObject({ phase: 'suspended', attempts: i + 1, suspendedAt: 0 });
    }
    expect(effects.filter((effect) => effect.type === 'rejoin')).toHaveLength(REJOIN_DEFAULTS.maxAttempts);
    const exhausted = reduceRejoin(state, { type: 'authenticated', at: 10_000 });
    expect(exhausted.state.phase).toBe('abandoned');
    expect(exhausted.effects).toEqual([{ type: 'giveUp', reason: 'attempts', code: null }]);

    const away = run([{ type: 'joined', channelId: 'lobby' }, { type: 'socketLost', at: 0 }, { type: 'tick', at: REJOIN_DEFAULTS.maxSuspendedMs - 1 }]);
    expect(away.state.phase).toBe('suspended');
    const late = reduceRejoin(away.state, { type: 'tick', at: REJOIN_DEFAULTS.maxSuspendedMs });
    expect(late.effects).toEqual([{ type: 'giveUp', reason: 'timeout', code: null }]);
    // A sign-in that arrives after the deadline is also too late.
    const lateAuth = reduceRejoin(away.state, { type: 'authenticated', at: REJOIN_DEFAULTS.maxSuspendedMs + 5 });
    expect(lateAuth.effects).toEqual([{ type: 'giveUp', reason: 'timeout', code: null }]);
  });
});
