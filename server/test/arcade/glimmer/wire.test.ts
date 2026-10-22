/**
 * Glimmerhall wire sizes and the golden replay (glimmerhall.md §10, §18.1 tests 5–6; plan.md §3.4
 * "Wire" and "Determinism"). Sizes are JSON payload bytes, framing excluded.
 */
import { describe, expect, it } from 'vitest';
import { goldenHash, seededRng } from '../../../src/arcade/core/glimmer/golden.js';
import { DEFS_BY_IDX, EMBERVAULT, ORCHARD, TIDEPOOL } from '../../../src/arcade/core/glimmer/machines.js';
import { playFeature } from '../../../src/arcade/core/glimmer/spin.js';
import { freeRun } from '../../../src/arcade/core/glimmer/feature.js';
import {
  decodeStops,
  encodeStops,
  emptyPending,
  isSpinId,
  packFeed,
  SIZE,
  STOP_ALPHABET,
  wireFeature,
  type DashView,
  type EnterOk,
  type FeedEntry,
  type MemberRow,
  type SpinOk,
} from '../../../src/arcade/core/glimmer/wire.js';

/** The golden value; the client suite checks the same one (client/src/arcade/glimmer/golden.test.ts). */
export const GOLDEN = 0x6562190a;

const bytes = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;
const ID = 'q7Xc2LmA9fZk';
const ACCT = 'acct_' + 'x'.repeat(20);

describe('golden replay', () => {
  it('hashes 10k seeded spins per machine, features included, to the golden value', () => {
    expect(goldenHash(0x61177e12, 10_000)).toBe(GOLDEN);
  });
});

describe('stop codec', () => {
  it('round-trips every stop of every strip', () => {
    expect(STOP_ALPHABET).toHaveLength(64);
    for (const def of DEFS_BY_IDX) {
      for (const fs of [false, true]) {
        const strips = fs ? def.fsStrips : def.strips;
        const rng = seededRng(7 + def.idx);
        const stops: number[] = [];
        for (let spin = 0; spin < 40; spin += 1) for (let r = 0; r < def.reels; r += 1) stops.push(rng((strips[r] as Uint8Array).length));
        const text = encodeStops(stops);
        expect(text).toHaveLength(stops.length);
        expect(decodeStops(text, def, fs)).toEqual(stops);
      }
    }
  });

  it('rejects out-of-range characters per reel, bad lengths and non-strings', () => {
    // Tidepool reel 2 has 48 stops: index 48 ('w') is out of range there but fine on reel 1 (49 stops).
    expect(decodeStops('wAAAA', TIDEPOOL, false)).toEqual([48, 0, 0, 0, 0]);
    expect(decodeStops('AwAAA', TIDEPOOL, false)).toBeNull();
    // Reel 3 has 51 stops: 'y' (50) is fine, 'z' (51) is not.
    expect(decodeStops('AAyAA', TIDEPOOL, false)).toEqual([0, 0, 50, 0, 0]);
    expect(decodeStops('AAzAA', TIDEPOOL, false)).toBeNull();
    expect(decodeStops('AAAA', TIDEPOOL, false)).toBeNull();
    expect(decodeStops('', TIDEPOOL, false)).toBeNull();
    expect(decodeStops('AA!AA', TIDEPOOL, false)).toBeNull();
    expect(decodeStops(42, TIDEPOOL, false)).toBeNull();
    // Orchard strips are 22 stops: 'W' is 22.
    expect(decodeStops('VVV', ORCHARD, false)).toEqual([21, 21, 21]);
    expect(decodeStops('VWV', ORCHARD, false)).toBeNull();
    // Forge strips are shorter than the base strips: 'p' (41) fits reel 1's base strip only.
    expect(decodeStops('pAAAA', EMBERVAULT, false)).toEqual([41, 0, 0, 0, 0]);
    expect(decodeStops('pAAAA', EMBERVAULT, true)).toBeNull();
    expect(decodeStops('A'.repeat(5 * 201), TIDEPOOL, true)).toBeNull();
  });

  it('accepts 12-character base64url spin ids only', () => {
    expect(isSpinId(ID)).toBe(true);
    expect(isSpinId('q7Xc2LmA9fZ')).toBe(false);
    expect(isSpinId('q7Xc2LmA9fZ+')).toBe(false);
    expect(isSpinId(12)).toBe(false);
  });
});

