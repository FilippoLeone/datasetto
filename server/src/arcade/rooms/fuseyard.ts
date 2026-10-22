/**
 * Fuseyard's MatchGameDef (plan.md §2.6.3, fuseyard.md §3–§5, §10): the lobby options, how a match
 * is built from a live lobby, its seat and idle rules, its pacing budget, and what is written at the
 * end. The match itself is the shared core runtime (core/fuseyard/runtime.ts) wrapped by `wrapCore`;
 * the server adds the deflated HANDOVER and replay bodies.
 */
import { deflateRawSync } from 'node:zlib';
import { z } from 'zod';
import { BUDGET } from '../core/fuseyard/budget.js';
import { createFuseyardCore } from '../core/fuseyard/runtime.js';
import { ARENA_IDS, BotLevel, type ArenaId, type MatchConfig } from '../core/fuseyard/rules.js';
import { statBoard, type BoardDef } from '../stats.js';
import type { MatchGameDef } from './types.js';
import { wrapCore } from './wrap.js';

const LEVELS = { sprout: BotLevel.Sprout, scrapper: BotLevel.Scrapper, menace: BotLevel.Menace } as const;

/** `arcade:lobby:create` cfg for Fuseyard (the generic options form, fuseyard.md §3.2). */
export const cfgSchema = z
  .object({
    mode: z.enum(['brawl', 'quickfire']).optional(),
    arena: z.enum(['rotation', ...(ARENA_IDS as readonly [ArenaId, ...ArenaId[]])]).default('rotation'),
    fighters: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(4),
    wins: z.union([z.literal(2), z.literal(3), z.literal(5)]).default(3),
    bots: z.enum(['sprout', 'scrapper', 'menace']).default('scrapper'),
  })
  .strict();

export type FuseyardCfg = z.infer<typeof cfgSchema>;

/** The match configuration for a lobby's options (mode defaults to Brawl). */
export const configOf = (cfg: unknown, seed: number, mode?: string): MatchConfig => {
  const parsed = cfgSchema.safeParse(cfg ?? {});
  const c = parsed.success ? parsed.data : cfgSchema.parse({});
  const m = mode === 'quickfire' || c.mode === 'quickfire' ? 'quickfire' : 'brawl';
  return { mode: m, arena: c.arena, fighters: c.fighters, winsNeeded: c.wins, botLevel: LEVELS[c.bots], seed: seed >>> 0 };
};

const WEEK_MS = 7 * 24 * 3600 * 1000;

const weeklyWins: BoardDef = {
  id: 'fuseyard-week',
  label: 'Wins this week',
  query: (db, limit) =>
    db
      .prepare(
        `SELECT p.account_id AS accountId, COUNT(*) AS value
           FROM arcade_results r JOIN arcade_result_players p ON p.result_id = r.id
          WHERE r.game = 'fuseyard' AND r.ended_at >= ? AND p.place = 1
          GROUP BY p.account_id ORDER BY value DESC LIMIT ?`,
      )
      .all(Date.now() - WEEK_MS, Math.max(1, Math.min(100, limit))) as { accountId: string; value: number }[],
};

const fuseyard: MatchGameDef = {
  game: 'fuseyard',
  wireId: 1,
  seats: { min: 2, max: 4 },
  spectators: 4,
  join: 'nextRound',
  host: 'lowestSeat',
  // A ghost seat: 60 s per episode, 90 s per match, then a Scrapper bot until its owner reclaims it.
  grace: { episodeMs: 60_000, matchMs: 90_000, awayLimitMs: 60_000, after: 'bot' },
  idle: { noHumanMs: 30_000, noInputMs: 120_000 },
  sender: { skipUnchanged: true, budget: BUDGET },
  serverLimit: null,
  botFill: true,
  cfgSchema,
  create(ctx) {
    const cfg = ctx.cfg as (FuseyardCfg & { mode?: string }) | null;
    const config = configOf(cfg, ctx.seed, cfg?.mode);
    const seats = ctx.seats.map((s) => ({ slot: s.slot, human: !s.bot, botLevel: s.bot ? s.botLevel : config.botLevel }));
    const core = createFuseyardCore({ config, seats, offline: false, replay: true });
    return wrapCore('fuseyard', ctx.id, core, {
      handover: () => deflateRawSync(core.dump()),
      replay: () => deflateRawSync(core.replayBytes()),
    });
  },
  persist(e, api) {
    // Results are written once, at the end of an online match with at least 2 humans (§10).
    if (e.t !== 'end' || !e.result || e.result.humans < 2) return;
    const now = Date.now();
    const summary = e.result.summary as { rounds?: number } | null;
    const players: { accountId: string; place: number | null; score: number | null; chipsDelta: number }[] = [];
    for (const p of e.result.players) {
      const accountId = api.accountOf(p.slot);
      if (accountId) players.push({ accountId, place: p.place, score: p.score, chipsDelta: 0 });
    }
    if (players.length === 0) return;
    api.results.record(
      { game: 'fuseyard', mode: e.result.mode, channelId: null, humans: e.result.humans, startedAt: now - (summary?.rounds ?? 1) * 60_000, endedAt: now, summary: e.result.summary },
      players,
    );
    for (const s of e.result.stats) {
      const accountId = api.accountOf(s.slot);
      if (!accountId) continue;
      if (s.op === 'add') api.stats.add(accountId, 'fuseyard', s.stat, s.value);
      else api.stats.max(accountId, 'fuseyard', s.stat, s.value);
    }
  },
  boards: [statBoard('fuseyard', 'wins', 'fuseyard-wins', 'Wins'), weeklyWins],
};

export default fuseyard;
