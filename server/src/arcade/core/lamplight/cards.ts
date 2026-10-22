/**
 * Cards for Lamplight Hold'em (lamplight.md §3). A card is an integer 0–51: `rank = c >> 2` (0 is a
 * two, 12 an ace) and `suit = c & 3`, in the order clubs, diamonds, hearts, spades.
 *
 * The shuffle is a Fisher–Yates over an injected `randInt(n)`: on the server `crypto.randomInt`,
 * offline xoshiro128** seeded from `crypto.getRandomValues`. Core itself never draws randomness.
 */
import type { RandInt } from '../rng.js';

export type Card = number;

export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';
export const DECK_SIZE = 52;

export const rankOf = (c: Card): number => c >> 2;
export const suitOf = (c: Card): number => c & 3;
export const cardOf = (rank: number, suit: number): Card => (rank << 2) | suit;

export const isCard = (v: unknown): v is Card => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < DECK_SIZE;

/** "As" → 51; null for anything else. Accepts lower-case ranks and the suit symbols. */
export const parseCard = (text: string): Card | null => {
  if (text.length !== 2) return null;
  const rank = RANKS.indexOf(text[0].toUpperCase());
  const suitChar = text[1];
  let suit = SUITS.indexOf(suitChar.toLowerCase());
  if (suit < 0) suit = '♣♦♥♠'.indexOf(suitChar);
  return rank < 0 || suit < 0 ? null : cardOf(rank, suit);
};

/** "As Kd 2c" → [51, 45, 0]; throws on a bad card (tests and fixtures only). */
export const parseCards = (text: string): Card[] => {
  const out: Card[] = [];
  for (const part of text.trim().split(/\s+/)) {
    if (!part) continue;
    const c = parseCard(part);
    if (c === null) throw new Error('bad card ' + part);
    out.push(c);
  }
  return out;
};

export const formatCard = (c: Card): string => RANKS[rankOf(c)] + SUITS[suitOf(c)];
export const formatCards = (cards: readonly Card[]): string => cards.map(formatCard).join(' ');

/** A fresh ordered deck, 0–51. */
export const newDeck = (): Card[] => {
  const deck: Card[] = [];
  for (let c = 0; c < DECK_SIZE; c++) deck.push(c);
  return deck;
};

/** Fisher–Yates in place with an injected uniform `randInt(n)` in [0, n). Returns the deck. */
export const shuffle = <T>(deck: T[], randInt: RandInt): T[] => {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    const t = deck[i];
    deck[i] = deck[j];
    deck[j] = t;
  }
  return deck;
};

/**
 * The 169 starting-hand classes: 0–12 pairs (22 … AA), then suited and offsuit combinations.
 * Index = hi * 13 + lo for suited (hi > lo), lo * 13 + hi for offsuit, r * 13 + r for pairs, so
 * every class is one cell of a 13 × 13 grid.
 */
export const classOf = (a: Card, b: Card): number => {
  const ra = rankOf(a);
  const rb = rankOf(b);
  const hi = ra > rb ? ra : rb;
  const lo = ra > rb ? rb : ra;
  if (hi === lo) return hi * 13 + hi;
  return suitOf(a) === suitOf(b) ? hi * 13 + lo : lo * 13 + hi;
};

/** "AKs", "72o", "TT" for a class index. */
export const className = (cls: number): string => {
  const row = Math.floor(cls / 13);
  const col = cls % 13;
  if (row === col) return RANKS[row] + RANKS[row];
  return row > col ? RANKS[row] + RANKS[col] + 's' : RANKS[col] + RANKS[row] + 'o';
};

/** Combinations in a class: 6 for a pair, 4 suited, 12 offsuit (1,326 in all). */
export const classCombos = (cls: number): number => {
  const row = Math.floor(cls / 13);
  const col = cls % 13;
  return row === col ? 6 : row > col ? 4 : 12;
};
