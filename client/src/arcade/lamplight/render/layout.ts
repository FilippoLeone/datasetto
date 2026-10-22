/**
 * Table geometry (lamplight.md §14.4), in CSS px of the stage. Phone portrait is a tall oval with
 * you at the bottom centre and the action bar in the bottom 64 px; phone landscape a wide oval with
 * the bar as a 96 px column on the right; desktop a 16:9 table with the bar at the bottom right.
 */
import { CARD_H, CARD_W } from './art';

export type LayoutMode = 'portrait' | 'landscape' | 'desktop';

export interface SeatSpot {
  /** Avatar centre. */
  x: number;
  y: number;
  /** Where its bet sits (towards the middle). */
  betX: number;
  betY: number;
  /** Hidden or shown cards, top-left. */
  cardX: number;
  cardY: number;
  /** Unit vector from the seat towards the middle. */
  dx: number;
  dy: number;
}

export interface Layout {
  mode: LayoutMode;
  w: number;
  h: number;
  /** The area the table uses (the bar sits outside it). */
  area: { x: number; y: number; w: number; h: number };
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  seats: SeatSpot[];
  board: { x: number; y: number; scale: number; gap: number };
  pot: { x: number; y: number };
  own: { x: number; y: number; scale: number };
  /** Seat cards (others), art px scale. */
  seatScale: number;
  avatar: number;
  /** Text scale for the 5 × 7 font. */
  text: number;
  nameChars: number;
  /** The action bar's box. */
  bar: { x: number; y: number; w: number; h: number };
}

export const BAR_PORTRAIT = 64;
export const BAR_LANDSCAPE = 96;

export const modeFor = (w: number, h: number): LayoutMode => (w >= 900 && h >= 520 ? 'desktop' : w > h ? 'landscape' : 'portrait');

/** `slot` 0 is the bottom centre (you); the others go clockwise. */
export const layoutTable = (w: number, h: number, seats: number, me: number | null): Layout => {
  const mode = modeFor(w, h);
  const base = me ?? 0;
  let area: Layout['area'];
  let bar: Layout['bar'];
  if (mode === 'portrait') {
    area = { x: 0, y: 0, w, h: Math.max(0, h - BAR_PORTRAIT) };
    bar = { x: 0, y: h - BAR_PORTRAIT, w, h: BAR_PORTRAIT };
  } else if (mode === 'landscape') {
    area = { x: 0, y: 0, w: Math.max(0, w - BAR_LANDSCAPE), h };
    bar = { x: w - BAR_LANDSCAPE, y: 0, w: BAR_LANDSCAPE, h };
  } else {
    // A 16:9 table in the stage; the bar overlays the bottom right corner.
    const tw = Math.min(w, (h * 16) / 9);
    const th = (tw * 9) / 16;
    area = { x: (w - tw) / 2, y: (h - th) / 2, w: tw, h: th };
    bar = { x: w - 380, y: h - 128, w: 372, h: 120 };
  }
  const ownScale = mode === 'landscape' ? 2 : 3;
  const ownW = CARD_W * ownScale * 2 + 6;
  const ownH = CARD_H * ownScale;
  const pad = mode === 'desktop' ? 70 : 46;
  const cx = area.x + area.w / 2;
  let top: number;
  let bottom: number;
  if (mode === 'portrait') {
    top = area.y + 58;
    bottom = area.y + area.h - ownH - 28;
  } else if (mode === 'landscape') {
    top = area.y + 50;
    bottom = area.y + area.h - 56;
  } else {
    top = area.y + 70;
    bottom = area.y + area.h - 120;
  }
  const cy = (top + bottom) / 2;
  const rx = Math.max(60, area.w / 2 - pad);
  const ry = Math.max(50, (bottom - top) / 2);
  const own =
    mode === 'portrait'
      ? { x: cx - ownW / 2 + 22, y: area.y + area.h - ownH - 6, scale: ownScale }
      : { x: cx - ownW / 2 + 22, y: cy + ry - ownH / 2 + (mode === 'landscape' ? 4 : 10), scale: ownScale };
  const spots: SeatSpot[] = [];
  for (let s = 0; s < seats; s++) {
    const slot = (s - base + seats) % seats;
    const a = Math.PI / 2 + (slot * 2 * Math.PI) / seats;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    let x = cx + rx * ca;
    let y = cy + ry * sa;
    if (slot === 0) {
      // You sit beside your cards.
      x = own.x - 30;
      y = own.y + ownH / 2;
    }
    const len = Math.hypot(cx - x, cy - y) || 1;
    const dx = (cx - x) / len;
    const dy = (cy - y) / len;
    spots.push({
      x,
      y,
      // Past the name plate for seats in the top half (their plate hangs towards the middle).
      betX: x + dx * Math.max(46, Math.min(90, len * 0.45)),
      betY: y + dy * Math.max(46, Math.min(90, len * 0.45)) + (dy > 0.45 ? 30 : 0),
      cardX: x + (ca >= 0 ? -48 : 18),
      cardY: y - 14,
      dx,
      dy,
    });
  }
  const boardScale = mode === 'desktop' ? 3 : mode === 'landscape' && area.h < 400 ? 1.5 : 2;
  const gap = boardScale * 2;
  const boardW = 5 * CARD_W * boardScale + 4 * gap;
  return {
    mode,
    w,
    h,
    area,
    cx,
    cy,
    rx,
    ry,
    seats: spots,
    board: { x: cx - boardW / 2, y: cy - (CARD_H * boardScale) / 2, scale: boardScale, gap },
    // Below the board: the side seats' plates crowd the space above it on narrow phones.
    pot: { x: cx, y: cy + (CARD_H * boardScale) / 2 + 8 },
    own,
    seatScale: mode === 'desktop' ? 1.5 : 1,
    avatar: mode === 'desktop' ? 48 : 40,
    text: 2,
    nameChars: seats >= 8 && mode !== 'desktop' ? 6 : 8,
    bar,
  };
};
