/**
 * Arcade stats, results and leaderboards (platform.md §11.3, plan.md §1.3 #11). Boards read
 * `arcade_stats` counters that games keep (Lamplight weekly net, Glimmerhall best win, Fuseyard
 * wins, Bellwick fastest clear), never ledger deny-lists. Only games with at least 2 humans count;
 * offline and solo results stay on the device.
 */
import type { DB } from '../db/index.js';
import type { Clock } from './clock.js';
import type { GameId } from './core/version.js';

export interface Stats {
  add(accountId: string, game: GameId, stat: string, delta: number): void;
  max(accountId: string, game: GameId, stat: string, value: number): void;
  get(accountId: string, game: GameId, stat: string): number;
}

export interface Results {
  /** Returns the `arcade_results` id. */
  record(
    r: { game: GameId; mode: string; channelId: string | null; humans: number; startedAt: number; endedAt: number; summary: unknown },
    players: readonly { accountId: string; place: number | null; score: number | null; chipsDelta: number }[],
  ): number;
}

/** A leaderboard a game supplies; the platform caches each board's rows for 60 s. */
export interface BoardDef {
  id: string;
  label: string;
  query(db: DB, limit: number): readonly { accountId: string; value: number; label?: string }[];
}

/** One leaderboard row as sent to clients (display names are looked up from presence, never stored). */
export interface BoardRow {
  accountId: string;
  value: number;
  label?: string;
}

/** A board over one `arcade_stats` counter, highest first (the common case for game boards). */
export const statBoard = (game: GameId, stat: string, id: string, label: string, order: 'desc' | 'asc' = 'desc'): BoardDef => ({
  id,
  label,
  query: (db, limit) =>
    db
      .prepare(
        'SELECT account_id AS accountId, value FROM arcade_stats WHERE game = ? AND stat = ? ORDER BY value ' +
          (order === 'asc' ? 'ASC' : 'DESC') +
          ', updated_at ASC LIMIT ?',
      )
      .all(game, stat, Math.max(1, Math.min(100, limit))) as { accountId: string; value: number }[],
});

const checkInt = (what: string, value: number): void => {
  if (!Number.isSafeInteger(value)) throw new TypeError('stats: ' + what + ' must be a safe integer');
};

/** Counters in `arcade_stats`. `max` keeps the larger value and only then moves `updated_at` (the boards' tie-break). */
export const createStats = (db: DB, clock: Clock): Stats => {
  const add = db.prepare(
    `INSERT INTO arcade_stats (account_id, game, stat, value, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (account_id, game, stat) DO UPDATE SET
       value = value + excluded.value,
       updated_at = CASE WHEN excluded.value != 0 THEN excluded.updated_at ELSE updated_at END`,
  );
  const max = db.prepare(
    `INSERT INTO arcade_stats (account_id, game, stat, value, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (account_id, game, stat) DO UPDATE SET
       value = max(value, excluded.value),
       updated_at = CASE WHEN excluded.value > value THEN excluded.updated_at ELSE updated_at END`,
  );
  const get = db.prepare('SELECT value FROM arcade_stats WHERE account_id = ? AND game = ? AND stat = ?').pluck();
  return {
    add(accountId, game, stat, delta) {
      checkInt('delta', delta);
      add.run(accountId, game, stat, delta, clock.now());
    },
    max(accountId, game, stat, value) {
      checkInt('value', value);
      max.run(accountId, game, stat, value, clock.now());
    },
    get: (accountId, game, stat) => (get.get(accountId, game, stat) as number | undefined) ?? 0,
  };
};

/** `arcade_results` plus its `arcade_result_players` rows, in one transaction; the summary is stored as compact JSON. */
export const createResults = (db: DB, clock: Clock): Results => {
  const insertResult = db.prepare(
    'INSERT INTO arcade_results (game, mode, channel_id, humans, started_at, ended_at, summary) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insertPlayer = db.prepare(
    'INSERT INTO arcade_result_players (result_id, account_id, place, score, chips_delta) VALUES (?, ?, ?, ?, ?)',
  );
  const record = db.transaction((r: Parameters<Results['record']>[0], players: Parameters<Results['record']>[1]): number => {
    const summary = JSON.stringify(r.summary ?? null) ?? 'null';
    const id = Number(insertResult.run(r.game, r.mode, r.channelId, r.humans, r.startedAt, r.endedAt, summary).lastInsertRowid);
    for (const p of players) insertPlayer.run(id, p.accountId, p.place, p.score, p.chipsDelta);
    return id;
  });
  return { record: (r, players) => record(r, players) };
};

/** Each board's rows are cached this long. */
export const BOARD_CACHE_MS = 60_000;
/** Rows fetched per board (and the most a caller can ask for). */
export const BOARD_MAX_ROWS = 100;
export const BOARD_DEFAULT_ROWS = 20;

export interface Boards {
  /** The board's rows, best first; null for an unknown game or board. */
  rows(game: GameId, boardId: string, limit?: number): BoardRow[] | null;
  list(game: GameId): { id: string; label: string }[];
}

export const createBoards = (db: DB, clock: Clock, defs: readonly { game: GameId; boards?: readonly BoardDef[] }[]): Boards => {
  const byGame = new Map<GameId, Map<string, BoardDef>>();
  for (const def of defs) {
    const boards = byGame.get(def.game) ?? new Map<string, BoardDef>();
    for (const board of def.boards ?? []) boards.set(board.id, board);
    byGame.set(def.game, boards);
  }
  const cache = new Map<string, { at: number; rows: BoardRow[] }>();
  return {
    rows(game, boardId, limit = BOARD_DEFAULT_ROWS) {
      const def = byGame.get(game)?.get(boardId);
      if (!def) return null;
      const n = Math.max(1, Math.min(BOARD_MAX_ROWS, Math.floor(limit) || BOARD_DEFAULT_ROWS));
      const key = game + '\u0000' + boardId;
      const now = clock.now();
      let hit = cache.get(key);
      if (!hit || now - hit.at >= BOARD_CACHE_MS || now < hit.at) {
        const rows = def.query(db, BOARD_MAX_ROWS).map((row): BoardRow => {
          const out: BoardRow = { accountId: row.accountId, value: row.value };
          if (row.label !== undefined) out.label = row.label;
          return out;
        });
        hit = { at: now, rows };
        cache.set(key, hit);
      }
      return hit.rows.slice(0, n);
    },
    list: (game) => [...(byGame.get(game)?.values() ?? [])].map((board) => ({ id: board.id, label: board.label })),
  };
};
