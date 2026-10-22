/**
 * "Hide Arcade" and the per-game toggles (`arcade_prefs`, plan.md §1.3 #15, glimmerhall.md §15).
 * They double as self-exclusion, so the server enforces them and they are asymmetric:
 * - hiding (`hidden: true`, or `games[g]: false`) applies at once;
 * - un-hiding is delayed: the stored state stays as it is and the wanted change waits in the row
 *   until `reenable_at` (now + 24 h). A new un-hide restarts that wait; hiding again cancels it.
 * The pending change is applied (and saved) by the first read at or after `reenable_at`, so no
 * timer is needed. A row is only written once the account changes something.
 *
 * Storage: `hidden` is the flag; `games` is JSON `{ <game>: false, …, pending?: { hidden?: false,
 * games?: { <game>: true } } }`, holding the hidden games and the un-hides that are waiting.
 */
import type { DB } from '../db/index.js';
import type { Clock } from './clock.js';
import { GAME_IDS, type GameId } from './core/version.js';

export interface ArcadePrefsRow {
  hidden: boolean;
  /** `games[g] === false` means that game is hidden. */
  games: Partial<Record<GameId, boolean>>;
  /** When the waiting un-hide applies; null when nothing is waiting. */
  reenableAt: number | null;
}

export interface ArcadePrefs {
  get(accountId: string): ArcadePrefsRow;
  set(accountId: string, next: { hidden?: boolean; games?: Partial<Record<GameId, boolean>> }): ArcadePrefsRow;
  /** Is this game hidden for the account (the whole Arcade, or that game)? */
  hidden(accountId: string, game: GameId): boolean;
}

/** Un-hiding takes effect this long after it is asked for. */
export const REENABLE_DELAY_MS = 24 * 60 * 60 * 1000;

interface Pending {
  hidden?: false;
  games?: Partial<Record<GameId, true>>;
}

interface State {
  hidden: boolean;
  /** Games currently hidden. */
  off: Set<GameId>;
  pending: Pending;
  reenableAt: number | null;
}

type RawPrefs = { hidden: number; games: string; reenableAt: number | null };

const parseState = (raw: RawPrefs | undefined): State => {
  const state: State = { hidden: false, off: new Set(), pending: {}, reenableAt: null };
  if (!raw) return state;
  state.hidden = raw.hidden !== 0;
  state.reenableAt = raw.reenableAt;
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw.games);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
  } catch {
    json = {};
  }
  for (const game of GAME_IDS) if (json[game] === false) state.off.add(game);
  const pending = json.pending && typeof json.pending === 'object' ? (json.pending as Record<string, unknown>) : {};
  if (pending.hidden === false && state.hidden) state.pending.hidden = false;
  const games = pending.games && typeof pending.games === 'object' ? (pending.games as Record<string, unknown>) : {};
  for (const game of GAME_IDS) {
    if (games[game] === true && state.off.has(game)) (state.pending.games ??= {})[game] = true;
  }
  if (!hasPending(state.pending)) state.reenableAt = null;
  return state;
};

const hasPending = (p: Pending): boolean => p.hidden === false || Object.keys(p.games ?? {}).length > 0;

const serializeGames = (state: State): string => {
  const out: Record<string, unknown> = {};
  for (const game of GAME_IDS) if (state.off.has(game)) out[game] = false;
  if (hasPending(state.pending)) out.pending = state.pending;
  return JSON.stringify(out);
};

const toRow = (state: State): ArcadePrefsRow => {
  const games: Partial<Record<GameId, boolean>> = {};
  for (const game of GAME_IDS) if (state.off.has(game)) games[game] = false;
  return { hidden: state.hidden, games, reenableAt: state.reenableAt };
};

export const createPrefs = (db: DB, clock: Clock): ArcadePrefs => {
  const read = db.prepare('SELECT hidden, games, reenable_at AS reenableAt FROM arcade_prefs WHERE account_id = ?');
  const write = db.prepare(
    `INSERT INTO arcade_prefs (account_id, hidden, games, reenable_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET
       hidden = excluded.hidden, games = excluded.games, reenable_at = excluded.reenable_at, updated_at = excluded.updated_at`,
  );

  const save = (accountId: string, state: State, now: number): void => {
    write.run(accountId, state.hidden ? 1 : 0, serializeGames(state), state.reenableAt, now);
  };

  /** The stored state with a due un-hide applied (and saved). */
  const load = (accountId: string, now: number): State => {
    const state = parseState(read.get(accountId) as RawPrefs | undefined);
    if (state.reenableAt !== null && now >= state.reenableAt) {
      if (state.pending.hidden === false) state.hidden = false;
      for (const game of Object.keys(state.pending.games ?? {}) as GameId[]) state.off.delete(game);
      state.pending = {};
      state.reenableAt = null;
      save(accountId, state, now);
    }
    return state;
  };

  const get = (accountId: string): ArcadePrefsRow => toRow(load(accountId, clock.now()));

  const set: ArcadePrefs['set'] = (accountId, next) =>
    db.transaction((): ArcadePrefsRow => {
      const now = clock.now();
      const state = load(accountId, now);
      const pending: Pending = { ...state.pending, games: { ...state.pending.games } };
      let restart = false;

      // The whole Arcade.
      const wantHidden = typeof next.hidden === 'boolean' ? next.hidden : pending.hidden === false ? false : state.hidden;
      if (wantHidden) {
        state.hidden = true;
        delete pending.hidden;
      } else if (state.hidden && pending.hidden !== false) {
        pending.hidden = false;
        restart = true;
      }

      // Per game.
      for (const game of GAME_IDS) {
        const waiting = pending.games?.[game] === true;
        const asked = next.games?.[game];
        const wantOn = typeof asked === 'boolean' ? asked : waiting || !state.off.has(game);
        if (!wantOn) {
          state.off.add(game);
          delete pending.games?.[game];
        } else if (state.off.has(game) && !waiting) {
          (pending.games ??= {})[game] = true;
          restart = true;
        }
      }

      if (pending.games && Object.keys(pending.games).length === 0) delete pending.games;
      state.pending = pending;
      state.reenableAt = !hasPending(pending) ? null : restart || state.reenableAt === null ? now + REENABLE_DELAY_MS : state.reenableAt;
      save(accountId, state, now);
      return toRow(state);
    })();

  const hidden: ArcadePrefs['hidden'] = (accountId, game) => {
    const state = load(accountId, clock.now());
    return state.hidden || state.off.has(game);
  };

  return { get, set, hidden };
};
