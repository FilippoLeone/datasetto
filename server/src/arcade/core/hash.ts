/** FNV-1a 32 for replay and state hashes (golden replays compare these). */

export const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export const fnv1a32 = (bytes: Uint8Array, h: number = FNV_OFFSET): number => {
  let x = h >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    x ^= bytes[i] as number;
    x = Math.imul(x, FNV_PRIME) >>> 0;
  }
  return x;
};

/** Mix the four little-endian bytes of a u32 into a running FNV-1a hash. */
export const fnvMix = (h: number, v: number): number => {
  let x = h >>> 0;
  const u = v >>> 0;
  x = Math.imul(x ^ (u & 0xff), FNV_PRIME) >>> 0;
  x = Math.imul(x ^ ((u >>> 8) & 0xff), FNV_PRIME) >>> 0;
  x = Math.imul(x ^ ((u >>> 16) & 0xff), FNV_PRIME) >>> 0;
  x = Math.imul(x ^ (u >>> 24), FNV_PRIME) >>> 0;
  return x;
};
