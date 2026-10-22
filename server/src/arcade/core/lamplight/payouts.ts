/**
 * Prize splits (lamplight.md §2.2–2.4). Every split is in whole chips and sums exactly to the pool:
 * shares are floored and the remainder goes to first place (or, in a tie, one chip each to the
 * tied players in the order given, clockwise from the button).
 */

/** Lamplight Cup percentages by the number of players who count (humans online, everyone offline). */
export const cupPercents = (players: number): number[] => (players <= 3 ? [100] : players <= 5 ? [70, 30] : [50, 30, 20]);

/** Floored shares of `pool` by percentage; first place gets the remainder. */
export const splitPool = (pool: number, percents: readonly number[]): number[] => {
  const shares = percents.map((p) => Math.floor((pool * p) / 100));
  let sum = 0;
  for (const s of shares) sum += s;
  if (shares.length > 0) shares[0] += pool - sum;
  return shares;
};

/** `total` split `k` ways: floored, odd chips one each to the first entries. */
export const tieShares = (total: number, k: number): number[] => {
  if (k <= 0) return [];
  const each = Math.floor(total / k);
  const out = new Array<number>(k).fill(each);
  let odd = total - each * k;
  for (let i = 0; i < k && odd > 0; i++, odd--) out[i]++;
  return out;
};

/**
 * Prizes by finishing groups, best first. A group of k players who busted in the same hand with the
 * same starting stack shares the prizes of the k places it covers. Returns one amount per player,
 * in the order of the groups.
 */
export const settlePlaces = (prizes: readonly number[], groups: readonly (readonly string[])[]): Map<string, number> => {
  const out = new Map<string, number>();
  let place = 0;
  for (const group of groups) {
    let total = 0;
    for (let i = 0; i < group.length; i++) total += prizes[place + i] ?? 0;
    const shares = tieShares(total, group.length);
    group.forEach((id, i) => out.set(id, shares[i]));
    place += group.length;
  }
  return out;
};

/**
 * An abandoned tournament: the unpaid prizes go to the remaining players in proportion to their
 * stacks, floored, the remainder to the biggest stack (the first of equal ones).
 */
export const abandonedSplit = (unpaid: number, stacks: readonly number[]): number[] => {
  let total = 0;
  let biggest = 0;
  for (let i = 0; i < stacks.length; i++) {
    total += stacks[i];
    if (stacks[i] > stacks[biggest]) biggest = i;
  }
  if (stacks.length === 0) return [];
  if (total <= 0) return tieShares(unpaid, stacks.length);
  const shares = stacks.map((s) => Math.floor((unpaid * s) / total));
  let sum = 0;
  for (const s of shares) sum += s;
  shares[biggest] += unpaid - sum;
  return shares;
};

/**
 * Order players who busted in the same hand: the bigger starting stack places higher. Returns
 * groups (best first) of players with equal starting stacks; each group is in seat order clockwise
 * from the seat after the button, for the odd chip.
 */
export const bustGroups = (
  busted: readonly { id: string; startStack: number; seat: number }[],
  button: number,
  seats: number,
): string[][] => {
  const dist = (seat: number): number => (seat - button - 1 + seats * 2) % seats;
  const sorted = busted.slice().sort((a, b) => b.startStack - a.startStack || dist(a.seat) - dist(b.seat));
  const groups: string[][] = [];
  let last = -1;
  for (const p of sorted) {
    if (groups.length > 0 && p.startStack === last) groups[groups.length - 1].push(p.id);
    else groups.push([p.id]);
    last = p.startStack;
  }
  return groups;
};
