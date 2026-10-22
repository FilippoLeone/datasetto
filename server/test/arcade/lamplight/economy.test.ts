/**
 * Economy and fairness pieces of the core (lamplight.md §18.1): the Firefly table mapped over every
 * draw value, the table validator, prize splits that always sum to the pool, blind schedules, and
 * the deck proof (build, verify, tamper, and what it may reveal).
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { b64url, fromB64url } from '../../../src/arcade/core/bytes.js';
import { abandonedSplit, bustGroups, cupPercents, settlePlaces, splitPool, tieShares } from '../../../src/arcade/core/lamplight/payouts.js';
import { buildProof, commitSync, revealPositions, verify, type Proof } from '../../../src/arcade/core/lamplight/proof.js';
import { blindsAt, levelAt, tableConfig } from '../../../src/arcade/core/lamplight/schedule.js';
import { DEFAULT_TRIO_TABLE, drawMultiplier, evE6, TRIO_SPACE, validateTrioTable, type TrioRow } from '../../../src/arcade/core/lamplight/trio.js';
import { rng, shuffledDeck } from './helpers.js';

const sha = (d: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(d).digest());
const shaAsync = async (d: Uint8Array): Promise<Uint8Array> => sha(d);

describe('Firefly Trio table', () => {
  it('maps all 1,000,000 draw values onto the table exactly, EV 2.9725', () => {
    const t0 = performance.now();
    const counts = new Map<number, number>();
    let sumMult = 0;
    for (let u = 0; u < TRIO_SPACE; u++) {
      const row = drawMultiplier(DEFAULT_TRIO_TABLE, u);
      counts.set(row.mult, (counts.get(row.mult) ?? 0) + 1);
      sumMult += row.mult;
    }
    expect(performance.now() - t0).toBeLessThan(500);
    for (const row of DEFAULT_TRIO_TABLE) expect(counts.get(row.mult)).toBe(row.weight);
    expect(sumMult).toBe(2_972_500);
    expect(evE6(DEFAULT_TRIO_TABLE)).toBe(2_972_500);
    expect(validateTrioTable(DEFAULT_TRIO_TABLE)).toBeNull();
  });

  it('rejects tables with an average of 3 or more, or bad weights', () => {
    const generous: TrioRow[] = DEFAULT_TRIO_TABLE.map((r) => ({ ...r }));
    generous[0] = { ...generous[0], mult: 3 };
    expect(evE6(generous)).toBeGreaterThanOrEqual(3_000_000);
    expect(validateTrioTable(generous)).toMatch(/below 3/);
    const exactlyThree: TrioRow[] = [{ mult: 3, weight: TRIO_SPACE, pay: [100, 0, 0] }];
    expect(validateTrioTable(exactlyThree)).toMatch(/below 3/);
    const short: TrioRow[] = DEFAULT_TRIO_TABLE.map((r) => ({ ...r }));
    short[0] = { ...short[0], weight: 739_999 };
    expect(validateTrioTable(short)).toMatch(/1,000,000/);
    expect(validateTrioTable([{ mult: 2, weight: TRIO_SPACE, pay: [90, 5, 4] }])).toMatch(/100/);
  });
});

describe('prize splits', () => {
  it('sums to the pool for every Cup size and pool', () => {
    for (let players = 2; players <= 9; players++) {
      for (const pool of [1000, 1001, 4000, 6000, 9999, 90_001]) {
        const shares = splitPool(pool, cupPercents(players));
        expect(shares.reduce((a, b) => a + b, 0)).toBe(pool);
        expect(shares.length).toBe(players <= 3 ? 1 : players <= 5 ? 2 : 3);
        for (let i = 1; i < shares.length; i++) expect(shares[0]).toBeGreaterThanOrEqual(shares[i]);
      }
    }
  });

  it('sums to the pool for every Trio row', () => {
    for (const row of DEFAULT_TRIO_TABLE) {
      for (const buyIn of [200, 1000, 5000]) {
        const pool = buyIn * row.mult;
        expect(splitPool(pool, row.pay).reduce((a, b) => a + b, 0)).toBe(pool);
      }
    }
  });

  it('splits tied places and gives the odd chip to the first in order', () => {
    expect(tieShares(101, 2)).toEqual([51, 50]);
    const prizes = splitPool(10_001, [50, 30, 20]);
    const places = settlePlaces(prizes, [['a'], ['b', 'c'], ['d']]);
    expect(places.get('a')).toBe(prizes[0]);
    expect((places.get('b') ?? 0) + (places.get('c') ?? 0)).toBe(prizes[1] + prizes[2]);
    expect(places.get('d')).toBe(0);
    expect([...places.values()].reduce((x, y) => x + y, 0)).toBe(10_001);
    // Same hand: bigger starting stack places higher; equal stacks share, clockwise from the button.
    expect(bustGroups([{ id: 'x', startStack: 300, seat: 1 }, { id: 'y', startStack: 900, seat: 4 }, { id: 'z', startStack: 300, seat: 5 }], 3, 6)).toEqual([['y'], ['z', 'x']]);
  });

  it('pays human-only Cup places from human buy-ins', () => {
    // Two humans and four bots, 2,000 each: the pool is 4,000 and first place takes it all.
    const pool = 2 * 2000;
    const places = settlePlaces(splitPool(pool, cupPercents(2)), [['h1'], ['h2']]);
    expect(places.get('h1')).toBe(4000);
    expect(places.get('h2')).toBe(0);
  });

  it('splits an abandoned tournament by stacks, remainder to the biggest', () => {
    const shares = abandonedSplit(1000, [300, 600, 101]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(shares[1]).toBeGreaterThan(shares[0]);
    expect(abandonedSplit(7, [0, 0])).toEqual([4, 3]);
    for (let i = 0; i < 200; i++) {
      const stacks = Array.from({ length: 1 + (i % 6) }, (_, k) => (i * 37 + k * 101) % 4000);
      const unpaid = 1 + ((i * 7919) % 50_000);
      expect(abandonedSplit(unpaid, stacks).reduce((a, b) => a + b, 0)).toBe(unpaid);
    }
  });
});

describe('blind schedules', () => {
  it('follows the Cup and Trio tables, then grows by ×1.5 and ×1.25 rounded to 10', () => {
    expect(blindsAt('cup', 0)).toEqual({ sb: 10, bb: 20 });
    expect(blindsAt('cup', 12)).toEqual({ sb: 1000, bb: 2000 });
    expect(blindsAt('cup', 13)).toEqual({ sb: 1500, bb: 3000 });
    expect(blindsAt('cup', 14)).toEqual({ sb: 2250, bb: 4500 });
    expect(blindsAt('trio', 11)).toEqual({ sb: 200, bb: 400 });
    expect(blindsAt('trio', 12)).toEqual({ sb: 250, bb: 500 });
    for (let i = 0; i < 80; i++) {
      for (const f of ['cup', 'trio'] as const) {
        const b = blindsAt(f, i);
        expect(b.sb % 5).toBe(0);
        expect(b.bb).toBe(b.sb * 2);
      }
    }
  });

  it('reads levels from elapsed time online and hand counts offline', () => {
    expect(levelAt('cup', { elapsedMs: 0, startedAt: 1000 })).toMatchObject({ index: 0, bb: 20, endsAt: 301_000 });
    expect(levelAt('cup', { elapsedMs: 5 * 60_000, startedAt: 0 })).toMatchObject({ index: 1, bb: 30 });
    expect(levelAt('trio', { hands: 4 })).toMatchObject({ index: 0, endsAfterHand: 5 });
    expect(levelAt('trio', { hands: 5 })).toMatchObject({ index: 1, bb: 30 });
    expect(tableConfig({ format: 'open', tier: 'cobble', seats: 6, bots: null })).toMatchObject({ buyInMin: 2000, buyInMax: 5000, actionMs: 15_000, timeBankMs: 30_000 });
    expect(tableConfig({ format: 'trio', seats: 9, bots: null })).toMatchObject({ seats: 3, actionMs: 10_000, timeBankMs: 15_000 });
  });
});

describe('deck proof', () => {
  const deal = () => {
    const deck = shuffledDeck(rng(99));
    const secret = randomBytes(32);
    const salts = deck.map((_, i) => new Uint8Array(createHmac('sha256', secret).update(Uint8Array.of(i)).digest()).subarray(0, 16));
    const { leaves, root } = commitSync(deck, salts, sha);
    return { deck, salts, leaves, root };
  };

  it('builds a proof that verifies, and fails on any changed card, salt or leaf', async () => {
    const { deck, salts, leaves, root } = deal();
    // Four players: deal order seats [1, 2, 3, 0]; viewer seat 2; seat 3 showed; full board.
    const positions = revealPositions({ dealt: [1, 2, 3, 0], board: 5, shown: [3], viewer: 2 });
    expect(positions).toEqual([1, 2, 5, 6, 8, 9, 10, 11, 12]);
    const proof = buildProof(
      leaves,
      root,
      positions.map((i) => ({ i, c: deck[i], salt: salts[i] })),
    );
    const cr = b64url(root);
    const expected = positions.map((i) => ({ i, c: deck[i] }));
    expect(await verify(proof, cr, expected, shaAsync)).toEqual({ ok: true });
    expect(proof.L.length).toBe(2219);

    const swapCard: Proof = { ...proof, rv: proof.rv.map((r, k) => (k === 0 ? { ...r, c: (r.c + 1) % 52 } : r)) };
    expect(await verify(swapCard, cr, expected, shaAsync)).toMatchObject({ ok: false });

    const badSalt = fromB64url(proof.rv[1].s) as Uint8Array;
    badSalt[0] ^= 1;
    const swapSalt: Proof = { ...proof, rv: proof.rv.map((r, k) => (k === 1 ? { ...r, s: b64url(badSalt) } : r)) };
    expect(await verify(swapSalt, cr, expected, shaAsync)).toEqual({ ok: false, why: 'leaf' });

    const L = fromB64url(proof.L) as Uint8Array;
    L[40 * 32] ^= 1; // an unrevealed leaf: the root no longer matches
    expect(await verify({ ...proof, L: b64url(L) }, cr, expected, shaAsync)).toEqual({ ok: false, why: 'root' });

    expect(await verify(proof, b64url(sha(Uint8Array.of(1))), expected, shaAsync)).toEqual({ ok: false, why: 'commitment' });
    expect(await verify(proof, cr, [...expected, { i: 3, c: deck[3] }], shaAsync)).toEqual({ ok: false, why: 'cards' });
  });

  it('never reveals a mucked or undealt card', () => {
    for (let players = 2; players <= 9; players++) {
      const dealt = Array.from({ length: players }, (_, i) => (i + 3) % 9);
      for (let board = 0; board <= 5; board++) {
        const shown = dealt.filter((_, i) => i % 3 === 1);
        const viewer = dealt[0];
        const pos = revealPositions({ dealt, board, shown, viewer });
        const allowed = new Set<number>();
        dealt.forEach((seat, i) => {
          if (seat === viewer || shown.includes(seat)) allowed.add(i).add(players + i);
        });
        for (let b = 0; b < board; b++) allowed.add(2 * players + b);
        expect(pos.every((p) => allowed.has(p))).toBe(true);
        expect(pos.length).toBe(allowed.size);
        expect(Math.max(-1, ...pos)).toBeLessThan(2 * players + board);
      }
    }
  });
});
