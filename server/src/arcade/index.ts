/**
 * The Arcade on the server (docs/arcade/platform.md). `createArcade` is wired once by
 * socket/index.ts; the entry point stops it with the other components and shutdown.ts calls
 * `onRestarting()` before the sockets close.
 *
 * With nothing open the Arcade runs no timers except the daily job: the scheduler starts with the
 * first live action match, the watchdog samples only while matches exist, the lane heartbeat only
 * while a lane is open, and table games hold timers only while they play.
 */
import type { Server as HttpServer } from 'node:http';
import type { Server } from 'socket.io';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { notAuthenticated } from '../errors.js';
import type { SocketContext } from '../socket/context.js';
import { systemClock, type Clock } from './clock.js';
import { fromB64url } from './core/bytes.js';
import { CLOSE, type ClientMsg } from './core/net/lane.js';
import { CODEC, DEFS, GAME_IDS, PROTO, TABLE_PROTO, type GameId } from './core/version.js';
import { MATCH_GAMES, TABLE_GAMES, gameAvailable, gameSettingsParsers, isActionGame, matchGame, tableGame } from './games.js';
import { callerOf, createPacedEmitter, gameSchema, idSchema, registerArcadeHandlers, tableRegistrar, type PlatformEvents, type TableEvent } from './handlers.js';
import { createHub, type Hub } from './hub.js';
import { createLane } from './lane.js';
import { registerLegacyHandlers } from './legacy.js';
import { createMaintenance } from './maintenance.js';
import { createPrefs } from './prefs.js';
import type { MatchGameDef, PersistApi } from './rooms/types.js';
import { createPending } from './pending.js';
import { createSaves, SAVE_MAX_BYTES, type SaveSlot } from './saves.js';
import { createScheduler } from './scheduler.js';
import { loadSettings, normalizeSettings, saveSettings, settingsInputSchema, type ArcadeSettings } from './settings.js';
import { createBoards, createResults, createStats } from './stats.js';
import type { TableApi, TableGame, TableGameDef } from './tables/types.js';
import { createTickets } from './tickets.js';
import { createWallet } from './wallet.js';
import { createWatchdog } from './watchdog.js';

export interface ArcadePublicConfig {
  enabled: boolean;
  games: Record<GameId, boolean>;
  proto: { lamplight: number };
  defs: { glimmer: number };
}

export interface Arcade {
  stop(): Promise<void>;
  onRestarting(): Promise<void>;
  /** After auth:success: arcade:activity:all, arcade:prefs and (when it exists) arcade:wallet. */
  onAuthenticated(sctx: SocketContext): void;
  /** An account left a voice channel: its seats there start their grace rules. */
  onVoiceLeft(accountId: string, channelId: string): void;
  onSocketGone(sctx: SocketContext): void;
  publicConfig(): ArcadePublicConfig;
  /** Register the Arcade's main-socket events on a new connection (called by socket/index.ts). */
  register(sctx: SocketContext): void;
}

export interface ArcadeOptions {
  clock?: Clock;
  /** Tests: replace the registry's game definitions. */
  matchGames?: readonly (MatchGameDef | null)[];
  tableGames?: readonly (TableGameDef | null)[];
  /** Tests: decide when a socket counts as having chat queued in engine.io (default: its writeBuffer). */
  tableLaneBusy?(socketId: string): boolean;
}

/** Escrow ref prefixes per table game, refunded when the game is switched off. */
const ESCROW_PREFIXES: Partial<Record<GameId, readonly string[]>> = { lamplight: ['lamplight:', 'cup:', 'trio:'], glimmer: ['dash:'] };
const WALLET_PUSH_MS = 2000;
const EGRESS_FLUSH_MS = 60_000;

