/**
 * The hub: lobbies per voice channel, the action matches they start, per-channel and server-wide
 * limits, the poker bot cap, invites and the passive activity summaries (platform.md §9.2–9.3).
 *
 * Joining is opt-in. People in a voice channel see a lobby only as a passive chip fed by
 * `arcade:activity` (at most one update per 2 s per channel, ≤ 150 B); only lobby members get
 * `arcade:lobby` (coalesced, ≤ 2 Hz). Channel viewers outside the call get activity only. An account
 * that hid the Arcade (or that game) gets nothing.
 */
import { randomBytes } from 'node:crypto';
import type { Server } from 'socket.io';
import type { AppContext } from '../context.js';
import type { SocketContext } from '../socket/context.js';
import type { Clock } from './clock.js';
import { isActionGame, matchGame, tableGame } from './games.js';
import type { GameId } from './core/version.js';
import { createServerMatch, type LaneConn, type ServerMatch } from './match.js';
import type { ArcadePrefs } from './prefs.js';
import type { MatchGameDef, PersistApi, SeatInit } from './rooms/types.js';
import type { Saves, SaveSlot } from './saves.js';
import type { Scheduler } from './scheduler.js';
import type { ArcadeLimits, ArcadeSettings } from './settings.js';
import type { ActivityEntry, CallerCtx, HubApi, LobbyRecord, TableGame, TableGameDef } from './tables/types.js';
import type { Tickets } from './tickets.js';
import type { Watchdog } from './watchdog.js';

export const LOBBY_PUBLISH_MS = 500;
export const ACTIVITY_MS = 2000;
export const LOBBY_SEAT_HOLD_MS = 30_000;
export const INVITE_PAIR_MS = 60_000;
export const POT_WIN_BADGE_MS = 60_000;

export type Refusal = { ok: false; code: string };

interface LobbySeat {
  accountId: string | null;
  bot: boolean;
  /** 0 present, 1 disconnected (held for 30 s). */
  state: number;
  heldUntil: number | null;
}

interface Lobby {
  id: string;
  game: GameId;
  channelId: string;
  mode: string;
  cfg: unknown;
  host: string;
  seats: LobbySeat[];
  watchers: Set<string>;
  /** Accounts that joined as players while the match ran (late joiners, drop-ins, reclaims). */
  joinedLive: Set<string>;
  state: 'open' | 'live' | 'ended';
  createdAt: number;
  joinedAt: Map<string, number>;
  bots: { count: number; level: number };
  version: number;
  match: ServerMatch | null;
  publishTimer: unknown;
  lastPublished: number;
  idleTimer: unknown;
  /** Bellwick: the save slot this session plays from. */
  save: { ownerId: string; slot: SaveSlot } | null;
}

export interface HubDeps {
  ctx: AppContext;
  io: Server;
  clock: Clock;
  tickets: Tickets;
  scheduler: Scheduler;
  watchdog: Watchdog;
  prefs: ArcadePrefs;
  saves: Saves;
  settings(): ArcadeSettings;
  persistApi(accountOf: (slot: number) => string | null): PersistApi;
  tx<T>(fn: () => T): T;
  tableGames(): ReadonlyMap<GameId, TableGame>;
  /** Does the account's main socket have chat queued in engine.io? */
  mainBusy?(accountId: string): boolean;
  /** Defs passed in tests; the registry otherwise. */
  matchDef?(game: GameId): MatchGameDef | null;
  tableDef?(game: GameId): TableGameDef | null;
}

export interface Hub extends HubApi {
  create(c: CallerCtx, input: { ch: string; game: GameId; mode: string; cfg: unknown }): { ok: true; lobby: LobbyView; ticket?: string } | Refusal;
  join(c: CallerCtx, input: { id: string; as: 'player' | 'spectator' }): { ok: true; lobby: LobbyView; ticket?: string } | Refusal;
  leave(c: CallerCtx, id: string): { ok: true } | Refusal;
  start(c: CallerCtx, id: string): { ok: true } | Refusal;
  setBots(c: CallerCtx, id: string, count: number, level: number): { ok: true } | Refusal;
  setConfig(c: CallerCtx, id: string, cfg: unknown): { ok: true } | Refusal;
  ticket(c: CallerCtx, id: string): { ok: true; ticket: string; exp: number } | Refusal;
  invite(c: CallerCtx, id: string, to: string): { ok: true } | Refusal;
  /** HELLO with a ticket or a resume token. */
  bindLane(conn: LaneConn, claim: { ticket?: string; resume?: string }): { match: ServerMatch; accountId: string; role: 'p' | 's'; via: 'ticket' | 'resume' } | number;
  activityAll(sctx: SocketContext): { chs: { ch: string; a: ActivityEntry[] }[] };
  /** The lobbies an account is a member of (sent again on every sign-in, so a reload finds its game). */
  lobbiesOf(accountId: string): LobbyView[];
  onVoiceLeft(accountId: string, channelId: string): void;
  onSocketGone(accountId: string, stillConnected: boolean): void;
  /** Pot-win badge for Glimmerhall (`j: {amt}` for 60 s). */
  potWin(channelId: string, amount: number): void;
  saveInUse(ownerId: string, game: GameId, slot: SaveSlot): boolean;
  restartAll(): void;
  /** Admin turned a game (or the Arcade) off: end its matches and lobbies. */
  disableGame(game: GameId | null): void;
  readonly matchCount: number;
  stop(): void;
}

