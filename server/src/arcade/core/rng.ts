/**
 * Seeded generators for the shared core. There is no Math.random anywhere in core: seeds and, for
 * online poker and slots, the random source itself are injected by the host (the server uses
 * crypto.randomInt; the device uses crypto.getRandomValues for the seed).
 */

export const MULBERRY_INC = 0x6d2b79f5;

/**
 * mulberry32's output function. The caller owns the state and advances it:
 * `s = (s + MULBERRY_INC) | 0`, then reads `mulberry32Out(s)` (a u32).
 */
export const mulberry32Out = (s: number): number => {
  let t = Math.imul(s ^ (s >>> 15), s | 1);
  t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
};

/** One xorshift32 step: returns the next state, which is also the output. The state must not be 0. */
export const xorshift32 = (s: number): number => {
  let x = s | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
};

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

/** xoshiro128**: a u32 from a 4-word state, which is mutated in place. */
export const xoshiro128ss = (state: Uint32Array): number => {
  const s0 = state[0] as number;
  const s1 = state[1] as number;
  const s2 = state[2] as number;
  const s3 = state[3] as number;
  const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
  const t = (s1 << 9) >>> 0;
  const n2 = (s2 ^ s0) >>> 0;
  const n3 = (s3 ^ s1) >>> 0;
  state[1] = (s1 ^ n2) >>> 0;
  state[0] = (s0 ^ n3) >>> 0;
  state[2] = (n2 ^ t) >>> 0;
  state[3] = rotl(n3, 11);
  return result;
};

/** Fill a xoshiro128** state from one u32 seed (splitmix32); never all zero. */
export const seedXoshiro = (seed: number, out: Uint32Array = new Uint32Array(4)): Uint32Array => {
  let x = seed >>> 0;
  for (let i = 0; i < 4; i += 1) {
    x = (x + 0x9e3779b9) >>> 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    out[i] = (z ^ (z >>> 16)) >>> 0;
  }
  if ((out[0] | out[1] | out[2] | out[3]) === 0) out[0] = 1;
  return out;
};

/** A uniform integer in [0, n). */
export type RandInt = (n: number) => number;

/**
 * A uniform integer in [0, n) from a u32 source, by rejection sampling (no modulo bias).
 * `n` must be an integer in [1, 2^32]. The loop is bounded: after 64 rejections, which happens
 * with probability below 2^−64, it falls back to the modulo.
 */
export const randInt = (nextU32: () => number, n: number): number => {
  if (!(n >= 1)) return 0;
  const range = 0x100000000;
  const limit = range - (range % n);
  let x = nextU32() >>> 0;
  for (let i = 0; i < 64 && x >= limit; i += 1) x = nextU32() >>> 0;
  return x % n;
};
