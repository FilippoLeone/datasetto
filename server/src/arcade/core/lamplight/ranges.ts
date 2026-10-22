/**
 * Preflop ranges for the bots (lamplight.md §13): hand percentiles from the committed 169-class
 * order, opening ranges by position, 3-bet and calling ranges, and the push/fold table for short
 * stacks. A range of 0.2 means "the strongest 20 % of the 1,326 starting hands".
 */
import { classCombos, classOf, className, type Card } from './cards.js';
import type { BotLevel, TableState } from './engine.js';
import { RANKS169_ORDER } from './ranks169.js';

/** Percentile of each class: the middle of its slice of the 1,326 hands, strongest first. */
export const CLASS_PCT: readonly number[] = (() => {
  const names = RANKS169_ORDER.split(' ');
  const order = names.map((name) => {
    for (let cls = 0; cls < 169; cls++) if (className(cls) === name) return cls;
    return -1;
  });
  const pct = new Array<number>(169).fill(1);
  let before = 0;
  for (const cls of order) {
    if (cls < 0) continue;
    const combos = classCombos(cls);
    pct[cls] = (before + combos / 2) / 1326;
    before += combos;
  }
  return pct;
})();

/** Strength percentile of two hole cards (0 = the very best). */
export const handPct = (a: Card, b: Card): number => CLASS_PCT[classOf(a, b)];

export type Position = 'EP' | 'MP' | 'CO' | 'BTN' | 'SB' | 'BB' | 'HU';

/** A seat's preflop position at this table (heads-up the button is 'HU'). */
export const positionOf = (state: TableState, seat: number): Position => {
  const hand = state.hand;
  if (!hand) return 'EP';
  const dealt: number[] = [];
  for (let i = 1; i <= state.seats.length; i++) {
    const idx = (hand.button + i) % state.seats.length;
    if (state.seats[idx].inHand) dealt.push(idx);
  }
  if (dealt.length === 2) return seat === hand.button ? 'HU' : 'BB';
  if (seat === hand.button) return 'BTN';
  if (seat === hand.sbSeat) return 'SB';
  if (seat === hand.bbSeat) return 'BB';
  // Seats from the big blind's left up to the button: the last one is the cutoff.
  const fromBB = dealt.indexOf(hand.bbSeat);
  const middle = dealt.slice(fromBB + 1).filter((s) => s !== hand.button);
  const k = middle.indexOf(seat);
  if (k === middle.length - 1) return 'CO';
  if (k === middle.length - 2 && middle.length >= 3) return 'MP';
  return 'EP';
};

/** Open-raise ranges by position. Heads-up the button opens wide. */
export const OPEN: Readonly<Record<'regular' | 'sharp', Readonly<Record<Position, number>>>> = {
  regular: { EP: 0.15, MP: 0.2, CO: 0.27, BTN: 0.38, SB: 0.3, BB: 0.3, HU: 0.6 },
  sharp: { EP: 0.14, MP: 0.19, CO: 0.27, BTN: 0.42, SB: 0.36, BB: 0.36, HU: 0.7 },
};

export const THREE_BET: Readonly<Record<BotLevel, number>> = { greenhorn: 0.08, regular: 0.05, sharp: 0.07 };

/** Calling a raise: twice the 3-bet range, or this much when defending the big blind. */
export const DEFEND_BB = 0.35;

/** Greenhorn: limps or calls with the top 60 %, raises only the top 8 %. */
export const GREENHORN = { play: 0.6, raise: 0.08 } as const;

/** Push/fold shove range by effective stack in big blinds (≤ 15 BB), doubled when only the big blind is left. */
export const pushRange = (stackBB: number): number => (stackBB <= 4 ? 0.6 : stackBB <= 7 ? 0.4 : stackBB <= 10 ? 0.28 : 0.18);

/** Calling an all-in of `shoveBB` big blinds: about half the range that would shove it. */
export const callShoveRange = (shoveBB: number): number => (shoveBB <= 15 ? pushRange(shoveBB) / 2 : shoveBB <= 30 ? 0.06 : 0.035);

/** Suited aces outside the value range: Sharp's 3-bet bluffs. */
export const isSuitedAce = (a: Card, b: Card): boolean => (a & 3) === (b & 3) && ((a >> 2) === 12 || (b >> 2) === 12);

/** Opponent range for equity, by what they did preflop (Regular): raised 20 %, called 50 %, limped 70 %. */
export const REGULAR_RANGE = { raised: 0.2, called: 0.5, limped: 0.7, none: 1 } as const;
