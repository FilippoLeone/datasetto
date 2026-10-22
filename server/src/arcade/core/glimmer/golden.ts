/**
 * The golden replay (glimmerhall.md §18.1 test 5): a fixed seed through every machine's base spins
 * and features, hashed with FNV-1a over the encoded results. The server suite (Node) and the
 * client suite (jsdom) both check the same value, so the draw order and the maths cannot drift
 * between the two. A change to the hash needs a `VERSION.defs` bump.
 */
import { fnv1a32, fnvMix, FNV_OFFSET } from '../hash.js';
import { randInt, seedXoshiro, xoshiro128ss } from '../rng.js';
import { shuffleDoors } from './feature.js';
import { DEFS_BY_IDX } from './machines.js';
import { openVault, playFeature, spinBase, type Rng } from './spin.js';
import { encodeStops } from './wire.js';

export const seededRng = (seed: number): Rng => {
  const state = seedXoshiro(seed);
  const next = (): number => xoshiro128ss(state);
  return (n) => randInt(next, n);
};

const ascii = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

/** FNV-1a over `spins` base spins per machine at its lowest bet, each feature played in full. */
export const goldenHash = (seed: number, spins: number): number => {
  const rng = seededRng(seed);
  let h = FNV_OFFSET;
  for (let m = 0; m < DEFS_BY_IDX.length; m += 1) {
    const def = DEFS_BY_IDX[m] as (typeof DEFS_BY_IDX)[number];
    const bet = def.bets[0] as number;
    for (let i = 0; i < spins; i += 1) {
      const base = spinBase(def, bet, rng);
      h = fnv1a32(ascii(encodeStops(base.stops)), h);
      h = fnvMix(h, base.win);
      if (!base.trigger) continue;
      const f = def.feature.kind === 'vault' ? openVault(def, bet, rng, shuffleDoors(rng), rng(3)) : playFeature(def, bet, rng);
      h = fnv1a32(ascii(encodeStops(f.stops)), h);
      h = fnvMix(h, f.win);
      h = fnvMix(h, f.segment ?? 255);
      h = fnvMix(h, f.picked ?? 255);
    }
  }
  return h;
};
