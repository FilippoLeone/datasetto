/**
 * Bots (lamplight.md §13, §18.1): the committed 169-class table, ranges, board texture, and that
 * every decision of every level is a legal action and bot-only tables finish their hands.
 */
import { describe, expect, it } from 'vitest';
import { classOf, parseCards } from '../../../src/arcade/core/lamplight/cards.js';
import { act, advance, pendingDelay, startHand, tableChips, updateSeat, type BotLevel } from '../../../src/arcade/core/lamplight/engine.js';
import { BOT_TRIALS, BOTS, createThinker, hasDraw, isDry, thinkMs } from '../../../src/arcade/core/lamplight/bots.js';
import { CLASS_PCT, handPct, positionOf, pushRange } from '../../../src/arcade/core/lamplight/ranges.js';
import { RANKS169_HASH, RANKS169_ORDER, RANKS169_SCORE } from '../../../src/arcade/core/lamplight/ranks169.js';
import { viewFor } from '../../../src/arcade/core/lamplight/views.js';
import { fnv1a32 } from '../../../src/arcade/core/hash.js';
import { utf8Encode } from '../../../src/arcade/core/bytes.js';
import { makeTable, rng, shuffledDeck } from './helpers.js';

describe('the 169-class table', () => {
  it('matches its recorded hash and orders AA first and 72o last', () => {
    expect(fnv1a32(utf8Encode(RANKS169_ORDER)) >>> 0).toBe(RANKS169_HASH);
    const names = RANKS169_ORDER.split(' ');
    expect(names).toHaveLength(169);
    expect(new Set(names).size).toBe(169);
    expect(names[0]).toBe('AA');
    expect(names[168]).toBe('72o');
    expect(RANKS169_SCORE).toHaveLength(169);
    for (let i = 1; i < 169; i++) expect(RANKS169_SCORE[i]).toBeLessThanOrEqual(RANKS169_SCORE[i - 1]);
    expect(RANKS169_ORDER.length).toBeLessThan(1200);
  });

  it('turns the order into percentiles', () => {
    expect(handPct(...(parseCards('As Ah') as [number, number]))).toBeLessThan(0.005);
    expect(handPct(...(parseCards('7c 2d') as [number, number]))).toBeGreaterThan(0.99);
    expect(handPct(...(parseCards('Ks Qs') as [number, number]))).toBeLessThan(handPct(...(parseCards('Kd Qc') as [number, number])));
    expect(CLASS_PCT[classOf(51, 47)]).toBeLessThan(0.05);
    expect(Math.min(...CLASS_PCT)).toBeGreaterThan(0);
    expect(Math.max(...CLASS_PCT)).toBeLessThan(1);
    expect([pushRange(3), pushRange(6), pushRange(9), pushRange(14)]).toEqual([0.6, 0.4, 0.28, 0.18]);
  });
});

describe('board reading', () => {
  it('tells dry boards from wet ones', () => {
    expect(isDry(parseCards('Ks 7d 2c'))).toBe(true);
    expect(isDry(parseCards('Ks 7s 2s'))).toBe(false);
    expect(isDry(parseCards('Ks Kd 2c'))).toBe(false);
    expect(isDry(parseCards('9s 8d 6c'))).toBe(false);
    expect(isDry(parseCards('Ad 3c 4h'))).toBe(false);
  });

  it('finds flush and open-ended straight draws', () => {
    expect(hasDraw(parseCards('Ah 5h'), parseCards('Kh 9h 2c'))).toBe(true);
    expect(hasDraw(parseCards('9c 8d'), parseCards('7s 6h Kd'))).toBe(true);
    expect(hasDraw(parseCards('Ac 2d'), parseCards('Ks 9h 5c'))).toBe(false);
    expect(hasDraw(parseCards('9c 8d'), parseCards('7s 6h Kd 2c 3c'))).toBe(false);
  });

  it('names positions around the table', () => {
    const state = makeTable([1000, 1000, 1000, 1000, 1000, 1000]);
    startHand(state, shuffledDeck(rng(1)), 0, 0);
    expect([0, 1, 2, 3, 4, 5].map((s) => positionOf(state, s))).toEqual(['BTN', 'SB', 'BB', 'EP', 'MP', 'CO']);
    expect(thinkMs('open', true, 0.9)).toBe(150);
    expect(thinkMs('open', false, 0.999)).toBeLessThanOrEqual(2200);
    expect(thinkMs('trio', false, 0)).toBe(400);
    expect(BOTS).toHaveLength(9);
  });
});

describe('bot play', () => {
  it('only ever chooses legal actions, at every level', () => {
    const r = rng(11);
    const levels: BotLevel[] = ['greenhorn', 'regular', 'sharp'];
    let decisions = 0;
    for (let t = 0; t < 40; t++) {
      const n = 2 + (t % 8);
      const stacks = Array.from({ length: n }, (_, i) => (i === t % n ? 120 : 400 + r.int(3000)));
      const state = makeTable(stacks, { format: t % 4 === 0 ? 'cup' : 'open' });
      const total = tableChips(state);
      startHand(state, shuffledDeck(r), 0, r.int(n));
      for (let g = 0; g < 300 && state.hand!.street !== 'done'; g++) {
        if (pendingDelay(state) !== null) {
          advance(state, 0);
          continue;
        }
        const seat = state.hand!.toAct;
        const level = levels[(seat + t) % 3];
        const th = createThinker(viewFor(state, seat), seat, level, r.u32(), { maxTrials: t % 2 ? 100 : BOT_TRIALS.server[level] });
        for (let i = 0; i < 10 && !th.step(200); i++);
        const res = act(state, seat, th.decide(), 0);
        expect(res.ok).toBe(true);
        decisions++;
      }
      expect(state.hand!.street).toBe('done');
      expect(tableChips(state)).toBe(total);
    }
    expect(decisions).toBeGreaterThan(150);
  });

  it('a bot-only table plays 150 hands with conserved chips', () => {
    const r = rng(12);
    const state = makeTable([1500, 1500, 1500, 1500, 1500, 1500]);
    const levels: BotLevel[] = ['sharp', 'greenhorn', 'greenhorn', 'regular', 'greenhorn', 'greenhorn'];
    for (let h = 0; h < 150; h++) {
      for (const s of state.seats) if (s.stack === 0) updateSeat(state, s.seat, { status: 'active', stack: 1500 });
      const total = tableChips(state);
      startHand(state, shuffledDeck(r), 0, 0);
      for (let g = 0; g < 300 && state.hand!.street !== 'done'; g++) {
        if (pendingDelay(state) !== null) {
          advance(state, 0);
          continue;
        }
        const seat = state.hand!.toAct;
        const th = createThinker(viewFor(state, seat), seat, levels[seat], r.u32(), { maxTrials: 60 });
        th.step(60);
        const res = act(state, seat, th.decide(), 0);
        if (!res.ok) throw new Error('refused ' + res.code);
      }
      expect(state.hand!.street).toBe('done');
      expect(tableChips(state)).toBe(total);
    }
  });
});
