/**
 * Game input (docs/arcade/platform.md §10.4, plan §2.6.6): keyboard, touch and gamepad merged into
 * one `InputSample` that the game reads once per sim tick. Framework-free, no timers: the keyboard and
 * touch work from events, the gamepad is read inside `sample()`. `dispose()` leaves nothing behind.
 */
import type { KeyBinding, KeyMap } from '../types';
import { createGamepad } from './gamepad';
import { createKeyboard, isReservedKey } from './keyboard';
import { ACT, DEFAULT_KEYS, DEFAULT_TOUCH, on, type InputSample, type Off, type TouchLayout } from './map';
import { createTouch } from './touch';

export { ACT, DEFAULT_KEYS, DEFAULT_TOUCH, isReservedKey };
export type { InputSample, TouchLayout };

export interface Input {
  /** Once per sim tick. `pressed` holds every press since the previous call, even one already released. */
  sample(): InputSample;
  /** Shows or hides a touch button (released if it was held). No-op without touch controls. */
  setButtonVisible(id: string, v: boolean): void;
  dispose(): void;
}

export function createInput(
  target: HTMLElement,
  o: { keys: KeyMap; ptt: KeyBinding | null; touch: TouchLayout | null; gamepad: boolean; /** Other app shortcuts never to bind (MountOpts.reserved). */ reserved?: readonly KeyBinding[] },
): Input {
  const offs: Off[] = [];
  // Bits held per source: keyboard, touch, gamepad.
  const src = [0, 0, 0];
  let latched = 0;
  const held = () => src[0] | src[1] | src[2];
  const setter = (i: number) => (bits: number) => {
    latched |= bits & ~held();
    src[i] = bits;
  };

  const releaseKeys = createKeyboard(target, o.keys, o.ptt, o.reserved ?? [], setter(0), offs);
  const touch = o.touch ? createTouch(target, o.touch, setter(1), offs) : null;
  const pad = o.gamepad ? createGamepad(offs) : null;
  const setPad = setter(2);
  on(
    window,
    'blur',
    () => {
      releaseKeys();
      touch?.release();
    },
    offs,
  );

  return {
    sample() {
      let x = touch ? touch.x : 0;
      let y = touch ? touch.y : 0;
      if (pad) {
        const p = pad();
        setPad(p.bits);
        if (!x && !y) {
          x = p.x;
          y = p.y;
        }
      }
      const pressed = latched;
      latched = 0;
      // `|| 0` turns −0 into 0.
      return { held: held(), pressed, stickX: x || 0, stickY: y || 0 };
    },
    setButtonVisible(id, v) {
      touch?.show(id, v);
    },
    dispose() {
      for (const off of offs.splice(0)) off();
      src.fill(0);
      latched = 0;
      if (touch) touch.x = touch.y = 0;
    },
  };
}