export const createArcade = (ctx: AppContext, http: HttpServer, io: Server, opts: ArcadeOptions = {}): Arcade => {
  const clock = opts.clock ?? systemClock;
  const matchDefs = opts.matchGames ?? MATCH_GAMES;
  const tableDefs = opts.tableGames ?? TABLE_GAMES;
  const parsers = gameSettingsParsers(tableDefs);
  let settings: ArcadeSettings = loadSettings(ctx.db, parsers);
  const currentSettings = (): ArcadeSettings => settings;

  // ---------------------------------------------------------------- persistence
  const walletPushAt = new Map<string, number>();
  const walletPushTimers = new Map<string, unknown>();
  const prefs = createPrefs(ctx.db, clock);
  const pending = createPending(ctx.db, clock);
  const pushWallet = (accountId: string): void => {
    walletPushTimers.delete(accountId);
    walletPushAt.set(accountId, clock.now());
    const view = wallet.view(accountId);
    for (const socketId of ctx.presence.getSocketsByAccount(accountId)) io.sockets.sockets.get(socketId)?.emit('arcade:wallet', view);
  };
  const wallet = createWallet(ctx.db, {
    clock,
    settings: currentSettings,
    onChange: (accountIds) => {
      for (const accountId of accountIds) {
        if (walletPushTimers.has(accountId) || ctx.presence.getSocketsByAccount(accountId).length === 0) continue;
        const wait = Math.max(0, (walletPushAt.get(accountId) ?? 0) + WALLET_PUSH_MS - clock.now());
        walletPushTimers.set(
          accountId,
          clock.setTimeout(() => pushWallet(accountId), wait),
        );
      }
    },
  });
  const stats = createStats(ctx.db, clock);
  const results = createResults(ctx.db, clock);
  const boardDefs = [...matchDefs, ...tableDefs].flatMap((def) => (def ? [{ game: def.game, boards: def.boards }] : []));
  const boards = createBoards(ctx.db, clock, boardDefs);
  // eslint-disable-next-line prefer-const
  let hub: Hub;
  const saves = createSaves(ctx.db, clock, (ownerId, game, slot) => hub.saveInUse(ownerId, game, slot));
  const tx = <T>(fn: () => T): T => wallet.tx(fn);
  const persistApi = (accountOf: (slot: number) => string | null): PersistApi => ({ wallet, stats, results, saves, accountOf });

  // ---------------------------------------------------------------- egress
  let egressPending = 0;
  let egressTimer: unknown = null;
  const flushEgress = (): void => {
    egressTimer = null;
    if (egressPending > 0) ctx.usage.addArcadeEgress(egressPending, clock.now());
    egressPending = 0;
  };
  const countEgress = (bytes: number): void => {
    egressPending += bytes;
    if (egressTimer === null) egressTimer = clock.setTimeout(flushEgress, EGRESS_FLUSH_MS);
  };

  // ---------------------------------------------------------------- engines
  const tickets = createTickets(clock);
  const watchdog = createWatchdog({ clock, log: ctx.log, egressKbps: () => settings.limits.egressKbps });
  const scheduler = createScheduler({ clock, onStep: (match, ms) => watchdog.step(match.id, ms) });
  const emitter = createPacedEmitter({ io, clock, onEgress: countEgress, busy: opts.tableLaneBusy ? (socket) => (opts.tableLaneBusy as (id: string) => boolean)(socket.id) : undefined });

  // ---------------------------------------------------------------- table games
  const tableEvents: TableEvent[] = [];
  const tableGames = new Map<GameId, TableGame>();
  const rooms = new Map<string, Set<string>>();
  const socketRooms = new Map<string, Set<string>>();

  const isVoiceMember = (accountId: string, channelId: string): boolean => {
    const room = ctx.presence.voiceRoom(channelId);
    if (!room) return false;
    for (const participant of room.participants.values()) if (participant.accountId === accountId) return true;
    return false;
  };

  const laneRtt = new Map<string, number>();

  hub = createHub({
    ctx,
    io,
    clock,
    tickets,
    scheduler,
    watchdog,
    prefs,
    saves,
    settings: currentSettings,
    persistApi,
    tx,
    tableGames: () => tableGames,
    matchDef: (game) => matchGame(game, matchDefs),
    tableDef: (game) => tableGame(game, tableDefs),
    mainBusy: (accountId) => {
      for (const socketId of ctx.presence.getSocketsByAccount(accountId)) {
        if (opts.tableLaneBusy?.(socketId)) return true;
        const conn = io.sockets.sockets.get(socketId)?.conn as unknown as { writeBuffer?: unknown[] } | undefined;
        if (Array.isArray(conn?.writeBuffer) && conn.writeBuffer.length > 0) return true;
      }
      return false;
    },
  });

  const apiFor = (def: TableGameDef): TableApi => ({
    on: tableRegistrar(def.game, tableEvents),
    queuePolicy: (queue, p) => emitter.policy(queue, p),
    emit: (socketId, ev, data, o) => emitter.emit(socketId, ev, data, o),
    emitAccount: (accountId, ev, data, o) => {
      for (const socketId of ctx.presence.getSocketsByAccount(accountId)) if (socketId !== o.except) emitter.emit(socketId, ev, data, o);
    },
    emitRoom: (room, ev, build, o) => {
      for (const socketId of rooms.get(room) ?? []) emitter.emit(socketId, ev, build(socketId), o);
    },
    rooms: {
      join(socketId, room) {
        let set = rooms.get(room);
        if (!set) {
          set = new Set();
          rooms.set(room, set);
        }
        set.add(socketId);
        let mine = socketRooms.get(socketId);
        if (!mine) {
          mine = new Set();
          socketRooms.set(socketId, mine);
        }
        mine.add(room);
      },
      leave(socketId, room) {
        rooms.get(room)?.delete(socketId);
        if (rooms.get(room)?.size === 0) rooms.delete(room);
        socketRooms.get(socketId)?.delete(room);
      },
      size: (room) => rooms.get(room)?.size ?? 0,
    },
    wallet,
    stats,
    results,
    hub,
    presence: {
      isVoiceMember,
      socketsOf: (accountId) => ctx.presence.getSocketsByAccount(accountId),
      // The app has no Do Not Disturb status yet; invites honour it once it exists.
      dnd: () => false,
    },
    prefs: { hidden: (accountId, game) => prefs.hidden(accountId, game) },
    ackRttMs: (socketId) => laneRtt.get(socketId) ?? 0,
    clock,
    log: ctx.log.child({ arcade: def.game }),
    settings: currentSettings,
    db: ctx.db,
    pending,
  });

  // Crash recovery: escrow left by a process that died without notice goes back to its owners.
  try {
    const refunded = wallet.refund('', 'restart-refund');
    if (refunded > 0) ctx.log.info({ refunded }, 'arcade escrow refunded at boot');
  } catch (error) {
    ctx.log.error({ err: error }, 'arcade boot refund failed');
  }

  for (const def of tableDefs) {
    if (!def) continue;
    try {
      const game = def.start(apiFor(def));
      tableGames.set(def.game, game);
      game.onBoot();
    } catch (error) {
      ctx.log.error({ err: error, game: def.game }, 'arcade table game failed to start');
    }
  }

  const maintenance = createMaintenance({ db: ctx.db, clock, log: ctx.log, tableGames: () => tableGames.values() });

  // ---------------------------------------------------------------- the lane
  const lane = createLane({
    ctx,
    http,
    clock,
    lanePerIp: () => settings.limits.lanePerIp,
    handlers: {
      hello(conn, hello) {
        if (hello.proto !== PROTO) return CLOSE.update;
        const bound = hub.bindLane(conn, 'ticket' in hello ? { ticket: hello.ticket } : { resume: hello.resume });
        if (typeof bound === 'number') return bound;
        const game = bound.match.game;
        if (hello.codec[game] !== CODEC[game]) return CLOSE.update;
        if (!settings.enabled || !settings.games[game] || prefs.hidden(bound.accountId, game)) return CLOSE.forbidden;
        const code = bound.match.attach(conn, { accountId: bound.accountId, role: bound.role, via: bound.via });
        if (code !== 0) return code;
        scheduler.wake();
        return {
          onMessage: (msg: ClientMsg) => {
            bound.match.onMessage(conn, msg);
            if (msg.t === 'vis' || msg.t === 'resync') scheduler.wake();
          },
          onClose: (closeCode: number) => {
            bound.match.onClose(conn, closeCode);
            scheduler.wake();
          },
        };
      },
    },
  });

  // ---------------------------------------------------------------- config
  const publicConfig = (): ArcadePublicConfig => {
    const games = {} as Record<GameId, boolean>;
    for (const game of GAME_IDS) games[game] = settings.enabled && settings.games[game] && gameAvailable(game, matchDefs, tableDefs);
    return { enabled: settings.enabled, games, proto: { lamplight: TABLE_PROTO.lamplight }, defs: { glimmer: DEFS.glimmer } };
  };

  const refuse = (accountId: string, game: GameId): string | null => {
    if (!settings.enabled || !settings.games[game]) return 'disabled';
    if (prefs.hidden(accountId, game)) return 'hidden';
    return null;
  };

  const caller = (sctx: SocketContext) => {
    const c = callerOf(sctx);
    if (!c) throw notAuthenticated();
    return c;
  };

  const disableGames = (before: ArcadeSettings, after: ArcadeSettings): void => {
    for (const game of GAME_IDS) {
      const was = before.enabled && before.games[game];
      const now = after.enabled && after.games[game];
      if (!was || now) continue;
      hub.disableGame(game);
      tableGames.get(game)?.onDisable();
      for (const prefix of ESCROW_PREFIXES[game] ?? []) wallet.refund(prefix, 'refund');
    }
    io.emit('arcade:config', publicConfig());
  };

  // ---------------------------------------------------------------- platform events
  const slotSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
  const platform: PlatformEvents = {
    'arcade:lobby:create': {
      schema: z.object({ ch: idSchema, game: gameSchema, mode: z.string().min(1).max(16), cfg: z.unknown().optional() }),
      fn: (sctx, p) => {
        const input = p as { ch: string; game: GameId; mode: string; cfg?: unknown };
        return hub.create(caller(sctx), { ch: input.ch, game: input.game, mode: input.mode, cfg: input.cfg ?? {} });
      },
    },
    'arcade:lobby:join': {
      schema: z.object({ id: idSchema, as: z.enum(['player', 'spectator']).default('player') }),
      fn: (sctx, p) => hub.join(caller(sctx), p as { id: string; as: 'player' | 'spectator' }),
    },
    'arcade:lobby:leave': { schema: z.object({ id: idSchema }), fn: (sctx, p) => hub.leave(caller(sctx), (p as { id: string }).id) },
    'arcade:lobby:start': { schema: z.object({ id: idSchema }), fn: (sctx, p) => hub.start(caller(sctx), (p as { id: string }).id) },
    'arcade:lobby:bots': {
      schema: z.object({ id: idSchema, count: z.number().int().min(0).max(9), level: z.number().int().min(0).max(9).default(1) }),
      fn: (sctx, p) => {
        const input = p as { id: string; count: number; level: number };
        return hub.setBots(caller(sctx), input.id, input.count, input.level);
      },
    },
    'arcade:lobby:config': { schema: z.object({ id: idSchema, cfg: z.unknown() }), fn: (sctx, p) => hub.setConfig(caller(sctx), (p as { id: string }).id, (p as { cfg: unknown }).cfg) },
    'arcade:ticket': { schema: z.object({ id: idSchema }), fn: (sctx, p) => hub.ticket(caller(sctx), (p as { id: string }).id) },
    'arcade:invite': { schema: z.object({ id: idSchema, to: idSchema }), fn: (sctx, p) => hub.invite(caller(sctx), (p as { id: string }).id, (p as { to: string }).to) },
    'arcade:wallet': {
      schema: z.object({}).passthrough().optional(),
      fn: (sctx) => ({ ok: true, ...wallet.view(caller(sctx).accountId) }),
    },
    'arcade:wallet:claim': {
      schema: z.object({}).passthrough().optional(),
      fn: (sctx) => {
        const c = caller(sctx);
        if (!settings.enabled) return { ok: false, code: 'disabled' };
        return wallet.claim(c.accountId);
      },
    },
    'arcade:boards': { schema: z.object({ game: gameSchema }), fn: (_sctx, p) => ({ ok: true, boards: boards.list((p as { game: GameId }).game) }) },
    'arcade:board': {
      schema: z.object({ game: gameSchema, board: z.string().min(1).max(32), limit: z.number().int().min(1).max(100).optional() }),
      fn: (_sctx, p) => {
        const input = p as { game: GameId; board: string; limit?: number };
        const rows = boards.rows(input.game, input.board, input.limit);
        if (!rows) return { ok: false, code: 'unknown' };
        return { ok: true, rows: rows.map((row) => ({ a: row.accountId, v: row.value, ...(row.label ? { l: row.label } : {}) })) };
      },
    },
    'arcade:saves': {
      schema: z.object({ game: gameSchema }),
      fn: (sctx, p) => {
        const c = caller(sctx);
        const game = (p as { game: GameId }).game;
        const def = isActionGame(game) ? matchGame(game, matchDefs) : null;
        const slots = saves.list(c.accountId, game).map((row) => ({
          slot: row.slot,
          updatedAt: row.updatedAt,
          members: row.members.length,
          inUse: hub.saveInUse(c.accountId, game, row.slot),
          ...(def?.summarizeSave ? def.summarizeSave(row.data) : {}),
        }));
        return { ok: true, slots };
      },
    },
    'arcade:saves:delete': {
      schema: z.object({ game: gameSchema, slot: slotSchema }),
      fn: (sctx, p) => {
        const input = p as { game: GameId; slot: SaveSlot };
        const result = saves.remove(caller(sctx).accountId, input.game, input.slot);
        return result === 'ok' ? { ok: true } : { ok: false, code: 'in-use' };
      },
    },
    'arcade:saves:import': {
      schema: z.object({ game: gameSchema, slot: slotSchema, version: z.number().int().min(1).max(255), data: z.string().max(Math.ceil((SAVE_MAX_BYTES * 4) / 3) + 4) }),
      fn: (sctx, p) => {
        const input = p as { game: GameId; slot: SaveSlot; version: number; data: string };
        const c = caller(sctx);
        if (hub.saveInUse(c.accountId, input.game, input.slot)) return { ok: false, code: 'in-use' };
        const bytes = fromB64url(input.data);
        if (!bytes || bytes.length > SAVE_MAX_BYTES) return { ok: false, code: 'invalid' };
        // The game decides what an imported file may claim (platform.md §20.2 note 51).
        const def = isActionGame(input.game) ? matchGame(input.game, matchDefs) : null;
        const stored = def?.importSave ? def.importSave(bytes, input.version) : null;
        if (!stored || stored.length > SAVE_MAX_BYTES) return { ok: false, code: 'invalid' };
        saves.put(c.accountId, input.game, input.slot, input.version, stored, [c.accountId]);
        return { ok: true };
      },
    },
    'arcade:probe': { schema: z.object({}).passthrough().optional(), limiter: 'arcadeProbe', fn: () => ({ ok: true, t: clock.now() }) },
    'arcade:away': {
      schema: z.object({ id: idSchema }),
      fn: (sctx, p) => {
        for (const game of tableGames.values()) game.onAway(sctx.socket.id, (p as { id: string }).id);
        return { ok: true };
      },
    },
    'arcade:back': {
      schema: z.object({ id: idSchema, since: z.number().int().min(0) }),
      fn: (sctx, p) => {
        const input = p as { id: string; since: number };
        for (const game of tableGames.values()) game.onBack(sctx.socket.id, input.id, input.since);
        return { ok: true };
      },
    },
    'arcade:prefs': { schema: z.object({}).passthrough().optional(), fn: (sctx) => ({ ok: true, ...prefs.get(caller(sctx).accountId) }) },
    'arcade:prefs:set': {
      schema: z.object({ hidden: z.boolean().optional(), games: z.record(z.string(), z.boolean()).optional() }),
      fn: (sctx, p) => {
        const input = p as { hidden?: boolean; games?: Record<string, boolean> };
        const games: Partial<Record<GameId, boolean>> = {};
        for (const [game, on] of Object.entries(input.games ?? {})) if ((GAME_IDS as readonly string[]).includes(game)) games[game as GameId] = on;
        const row = prefs.set(caller(sctx).accountId, { hidden: input.hidden, games });
        return { ok: true, ...row };
      },
    },
    // Admin › Arcade --------------------------------------------------------------
    'admin:arcade:get': {
      schema: z.object({}).passthrough().optional(),
      admin: true,
      fn: () => ({
        ok: true,
        settings,
        fields: Object.fromEntries(tableDefs.flatMap((def) => (def?.settings ? [[def.game, def.settings.fields]] : []))),
        available: Object.fromEntries(GAME_IDS.map((game) => [game, gameAvailable(game, matchDefs, tableDefs)])),
        stats: { matches: hub.matchCount, lanes: lane.connections, level: watchdog.level, ...watchdog.stats },
      }),
    },
    'admin:arcade:update': {
      schema: z.object({ settings: settingsInputSchema }),
      admin: true,
      fn: (sctx, p) => {
        const before = settings;
        const next = normalizeSettings({ ...before, ...(p as { settings: Record<string, unknown> }).settings }, parsers, before);
        saveSettings(ctx.db, next, sctx.user?.accountId ?? null, clock.now());
        settings = next;
        disableGames(before, next);
        ctx.log.info({ by: sctx.user?.accountId }, 'arcade settings updated');
        return { ok: true, settings };
      },
    },
    'admin:arcade:wallet:reset': {
      schema: z.object({ accountId: idSchema }),
      admin: true,
      fn: (sctx, p) => {
        const accountId = (p as { accountId: string }).accountId;
        if (!ctx.accounts.getById(accountId)) return { ok: false, code: 'not-found' };
        const view = wallet.view(accountId);
        const delta = settings.startChips - view.bal;
        if (delta === 0) return { ok: true, bal: view.bal };
        const result = wallet.transfer('admin', 'reset', sctx.user?.accountId ?? 'system', null, [
          { account: ('w:' + accountId) as `w:${string}`, delta },
          { account: 'house', delta: -delta },
        ]);
        if (!result.ok) return { ok: false, code: result.code };
        return { ok: true, bal: wallet.view(accountId).bal };
      },
    },
    'admin:arcade:ledger': {
      schema: z.object({ accountId: idSchema }),
      admin: true,
      fn: (_sctx, p) => {
        const accountId = (p as { accountId: string }).accountId;
        const rows = ctx.db
          .prepare(
            `SELECT t.id, t.kind, t.ref, t.created_at AS at, l.delta, l.balance_after AS after
               FROM arcade_ledger l JOIN arcade_txns t ON t.id = l.txn_id
              WHERE l.account = ? ORDER BY t.id DESC LIMIT 100`,
          )
          .all('w:' + accountId);
        return { ok: true, rows };
      },
    },
    'admin:arcade:void': {
      schema: z.object({ id: idSchema }),
      admin: true,
      fn: (_sctx, p) => {
        hub.close((p as { id: string }).id, 'admin');
        return { ok: true };
      },
    },
  };

  const stopAll = (): void => {
    scheduler.stop();
    lane.stop();
    hub.stop();
    for (const game of tableGames.values()) {
      try {
        game.stop();
      } catch (error) {
        ctx.log.warn({ err: error }, 'arcade table game failed to stop');
      }
    }
    watchdog.stop();
    maintenance.stop();
    emitter.stop();
    for (const timer of walletPushTimers.values()) clock.clearTimeout(timer);
    walletPushTimers.clear();
    if (egressTimer !== null) clock.clearTimeout(egressTimer);
    flushEgress();
  };

  return {
    register(sctx) {
      registerLegacyHandlers(sctx);
      registerArcadeHandlers(sctx, { app: ctx, emitter, tableEvents: () => tableEvents, platform, refuse });
    },
    onAuthenticated(sctx) {
      const user = sctx.user;
      if (!user) return;
      const row = prefs.get(user.accountId);
      sctx.socket.emit('arcade:prefs', row);
      if (row.hidden) return;
      const all = hub.activityAll(sctx);
      if (all.chs.length > 0) sctx.socket.emit('arcade:activity:all', all);
      for (const view of hub.lobbiesOf(user.accountId)) sctx.socket.emit('arcade:lobby', view);
      const has = ctx.db.prepare('SELECT 1 FROM arcade_wallets WHERE account_id = ?').get(user.accountId);
      if (has) sctx.socket.emit('arcade:wallet', wallet.view(user.accountId));
    },
    onVoiceLeft(accountId, channelId) {
      hub.onVoiceLeft(accountId, channelId);
      for (const game of tableGames.values()) {
        try {
          game.onVoiceLeft(accountId, channelId);
        } catch (error) {
          ctx.log.warn({ err: error }, 'arcade table voice-left hook failed');
        }
      }
    },
    onSocketGone(sctx) {
      const socketId = sctx.socket.id;
      emitter.forget(socketId);
      for (const room of socketRooms.get(socketId) ?? []) {
        rooms.get(room)?.delete(socketId);
        if (rooms.get(room)?.size === 0) rooms.delete(room);
      }
      socketRooms.delete(socketId);
      const accountId = sctx.user?.accountId;
      if (!accountId) return;
      for (const game of tableGames.values()) {
        try {
          game.onSocketGone(accountId, socketId);
        } catch (error) {
          ctx.log.warn({ err: error }, 'arcade table socket-gone hook failed');
        }
      }
      const others = ctx.presence.getSocketsByAccount(accountId).filter((id) => id !== socketId);
      hub.onSocketGone(accountId, others.length > 0);
    },
    publicConfig,
    async onRestarting() {
      hub.restartAll();
      for (const game of tableGames.values()) {
        try {
          game.onRestarting();
        } catch (error) {
          ctx.log.warn({ err: error }, 'arcade table restart hook failed');
        }
      }
      try {
        const refunded = wallet.refund('', 'restart-refund');
        if (refunded > 0) ctx.log.info({ refunded }, 'arcade escrow refunded for the restart');
      } catch (error) {
        ctx.log.error({ err: error }, 'arcade restart refund failed');
      }
    },
    async stop() {
      stopAll();
    },
  };
};

