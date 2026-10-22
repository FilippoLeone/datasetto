/**
 * The shared core's seeded generators (server/src/arcade/core/rng.ts), checked against independent
 * BigInt transliterations of the reference algorithms, plus randInt's range and uniformity.
 */
import { describe, expect, it } from 'vitest';
import { MULBERRY_INC, mulberry32Out, randInt, seedXoshiro, xorshift32, xoshiro128ss } from '../../src/arcade/core/rng.js';

const M32 = 0xffffffffn;
const mul32 = (a: bigint, b: bigint): bigint => (a * b) & M32;
const rotl32 = (x: bigint, k: number): bigint => ((x << BigInt(k)) | (x >> BigInt(32 - k))) & M32;

/** Marsaglia's xorshift32 (13, 17, 5), straight from the paper. */
const refXorshift32 = (s: number): number => {
  let x = BigInt(s >>> 0);
  x ^= (x << 13n) & M32;
  x ^= x >> 17n;
  x ^= (x << 5n) & M32;
  return Number(x);
};

/** mulberry32's output step on an already advanced state. */
const refMulberryOut = (s: number): number => {
  let t = BigInt(s >>> 0);
  t = mul32(t ^ (t >> 15n), t | 1n);
  t = ((t + mul32(t ^ (t >> 7n), t | 61n)) & M32) ^ t;
  return Number(t ^ (t >> 14n));
};

/** xoshiro128** 1.1, transliterated from the reference C code. */
const refXoshiroNext = (s: bigint[]): number => {
  const [s0, s1, s2, s3] = s as [bigint, bigint, bigint, bigint];
  const result = mul32(rotl32(mul32(s1, 5n), 7), 9n);
  const t = (s1 << 9n) & M32;
  let n2 = s2 ^ s0;
  let n3 = s3 ^ s1;
  const n1 = s1 ^ n2;
  const n0 = s0 ^ n3;
  n2 ^= t;
  n3 = rotl32(n3, 11);
  s[0] = n0;
  s[1] = n1;
  s[2] = n2;
  s[3] = n3;
  return Number(result);
};

/** The seeding the core documents: golden-ratio steps through the murmur3 finaliser. */
const refSeed = (seed: number): bigint[] => {
  let x = BigInt(seed >>> 0);
  const out: bigint[] = [];
  for (let i = 0; i < 4; i += 1) {
    x = (x + 0x9e3779b9n) & M32;
    let z = x;
    z = mul32(z ^ (z >> 16n), 0x85ebca6bn);
    z = mul32(z ^ (z >> 13n), 0xc2b2ae35n);
    out.push(z ^ (z >> 16n));
  }
  return out;
};

const xoshiroSource = (seed: number): (() => number) => {
  const state = seedXoshiro(seed);
  return () => xoshiro128ss(state);
};

describe('xorshift32', () => {
  it('matches the reference, including a hand-computed first step', () => {
    expect(xorshift32(1)).toBe(270369);
    expect(refXorshift32(1)).toBe(270369);
    for (const seed of [1, 2463534242, 0x80000000, 0xffffffff, 12345]) {
      let a = seed;
      let b = seed;
      for (let i = 0; i < 2000; i += 1) {
        a = xorshift32(a);
        b = refXorshift32(b);
        expect(a).toBe(b);
        expect(a).not.toBe(0);
      }
    }
  });

  it('is deterministic: the same seed gives the same sequence', () => {
    const run = (seed: number): number[] => {
      const out: number[] = [];
      let s = seed;
      for (let i = 0; i < 100; i += 1) out.push((s = xorshift32(s)));
      return out;
    };
    expect(run(99)).toEqual(run(99));
    expect(run(99)).not.toEqual(run(100));
  });
});

describe('mulberry32', () => {
  it('matches the reference when the caller advances the state', () => {
    for (const seed of [0, 1, 0x6d2b79f5, 0xdeadbeef, -7]) {
      let s = seed | 0;
      let ref = seed >>> 0;
      for (let i = 0; i < 2000; i += 1) {
        s = (s + MULBERRY_INC) | 0;
        ref = (ref + MULBERRY_INC) >>> 0;
        const out = mulberry32Out(s);
        expect(out).toBe(refMulberryOut(ref));
        expect(out >= 0 && out <= 0xffffffff && Number.isInteger(out)).toBe(true);
      }
    }
  });
});

