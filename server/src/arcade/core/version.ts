/**
 * Arcade version numbers. The numbers themselves live in each game's own `core/<id>/version.ts`,
 * so a codec or sim bump never touches this file; this module only gathers them.
 *
 * - `PROTO`: the action-lane envelope (net/lane.ts). Changes only with the platform.
 * - `CODEC`: a game's wire format on the action lane. Online play needs the same codec on both sides.
 * - `SIM`: a game's simulation rules. A different sim version only degrades prediction; golden replay
 *   hashes fail until it is bumped.
 * - `DEFS`: Glimmerhall's machine definitions (strips, paytables, lines, features).
 * - `TABLE_PROTO`: Lamplight's table-lane events.
 */
import { VERSION as BELLWICK } from './bellwick/version.js';
import { VERSION as FUSEYARD } from './fuseyard/version.js';
import { VERSION as GLIMMER } from './glimmer/version.js';
import { VERSION as LAMPLIGHT } from './lamplight/version.js';

export type GameId = 'lamplight' | 'glimmer' | 'fuseyard' | 'bellwick';
export type ActionGameId = 'fuseyard' | 'bellwick';
export type TableGameId = 'lamplight' | 'glimmer';

/** Every game, in catalogue order. */
export const GAME_IDS: readonly GameId[] = ['lamplight', 'glimmer', 'fuseyard', 'bellwick'];
export const ACTION_GAME_IDS: readonly ActionGameId[] = ['fuseyard', 'bellwick'];
export const TABLE_GAME_IDS: readonly TableGameId[] = ['lamplight', 'glimmer'];

export const isGameId = (value: unknown): value is GameId => typeof value === 'string' && (GAME_IDS as readonly string[]).includes(value);

export const PROTO = 1;

/** The `game` byte in WELCOME. */
export const WIRE_GAME: { readonly fuseyard: 1; readonly bellwick: 2 } = { fuseyard: 1, bellwick: 2 };

export const CODEC: { readonly fuseyard: number; readonly bellwick: number } = { fuseyard: FUSEYARD.codec, bellwick: BELLWICK.codec };
export const SIM: { readonly fuseyard: number; readonly bellwick: number } = { fuseyard: FUSEYARD.sim, bellwick: BELLWICK.sim };
export const DEFS: { readonly glimmer: number } = { glimmer: GLIMMER.defs };
export const TABLE_PROTO: { readonly lamplight: number } = { lamplight: LAMPLIGHT.proto };
