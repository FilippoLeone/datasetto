/**
 * Table games on the table lane (plan.md §2.6.4): Lamplight and Glimmerhall run as event-driven
 * games on the app's main socket. The platform gives each one a `TableApi` (paced emits, rooms,
 * wallet, stats, the hub) and calls its `TableGame` hooks.
 *
 * Ack convention for every `arcade:*`, `lamplight:*` and `glimmer:*` event: `{ok: true, …}` or
 * `{ok: false, code}`. Refusals are quiet: no toast unless it is the sender's own action, no `error`
 * emit, a debug log line.
 */
import type { ZodType } from 'zod';
import type { Logger } from '../../logger.js';
import type { Clock } from '../clock.js';
import type { GameId } from '../core/version.js';
import type { ArcadeLimits, ArcadeSettings, SettingsField } from '../settings.js';
import type { BoardDef, Results, Stats } from '../stats.js';
import type { Wallet } from '../wallet.js';

export type { BoardDef, Results, Stats } from '../stats.js';
export type { Leg, LedgerAccount, Transfer, TransferOpts, TxnKind, Wallet } from '../wallet.js';

export interface CallerCtx {
  accountId: string;
  socketId: string;
  voiceChannelId: string | null;
}

export interface EmitOpts {
  /** The per-game queue in the socket's paced emitter (3 KB/s, 6 KB depth). */
  queue: 'lamplight' | 'glimmer';
  /** Newest-wins key (emotes, feed, wallet). */
  coalesce?: string;
  /** Send-time fields, e.g. ms left from an absolute deadline. */
  stamp?(data: unknown, sentAtMs: number): unknown;
  /** Queue-wait report (Lamplight turn credit). */
  onSent?(waitedMs: number): void;
  /** Per-game sub-bucket (Glimmerhall pushes: 200 B/s, 800 B). */
  sub?: { rateBps: number; depth: number };
}

export interface QueuePolicy {
  /** Lamplight 32 / 2,000. */
  maxEvents: number;
  maxAgeMs: number;
  /** The event that replaces an overflowing queue (e.g. a fresh lamplight:snap), or null to just drop it. */
  onOverflow(socketId: string): { ev: string; data: unknown } | null;
}

export interface TableApi {
  /** Register a C→S event. The ack is the return value; refusals are quiet. */
  on<T>(
    event: `${'lamplight' | 'glimmer'}:${string}`,
    opts: { schema: ZodType<T>; limiter: 'arcade' | 'arcadeAct' | 'spin'; acked: boolean; voiceMember?: boolean },
    fn: (c: CallerCtx, payload: T) => unknown | Promise<unknown>,
  ): void;
  queuePolicy(queue: 'lamplight' | 'glimmer', p: QueuePolicy): void;
  /** Paced; waits while the main socket's writeBuffer is non-empty. */
  emit(socketId: string, ev: string, data: unknown, opts: EmitOpts): void;
  emitAccount(accountId: string, ev: string, data: unknown, opts: EmitOpts & { except?: string }): void;
  /** Per-socket fan-out, never io.to(). */
  emitRoom(room: string, ev: string, build: (socketId: string) => unknown, opts: EmitOpts): void;
  rooms: { join(socketId: string, room: string): void; leave(socketId: string, room: string): void; size(room: string): number };
  wallet: Wallet;
  stats: Stats;
  results: Results;
  hub: HubApi;
  presence: {
    isVoiceMember(accountId: string, channelId: string): boolean;
    socketsOf(accountId: string): readonly string[];
    dnd(accountId: string): boolean;
  };
  prefs: { hidden(accountId: string, game: GameId): boolean };
  ackRttMs(socketId: string): number;
  clock: Clock;
  log: Logger;
  settings(): ArcadeSettings;
}

export interface TableGameDef {
  readonly game: 'lamplight' | 'glimmer';
  /** Public config: arcade.proto.lamplight / arcade.defs.glimmer. */
  readonly proto: number;
  /** 'open' | 'cup' | 'trio'; 'hall' | 'dash'. */
  readonly modes: readonly string[];
  readonly cfgSchema: ZodType<unknown> | null;
  /** trioTable, slotsMaxBet, … edited in Admin › Arcade. */
  readonly settings?: { schema: ZodType<unknown>; defaults: unknown; fields: readonly SettingsField[] };
  readonly boards?: readonly BoardDef[];
  start(api: TableApi): TableGame;
}

export type Refusal = { ok: false; code: string };

export interface TableGame {
  lobby?: {
    onCreate(c: CallerCtx, cfg: unknown): { ok: true } | Refusal;
    /** May escrow a buy-in. */
    onJoin(c: CallerCtx, lobby: LobbyRecord, as: 'player' | 'spectator'): { ok: true } | Refusal;
    onLeave(c: CallerCtx, lobby: LobbyRecord): void;
    onStart(lobby: LobbyRecord): { ok: true } | Refusal;
  };
  onAway(socketId: string, id: string): void;
  onBack(socketId: string, id: string, since: number): void;
  onVoiceLeft(accountId: string, channelId: string): void;
  onSocketGone(accountId: string, socketId: string): void;
  onRestarting(): void;
  onBoot(): void;
  daily(nowMs: number): void;
  onDisable(): void;
  activity(channelId: string): readonly ActivityEntry[];
  /** Clears every timer the game holds. */
  stop(): void;
}

// ------------------------------------------------------------------------------ hub

export interface LobbyRecord {
  id: string;
  game: GameId;
  channelId: string;
  mode: string;
  cfg: unknown;
  /** Account id of the host. */
  host: string;
  seats: readonly { accountId: string | null; bot: boolean; state: number }[];
  watchers: readonly string[];
  state: 'open' | 'live' | 'ended';
}

export interface ActivityEntry {
  g: GameId;
  id: string;
  st: 'open' | 'lobby' | 'live' | 'dash';
  /** Players. */
  n: number;
  max: number;
  /** Watchers. */
  w: number;
  /** Optional label, ≤ 24 characters ("Cobble 25/50", "Cup 2k"). */
  x?: string;
  /** For 60 s after a pot win. */
  j?: { amt: number };
}

export interface HubApi {
  get(lobbyId: string): LobbyRecord | null;
  /** Coalesced arcade:lobby, ≤ 2 Hz. */
  publish(lobbyId: string): void;
  /** Coalesced arcade:activity, ≤ 1 per 2 s per channel. */
  activityChanged(channelId: string): void;
  close(lobbyId: string, reason: string): void;
  /** Server-wide poker bot cap (6). */
  bots: { take(n: number): boolean; give(n: number): void };
  limits(): ArcadeLimits;
}
