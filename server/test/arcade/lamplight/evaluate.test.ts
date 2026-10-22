/**
 * The hand evaluator (lamplight.md §4, §18.1): the spec's vectors, the exact five-card category
 * counts over all 2,598,960 hands, 100k seeded seven-card hands against a brute-force best of 21,
 * and the equity oracle by exact enumeration.
 */
import { describe, expect, it } from 'vitest';
import { parseCards, newDeck, shuffle, type Card } from '../../../src/arcade/core/lamplight/cards.js';
import { CAT, categoryOf, describeHand, eval7, straightHigh } from '../../../src/arcade/core/lamplight/evaluate.js';
import { randInt, seedXoshiro, xoshiro128ss } from '../../../src/arcade/core/rng.js';

const ev = (text: string): number => eval7(parseCards(text));

describe('eval7 vectors (lamplight.md §4)', () => {
  it('ranks the spec hands', () => {
    const sfAce = ev('As Ks Qs Js Ts 2d 3c');
    expect(categoryOf(sfAce)).toBe(CAT.straightFlush);
    expect((sfAce >> 16) & 15).toBe(12);

    const wheelSf = ev('Ad 2d 3d 4d 5d 9c 9h');
    expect(categoryOf(wheelSf)).toBe(CAT.straightFlush);
    expect((wheelSf >> 16) & 15).toBe(3);

    const wheel = ev('Ah 2c 3d 4s 5h Kd Kc');
    expect(categoryOf(wheel)).toBe(CAT.straight);
    expect((wheel >> 16) & 15).toBe(3);
    expect(ev('6c 2c 3d 4s 5h Kd Kc')).toBeGreaterThan(wheel);

    const flush = ev('7h 8h 9h Th Jc 2h Qd');
    expect(categoryOf(flush)).toBe(CAT.flush);
    expect(flush).toBe(ev('Th 9h 8h 7h 2h'));
    expect(flush).toBeGreaterThan(ev('8c 9d Td Jc Qd'));

    expect(ev('2h 4h 6h 8h Th Qh Ah')).toBe(ev('Ah Qh Th 8h 6h'));

    const fhK7 = ev('Kh Kd Kc 7s 7h 7d 2c');
    expect(categoryOf(fhK7)).toBe(CAT.fullHouse);
    expect([(fhK7 >> 16) & 15, (fhK7 >> 12) & 15]).toEqual([11, 5]);

    const fhQ9 = ev('Qs Qh Qd 9s 9h 5c 5d');
    expect([(fhQ9 >> 16) & 15, (fhQ9 >> 12) & 15]).toEqual([10, 7]);

    const quads = ev('8s 8h 8d 8c Ad Kc Qh');
    expect(categoryOf(quads)).toBe(CAT.quads);
    expect([(quads >> 16) & 15, (quads >> 12) & 15]).toEqual([6, 12]);

    const twoPair = ev('As Ah Ks Kh 9c 9d 7s');
    expect(categoryOf(twoPair)).toBe(CAT.twoPair);
    expect([(twoPair >> 16) & 15, (twoPair >> 12) & 15, (twoPair >> 8) & 15]).toEqual([12, 11, 7]);

    const nineHigh = ev('5c 6d 7h 8s 9c 9d 9h');
    expect(categoryOf(nineHigh)).toBe(CAT.straight);
    expect((nineHigh >> 16) & 15).toBe(7);
  });

  it('splits when the board plays, and decides kickers', () => {
    const board = 'Ah Kh Qh Jh Th';
    expect(ev(board + ' 2c 3d')).toBe(ev(board + ' 9s 9d'));

    const b2 = ' Ac 7d 4s 2h 9c';
    expect(ev('As Kd' + b2)).toBeGreaterThan(ev('Ad Qs' + b2));

    const b3 = ' 9s 9d 6c 6h Ks';
    expect(ev('Ac 2d' + b3)).toBeGreaterThan(ev('Qc Jd' + b3));
  });

  it('finds straights with the ace low and high', () => {
    expect(straightHigh(0b1000000001111)).toBe(3);
    expect(straightHigh(0b1111100000000)).toBe(12);
    expect(straightHigh(0b0000000011110)).toBe(-1);
    expect(describeHand(ev('As Ks Qs Js Ts'))).toBe('Royal straight flush');
    expect(describeHand(ev('Kh Kd Kc 7s 7h'))).toBe('Full house, kings over sevens');
  });
});

describe('eval7 exhaustively', () => {
  it('gives the exact category counts over all 2,598,960 five-card hands', () => {
    const counts = new Array<number>(9).fill(0);
    const hand = new Int32Array(5);
    for (let a = 0; a < 52; a++) {
      hand[0] = a;
      for (let b = a + 1; b < 52; b++) {
        hand[1] = b;
        for (let c = b + 1; c < 52; c++) {
          hand[2] = c;
          for (let d = c + 1; d < 52; d++) {
            hand[3] = d;
            for (let e = d + 1; e < 52; e++) {
              hand[4] = e;
              counts[eval7(hand, 5) >> 20]++;
            }
          }
        }
      }
    }
    expect(counts.slice().reverse()).toEqual([40, 624, 3744, 5108, 10200, 54912, 123552, 1098240, 1302540]);
  });

  it('matches a brute-force best of 21 on 100,000 seeded seven-card hands', () => {
    const state = seedXoshiro(0x1a2b3c);
    const next = () => xoshiro128ss(state);
    const five = new Int32Array(5);
    let mismatches = 0;
    for (let t = 0; t < 100_000; t++) {
      const deck = newDeck();
      // A partial shuffle is enough: the first seven cards.
      for (let i = 0; i < 7; i++) {
        const j = i + randInt(next, 52 - i);
        const tmp = deck[i];
        deck[i] = deck[j];
        deck[j] = tmp;
      }
      const seven = deck.slice(0, 7);
      let best = -1;
      for (let skipA = 0; skipA < 7; skipA++) {
        for (let skipB = skipA + 1; skipB < 7; skipB++) {
          let k = 0;
          for (let i = 0; i < 7; i++) if (i !== skipA && i !== skipB) five[k++] = seven[i];
          const v = eval7(five, 5);
          if (v > best) best = v;
        }
      }
      if (eval7(seven) !== best) mismatches++;
    }
    expect(mismatches).toBe(0);
  });
});

describe('equity oracle', () => {
  it('Ah Kh against Qs Qd on 2h 7h Qc 9s: 7 outs in 44, 15.909 %', () => {
    const hero = parseCards('Ah Kh');
    const villain = parseCards('Qs Qd');
    const board = parseCards('2h 7h Qc 9s');
    const used = new Set<Card>([...hero, ...villain, ...board]);
    let wins = 0;
    let ties = 0;
    let total = 0;
    for (let river = 0; river < 52; river++) {
      if (used.has(river)) continue;
      total++;
      const h = eval7([...hero, ...board, river]);
      const v = eval7([...villain, ...board, river]);
      if (h > v) wins++;
      else if (h === v) ties++;
    }
    expect(total).toBe(44);
    expect(ties).toBe(0);
    expect(wins).toBe(7);
    expect(((wins / total) * 100).toFixed(3)).toBe('15.909');
  });

  it('shuffles a full deck with an injected randInt', () => {
    const state = seedXoshiro(7);
    const deck = shuffle(newDeck(), (n) => randInt(() => xoshiro128ss(state), n));
    expect(deck.slice().sort((a, b) => a - b)).toEqual(newDeck());
    expect(deck).not.toEqual(newDeck());
  });
});
