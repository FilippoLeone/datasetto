/**
 * Shared pieces of the input module (docs/arcade/platform.md §10.4): the action bits, the sample and
 * touch layout types, the default bindings, and the small helpers the three sources share.
 */
import type { KeyMap } from '../types';

/** Action bits. A KeyMap value may combine them. */
/** Action bits. `map` (M, gamepad Back) is for games with a map screen (Bellwick). */
export const ACT = { up: 1, down: 2, left: 4, right: 8, a: 16, b: 32, swap: 64, menu: 128, map: 256 } as const;

/**
 * One sample per sim tick. `held`: bits held now (keyboard ∪ touch ∪ gamepad). `pressed`: bits that
 * went down since the previous sample, latched, so a tap released before the sample still shows.
 * `stickX`/`stickY`: the touch stick or the gamepad's left stick, −1..1 after the dead zone, +y down;
 * 0 from the keyboard and the touch D-pad, which give bits only.
 */
export interface InputSample {
  held: number;
  pressed: number;
  stickX: number;
  stickY: number;
}

export interface TouchLayout {
  /** 'float': the stick base appears where the finger lands; 'dpad': four fixed direction pads. */
  stick: 'float' | 'dpad';
  /** Bottom right, the first one lowest; 'menu' sits top right. A 40 px button is padded to a 44 px target. */
  buttons: readonly { id: 'a' | 'b' | 'swap' | 'menu'; label: string; px: 40 | 56 | 76 }[];
  deadZonePx: number;
  radiusPx: number;
  /** Vibration on a button press (Android), off by default. */
  vibrateMs: 0 | 10;
  /** 'overlay': translucent, above the canvas; 'deck': opaque controls below the canvas. */
  region: 'deck' | 'overlay';
}

const { up, down, left, right, a, b, swap, menu, map } = ACT;

/** Arrows or WASD move; Space or J → A; K or Shift → B; Esc or P → menu; L → swap; M → map. */
export const DEFAULT_KEYS: KeyMap = {
  ArrowUp: up,
  KeyW: up,
  ArrowDown: down,
  KeyS: down,
  ArrowLeft: left,
  KeyA: left,
  ArrowRight: right,
  KeyD: right,
  Space: a,
  KeyJ: a,
  KeyK: b,
  ShiftLeft: b,
  ShiftRight: b,
  Escape: menu,
  KeyP: menu,
  KeyL: swap,
  KeyM: map,
};

export const DEFAULT_TOUCH: TouchLayout = {
  stick: 'float',
  buttons: [
    { id: 'a', label: 'A', px: 76 },
    { id: 'b', label: 'B', px: 56 },
  ],
  deadZonePx: 12,
  radiusPx: 48,
  vibrateMs: 0,
  region: 'deck',
};

/** Undoes one thing a source did (a listener, a DOM change); dispose() runs them all. */
export type Off = () => void;

export const on = <E extends Event>(t: EventTarget, type: string, fn: (e: E) => void, offs: Off[]): void => {
  const l = fn as EventListener;
  t.addEventListener(type, l);
  offs.push(() => t.removeEventListener(type, l));
};

/** Stick output beyond this on an axis also sets that direction's bit. */
const DIR_AT = 0.35;

export const dirBits = (x: number, y: number): number =>
  (x < -DIR_AT ? left : x > DIR_AT ? right : 0) | (y < -DIR_AT ? up : y > DIR_AT ? down : 0);

/**
 * Radial dead zone for a vector of length `d`: the factor to multiply it by, so the output grows from 0
 * at the dead zone's edge to 1 at `r` and stays at 1 beyond.
 */
export const deadZone = (d: number, dz: number, r: number): number => (d > dz ? Math.min(1, (d - dz) / (r - dz)) / d : 0);