export interface LobbyView {
  id: string;
  game: GameId;
  ch: string;
  mode: string;
  st: 'open' | 'live' | 'ended';
  host: string;
  seats: { a: string | null; bot: boolean; st: number }[];
  spec: number;
  cfg: unknown;
  v: number;
}

const newId = (): string => randomBytes(9).toString('base64url');

const seatCountFor = (lobbyGame: GameId, cfg: unknown, min: number, max: number): number => {
  const o = cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>) : {};
  const wanted = Number(o.players ?? o.fighters ?? (isActionGame(lobbyGame) ? max : max));
  return Math.max(min, Math.min(max, Number.isFinite(wanted) ? Math.round(wanted) : max));
};

export const createHub = (d: HubDeps): Hub => {
  const { ctx, clock } = d;
  const lobbies = new Map<string, Lobby>();
  const activityTimers = new Map<string, unknown>();
  const activityLast = new Map<string, number>();
  const potBadges = new Map<string, { amt: number; until: number }>();
  const invitePairs = new Map<string, number>();
  const savesInUse = new Set<string>();
  let botsInUse = 0;
  const matches = new Map<string, ServerMatch>();

  const limits = (): ArcadeLimits => d.settings().limits;
  const defOf = (game: GameId): MatchGameDef | null => (d.matchDef ? d.matchDef(game) : matchGame(game));
  const tableDefOf = (game: GameId): TableGameDef | null => (d.tableDef ? d.tableDef(game) : tableGame(game));

  const isVoiceMember = (accountId: string, channelId: string): boolean => {
    const room = ctx.presence.voiceRoom(channelId);
    if (!room) return false;
    for (const participant of room.participants.values()) if (participant.accountId === accountId) return true;
    return false;
  };

  const canView = (accountId: string, channelId: string): boolean => {
    const channel = ctx.channels.get(channelId);
    if (!channel) return false;
    for (const socketId of ctx.presence.getSocketsByAccount(accountId)) {
      const user = ctx.presence.getUser(socketId);
      if (user && ctx.channels.canAccess(channel, user, 'view')) return true;
    }
    return false;
  };

  const enabled = (game: GameId): boolean => {
    const s = d.settings();
    if (!s.enabled || !s.games[game]) return false;
    return isActionGame(game) ? defOf(game) !== null : tableDefOf(game) !== null;
  };

  const emitToAccount = (accountId: string, event: string, payload: unknown): void => {
    for (const socketId of ctx.presence.getSocketsByAccount(accountId)) d.io.sockets.sockets.get(socketId)?.emit(event, payload);
  };

  // ------------------------------------------------------------ views and publishing

  const viewOf = (lobby: Lobby): LobbyView => {
    const seats = lobby.match
      ? lobby.match.seats().map((s) => ({ a: s.accountId, bot: s.bot, st: s.state }))
      : lobby.seats.map((s) => ({ a: s.accountId, bot: s.bot, st: s.state }));
    return {
      id: lobby.id,
      game: lobby.game,
      ch: lobby.channelId,
      mode: lobby.mode,
      st: lobby.state,
      host: lobby.host,
      seats,
      spec: lobby.match ? lobby.match.watchers() : lobby.watchers.size,
      cfg: lobby.cfg,
      v: lobby.version,
    };
  };

  const recordOf = (lobby: Lobby): LobbyRecord => {
    const view = viewOf(lobby);
    return {
      id: lobby.id,
      game: lobby.game,
      channelId: lobby.channelId,
      mode: lobby.mode,
      cfg: lobby.cfg,
      host: lobby.host,
      seats: view.seats.map((s) => ({ accountId: s.a, bot: s.bot, state: s.st })),
      watchers: [...lobby.watchers],
      state: lobby.state,
    };
  };

  const members = (lobby: Lobby): Set<string> => {
    const out = new Set<string>([lobby.host, ...lobby.watchers]);
    for (const seat of lobby.seats) if (seat.accountId) out.add(seat.accountId);
    for (const seat of lobby.match?.seats() ?? []) if (seat.accountId) out.add(seat.accountId);
    return out;
  };

  const sendLobby = (lobby: Lobby): void => {
    lobby.publishTimer = null;
    lobby.lastPublished = clock.now();
    const view = viewOf(lobby);
    for (const accountId of members(lobby)) {
      if (d.prefs.hidden(accountId, lobby.game)) continue;
      emitToAccount(accountId, 'arcade:lobby', view);
    }
  };

  const publish = (lobbyId: string): void => {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;
    lobby.version += 1;
    if (lobby.publishTimer !== null) return;
    const wait = Math.max(0, lobby.lastPublished + LOBBY_PUBLISH_MS - clock.now());
    lobby.publishTimer = clock.setTimeout(() => sendLobby(lobby), wait);
  };

  const activityOf = (channelId: string): ActivityEntry[] => {
    const out: ActivityEntry[] = [];
    for (const lobby of lobbies.values()) {
      if (lobby.channelId !== channelId || lobby.state === 'ended') continue;
      // Table games report their own running tables and halls; their lobbies show while forming.
      if (!isActionGame(lobby.game) && lobby.state === 'live') continue;
      const view = viewOf(lobby);
      out.push({
        g: lobby.game,
        id: lobby.id,
        st: lobby.state === 'live' ? 'live' : 'lobby',
        n: view.seats.filter((s) => s.a !== null).length,
        max: view.seats.length,
        w: view.spec,
      });
    }
    for (const game of d.tableGames().values()) {
      try {
        out.push(...game.activity(channelId));
      } catch (error) {
        ctx.log.warn({ err: error }, 'arcade table activity failed');
      }
    }
    const badge = potBadges.get(channelId);
    if (badge && badge.until > clock.now()) {
      const hall = out.find((entry) => entry.g === 'glimmer');
      if (hall) hall.j = { amt: badge.amt };
    } else if (badge) potBadges.delete(channelId);
    for (const entry of out) if (entry.x && entry.x.length > 24) entry.x = entry.x.slice(0, 24);
    return out;
  };

  const sendActivity = (channelId: string): void => {
    activityTimers.delete(channelId);
    activityLast.set(channelId, clock.now());
    const channel = ctx.channels.get(channelId);
    if (!channel) return;
    const all = activityOf(channelId);
    for (const socket of d.io.sockets.sockets.values()) {
      const sctx = socket.data.ctx as SocketContext | undefined;
      const user = sctx?.user;
      if (!user || !ctx.channels.canAccess(channel, user, 'view')) continue;
      const visible = all.filter((entry) => !d.prefs.hidden(user.accountId, entry.g));
      socket.emit('arcade:activity', { ch: channelId, a: visible });
    }
  };

  const activityChanged = (channelId: string): void => {
    if (activityTimers.has(channelId)) return;
    const wait = Math.max(0, (activityLast.get(channelId) ?? 0) + ACTIVITY_MS - clock.now());
    activityTimers.set(
      channelId,
      clock.setTimeout(() => sendActivity(channelId), wait),
    );
  };

  // ------------------------------------------------------------ lobby lifecycle

  const armIdle = (lobby: Lobby): void => {
    if (lobby.idleTimer !== null) clock.clearTimeout(lobby.idleTimer);
    lobby.idleTimer = null;
    if (lobby.state !== 'open') return;
    lobby.idleTimer = clock.setTimeout(() => close(lobby.id, 'idle'), limits().lobbyIdleMs);
  };

  const close = (lobbyId: string, reason: string): void => {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;
    if (lobby.match && !lobby.match.ended) lobby.match.dispose();
    lobby.state = 'ended';
    if (lobby.publishTimer !== null) clock.clearTimeout(lobby.publishTimer);
    if (lobby.idleTimer !== null) clock.clearTimeout(lobby.idleTimer);
    lobby.publishTimer = lobby.idleTimer = null;
    sendLobby(lobby);
    lobbies.delete(lobbyId);
    if (lobby.save) savesInUse.delete(lobby.save.ownerId + ':' + lobby.game + ':' + lobby.save.slot);
    ctx.log.debug({ lobby: lobbyId, game: lobby.game, reason }, 'arcade lobby closed');
    activityChanged(lobby.channelId);
  };

  const passHost = (lobby: Lobby): void => {
    const def = isActionGame(lobby.game) ? defOf(lobby.game) : null;
    const humans = (lobby.match ? lobby.match.seats().map((s) => ({ accountId: s.accountId, bot: s.bot })) : lobby.seats).filter(
      (s): s is { accountId: string; bot: boolean } => s.accountId !== null && !s.bot,
    );
    if (humans.length === 0) {
      if (lobby.state === 'open') close(lobby.id, 'empty');
      return;
    }
    let next = humans[0] as { accountId: string };
    if (!def || def.host === 'longestPresent') {
      next = [...humans].sort((a, b) => (lobby.joinedAt.get(a.accountId) ?? 0) - (lobby.joinedAt.get(b.accountId) ?? 0))[0] as { accountId: string };
    }
    lobby.host = next.accountId;
  };

  const channelCounts = (channelId: string): { action: number; tables: number } => {
    let action = 0;
    let tables = 0;
    for (const lobby of lobbies.values()) {
      if (lobby.channelId !== channelId || lobby.state === 'ended') continue;
      if (isActionGame(lobby.game)) action += 1;
      else if (lobby.game === 'lamplight') tables += 1;
    }
    return { action, tables };
  };

  const serverCounts = (): { action: number; bellwick: number; tables: number } => {
    let action = 0;
    let bellwick = 0;
    let tables = 0;
    for (const lobby of lobbies.values()) {
      if (lobby.state === 'ended') continue;
      if (isActionGame(lobby.game)) {
        action += 1;
        if (lobby.game === 'bellwick') bellwick += 1;
      } else if (lobby.game === 'lamplight') tables += 1;
    }
    return { action, bellwick, tables };
  };

  const startMatch = (lobby: Lobby, def: MatchGameDef): { ok: true } | Refusal => {
    if (d.watchdog.refuseMatches) return { ok: false, code: 'busy' };
    const humans = lobby.seats.filter((s) => s.accountId && !s.bot);
    if (humans.length === 0) return { ok: false, code: 'empty' };
    const seats: SeatInit[] = lobby.seats.map((s, slot) => ({
      slot,
      accountId: s.bot ? null : s.accountId,
      bot: s.bot || (s.accountId === null && def.botFill),
      botLevel: lobby.bots.level,
    }));
    const id = newId();
    let saveData: Uint8Array | null = null;
    if (lobby.save) saveData = d.saves.get(lobby.save.ownerId, lobby.game, lobby.save.slot)?.data ?? null;
    let runtime;
    try {
      runtime = def.create({
        id,
        channelId: lobby.channelId,
        mode: lobby.mode,
        cfg: lobby.cfg,
        seed: randomBytes(4).readUInt32LE(0),
        seats,
        save: lobby.save ? { ownerId: lobby.save.ownerId, slot: lobby.save.slot, data: saveData } : null,
        log: ctx.log.child({ arcade: lobby.game, match: id }),
      });
    } catch (error) {
      ctx.log.error({ err: error, game: lobby.game }, 'arcade match create failed');
      return { ok: false, code: 'error' };
    }
    const match = createServerMatch({
      id,
      channelId: lobby.channelId,
      def,
      runtime,
      seats,
      clock,
      log: ctx.log,
      tickets: d.tickets,
      persistApi: d.persistApi,
      tx: d.tx,
      onEgress: (bytes) => {
        d.watchdog.egress(bytes);
        egressBytes += bytes;
      },
      floor: (spectator) => (d.watchdog.level >= 2 ? (spectator ? 6 : 3) : d.watchdog.level >= 1 && spectator ? 6 : spectator ? 3 : 2),
      spectatorsAllowed: () => d.watchdog.level < 3,
      spectatorCap: () => limits().spectatorsAction,
      onEnded: (reason) => {
        matches.delete(id);
        d.watchdog.forget(id);
        d.watchdog.setActive(matches.size > 0);
        if (lobby.match === match) lobby.match = null;
        if (lobbies.has(lobby.id)) {
          lobby.state = 'open';
          // Humans who left during the match leave the lobby too.
          lobby.seats = lobby.seats.map((s) => (s.accountId && !isVoiceMember(s.accountId, lobby.channelId) ? { accountId: null, bot: false, state: 0, heldUntil: null } : s));
          if (reason === 'restart' || reason === 'overload' || reason === 'error' || reason === 'admin') close(lobby.id, reason);
          else {
            passHost(lobby);
            armIdle(lobby);
            publish(lobby.id);
            activityChanged(lobby.channelId);
          }
        }
      },
      onChanged: () => {
        publish(lobby.id);
        activityChanged(lobby.channelId);
      },
      tickPhaseUs: () => d.scheduler.tickPhaseUs(),
      mainBusy: d.mainBusy,
    });
    matches.set(id, match);
    lobby.match = match;
    lobby.state = 'live';
    if (lobby.idleTimer !== null) clock.clearTimeout(lobby.idleTimer);
    lobby.idleTimer = null;
    d.watchdog.setActive(true);
    d.scheduler.add(match);
    publish(lobby.id);
    activityChanged(lobby.channelId);
    return { ok: true };
  };

  let egressBytes = 0;

  const issueTicket = (lobby: Lobby, accountId: string, role: 'p' | 's'): string | undefined => {
    if (!lobby.match || lobby.match.ended) return undefined;
    return d.tickets.issue({ accountId, matchId: lobby.match.id, role }).ticket;
  };

  // ------------------------------------------------------------ the hub

  const hub: Hub = {
    get: (lobbyId) => {
      const lobby = lobbies.get(lobbyId);
      return lobby ? recordOf(lobby) : null;
    },
    publish,
    activityChanged,
    close,
    update(lobbyId, patch) {
      const lobby = lobbies.get(lobbyId);
      if (!lobby || lobby.state === 'ended') return;
      if (patch.seats) lobby.seats = patch.seats.map((s) => ({ accountId: s.accountId, bot: s.bot, state: s.state, heldUntil: null }));
      if (patch.watchers) lobby.watchers = new Set(patch.watchers);
      if (patch.state && patch.state !== lobby.state) {
        lobby.state = patch.state;
        if (patch.state === 'live' && lobby.idleTimer !== null) {
          clock.clearTimeout(lobby.idleTimer);
          lobby.idleTimer = null;
        }
        if (patch.state === 'open') armIdle(lobby);
      }
      publish(lobbyId);
      activityChanged(lobby.channelId);
    },
    bots: {
      take(n) {
        if (botsInUse + n > limits().pokerBots) return false;
        botsInUse += n;
        return true;
      },
      give(n) {
        botsInUse = Math.max(0, botsInUse - n);
      },
    },
    limits,

    create(c, input) {
      const { ch, game, mode } = input;
      if (!enabled(game)) return { ok: false, code: 'disabled' };
      if (d.prefs.hidden(c.accountId, game)) return { ok: false, code: 'hidden' };
      if (!isVoiceMember(c.accountId, ch)) return { ok: false, code: 'not-in-voice' };
      for (const lobby of lobbies.values()) {
        if (lobby.state === 'ended') continue;
        if (lobby.seats.some((s) => s.accountId === c.accountId) || lobby.match?.seats().some((s) => s.accountId === c.accountId)) {
          if (lobby.game === game) return { ok: false, code: 'already' };
        }
      }
      const counts = channelCounts(ch);
      const server = serverCounts();
      const l = limits();
      let cfg: unknown = input.cfg ?? {};
      let seatTotal = 1;
      if (isActionGame(game)) {
        const def = defOf(game);
        if (!def) return { ok: false, code: 'disabled' };
        if (counts.action >= l.actionPerChannel) return { ok: false, code: 'channel-limit' };
        if (server.action >= l.actionMatches || (game === 'bellwick' && server.bellwick >= Math.min(l.bellwickSessions, def.serverLimit ?? Infinity))) {
          return { ok: false, code: 'server-limit' };
        }
        if (d.watchdog.refuseMatches) return { ok: false, code: 'busy' };
        const parsed = def.cfgSchema.safeParse(cfg);
        if (!parsed.success) return { ok: false, code: 'invalid' };
        cfg = parsed.data;
        seatTotal = seatCountFor(game, cfg, def.seats.min, def.seats.max);
      } else {
        const def = tableDefOf(game);
        const running = d.tableGames().get(game);
        if (!def || !running?.lobby) return { ok: false, code: 'no-lobby' };
        if (game === 'lamplight' && (counts.tables >= l.tablesPerChannel || server.tables >= l.tables)) return { ok: false, code: 'channel-limit' };
        if (def.cfgSchema) {
          const parsed = def.cfgSchema.safeParse(cfg);
          if (!parsed.success) return { ok: false, code: 'invalid' };
          cfg = parsed.data;
        }
        const refusal = running.lobby.onCreate(c, cfg);
        if (!refusal.ok) return refusal;
        seatTotal = seatCountFor(game, cfg, 2, 9);
      }
      const now = clock.now();
      const o = cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>) : {};
      let save: Lobby['save'] = null;
      if (game === 'bellwick' && o.tale === 'slot' && (o.slot === 0 || o.slot === 1 || o.slot === 2)) {
        const key = c.accountId + ':bellwick:' + o.slot;
        if (savesInUse.has(key)) return { ok: false, code: 'in-use' };
        save = { ownerId: c.accountId, slot: o.slot };
        savesInUse.add(key);
      } else if (game === 'bellwick' && (o.slot === 0 || o.slot === 1 || o.slot === 2)) {
        save = { ownerId: c.accountId, slot: o.slot };
        savesInUse.add(c.accountId + ':bellwick:' + o.slot);
      }
      const lobby: Lobby = {
        id: newId(),
        game,
        channelId: ch,
        mode,
        cfg,
        host: c.accountId,
        seats: Array.from({ length: seatTotal }, (_, i) => ({ accountId: i === 0 ? c.accountId : null, bot: false, state: 0, heldUntil: null })),
        watchers: new Set(),
        joinedLive: new Set(),
        state: 'open',
        createdAt: now,
        joinedAt: new Map([[c.accountId, now]]),
        bots: { count: 0, level: Number(o.botLevel ?? o.bots ?? 1) || 1 },
        version: 1,
        match: null,
        publishTimer: null,
        lastPublished: 0,
        idleTimer: null,
        save,
      };
      lobbies.set(lobby.id, lobby);
      armIdle(lobby);
      if (!isActionGame(game)) {
        try {
          d.tableGames().get(game)?.lobby?.onCreated?.(c, recordOf(lobby));
        } catch (error) {
          ctx.log.error({ err: error, game }, 'arcade table onCreated failed');
        }
      }
      if (!lobbies.has(lobby.id)) return { ok: false, code: 'error' };
      sendLobby(lobby);
      activityChanged(ch);
      return { ok: true, lobby: viewOf(lobby) };
    },

    join(c, input) {
      const lobby = lobbies.get(input.id);
      if (!lobby || lobby.state === 'ended') return { ok: false, code: 'gone' };
      if (d.prefs.hidden(c.accountId, lobby.game)) return { ok: false, code: 'hidden' };
      const now = clock.now();
      if (input.as === 'spectator') {
        const def = isActionGame(lobby.game) ? defOf(lobby.game) : null;
        if (def && def.spectators === 0) return { ok: false, code: 'no-spectators' };
        if (!isVoiceMember(c.accountId, lobby.channelId) && !canView(c.accountId, lobby.channelId)) return { ok: false, code: 'forbidden' };
        const cap = isActionGame(lobby.game) ? limits().spectatorsAction : limits().spectatorsTable;
        if (lobby.watchers.size >= cap || d.watchdog.level >= 3) return { ok: false, code: 'full' };
        if (!isActionGame(lobby.game)) {
          const refusal = d.tableGames().get(lobby.game)?.lobby?.onJoin(c, recordOf(lobby), 'spectator');
          if (refusal && !refusal.ok) return refusal;
        }
        lobby.watchers.add(c.accountId);
        publish(lobby.id);
        activityChanged(lobby.channelId);
        return { ok: true, lobby: viewOf(lobby), ticket: issueTicket(lobby, c.accountId, 's') };
      }
      if (!isVoiceMember(c.accountId, lobby.channelId)) return { ok: false, code: 'not-in-voice' };
      lobby.joinedAt.set(c.accountId, lobby.joinedAt.get(c.accountId) ?? now);
      if (lobby.match && !lobby.match.ended) {
        const admitted = lobby.match.admit(c.accountId);
        if (admitted === 'full') return { ok: false, code: 'full' };
        lobby.watchers.delete(c.accountId);
        lobby.joinedLive.add(c.accountId);
        publish(lobby.id);
        return { ok: true, lobby: viewOf(lobby), ticket: issueTicket(lobby, c.accountId, 'p') };
      }
      const existing = lobby.seats.find((s) => s.accountId === c.accountId);
      if (existing) {
        existing.state = 0;
        existing.heldUntil = null;
        return { ok: true, lobby: viewOf(lobby) };
      }
      const free = lobby.seats.find((s) => s.accountId === null && !s.bot);
      if (!free) return { ok: false, code: 'full' };
      if (!isActionGame(lobby.game)) {
        const refusal = d.tableGames().get(lobby.game)?.lobby?.onJoin(c, recordOf(lobby), 'player');
        if (refusal && !refusal.ok) return refusal;
      }
      free.accountId = c.accountId;
      free.state = 0;
      lobby.watchers.delete(c.accountId);
      armIdle(lobby);
      publish(lobby.id);
      activityChanged(lobby.channelId);
      return { ok: true, lobby: viewOf(lobby) };
    },

    leave(c, id) {
      const lobby = lobbies.get(id);
      if (!lobby) return { ok: true };
      lobby.watchers.delete(c.accountId);
      lobby.joinedLive.delete(c.accountId);
      lobby.match?.release(c.accountId);
      const seat = lobby.seats.find((s) => s.accountId === c.accountId);
      if (seat) {
        seat.accountId = null;
        seat.state = 0;
        if (!isActionGame(lobby.game)) d.tableGames().get(lobby.game)?.lobby?.onLeave(c, recordOf(lobby));
      }
      lobby.joinedAt.delete(c.accountId);
      if (lobby.host === c.accountId) passHost(lobby);
      if (lobbies.has(id)) {
        publish(id);
        activityChanged(lobby.channelId);
      }
      return { ok: true };
    },

    start(c, id) {
      const lobby = lobbies.get(id);
      if (!lobby || lobby.state === 'ended') return { ok: false, code: 'gone' };
      if (lobby.host !== c.accountId) return { ok: false, code: 'not-host' };
      if (lobby.state === 'live') return { ok: false, code: 'running' };
      // Seats held for a disconnected member are released at the start.
      for (const seat of lobby.seats) if (seat.state === 1) seat.accountId = null;
      if (isActionGame(lobby.game)) {
        const def = defOf(lobby.game);
        if (!def) return { ok: false, code: 'disabled' };
        for (let i = 0; i < lobby.seats.length && i < lobby.bots.count + lobby.seats.filter((s) => s.accountId).length; i += 1) {
          const seat = lobby.seats[i] as LobbySeat;
          if (!seat.accountId) seat.bot = true;
        }
        return startMatch(lobby, def);
      }
      const refusal = d.tableGames().get(lobby.game)?.lobby?.onStart(recordOf(lobby));
      if (!refusal || !refusal.ok) return refusal ?? { ok: false, code: 'no-lobby' };
      lobby.state = 'live';
      if (lobby.idleTimer !== null) clock.clearTimeout(lobby.idleTimer);
      lobby.idleTimer = null;
      publish(id);
      activityChanged(lobby.channelId);
      return { ok: true };
    },

    setBots(c, id, count, level) {
      const lobby = lobbies.get(id);
      if (!lobby || lobby.state !== 'open') return { ok: false, code: 'gone' };
      if (lobby.host !== c.accountId) return { ok: false, code: 'not-host' };
      lobby.bots = { count: Math.max(0, Math.min(lobby.seats.length, Math.round(count))), level: Math.max(0, Math.min(9, Math.round(level))) };
      publish(id);
      return { ok: true };
    },

    setConfig(c, id, cfg) {
      const lobby = lobbies.get(id);
      if (!lobby || lobby.state !== 'open') return { ok: false, code: 'gone' };
      if (lobby.host !== c.accountId) return { ok: false, code: 'not-host' };
      const schema = isActionGame(lobby.game) ? defOf(lobby.game)?.cfgSchema : tableDefOf(lobby.game)?.cfgSchema;
      if (schema) {
        const parsed = schema.safeParse(cfg);
        if (!parsed.success) return { ok: false, code: 'invalid' };
        lobby.cfg = parsed.data;
      } else lobby.cfg = cfg;
      publish(id);
      return { ok: true };
    },

    ticket(c, id) {
      const lobby = lobbies.get(id);
      if (!lobby || !lobby.match || lobby.match.ended) return { ok: false, code: 'gone' };
      // Seat owners (also after the grace, to reclaim), accounts that joined while it runs, and registered watchers.
      const seated = lobby.match.seats().some((s) => s.accountId === c.accountId) || lobby.joinedLive.has(c.accountId);
      const role: 'p' | 's' | null = seated ? 'p' : lobby.watchers.has(c.accountId) ? 's' : null;
      if (role === null) return { ok: false, code: 'forbidden' };
      const { ticket, exp } = d.tickets.issue({ accountId: c.accountId, matchId: lobby.match.id, role });
      return { ok: true, ticket, exp };
    },

    lobbiesOf(accountId) {
      const out: LobbyView[] = [];
      for (const lobby of lobbies.values()) {
        if (lobby.state !== 'ended' && members(lobby).has(accountId) && !d.prefs.hidden(accountId, lobby.game)) out.push(viewOf(lobby));
      }
      return out;
    },

    invite(c, id, to) {
      const lobby = lobbies.get(id);
      if (!lobby || lobby.state === 'ended') return { ok: false, code: 'gone' };
      if (!members(lobby).has(c.accountId)) return { ok: false, code: 'forbidden' };
      if (to === c.accountId || !isVoiceMember(to, lobby.channelId)) return { ok: false, code: 'not-in-voice' };
      const key = c.accountId + '>' + to;
      const now = clock.now();
      const last = invitePairs.get(key);
      if (last !== undefined && now - last < INVITE_PAIR_MS) return { ok: false, code: 'busy' };
      for (const [pair, at] of invitePairs) if (now - at >= INVITE_PAIR_MS) invitePairs.delete(pair);
      invitePairs.set(key, now);
      // Quietly not delivered to someone who hid the game (no Do Not Disturb status exists yet).
      if (!d.prefs.hidden(to, lobby.game)) emitToAccount(to, 'arcade:invited', { id, from: c.accountId, game: lobby.game, ch: lobby.channelId });
      return { ok: true };
    },

    bindLane(conn, claim) {
      void conn;
      if (claim.ticket) {
        const t = d.tickets.redeem(claim.ticket);
        if (!t) return 4401;
        const match = matches.get(t.matchId);
        if (!match || match.ended) return 4404;
        return { match, accountId: t.accountId, role: t.role, via: 'ticket' };
      }
      if (claim.resume) {
        const r = d.tickets.resume(claim.resume);
        if (!r) return 4401;
        const match = matches.get(r.matchId);
        if (!match || match.ended) return 4404;
        return { match, accountId: r.accountId, role: r.slot === 0xff ? 's' : 'p', via: 'resume' };
      }
      return 4401;
    },

    activityAll(sctx) {
      const user = sctx.user;
      if (!user) return { chs: [] };
      // Lobbies, and whatever the table games run (tables and halls live in voice channels).
      const channels = new Set<string>();
      for (const lobby of lobbies.values()) channels.add(lobby.channelId);
      if (d.tableGames().size > 0) for (const channel of ctx.channels.list()) if (channel.type === 'voice') channels.add(channel.id);
      const out: { ch: string; a: ActivityEntry[] }[] = [];
      for (const ch of channels) {
        const channel = ctx.channels.get(ch);
        if (!channel || !ctx.channels.canAccess(channel, user, 'view')) continue;
        const a = activityOf(ch).filter((entry) => !d.prefs.hidden(user.accountId, entry.g));
        if (a.length > 0) out.push({ ch, a });
      }
      return { chs: out };
    },

    onVoiceLeft(accountId, channelId) {
      if (isVoiceMember(accountId, channelId)) return;
      for (const lobby of Array.from(lobbies.values())) {
        if (lobby.channelId !== channelId || lobby.state !== 'open') continue;
        const seat = lobby.seats.find((s) => s.accountId === accountId);
        if (!seat) continue;
        seat.accountId = null;
        if (lobby.host === accountId) passHost(lobby);
        if (lobbies.has(lobby.id)) {
          publish(lobby.id);
          activityChanged(lobby.channelId);
        }
      }
    },

    onSocketGone(accountId, stillConnected) {
      if (stillConnected) return;
      const now = clock.now();
      for (const lobby of lobbies.values()) {
        if (lobby.state !== 'open') continue;
        const seat = lobby.seats.find((s) => s.accountId === accountId);
        if (!seat) continue;
        seat.state = 1;
        seat.heldUntil = now + LOBBY_SEAT_HOLD_MS;
        publish(lobby.id);
        clock.setTimeout(() => {
          if (seat.state === 1 && seat.heldUntil !== null && clock.now() >= seat.heldUntil && lobby.state === 'open') {
            seat.accountId = null;
            seat.state = 0;
            seat.heldUntil = null;
            if (lobby.host === accountId) passHost(lobby);
            if (lobbies.has(lobby.id)) {
              publish(lobby.id);
              activityChanged(lobby.channelId);
            }
          }
        }, LOBBY_SEAT_HOLD_MS + 5);
      }
    },

    potWin(channelId, amount) {
      potBadges.set(channelId, { amt: amount, until: clock.now() + POT_WIN_BADGE_MS });
      activityChanged(channelId);
    },

    saveInUse: (ownerId, game, slot) => savesInUse.has(ownerId + ':' + game + ':' + slot),

    restartAll() {
      for (const match of Array.from(matches.values())) match.abort('restart');
    },

    disableGame(game) {
      for (const lobby of Array.from(lobbies.values())) {
        if (game !== null && lobby.game !== game) continue;
        if (lobby.match && !lobby.match.ended) lobby.match.abort('admin');
        close(lobby.id, 'disabled');
      }
    },

    get matchCount() {
      return matches.size;
    },

    stop() {
      for (const match of Array.from(matches.values())) match.dispose();
      for (const lobby of lobbies.values()) {
        if (lobby.publishTimer !== null) clock.clearTimeout(lobby.publishTimer);
        if (lobby.idleTimer !== null) clock.clearTimeout(lobby.idleTimer);
      }
      for (const timer of activityTimers.values()) clock.clearTimeout(timer);
      activityTimers.clear();
      lobbies.clear();
    },
  };
  return hub;
};
