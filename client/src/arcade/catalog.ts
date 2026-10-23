/**
 * The Arcade catalogue (plan.md §2.6.7): one small `meta.ts` per game, in the main bundle (≤ 1 KB
 * gzip each, the Arcade's main-bundle share ≤ 4 KB in all), and nothing else of the game until it
 * is opened. The shell draws its game cards, the generic setup form and the lobby chips from these
 * entries (features/arcade/setup.ts reads the fields). Each `meta.ts` is owned by its game; this
 * file only lists them, in sheet order.
 */
import type { GameChunk, GameId } from './runtime/types';
import { meta as bellwick } from './bellwick/meta';
import { meta as fuseyard } from './fuseyard/meta';
import { meta as glimmer } from './glimmer/meta';
import { meta as lamplight } from './lamplight/meta';

/** Solo play on this device, or a game with your call. */
export type Where = 'online' | 'offline';

export interface Choice {
  value: string | number;
  label: string;
  /** One short line under the label, e.g. "Buy in up to 1,000". */
  hint?: string;
}

/**
 * One field of the generic setup form. `when` limits it to some modes, to one place, and to while
 * another field has one of the listed values; a field that is part of the cfg but hidden that way
 * sends its default.
 */
export type OptionField = {
  key: string;
  label: string;
  /** One line under the field label. */
  hint?: string;
  when?: { mode?: readonly string[]; where?: Where; field?: { key: string; in: readonly unknown[] } };
  /** Under "More options" (collapsed): true everywhere, 'offline' / 'online' only there. */
  more?: boolean | Where;
  /** Decides the seat count at create (the hub reads players ?? fighters): read-only in the lobby. */
  setsSeats?: boolean;
  /** How summary lines show the chosen label, '#' standing for it ("# bots" → "Regular bots"). */
  sum?: string;
} & (
  | { kind: 'choice'; choices: readonly Choice[]; default: string | number; /** Default 'pills'. */ control?: 'pills' | 'stepper' | 'select' }
  | { kind: 'toggle'; default: boolean }
  /** `arcade:saves {game}`; `into` names the companion "new tale in" field the shell fills by itself. */
  | { kind: 'saveSlot'; into?: string }
);

export interface GameMeta {
  id: GameId;
  name: string;
  tagline: string;
  icon: 'cards' | 'coins' | 'bomb' | 'sword';
  lane: 'action' | 'table';
  /** A game shows its card only where it is ready. */
  ready: { offline: boolean; online: boolean };
  /** `blurb`: one line in plain words, about 70 characters (under the label on the setup screen's mode cards). */
  modes: readonly { id: string; label: string; blurb?: string; online: boolean; offline: boolean }[];
  /** Players, min and max. */
  seats: readonly [number, number];
  /** Offers Watch. */
  watch: boolean;
  /**
   * The lobby's host fills free seats with bots from the sheet (default true). False when the game
   * chooses its own bots (Lamplight, Fuseyard) or has none (Bellwick): the sheet then shows no bot
   * stepper, labels no seat "Bot" before the start, and leaves the minimum-players check to the game.
   */
  hostBots?: boolean;
  /** Plays with chips: the wallet in the sheet, the PRACTICE badge in solo play. */
  chips?: boolean;
  options: readonly OptionField[];
  /** `() => import('./index').then((m) => m.default)`. */
  load(): Promise<GameChunk>;
}

export const CATALOG: readonly GameMeta[] = [lamplight, glimmer, fuseyard, bellwick];

export const metaOf = (id: string): GameMeta | null => CATALOG.find((meta) => meta.id === id) ?? null;

/**
 * The default value of every option a mode sends (the setup form's starting point), for one place
 * when `where` is given. A save slot starts as 'new'.
 */
export const defaultOptions = (meta: GameMeta, mode: string, where?: Where): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const field of meta.options) {
    if (field.when?.mode && !field.when.mode.includes(mode)) continue;
    if (where && field.when?.where && field.when.where !== where) continue;
    out[field.key] = field.kind === 'saveSlot' ? 'new' : field.default;
  }
  return out;
};
