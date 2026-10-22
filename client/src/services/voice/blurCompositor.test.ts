import { describe, expect, it } from 'vitest';
import { gaussianTaps } from './blurCompositor';

const total = (weights: number[]) => weights[0] + 2 * weights.slice(1).reduce((a, b) => a + b, 0);

describe('gaussianTaps', () => {
  it('folds a Gaussian into paired taps that keep the brightness', () => {
    for (const sigma of [0.3, 1, 2.2, 4.7, 9]) {
      const { offsets, weights } = gaussianTaps(sigma);
      expect(offsets).toHaveLength(weights.length);
      expect(total(weights)).toBeCloseTo(1, 6);
      expect(offsets[0]).toBe(0);
      for (let i = 1; i < offsets.length; i++) expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
    }
  });

  it('stays within the shader limit of 9 fetches per side', () => {
    const { offsets } = gaussianTaps(40);
    expect(offsets.length).toBeLessThanOrEqual(9);
    expect(offsets.at(-1)).toBeLessThanOrEqual(16.5);
  });

  it('puts each pair between its two texels, weighted toward the heavier one', () => {
    const { offsets } = gaussianTaps(2);
    // The first pair covers texels 1 and 2, so its offset lies between them, nearer to 1.
    expect(offsets[1]).toBeGreaterThan(1);
    expect(offsets[1]).toBeLessThan(1.5);
  });
});
