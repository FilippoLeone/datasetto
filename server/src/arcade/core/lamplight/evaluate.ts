/**
 * The hand evaluator (lamplight.md §4). `eval7` takes 5 to 7 cards and returns
 * `cat << 20 | r0 << 16 | r1 << 12 | r2 << 8 | r3 << 4 | r4`: a bigger value is a better hand, equal
 * values tie. Ranks are 0–12 (two to ace) and `cat` runs from 8 (straight flush) down to 0 (high
 * card). No lookup tables; one pass over the cards, then a fixed 13-step scan of the ranks.
 */
import type { Card } from './cards.js';

export const CAT = {
  high: 0,
  pair: 1,
  twoPair: 2,
  trips: 3,
  straight: 4,
  flush: 5,
  fullHouse: 6,
  quads: 7,
  straightFlush: 8,
} as const;

export const CATEGORY_NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'] as const;

const pack = (cat: number, r0: number, r1: number, r2: number, r3: number, r4: number): number =>
  (cat << 20) | (r0 << 16) | (r1 << 12) | (r2 << 8) | (r3 << 4) | r4;

export const categoryOf = (value: number): number => value >> 20;

/** The high rank of the best straight in a 13-bit rank mask (the ace also plays low), or −1. */
export const straightHigh = (mask: number): number => {
  const x = (mask << 1) | ((mask >> 12) & 1);
  for (let h = 13; h >= 4; h--) if (((x >> (h - 4)) & 31) === 31) return h - 1;
  return -1;
};

/** The top five ranks of a rank mask, packed as five nibbles (fewer bits: zeros after). */
const top5 = (mask: number, cat: number): number => (cat << 20) | highest(mask, 5);

const counts = new Uint8Array(13);

/** Best five-card value of 5–7 cards (the first `n` entries of `cards`). */
export const eval7 = (cards: ArrayLike<Card>, n: number = cards.length): number => {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let n0 = 0;
  let n1 = 0;
  let n2 = 0;
  let n3 = 0;
  counts.fill(0);
  for (let i = 0; i < n; i++) {
    const c = cards[i];
    const r = c >> 2;
    const bit = 1 << r;
    counts[r]++;
    switch (c & 3) {
      case 0:
        s0 |= bit;
        n0++;
        break;
      case 1:
        s1 |= bit;
        n1++;
        break;
      case 2:
        s2 |= bit;
        n2++;
        break;
      default:
        s3 |= bit;
        n3++;
    }
  }
  // With at most 7 cards a flush rules out quads and a full house.
  const flushMask = n0 >= 5 ? s0 : n1 >= 5 ? s1 : n2 >= 5 ? s2 : n3 >= 5 ? s3 : 0;
  if (flushMask) {
    const h = straightHigh(flushMask);
    return h >= 0 ? pack(CAT.straightFlush, h, 0, 0, 0, 0) : top5(flushMask, CAT.flush);
  }
  let quad = -1;
  let trip0 = -1;
  let trip1 = -1;
  let pair0 = -1;
  let pair1 = -1;
  let pair2 = -1;
  let singles = 0;
  let all = 0;
  for (let r = 12; r >= 0; r--) {
    const k = counts[r];
    if (k === 0) continue;
    all |= 1 << r;
    if (k === 4) quad = r;
    else if (k === 3) {
      if (trip0 < 0) trip0 = r;
      else trip1 = r;
    } else if (k === 2) {
      if (pair0 < 0) pair0 = r;
      else if (pair1 < 0) pair1 = r;
      else pair2 = r;
    } else singles |= 1 << r;
  }
  if (quad >= 0) {
    let kicker = 0;
    for (let r = 12; r >= 0; r--) {
      if (r !== quad && all & (1 << r)) {
        kicker = r;
        break;
      }
    }
    return pack(CAT.quads, quad, kicker, 0, 0, 0);
  }
  if (trip0 >= 0 && (trip1 >= 0 || pair0 >= 0)) return pack(CAT.fullHouse, trip0, trip1 > pair0 ? trip1 : pair0, 0, 0, 0);
  const sh = straightHigh(all);
  if (sh >= 0) return pack(CAT.straight, sh, 0, 0, 0, 0);
  if (trip0 >= 0) {
    const k = highest(singles, 2);
    return pack(CAT.trips, trip0, k >> 4, k & 15, 0, 0);
  }
  if (pair1 >= 0) {
    // Two pairs: the kicker is the best remaining rank, a third pair included.
    let rest = singles;
    if (pair2 >= 0) rest |= 1 << pair2;
    return pack(CAT.twoPair, pair0, pair1, highest(rest, 1), 0, 0);
  }
  if (pair0 >= 0) {
    const k = highest(singles, 3);
    return pack(CAT.pair, pair0, (k >> 8) & 15, (k >> 4) & 15, k & 15, 0);
  }
  return top5(all, CAT.high);
};

/** The top `n` ranks of a mask as nibbles, highest first (missing ranks are 0). */
const highest = (mask: number, n: number): number => {
  let out = 0;
  let got = 0;
  for (let r = 12; r >= 0 && got < n; r--) {
    if (mask & (1 << r)) {
      out = (out << 4) | r;
      got++;
    }
  }
  for (; got < n; got++) out <<= 4;
  return out;
};

/** "Flush, ace high", "Two pair, kings and sevens" for the hand history and screen reader. */
export const describeHand = (value: number): string => {
  const cat = categoryOf(value);
  const r0 = (value >> 16) & 15;
  const r1 = (value >> 12) & 15;
  const name = CATEGORY_NAMES[cat] ?? 'Hand';
  const word = (r: number): string => RANK_WORDS[r] ?? '?';
  switch (cat) {
    case CAT.straightFlush:
      return r0 === 12 ? 'Royal straight flush' : 'Straight flush, ' + word(r0) + ' high';
    case CAT.quads:
      return 'Four ' + plural(r0);
    case CAT.fullHouse:
      return 'Full house, ' + plural(r0) + ' over ' + plural(r1);
    case CAT.flush:
    case CAT.straight:
    case CAT.high:
      return name + ', ' + word(r0) + ' high';
    case CAT.trips:
      return 'Three ' + plural(r0);
    case CAT.twoPair:
      return 'Two pair, ' + plural(r0) + ' and ' + plural(r1);
    default:
      return 'Pair of ' + plural(r0);
  }
};

const RANK_WORDS = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'jack', 'queen', 'king', 'ace'];
const plural = (r: number): string => (r === 4 ? 'sixes' : (RANK_WORDS[r] ?? '?') + 's');
