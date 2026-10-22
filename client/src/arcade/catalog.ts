/**
 * The Arcade catalogue (plan.md §2.6.7): one small `meta.ts` per game, in the main bundle (≤ 300 B
 * gzip each), and nothing else of the game until it is opened. The shell draws its tiles, the
 * generic lobby options form and the lobby chips from these entries. Each `meta.ts` is owned by its
 * game; this file only lists them, in sheet order.
 */
import type { GameChunk, GameId } from './runtime/types';
import { meta as bellwick } from './bellwick/meta';
import { meta as fuseyard } from './fuseyard/meta';
import { meta as glimmer } from './glimmer/meta';
import { meta as lamplight } from './lamplight/meta';

/** One field of the generic lobby options form; `when` shows it only for some modes. */
export type OptionField = { key: string; label: string; when?: { mode: readonly string[] } } & (
  | { kind: 'choice'; choices: readonly { value: string | number; label: string }[]; default: string | number }
  | { kind: 'toggle'; default: boolean }
  /** Calls `arcade:saves {game}` and lists the slots. */
  | { kind: 'saveSlot' }
);

export interface GameMeta {
  id: GameId;
  name: string;
  tagline: string;
  icon: 'cards' | 'coins' | 'bomb' | 'sword';
  lane: 'action' | 'table';
  /** A game shows its tile only where it is ready. */
  ready: { offline: boolean; online: boolean };
  modes: readonly { id: string; label: string; online: boolean; offline: boolean }[];
  /** Players, min and max. */
  seats: readonly [number, number];
  /** Offers Watch. */
  watch: boolean;
  options: readonly OptionField[];
  /** `() => import('./index').then((m) => m.default)`. */
  load(): Promise<GameChunk>;
}

export const CATALOG: readonly GameMeta[] = [lamplight, glimmer, fuseyard, bellwick];

export const metaOf = (id: string): GameMeta | null => CATALOG.find((meta) => meta.id === id) ?? null;

/** The default value of every option a mode shows (the offline form's starting point). */
export const defaultOptions = (meta: GameMeta, mode: string): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const field of meta.options) {
    if (field.when && !field.when.mode.includes(mode)) continue;
    if (field.kind === 'choice' || field.kind === 'toggle') out[field.key] = field.default;
    else out[field.key] = 'new';
  }
  return out;
};
