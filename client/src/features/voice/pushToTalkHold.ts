/**
 * Release detection for the system-wide push-to-talk key.
 *
 * Electron's globalShortcut only reports presses, never releases. While a key is held
 * the operating system repeats the press at the keyboard's repeat rate (Windows and X11
 * do; macOS does not), so the shell forwards every press and this tracker treats the key
 * as held until the presses stop. The first press waits for the keyboard's initial
 * repeat delay (up to one second on Windows); once repeats arrive, the release is
 * noticed within three repeat intervals, 150 ms at the default repeat rate.
 */

/** Longest Windows "repeat delay" setting (1 s) plus a margin. */
export const HOLD_FIRST_MS = 1200;
/** Bounds for the window derived from the measured repeat interval. */
export const HOLD_REPEAT_MIN_MS = 150;
export const HOLD_REPEAT_MAX_MS = 1200;
/** Keep the key held for this many repeat intervals after the last press. */
const REPEAT_WINDOW_FACTOR = 3;

export interface HoldState {
  held: boolean;
  /** Time of the latest press (ms). */
  lastPressAt: number | null;
  /** Measured distance between the last two presses, once two have been seen. */
  interval: number | null;
  /** When the key counts as released unless another press arrives before. */
  releaseAt: number | null;
}

export const initialHoldState: HoldState = { held: false, lastPressAt: null, interval: null, releaseAt: null };

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** A press (or auto-repeat) of the key at `at`. */
export const pressHold = (state: HoldState, at: number): HoldState => {
  const interval = state.held && state.lastPressAt !== null ? Math.max(1, at - state.lastPressAt) : null;
  const window = interval === null ? HOLD_FIRST_MS : clamp(interval * REPEAT_WINDOW_FACTOR, HOLD_REPEAT_MIN_MS, HOLD_REPEAT_MAX_MS);
  return { held: true, lastPressAt: at, interval, releaseAt: at + window };
};

/** Time passed: releases the key once its window ran out without another press. */
export const expireHold = (state: HoldState, now: number): HoldState => {
  if (!state.held || state.releaseAt === null || now < state.releaseAt) return state;
  return initialHoldState;
};

/** Forget everything (leaving voice, switching modes). */
export const releaseHold = (): HoldState => initialHoldState;