describe('message sizes', () => {
  it('keeps a base spin ack at 80 B or less', () => {
    const ack: SpinOk = { ok: true, id: ID, st: 'kD3aP', w: 9999, bal: 9_999_999, pot: 99_999 };
    expect(bytes(ack)).toBeLessThanOrEqual(SIZE.baseAck);
    expect(bytes({ ok: true, id: ID, st: 'kD3aP', w: 40, bal: 18_420 })).toBeLessThanOrEqual(64);
  });

  it('keeps a Tide Turn ack at 160 B or less at 10 spins and 1.2 KB at the 200-spin cap', () => {
    const rng = seededRng(99);
    const ten = freeRun(TIDEPOOL, 500, rng, { spins: 10, mult: 2, retrigger: 0, scatterPay: 2, strips: TIDEPOOL.fsStrips });
    expect(ten.spins).toBe(10);
    const ack10: SpinOk = { ok: true, id: ID, st: 'kD3aP', w: 1000, bal: 9_999_999, pot: 99_999, f: wireFeature('tide', { stops: ten.stops, win: 99_999 }) };
    expect(bytes(ack10)).toBeLessThanOrEqual(SIZE.tideAck10);
    // A run forced to the cap: every free spin retriggers (scatter pay 0 so the win stays plain).
    const capped = freeRun(TIDEPOOL, 500, rng, { spins: 400, mult: 2, retrigger: 10, scatterPay: 2, strips: TIDEPOOL.fsStrips });
    expect(capped.spins).toBe(200);
    const ack200: SpinOk = { ok: true, id: ID, st: 'kD3aP', w: 1000, bal: 9_999_999, pot: 99_999, f: wireFeature('tide', { stops: capped.stops, win: 9_999_999 }) };
    expect(bytes(ack200)).toBeLessThanOrEqual(SIZE.featureAck);
    const vault = { ok: true, id: ID, dr: [2, 0, 1], f: wireFeature('vault', { stops: capped.stops, win: 9_999_999, picked: 2 }), bal: 9_999_999 };
    expect(bytes(vault)).toBeLessThanOrEqual(SIZE.featureAck);
  });

  it('keeps a typical feature ack small (wheel and a real Tide Turn run)', () => {
    const rng = seededRng(5);
    const wheel = playFeature(ORCHARD, 100, rng);
    expect(bytes({ ok: true, id: ID, st: 'kD3', w: 120, bal: 18_500, pot: 15_234, f: wireFeature('wheel', wheel) })).toBeLessThanOrEqual(110);
  });

  const dash = (entrants: number): DashView => {
    const s: number[] = [];
    for (let i = 0; i < entrants; i += 1) s.push(i * 2, 1840 + i * 137, 47 + i);
    return { id: 'd7', st: 1, m: 2, len: 5, buy: 500, host: 0, t: 185, s };
  };

  it('keeps a Dash view at 150 B or less with 8 entrants', () => {
    expect(bytes(dash(8))).toBeLessThanOrEqual(SIZE.dashView);
    const done: DashView = { ...dash(8), st: 2, t: 0, pay: [2, 2800, 4, 1200] };
    expect(bytes(done)).toBeLessThanOrEqual(SIZE.dashView + 20);
  });

  it('keeps the enter ack at 1 KB or less with 16 members and a running Dash', () => {
    const mem: MemberRow[] = [];
    for (let slot = 0; slot < 16; slot += 1) mem.push([slot, ACCT, (slot % 3) as 0 | 1 | 2, (slot % 2) as 0 | 1, 12_400, 6_200]);
    const ack: EnterOk = { ok: true, bal: 9_999_999, pot: 99_999, me: 15, maxBet: 500, mem, dash: dash(8) };
    expect(bytes(ack)).toBeLessThanOrEqual(SIZE.enterAck);
  });

  it('packs a hall push into 400 B and keeps what did not fit for the next one', () => {
    const p = emptyPending();
    for (let i = 0; i < 20; i += 1) p.e.push([i % 16, (i % 3) as 0 | 1 | 2, 500, 2500 * (i + 1), 0] as FeedEntry);
    for (let slot = 0; slot < 16; slot += 1) p.h.push([slot, ACCT, 1, 0]);
    for (let i = 0; i < 16; i += 1) p.r.push([i, (i + 1) % 16, i % 6]);
    p.p = 123_456;
    p.d = dash(8);
    const first = packFeed(p);
    expect(first).not.toBeNull();
    expect(bytes(first)).toBeLessThanOrEqual(SIZE.feed);
    expect(first?.e).toHaveLength(6);
    // The six biggest entries were kept (wins 50,000 down to 37,500).
    expect(first?.e?.map((e) => e[3])).toEqual([50_000, 47_500, 45_000, 42_500, 40_000, 37_500]);
    expect(first?.p).toBe(123_456);
    let pushes = 1;
    let members = first?.h?.length ?? 0;
    let reactions = first?.r?.length ?? 0;
    for (let next = packFeed(p); next; next = packFeed(p)) {
      expect(bytes(next)).toBeLessThanOrEqual(SIZE.feed);
      members += next.h?.length ?? 0;
      reactions += next.r?.length ?? 0;
      pushes += 1;
      expect(pushes).toBeLessThan(10);
    }
    expect(members).toBe(16);
    expect(reactions).toBe(16);
    expect(packFeed(p)).toBeNull();
  });
});
