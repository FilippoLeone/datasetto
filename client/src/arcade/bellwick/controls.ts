/**
 * Controls and layout (bellwick.md §10): keys, the touch overlay, and where the canvas sits on phones
 * (portrait: full width on top, at most 60 % of the height, controls below; landscape: full height with
 * the controls in the gutters; when space is short the controls overlay the canvas at 45 % opacity).
 */
import { ACT, type TouchLayout } from '@/arcade/runtime/input';
import type { ArcadePrefs, KeyMap } from '@/arcade/runtime/types';

const { up, down, left, right, a, b, swap, menu, map } = ACT;

/** Arrows or WASD; A: J, Z or Space; B: K, X or Shift; swap: L or C; menu: Esc or P; map: M. */
export const KEYS: KeyMap = {
  ArrowUp: up,
  KeyW: up,
  ArrowDown: down,
  KeyS: down,
  ArrowLeft: left,
  KeyA: left,
  ArrowRight: right,
  KeyD: right,
  KeyJ: a,
  KeyZ: a,
  Space: a,
  KeyK: b,
  KeyX: b,
  ShiftLeft: b,
  ShiftRight: b,
  KeyL: swap,
  KeyC: swap,
  Escape: menu,
  KeyP: menu,
  KeyM: map,
};

export const touchLayout = (prefs: ArcadePrefs): TouchLayout => ({
  stick: prefs.stick,
  buttons: [
    { id: 'a', label: 'A', px: prefs.buttonPx },
    { id: 'b', label: 'B', px: 56 },
    { id: 'swap', label: '⇄', px: 40 },
    { id: 'menu', label: '≡', px: 40 },
  ],
  deadZonePx: 12,
  radiusPx: 48,
  vibrateMs: prefs.vibrate ? 10 : 0,
  region: 'overlay',
});

/**
 * Places the canvas box inside the stage. Returns true when the touch controls have room of their own
 * (opaque), false when they overlay the canvas (translucent).
 */
export const layout = (stage: HTMLElement, box: HTMLElement, coarse: boolean): boolean => {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const s = box.style;
  s.position = 'absolute';
  s.left = '0';
  s.top = '0';
  s.width = w + 'px';
  s.height = h + 'px';
  if (!coarse || w === 0 || h === 0) return true;
  if (h >= w) {
    // Portrait: canvas on top (6:5), at most 60 % of the height; controls below in at least 180 px.
    const ch = Math.min(Math.round((w * 5) / 6), Math.round(h * 0.6));
    if (h - ch < 180) return false;
    s.height = ch + 'px';
    return true;
  }
  // Landscape: full height, gutters for the controls; under 140 px of gutter the controls overlay.
  const cw = Math.round((h * 6) / 5);
  const gutter = (w - cw) / 2;
  if (gutter < 140) return false;
  s.left = Math.round(gutter) + 'px';
  s.width = cw + 'px';
  return true;
};
