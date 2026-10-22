/**
 * The table layout: at every stage size the game runs in (phones both ways, the online stage under
 * the voice strip, desktop), no other seat's name plate covers the board.
 */
import { describe, expect, it } from 'vitest';
import { CARD_H, CARD_W } from './art';
import { layoutTable } from './layout';

const SIZES: [number, number][] = [
  [360, 640],
  [390, 844],
  [390, 515], // the online stage on a phone, under the header and voice strip
  [360, 480],
  [640, 360],
  [784, 340], // the online stage on a laptop, under the voice strip
  [568, 320],
  [1280, 720],
  [1024, 600],
];

describe('table layout', () => {
  it('keeps name plates off the board and inside the table for 2 to 9 seats at every stage size', () => {
    const bad: string[] = [];
    for (const [w, h] of SIZES) {
      for (let seats = 2; seats <= 9; seats++) {
        const l = layoutTable(w, h, seats, 0);
        const bw = 5 * CARD_W * l.board.scale + 4 * l.board.gap;
        const bh = CARD_H * l.board.scale;
        const r = l.avatar / 2;
        const half = (l.nameChars * 6 * l.text + 8) / 2;
        l.seats.forEach((sp, s) => {
          // Every plate, yours included, stays inside the table area.
          if (sp.y + r + 38 > l.area.y + l.area.h + 1) bad.push(`${w}x${h} ${seats} seats: seat ${s} plate below the edge`);
          if (s === 0) return;
          const x0 = sp.x - half;
          const x1 = sp.x + half;
          const y0 = sp.y + r + 2;
          const y1 = sp.y + r + 38;
          if (x1 > l.board.x && x0 < l.board.x + bw && y1 > l.board.y && y0 < l.board.y + bh) bad.push(`${w}x${h} ${seats} seats: seat ${s} (board ×${l.board.scale})`);
        });
        expect(l.board.scale).toBeGreaterThanOrEqual(1.25);
      }
    }
    expect(bad).toEqual([]);
  });

  it('keeps the full-size board where there is room', () => {
    expect(layoutTable(360, 640, 6, 0).board.scale).toBe(2);
    expect(layoutTable(1280, 720, 9, 0).board.scale).toBe(3);
  });
});
