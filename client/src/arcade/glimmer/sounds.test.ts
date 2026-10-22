/**
 * Glimmerhall's sound recipes (glimmerhall.md §12.7, §16): every recipe is well formed, and one
 * machine's set renders to well under the 1 MB audio budget (mono 22,050 Hz float buffers).
 */
import { describe, expect, it } from 'vitest';
import { machineRecipes, sharedRecipes } from './sounds';

const seconds = (layers: readonly { delay?: number; attack?: number; decay: number }[]): number =>
  Math.max(...layers.map((l) => (l.delay ?? 0) + (l.attack ?? 0.005) + l.decay)) + 0.01;

describe('sound recipes', () => {
  it('are well formed, and the shared set plus the wins of all three machines fit the 1 MB budget', () => {
    const sets = [sharedRecipes(), machineRecipes(0), machineRecipes(1), machineRecipes(2)];
    expect(Object.keys(sets[0] ?? {}).sort()).toEqual(['door', 'pot', 'reveal', 'scatter', 'soft', 'stop', 'tap', 'tick', 'wheel', 'whirr', 'win3', 'win4']);
    let bytes = 0;
    for (const set of sets) {
      for (const [id, r] of Object.entries(set)) {
        expect(r.layers.length, id).toBeGreaterThan(0);
        for (const l of r.layers) {
          expect(Number.isFinite(l.freq) && l.freq > 20 && l.freq < 12_000, id).toBe(true);
          expect(l.decay, id).toBeGreaterThan(0);
          expect((l.gain ?? 1) <= 1 && (l.gain ?? 1) > 0, id).toBe(true);
        }
        const s = seconds(r.layers);
        expect(s, id).toBeLessThanOrEqual(2.6);
        bytes += Math.ceil(s * 22_050) * 4;
      }
    }
    expect(bytes).toBeLessThan(1_000_000);
  });
});
