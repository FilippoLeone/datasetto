/**
 * Fuseyard's controls (fuseyard.md §8.3, §8.4): the key map, turning one input sample per tick into
 * the input byte, and the touch layout per orientation. The touch overlay itself is the platform's
 * (runtime/input/touch.ts), built once; a layout change only moves elements and changes styles.
 *
 * - Keyboard and D-pad: the newest held direction is primary, the one held before it secondary.
 * - Stick (touch or gamepad): the larger axis is primary and switches only when the other leads by
 *   15 %; the minor axis becomes the secondary direction above 35 % of the radius.
 * - Presses are latched by the platform between samples, so a 10 ms tap is never lost.
 */
import { ACT, type InputSample, type TouchLayout } from '@/arcade/runtime/input';
import type { ArcadePrefs, KeyMap } from '@/arcade/runtime/types';
import { Dir, inputByte } from '@arcade/core/fuseyard/rules';

export const KEYMAP: KeyMap = {
  ArrowUp: ACT.up,
  KeyW: ACT.up,
  ArrowDown: ACT.down,
  KeyS: ACT.down,
  ArrowLeft: ACT.left,
  KeyA: ACT.left,
  ArrowRight: ACT.right,
  KeyD: ACT.right,
  Space: ACT.a,
  KeyJ: ACT.a,
  KeyK: ACT.b,
  ShiftLeft: ACT.b,
  ShiftRight: ACT.b,
  Escape: ACT.menu,
  KeyP: ACT.menu,
};

/** Above this lead the other stick axis takes over as primary. */
export const AXIS_SWITCH = 1.15;
/** The minor stick axis counts as the secondary direction above this. */
export const MINOR_AT = 0.35;

const DIR_BITS: readonly [number, number][] = [
  [ACT.up, Dir.N],
  [ACT.right, Dir.E],
  [ACT.down, Dir.S],
  [ACT.left, Dir.W],
];

const dirOf = (bit: number): number => (bit === ACT.up ? Dir.N : bit === ACT.right ? Dir.E : bit === ACT.down ? Dir.S : bit === ACT.left ? Dir.W : 0);

export interface Steering {
  /** The input byte for this tick, plus whether the menu was pressed. */
  sample(s: InputSample): { byte: number; menu: boolean };
  reset(): void;
}

export const createSteering = (): Steering => {
  // Held direction bits, oldest first.
  const order: number[] = [];
  let axis = 0; // 0 none, 1 horizontal, 2 vertical
  const out = { byte: 0, menu: false };
  return {
    sample(s) {
      let d1 = 0;
      let d2 = 0;
      const ax = Math.abs(s.stickX);
      const ay = Math.abs(s.stickY);
      if (ax > 0 || ay > 0) {
        if (axis === 1 && ay > ax * AXIS_SWITCH) axis = 2;
        else if (axis === 2 && ax > ay * AXIS_SWITCH) axis = 1;
        else if (axis === 0) axis = ax >= ay ? 1 : 2;
        const hx = s.stickX > 0 ? Dir.E : Dir.W;
        const vy = s.stickY > 0 ? Dir.S : Dir.N;
        if (axis === 1) {
          d1 = hx;
          if (ay > MINOR_AT) d2 = vy;
        } else {
          d1 = vy;
          if (ax > MINOR_AT) d2 = hx;
        }
        order.length = 0;
      } else {
        axis = 0;
        // Keyboard and D-pad: keep held bits in the order they went down.
        for (let i = order.length - 1; i >= 0; i -= 1) if (!(s.held & (order[i] as number))) order.splice(i, 1);
        for (let k = 0; k < DIR_BITS.length; k += 1) {
          const bit = (DIR_BITS[k] as [number, number])[0];
          if (!(s.held & bit)) continue;
          const at = order.indexOf(bit);
          if (at < 0) order.push(bit);
          else if (s.pressed & bit) {
            // Released and pressed again since the last sample: it is the newest again.
            order.splice(at, 1);
            order.push(bit);
          }
        }
        if (order.length > 0) d1 = dirOf(order[order.length - 1] as number);
        if (order.length > 1) d2 = dirOf(order[order.length - 2] as number);
      }
      out.byte = inputByte(d1, d2, (s.pressed & ACT.a) !== 0, (s.pressed & ACT.b) !== 0);
      out.menu = (s.pressed & ACT.menu) !== 0;
      return out;
    },
    reset() {
      order.length = 0;
      axis = 0;
    },
  };
};

/** The touch overlay: the stick, Pop (bomb) and Click (detonate), and a menu button. */
export const touchLayout = (prefs: ArcadePrefs): TouchLayout => ({
  stick: prefs.stick,
  buttons: [
    { id: 'a', label: 'Pop', px: prefs.buttonPx },
    { id: 'b', label: 'Click', px: 56 },
    { id: 'menu', label: 'II', px: 40 },
  ],
  deadZonePx: 12,
  radiusPx: 48,
  vibrateMs: prefs.vibrate ? 10 : 0,
  region: 'deck',
});

export type Orientation = 'portrait' | 'landscape' | 'desktop';

export interface LayoutBox {
  /** Board area inside the game element, in CSS px. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Touch controls drawn over the board (narrow side margins). */
  overlay: boolean;
  orientation: Orientation;
}

/** Portrait deck height, landscape side margin below which controls overlay the board. */
export const DECK_MIN = 200;
export const MARGIN_MIN = 140;
const GUTTER = 8;
const LEGEND_H = 28;

/** Where the board goes for a game element of `w` × `h` CSS px (pure; exported for tests). */
export const layoutFor = (w: number, h: number, coarse: boolean): LayoutBox => {
  if (!coarse) {
    return { left: GUTTER, top: GUTTER, width: Math.max(0, w - 2 * GUTTER), height: Math.max(0, h - 2 * GUTTER - LEGEND_H), overlay: false, orientation: 'desktop' };
  }
  if (h >= w) {
    // The board in the top 60 % (with a gutter), the control deck below it, at least 200 px.
    const boardH = Math.max(0, Math.min(h * 0.6, h - DECK_MIN) - GUTTER);
    return { left: GUTTER, top: GUTTER, width: Math.max(0, w - 2 * GUTTER), height: boardH, overlay: false, orientation: 'portrait' };
  }
  // Landscape: the board fits the height; the controls take the side margins when there is room.
  const boardW = Math.min(w, (h * 240) / 224);
  const margin = (w - boardW) / 2;
  return { left: 0, top: 0, width: w, height: h, overlay: margin < MARGIN_MIN, orientation: 'landscape' };
};
