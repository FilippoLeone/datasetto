/**
 * The device's random source for offline play (glimmerhall.md §6): `crypto.getRandomValues` in
 * blocks of 64 words, with rejection sampling (core's `randInt`) so every stop is exactly uniform.
 */
import { randInt } from '@arcade/core/rng';
import type { Rng } from '@arcade/core/glimmer/spin';

export const cryptoRng = (): Rng => {
  const block = new Uint32Array(64);
  let at = block.length;
  const next = (): number => {
    if (at >= block.length) {
      crypto.getRandomValues(block);
      at = 0;
    }
    return block[at++] as number;
  };
  return (n) => randInt(next, n);
};

/** 12 base64url characters (72 random bits): spin and pick ids. */
export const newSpinId = (): string => {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < 9; i += 3) {
    const v = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out += alphabet[(v >> 18) & 63]! + alphabet[(v >> 12) & 63]! + alphabet[(v >> 6) & 63]! + alphabet[v & 63]!;
  }
  return out;
};