describe('xoshiro128**', () => {
  it('matches hand-computed values from the state [1, 2, 3, 4]', () => {
    const state = Uint32Array.of(1, 2, 3, 4);
    expect(xoshiro128ss(state)).toBe(11520);
    expect(Array.from(state)).toEqual([7, 0, 1026, 12288]);
    expect(xoshiro128ss(state)).toBe(0);
    expect(Array.from(state)).toEqual([12295, 1029, 1029, 25165824]);
    expect(xoshiro128ss(state)).toBe(5927040);
  });

  it('matches the reference implementation for seeded states, word for word', () => {
    for (const seed of [0, 1, 42, 0x9e3779b9, 0xffffffff, 0x12345678]) {
      const state = seedXoshiro(seed);
      const ref = refSeed(seed);
      expect(Array.from(state)).toEqual(ref.map(Number));
      for (let i = 0; i < 5000; i += 1) expect(xoshiro128ss(state)).toBe(refXoshiroNext(ref));
      expect(Array.from(state)).toEqual(ref.map(Number));
    }
  });

  it('is deterministic per seed', () => {
    const take = (seed: number): number[] => {
      const next = xoshiroSource(seed);
      return Array.from({ length: 64 }, next);
    };
    expect(take(7)).toEqual(take(7));
    expect(take(7)).not.toEqual(take(8));
  });

  it('seedXoshiro never yields an all-zero state and fills the buffer it is given', () => {
    const out = new Uint32Array(4);
    const seen = new Set<string>();
    // -0x9e3779b9 >>> 0 makes the first splitmix step land on 0, so its first word is 0.
    const seeds: number[] = [0xffffffff, 0x9e3779b9, -0x9e3779b9 >>> 0, 0x80000000, -1];
    for (let s = 0; s < 30000; s += 1) seeds.push(s);
    for (const seed of seeds) {
      const st = seedXoshiro(seed, out);
      expect(st).toBe(out);
      expect((st[0]! | st[1]! | st[2]! | st[3]!) !== 0).toBe(true);
      seen.add(st.join(','));
    }
    // Distinct seeds give distinct states (seed −1 and 0xffffffff are the same u32).
    expect(seen.size).toBe(seeds.length - 1);
  });
});

describe('randInt', () => {
  it('stays in [0, n) for many n, on several sources', () => {
    const next = xoshiroSource(2024);
    for (const n of [1, 2, 3, 6, 7, 10, 52, 1000, 65537, 2 ** 31 + 1, 2 ** 32 - 1, 2 ** 32]) {
      for (let i = 0; i < 2000; i += 1) {
        const v = randInt(next, n);
        expect(Number.isInteger(v) && v >= 0 && v < n).toBe(true);
      }
    }
  });

  it('randInt(next, 1) is 0 and takes exactly one draw; n below 1 gives 0', () => {
    let calls = 0;
    const counting = (): number => {
      calls += 1;
      return 0xffffffff;
    };
    for (let i = 0; i < 10; i += 1) expect(randInt(counting, 1)).toBe(0);
    expect(calls).toBe(10);
    expect(randInt(counting, 0)).toBe(0);
    expect(randInt(counting, -3)).toBe(0);
    expect(randInt(counting, Number.NaN)).toBe(0);
  });

  it('rejects the biased top of the range instead of folding it with a modulo', () => {
    // n = 3: 2^32 mod 3 = 1, so 0xffffffff is the one rejected value.
    const seq = [0xffffffff, 5];
    let i = 0;
    expect(randInt(() => seq[i++] as number, 3)).toBe(2);
    expect(i).toBe(2);
    // n = 2^31 + 1: every value ≥ n is rejected.
    const seq2 = [2 ** 31 + 1, 0xfffffff0, 7];
    let j = 0;
    expect(randInt(() => seq2[j++] as number, 2 ** 31 + 1)).toBe(7);
    expect(j).toBe(3);
    // A source stuck in the rejected zone ends after 64 retries instead of looping forever.
    let k = 0;
    expect(randInt(() => (k++, 0xffffffff), 3)).toBe(0);
    expect(k).toBe(65);
  });

  it('is roughly uniform: 60,000 draws of n = 6 pass a loose chi-square bound', () => {
    for (const [name, next] of [
      ['xoshiro', xoshiroSource(0x5eed)],
      ['xorshift', ((): (() => number) => {
        let s = 0x5eed;
        return () => (s = xorshift32(s));
      })()],
    ] as const) {
      const counts = [0, 0, 0, 0, 0, 0];
      const draws = 60000;
      for (let i = 0; i < draws; i += 1) counts[randInt(next, 6)]! += 1;
      const expected = draws / 6;
      const chi2 = counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
      // 5 degrees of freedom: p = 0.001 is at 20.5.
      expect(chi2, name + ' ' + counts.join(',')).toBeLessThan(25);
      for (const c of counts) expect(Math.abs(c - expected) / expected).toBeLessThan(0.05);
    }
  });
});
