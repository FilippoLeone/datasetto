/**
 * Arcade admin settings (platform.md §11.4), stored as JSON in the `settings` table under the key
 * `arcade` and edited in Admin › Arcade. A stale or hand-edited row can never break the server:
 * every field falls back to its default.
 */
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { GAME_IDS, type GameId } from './core/version.js';

export interface ArcadeLimits {
  /** Action matches (Fuseyard or Bellwick) per voice channel. */
  actionPerChannel: number;
  /** Poker tables per voice channel. */
  tablesPerChannel: number;
  /** Glimmerhall halls per voice channel. */
  hallsPerChannel: number;
  /** Action matches server-wide. */
  actionMatches: number;
  /** Bellwick sessions server-wide, counted inside `actionMatches`. */
  bellwickSessions: number;
  /** Poker tables server-wide. */
  tables: number;
  /** Poker bots server-wide. */
  pokerBots: number;
  /** Watchers per action match. */
  spectatorsAction: number;
  /** Watchers per poker table. */
  spectatorsTable: number;
  /** An unstarted lobby closes after this long. */
  lobbyIdleMs: number;
  /** Lane egress above which the server degrades (spectators slower, then players, then refusals). */
  egressKbps: number;
  /** Action-lane sockets per IP. */
  lanePerIp: number;
  /** Members per Glimmerhall hall. */
  hallMembers: number;
  /** Glimmer Dashes running at once, server-wide. */
  dashes: number;
}

/** A per-game admin setting as the Admin › Arcade form shows it (from `TableGameDef.settings.fields`). */
export type SettingsField = { key: string; label: string; help?: string } & (
  | { kind: 'number'; min: number; max: number; step?: number }
  | { kind: 'toggle' }
  | { kind: 'json' }
);

export interface ArcadeSettings {
  enabled: boolean;
  games: Record<GameId, boolean>;
  /** Chips granted on the first wallet read. */
  startChips: number;
  /** Daily claim: `max(claimMin, claimFloor − (balance + escrow))`, once per UTC day. */
  claimFloor: number;
  claimMin: number;
  /** Poker bots at the low-stakes cash tables (Lamplight's economy rules). */
  serverBots: boolean;
  limits: ArcadeLimits;
  /**
   * Table games' own settings (Firefly Trio table, slots max bet, …), keyed by game and already
   * parsed by that game's `TableGameDef.settings.schema` with its defaults filled in.
   */
  gameSettings: Partial<Record<'lamplight' | 'glimmer', unknown>>;
}

export const DEFAULT_LIMITS: ArcadeLimits = {
  actionPerChannel: 1,
  tablesPerChannel: 2,
  hallsPerChannel: 1,
  actionMatches: 6,
  bellwickSessions: 3,
  tables: 10,
  pokerBots: 6,
  spectatorsAction: 4,
  spectatorsTable: 8,
  lobbyIdleMs: 10 * 60_000,
  egressKbps: 1500,
  lanePerIp: 12,
  hallMembers: 16,
  dashes: 4,
};

export const DEFAULT_SETTINGS: ArcadeSettings = {
  enabled: true,
  games: { lamplight: true, glimmer: true, fuseyard: true, bellwick: true },
  startChips: 20_000,
  claimFloor: 10_000,
  claimMin: 2_000,
  serverBots: true,
  limits: DEFAULT_LIMITS,
  gameSettings: {},
};

const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const limitsSchema = z.object({
  actionPerChannel: int(0, 4),
  tablesPerChannel: int(0, 8),
  hallsPerChannel: int(0, 2),
  actionMatches: int(0, 32),
  bellwickSessions: int(0, 16),
  tables: int(0, 64),
  pokerBots: int(0, 32),
  spectatorsAction: int(0, 8),
  spectatorsTable: int(0, 16),
  lobbyIdleMs: int(60_000, 60 * 60_000),
  egressKbps: int(100, 100_000),
  lanePerIp: int(1, 64),
  hallMembers: int(1, 32),
  dashes: int(0, 16),
});

/** What an admin may send: every field optional; `gameSettings` entries are checked by each game's schema. */
export const settingsInputSchema = z
  .object({
    enabled: z.boolean(),
    games: z.object(Object.fromEntries(GAME_IDS.map((g) => [g, z.boolean()])) as Record<GameId, z.ZodBoolean>).partial(),
    startChips: int(0, 10_000_000),
    claimFloor: int(0, 10_000_000),
    claimMin: int(0, 10_000_000),
    serverBots: z.boolean(),
    limits: limitsSchema.partial(),
    gameSettings: z.object({ lamplight: z.unknown(), glimmer: z.unknown() }).partial(),
  })
  .partial();

export type ArcadeSettingsInput = z.infer<typeof settingsInputSchema>;

/** Per-game settings parsers, supplied by the registry (games.ts) from each TableGameDef. */
export type GameSettingsParsers = Partial<Record<'lamplight' | 'glimmer', { schema: z.ZodType<unknown>; defaults: unknown }>>;

const pick = <T>(value: unknown, schema: z.ZodType<T>, fallback: T): T => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
};

/** Merge a stored or submitted object over the defaults, field by field. */
export const normalizeSettings = (raw: unknown, parsers: GameSettingsParsers = {}, base: ArcadeSettings = DEFAULT_SETTINGS): ArcadeSettings => {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const games = { ...base.games };
  const rawGames = o.games && typeof o.games === 'object' ? (o.games as Record<string, unknown>) : {};
  for (const g of GAME_IDS) if (typeof rawGames[g] === 'boolean') games[g] = rawGames[g] as boolean;
  const limits = { ...base.limits };
  const rawLimits = o.limits && typeof o.limits === 'object' ? (o.limits as Record<string, unknown>) : {};
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof ArcadeLimits)[]) {
    const field = limitsSchema.shape[key];
    limits[key] = pick(rawLimits[key], field, limits[key]);
  }
  const gameSettings: ArcadeSettings['gameSettings'] = {};
  const rawGameSettings = o.gameSettings && typeof o.gameSettings === 'object' ? (o.gameSettings as Record<string, unknown>) : {};
  for (const g of ['lamplight', 'glimmer'] as const) {
    const parser = parsers[g];
    if (!parser) continue;
    const current = base.gameSettings[g] ?? parser.defaults;
    gameSettings[g] = g in rawGameSettings ? pick(rawGameSettings[g], parser.schema, current) : current;
  }
  return {
    enabled: pick(o.enabled, z.boolean(), base.enabled),
    games,
    startChips: pick(o.startChips, int(0, 10_000_000), base.startChips),
    claimFloor: pick(o.claimFloor, int(0, 10_000_000), base.claimFloor),
    claimMin: pick(o.claimMin, int(0, 10_000_000), base.claimMin),
    serverBots: pick(o.serverBots, z.boolean(), base.serverBots),
    limits,
    gameSettings,
  };
};

const KEY = 'arcade';

/** Read the stored settings (defaults when absent or unreadable). */
export const loadSettings = (db: DB, parsers: GameSettingsParsers = {}): ArcadeSettings => {
  let raw: unknown = {};
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
    if (row) raw = JSON.parse(row.value);
  } catch {
    raw = {};
  }
  return normalizeSettings(raw, parsers);
};

export const saveSettings = (db: DB, settings: ArcadeSettings, updatedBy: string | null, now = Date.now()): void => {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(KEY, JSON.stringify(settings), now, updatedBy);
};
