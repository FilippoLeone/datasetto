import { describe, expect, it } from 'vitest';
import { expireHold, HOLD_FIRST_MS, HOLD_REPEAT_MAX_MS, HOLD_REPEAT_MIN_MS, initialHoldState, pressHold, releaseHold } from './pushToTalkHold';

describe('push-to-talk hold tracker', () => {
  it('holds after the first press until the initial repeat delay has passed', () => {
    const pressed = pressHold(initialHoldState, 1000);
    expect(pressed.held).toBe(true);
    expect(pressed.interval).toBeNull();
    expect(pressed.releaseAt).toBe(1000 + HOLD_FIRST_MS);
    expect(expireHold(pressed, 1000 + HOLD_FIRST_MS - 1)).toBe(pressed);
    expect(expireHold(pressed, 1000 + HOLD_FIRST_MS)).toEqual(initialHoldState);
  });

  it('shortens the window once key repeats show the repeat rate', () => {
    let state = pressHold(initialHoldState, 0);
    state = pressHold(state, 500); // Windows initial repeat delay
    expect(state.interval).toBe(500);
    expect(state.releaseAt).toBe(500 + HOLD_REPEAT_MAX_MS); // 3 x 500 capped
    state = pressHold(state, 533); // 30 repeats per second from here on
    expect(state.interval).toBe(33);
    expect(state.releaseAt).toBe(533 + HOLD_REPEAT_MIN_MS); // 3 x 33 raised to the floor
    state = pressHold(state, 566);
    expect(state.held).toBe(true);
    // Released: no repeat within the window.
    expect(expireHold(state, 566 + HOLD_REPEAT_MIN_MS - 1).held).toBe(true);
    expect(expireHold(state, 566 + HOLD_REPEAT_MIN_MS).held).toBe(false);
  });

  it('keeps a slow repeat rate held between repeats', () => {
    let state = pressHold(initialHoldState, 0);
    state = pressHold(state, 1000);
    state = pressHold(state, 1400); // 2.5 repeats per second
    expect(state.releaseAt).toBe(1400 + 1200);
    expect(expireHold(state, 1800).held).toBe(true);
  });

  it('starts over after a release', () => {
    let state = pressHold(initialHoldState, 0);
    state = pressHold(state, 30);
    state = expireHold(state, 5000);
    expect(state).toEqual(initialHoldState);
    const again = pressHold(state, 6000);
    expect(again.interval).toBeNull();
    expect(again.releaseAt).toBe(6000 + HOLD_FIRST_MS);
    expect(releaseHold()).toEqual(initialHoldState);
  });

  it('ignores time checks while not held', () => {
    expect(expireHold(initialHoldState, 99_999)).toBe(initialHoldState);
  });
});
