/**
 * The Firefly multiplier (lamplight.md §2.3). When the third player registers, the host draws a
 * uniform integer in [0, 1,000,000) and maps it through the table; the prize pool is the buy-in times
 * the multiplier. The default table's expected multiplier is exactly 2.9725 buy-ins against the 3
 * paid in, so the format is a small chip sink. Admins may edit the table, but never to an expected
 * value of 3 or more.
 */

export interface TrioRow {
  mult: number;
  /** Out of 1,000,000. */
  weight: number;
  /** Percent of the pool for 1st, 2nd and 3rd. */
  pay: readonly [number, number, number];
}

export const TRIO_SPACE = 1_000_000;

export const DEFAULT_TRIO_TABLE: readonly TrioRow[] = [
  { mult: 2, weight: 740_000, pay: [100, 0, 0] },
  { mult: 3, weight: 160_000, pay: [100, 0, 0] },
  { mult: 5, weight: 65_000, pay: [100, 0, 0] },
  { mult: 10, weight: 26_000, pay: [100, 0, 0] },
  { mult: 25, weight: 7_500, pay: [84, 8, 8] },
  { mult: 100, weight: 1_400, pay: [80, 10, 10] },
  { mult: 1000, weight: 100, pay: [80, 10, 10] },
];

/** The row a draw `u` in [0, 1e6) lands on. */
export const drawMultiplier = (table: readonly TrioRow[], u: number): TrioRow => {
  let acc = 0;
  for (const row of table) {
    acc += row.weight;
    if (u < acc) return row;
  }
  return table[table.length - 1];
};

/** Σ mult × weight, i.e. the expected multiplier × 1,000,000, as an exact integer. */
export const evE6 = (table: readonly TrioRow[]): number => {
  let sum = 0;
  for (const row of table) sum += row.mult * row.weight;
  return sum;
};

/** Null when the table is valid, otherwise why not. */
export const validateTrioTable = (table: readonly TrioRow[]): string | null => {
  if (table.length === 0 || table.length > 16) return 'The table needs 1 to 16 rows.';
  let weights = 0;
  for (const row of table) {
    if (!Number.isInteger(row.mult) || row.mult < 1 || row.mult > 100_000) return 'Multipliers are whole numbers from 1 to 100,000.';
    if (!Number.isInteger(row.weight) || row.weight < 1) return 'Weights are whole numbers above 0.';
    if (row.pay.length !== 3 || row.pay.some((p) => !Number.isInteger(p) || p < 0) || row.pay[0] + row.pay[1] + row.pay[2] !== 100) return 'Each row pays 1st, 2nd and 3rd percentages that add up to 100.';
    weights += row.weight;
  }
  if (weights !== TRIO_SPACE) return 'The weights must add up to 1,000,000.';
  if (evE6(table) >= 3 * TRIO_SPACE) return 'The average multiplier must stay below 3.';
  return null;
};
