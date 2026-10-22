/**
 * Action games on the action lane (plan.md §2.6.3). Each action game supplies a `MatchGameDef`
 * (rooms/<id>.ts) whose `create()` returns a `MatchRuntime`: usually its pure `CoreMatch` wrapped
 * by `wrapCore` (rooms/wrap.ts).
 *
 * Around a runtime the platform does: the lane, tickets and resume tokens; per-recipient pacing,
 * the ladder and parking (and `At` marks when a FRAME merges several ticks); seat grace, away
 * limits and takeover; the late-join queue, reclaim and WELCOME re-sends on a role change; evSeq
 * deduplication; idle reapers, the restart and overload flow (PHASE 4, HANDOVER, 1012), the
 * watchdog and replay dumps, and the egress and event-loop degrade ladders.
 */
import type { ZodType } from 'zod';
import type { Logger } from '../../logger.js';
import type { GameBudget } from '../core/net/budget.js';
import type { CoreMatch, HostEvent } from '../core/net/match.js';
import type { ActionGameId } from '../core/version.js';
import type { SaveSummary, Saves } from '../saves.js';
import type { BoardDef, Results, Stats } from '../stats.js';
import type { Wallet } from '../wallet.js';

export type { CoreMatch, EventChunk, HostEvent, MatchResult, RecipientView, SeatCmd } from '../core/net/match.js';
export type { SaveRow, SaveSlot, SaveSummary, Saves } from '../saves.js';

export interface MatchRuntime extends CoreMatch {
  readonly game: ActionGameId;
  readonly id: string;
  /** HANDOVER body (opaque per game): Fuseyard its dump plus records, Bellwick SaveV1 plus hero placement. */
  handover(): Uint8Array;
  /** ≤ 8 KB deflated, for watchdog dumps. */
  replay(): Uint8Array;
  dispose(): void;
}

export interface SeatInit {
  slot: number;
  accountId: string | null;
  bot: boolean;
  botLevel: number;
}

export interface MatchCreateCtx {
  id: string;
  channelId: string;
  /** The lobby's mode (one of the game's catalogue modes, e.g. 'brawl'). */
  mode: string;
  /** The lobby options, after the game's cfgSchema. */
  cfg: unknown;
  seed: number;
  seats: readonly SeatInit[];
  /** Bellwick: the tale this session plays from. */
  save: { ownerId: string; slot: number; data: Uint8Array | null } | null;
  log: Logger;
}

export interface PersistApi {
  wallet: Wallet;
  stats: Stats;
  results: Results;
  saves: Saves;
  accountOf(slot: number): string | null;
}

export interface MatchGameDef {
  readonly game: ActionGameId;
  readonly wireId: 1 | 2;
  readonly seats: { min: number; max: 4 };
  /** Fuseyard 4, Bellwick 0. */
  readonly spectators: number;
  /** Fuseyard queues late joiners to the next round; Bellwick drops them in. */
  readonly join: 'nextRound' | 'dropIn';
  /** Who becomes host when the host leaves. */
  readonly host: 'lowestSeat' | 'longestPresent';
  /**
   * Seat grace: a ghost or resting seat after a drop, stall, away or yield. After `episodeMs` (or
   * `matchMs` in total per match) the seat goes to a bot or leaves; `awayLimitMs` closes the lane
   * with 4000 after that long away.
   */
  readonly grace: { episodeMs: number; matchMs: number | null; awayLimitMs: number; after: 'bot' | 'leave' };
  /** Fuseyard 30 s / 120 s, Bellwick 60 s / 300 s. */
  readonly idle: { noHumanMs: number; noInputMs: number };
  readonly sender: { skipUnchanged: boolean; budget: GameBudget };
  /** Bellwick 3; null for no own limit. */
  readonly serverLimit: number | null;
  readonly botFill: boolean;
  readonly cfgSchema: ZodType<unknown>;
  create(ctx: MatchCreateCtx): MatchRuntime;
  /** Runs inside one db transaction. */
  persist(e: Extract<HostEvent, { t: 'persist' | 'end' }>, api: PersistApi): void;
  /** ≤ 400 B list rows. */
  summarizeSave?(data: Uint8Array): SaveSummary;
  readonly boards?: readonly BoardDef[];
}
