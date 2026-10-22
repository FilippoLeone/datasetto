/**
 * The Firefly Trio on the server (lamplight.md §2.3): the admin-editable multiplier table (Admin ›
 * Arcade, key `trioTable`) and the draw, made with `crypto.randomInt(1_000_000)` when the third
 * player registers. The default table averages 2.9725 buy-ins against 3 paid in; the validator
 * refuses any table averaging 3 or more, or whose weights do not add up to 1,000,000.
 */
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_TRIO_TABLE, drawMultiplier, TRIO_SPACE, validateTrioTable, type TrioRow } from '../core/lamplight/trio.js';
import { splitPool } from '../core/lamplight/payouts.js';

const rowSchema = z.object({
  mult: z.number().int().min(1).max(100_000),
  weight: z.number().int().min(1).max(TRIO_SPACE),
  pay: z.tuple([z.number().int().min(0).max(100), z.number().int().min(0).max(100), z.number().int().min(0).max(100)]),
});

export interface LamplightSettings {
  trioTable: TrioRow[];
}

export const LAMPLIGHT_DEFAULTS: LamplightSettings = { trioTable: DEFAULT_TRIO_TABLE.map((r) => ({ ...r, pay: [...r.pay] as [number, number, number] })) };

/** Parsed admin settings; an invalid table is refused (the admin form shows the reason). */
export const lamplightSettingsSchema = z
  .object({ trioTable: z.array(rowSchema).min(1).max(16) })
  .superRefine((v, ctx) => {
    const why = validateTrioTable(v.trioTable);
    if (why) ctx.addIssue({ code: 'custom', message: why, path: ['trioTable'] });
  });

export const settingsOf = (raw: unknown): LamplightSettings => {
  const parsed = lamplightSettingsSchema.safeParse(raw);
  return parsed.success ? (parsed.data as LamplightSettings) : LAMPLIGHT_DEFAULTS;
};

export interface TrioDraw {
  u: number;
  mult: number;
  pool: number;
  /** Prize for 1st, 2nd and 3rd. */
  pay: number[];
}

/** Draw the multiplier for a Trio of `buyIn` (u from crypto.randomInt unless injected). */
export const drawTrio = (table: readonly TrioRow[], buyIn: number, u: number = randomInt(TRIO_SPACE)): TrioDraw => {
  const row = drawMultiplier(table, u);
  const pool = buyIn * row.mult;
  return { u, mult: row.mult, pool, pay: splitPool(pool, row.pay) };
};
