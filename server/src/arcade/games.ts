/**
 * Static registry over the handover stubs (plan.md §2.2 rule 2): adding a game replaces its stub's
 * default export and never edits this file. A null entry is a game that is not available yet.
 */
import type { ActionGameId, GameId } from './core/version.js';
import glimmer from './halls/glimmer.js';
import bellwick from './rooms/bellwick.js';
import fuseyard from './rooms/fuseyard.js';
import type { MatchGameDef } from './rooms/types.js';
import type { GameSettingsParsers } from './settings.js';
import lamplight from './tables/lamplight.js';
import type { TableGameDef } from './tables/types.js';

export const MATCH_GAMES: readonly (MatchGameDef | null)[] = [fuseyard, bellwick];
export const TABLE_GAMES: readonly (TableGameDef | null)[] = [lamplight, glimmer];

export const matchGame = (game: GameId, games: readonly (MatchGameDef | null)[] = MATCH_GAMES): MatchGameDef | null =>
  games.find((def) => def?.game === game) ?? null;

export const tableGame = (game: GameId, games: readonly (TableGameDef | null)[] = TABLE_GAMES): TableGameDef | null =>
  games.find((def) => def?.game === game) ?? null;

/** Is this game implemented on the server (its stub replaced)? */
export const gameAvailable = (game: GameId, match: readonly (MatchGameDef | null)[] = MATCH_GAMES, table: readonly (TableGameDef | null)[] = TABLE_GAMES): boolean =>
  (game === 'fuseyard' || game === 'bellwick' ? matchGame(game, match) : tableGame(game, table)) !== null;

export const isActionGame = (game: GameId): game is ActionGameId => game === 'fuseyard' || game === 'bellwick';

/** Each table game's admin settings parser, for settings.ts. */
export const gameSettingsParsers = (table: readonly (TableGameDef | null)[] = TABLE_GAMES): GameSettingsParsers => {
  const out: GameSettingsParsers = {};
  for (const def of table) if (def?.settings) out[def.game] = { schema: def.settings.schema, defaults: def.settings.defaults };
  return out;
};
