/**
 * A 64-entry integer sine table (bellwick.md §0): round(sin(2π·i/64) × 256). Math.sin is not guaranteed
 * to be bit-identical across JavaScript engines, so the Moth Wisp's path reads this instead.
 */
export const SINE: readonly number[] = [
  0, 25, 50, 74, 98, 121, 142, 162, 181, 198, 213, 226, 237, 245, 251, 255,
  256, 255, 251, 245, 237, 226, 213, 198, 181, 162, 142, 121, 98, 74, 50, 25,
  0, -25, -50, -74, -98, -121, -142, -162, -181, -198, -213, -226, -237, -245, -251, -255,
  -256, -255, -251, -245, -237, -226, -213, -198, -181, -162, -142, -121, -98, -74, -50, -25,
];

/** sin at phase `i` (any integer; the table period is 64), scaled by 256. */
export const isin = (i: number): number => SINE[((i % 64) + 64) % 64] as number;
/** cos at phase `i`, scaled by 256. */
export const icos = (i: number): number => isin(i + 16);
