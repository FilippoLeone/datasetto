/**
 * The server side of one action match (plan.md §2.6.3, "What the platform does around
 * MatchRuntime"): seats and their lane connections, the seat grace and away limit, takeover
 * (4409), the late-join queue and reclaim with a WELCOME re-sent on a role change, UP and EVT
 * deduplication, one paced stream per recipient (sender.ts), host events, the idle reapers, and the
 * end, restart and overload flows.
 *
 * The scheduler calls `step()` and `send()` once per tick while the match needs it. Deadlines (grace,
 * away limit, idle) run on one timer per match, so they fire even while nothing ticks.
 */
import { performance } from 'node:perf_hooks';
import { deflateRawSync } from 'node:zlib';
import type { Logger } from '../logger.js';
import type { Clock } from './clock.js';
import { b64url, seqNewer } from './core/bytes.js';
import { SEAT_STATE, type SeatStateCode } from './core/net/events.js';
import { CLOSE, KEY_REASON, PHASE, PHASE_REASON, SPECTATOR, TICK_HZ, VIS, writeHandover, writePhase, writePong, type ClientMsg, type Divisor } from './core/net/lane.js';
import type { HostEvent, RecipientView } from './core/net/match.js';
import { CODEC, PROTO, SIM } from './core/version.js';
import type { MatchGameDef, MatchRuntime, PersistApi, SeatInit } from './rooms/types.js';
import { createRecipient, type Recipient } from './sender.js';
import type { Tickets } from './tickets.js';

/** One open `/arcade/ws` connection, as the match sees it. */
export interface LaneConn {
  readonly id: number;
  readonly bufferedAmount: number;
  send(bytes: Uint8Array): void;
  /** BYE with the code and reason, then close with the same code. */
  close(code: number, reason: string): void;
}

export interface MatchDeps {
  id: string;
  channelId: string;
  def: MatchGameDef;
  runtime: MatchRuntime;
  seats: readonly SeatInit[];
  clock: Clock;
  log: Logger;
  tickets: Tickets;
  /** The persistence API (wallet, stats, results, saves) with `accountOf` bound to this match. */
  persistApi(accountOf: (slot: number) => string | null): PersistApi;
  /** One db transaction. */
  tx<T>(fn: () => T): T;
  onEgress(wireBytes: number): void;
  /** The degrade ladder's lowest divisor for players or spectators. */
  floor(spectator: boolean): Divisor;
  /** May a new spectator join (degrade level 3 refuses them)? */
  spectatorsAllowed(): boolean;
  spectatorCap(): number;
  /** The match ended for good (hub removes it). */
  onEnded(reason: string): void;
  /** Seats, watchers or the queue changed (hub republishes the lobby, ≤ 2 Hz). */
  onChanged(): void;
  /** Time since the current scheduler tick started, µs (for PONG). */
  tickPhaseUs(): number;
  /** The account's main socket has chat or signalling queued in engine.io (server-side chat first). */
  mainBusy?(accountId: string): boolean;
}

type SeatControl = 'human' | 'bot' | 'none';

interface Seat {
  slot: number;
  /** The human who owns the seat (kept while a bot plays it after the grace, so it can be reclaimed). */
  owner: string | null;
  control: SeatControl;
  conn: LaneConn | null;
  recipient: Recipient | null;
  /** Last state confirmed by the runtime (SeatState). */
  state: 'live' | 'ghost' | 'bot' | 'left';
  ghostSince: number | null;
  graceUsedMs: number;
  awaySince: number | null;
  lastEvSeq: number;
  lastUpSeq: number | null;
  /** The recipient's park reason seen at the last tick (stall detection). */
  seenPark: string | null;
  /** Main-socket backlog: since when it has been busy, and since when calm again while parked for it. */
  busySince: number | null;
  calmSince: number | null;
  serverYield: boolean;
  joinedAt: number;
}

interface Watcher {
  accountId: string;
  conn: LaneConn;
  recipient: Recipient;
  /** A late joiner waiting for a seat at the next round start (not counted against the spectator cap). */
  queued: boolean;
}

export interface MatchSeatView {
  slot: number;
  accountId: string | null;
  bot: boolean;
  /** 0 live, 1 ghost, 2 bot, 3 left. */
  state: number;
}

export interface ServerMatch {
  readonly id: string;
  readonly game: MatchGameDef['game'];
  readonly channelId: string;
  readonly runtime: MatchRuntime;
  readonly ended: boolean;
  /** The runtime needs steps (false when idle). */
  readonly active: boolean;
  /** Something must go out even while idle (BEATs to live or yielding recipients). */
  readonly sending: boolean;
  /** Attach a lane after HELLO. Returns 0 or a close code. */
  attach(conn: LaneConn, claim: { accountId: string; role: 'p' | 's'; via: 'ticket' | 'resume' }): number;
  onMessage(conn: LaneConn, msg: ClientMsg): void;
  onClose(conn: LaneConn, code: number): void;
  /** One sim tick; returns the step time in ms. */
  step(): number;
  /** Process this tick's sends (after `step()`, or alone while idle). */
  send(): void;
  /** Add a late joiner or a drop-in seat for an account (hub: lobby join while live). */
  admit(accountId: string): 'seat' | 'queued' | 'full';
  /** An account left the voice channel or the lobby. */
  release(accountId: string): void;
  seats(): readonly MatchSeatView[];
  watchers(): number;
  humans(): number;
  /** End now: PHASE 4 with `reason`, HANDOVER, close 1012; results are void. */
  abort(reason: 'restart' | 'overload' | 'admin' | 'error'): void;
  /** Persist and end normally (admin turned the game off without a restart flow, or a test). */
  dispose(): void;
}

export const createServerMatch = (d: MatchDeps): ServerMatch => {
  const { def, runtime, clock, log } = d;
  const seats: Seat[] = d.seats.map((init) => ({
    slot: init.slot,
    owner: init.bot ? null : init.accountId,
    control: init.bot ? 'bot' : init.accountId ? 'human' : 'none',
    conn: null,
    recipient: null,
    state: init.bot ? 'bot' : init.accountId ? 'ghost' : 'left',
    ghostSince: init.bot || !init.accountId ? null : clock.now(),
    graceUsedMs: 0,
    awaySince: null,
    lastEvSeq: 0,
    lastUpSeq: null,
    seenPark: null,
    busySince: null,
    calmSince: null,
    serverYield: false,
    joinedAt: clock.now(),
  }));
  const watchers: Watcher[] = [];
  const connIndex = new Map<number, { seat: Seat } | { watcher: Watcher }>();
  let ended = false;
  let phase: { phase: number; reason: number; body: Uint8Array } | null = null;
  let lastInputAt = clock.now();
  let noHumanSince: number | null = clock.now();
  let timer: unknown = null;
  let ticks = 0;

  const view = (slot: number, recipient: Recipient): RecipientView => ({ slot, view: recipient.view });
  const humansConnected = (): number => seats.filter((s) => s.control === 'human' && s.conn !== null).length;
  const accountOf = (slot: number): string | null => seats.find((s) => s.slot === slot)?.owner ?? null;
  const allRecipients = (): Recipient[] => [...seats.flatMap((s) => (s.recipient && s.conn ? [s.recipient] : [])), ...watchers.map((w) => w.recipient)];

  const makeRecipient = (slot: number, spectator: boolean): Recipient =>
    createRecipient({
      slot,
      spectator,
      budget: def.sender.budget,
      defaultDivisor: spectator ? 3 : 2,
      skipUnchanged: def.sender.skipUnchanged,
      now: () => clock.now(),
      onEgress: d.onEgress,
      onCeiling: (info) => log.info({ match: d.id, slot, ...info }, 'arcade lane ceiling exceeded over 10 s'),
    });

  const sinkOf = (conn: LaneConn) => ({
    send: (bytes: Uint8Array) => conn.send(bytes),
    get bufferedAmount() {
      return conn.bufferedAmount;
    },
  });

  const graceUntil = (seat: Seat): number => {
    const now = clock.now();
    const since = seat.ghostSince ?? now;
    let until = since + def.grace.episodeMs;
    if (def.grace.matchMs !== null) until = Math.min(until, since + Math.max(0, def.grace.matchMs - seat.graceUsedMs));
    return until;
  };

  const welcome = (conn: LaneConn, recipient: Recipient, o: { accountId: string; slot: number; queued: boolean; lastEvSeq: number; reason: number }) => {
    const until = o.slot === SPECTATOR ? clock.now() + def.grace.episodeMs : Math.max(clock.now() + def.grace.episodeMs, graceUntil(seats.find((s) => s.slot === o.slot) as Seat));
    const resumeToken = d.tickets.resumeToken({ accountId: o.accountId, matchId: d.id, slot: o.slot }, until);
    recipient.welcome(
      {
        proto: PROTO,
        game: def.wireId,
        codec: CODEC[def.game],
        slot: o.slot,
        queued: o.queued,
        tick: runtime.tick >>> 0,
        tickHz: TICK_HZ,
        divisor: o.slot === SPECTATOR ? 3 : 2,
        lastEvSeq: o.lastEvSeq,
        resumeToken,
        cfg: runtime.welcomeCfg(),
      },
      o.reason,
    );
  };

  // -------------------------------------------------------------- deadlines

  const nextDeadline = (): number => {
    let next = Infinity;
    for (const seat of seats) {
      if (seat.ghostSince !== null && seat.control === 'human') next = Math.min(next, graceUntil(seat));
      if (seat.awaySince !== null && seat.conn) next = Math.min(next, seat.awaySince + def.grace.awayLimitMs);
    }
    if (noHumanSince !== null) next = Math.min(next, noHumanSince + def.idle.noHumanMs);
    next = Math.min(next, lastInputAt + def.idle.noInputMs);
    return next;
  };

  const arm = (): void => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    if (ended) return;
    const at = nextDeadline();
    if (!Number.isFinite(at)) return;
    timer = clock.setTimeout(() => {
      timer = null;
      checkDeadlines();
    }, Math.max(0, at - clock.now()) + 1);
  };

  const graceOver = (seat: Seat): void => {
    const now = clock.now();
    if (seat.ghostSince !== null) seat.graceUsedMs += now - seat.ghostSince;
    seat.ghostSince = null;
    seat.awaySince = null;
    if (def.grace.after === 'bot') {
      runtime.setSeat(seat.slot, 'bot');
      seat.control = 'bot';
    } else {
      runtime.setSeat(seat.slot, 'left');
      seat.control = 'none';
      seat.owner = null;
      d.tickets.revoke(d.id, seat.slot);
    }
    if (seat.conn) {
      const conn = seat.conn;
      detachSeat(seat);
      conn.close(CLOSE.away, 'Away too long');
    }
    d.onChanged();
  };

  const checkDeadlines = (): void => {
    if (ended) return;
    const now = clock.now();
    for (const seat of seats) {
      if (seat.control !== 'human') continue;
      if (seat.awaySince !== null && seat.conn && now >= seat.awaySince + def.grace.awayLimitMs) {
        const conn = seat.conn;
        detachSeat(seat);
        conn.close(CLOSE.away, 'Away too long');
      }
      if (seat.ghostSince !== null && now >= graceUntil(seat)) graceOver(seat);
    }
    if (noHumanSince !== null && now >= noHumanSince + def.idle.noHumanMs) {
      finish('idle', null);
      return;
    }
    if (now >= lastInputAt + def.idle.noInputMs) {
      finish('idle', null);
      return;
    }
    arm();
  };

  // -------------------------------------------------------------- seats

  const seatAway = (seat: Seat): void => {
    if (seat.control !== 'human' || seat.ghostSince !== null) return;
    seat.ghostSince = clock.now();
    runtime.setSeat(seat.slot, 'ghost');
    d.tickets.setValidUntil(d.id, seat.slot, graceUntil(seat));
  };

  const seatBack = (seat: Seat): void => {
    if (seat.control !== 'human') return;
    seat.awaySince = null;
    if (seat.ghostSince === null) return;
    seat.graceUsedMs += clock.now() - seat.ghostSince;
    seat.ghostSince = null;
    runtime.setSeat(seat.slot, 'live');
  };

  const detachSeat = (seat: Seat): void => {
    if (seat.conn) connIndex.delete(seat.conn.id);
    seat.conn = null;
    seat.recipient?.detach();
    if (humansConnected() === 0 && noHumanSince === null) noHumanSince = clock.now();
  };

  const attachSeat = (seat: Seat, conn: LaneConn, accountId: string, reason: number): void => {
    if (seat.conn && seat.conn !== conn) {
      const old = seat.conn;
      connIndex.delete(old.id);
      old.close(CLOSE.takenOver, 'Playing in another window');
    }
    seat.conn = conn;
    seat.recipient = makeRecipient(seat.slot, false);
    seat.recipient.attach(sinkOf(conn));
    seat.seenPark = null;
    seat.lastUpSeq = null;
    connIndex.set(conn.id, { seat });
    noHumanSince = null;
    welcome(conn, seat.recipient, { accountId, slot: seat.slot, queued: false, lastEvSeq: seat.lastEvSeq, reason });
    seatBack(seat);
    lastInputAt = Math.max(lastInputAt, clock.now() - def.idle.noInputMs / 2);
  };

  const freeSeat = (): Seat | null =>
    seats.find((s) => s.control === 'none') ?? seats.find((s) => s.control === 'bot' && s.owner === null) ?? null;

  const addWatcher = (conn: LaneConn, accountId: string, queued: boolean): void => {
    const recipient = makeRecipient(SPECTATOR, true);
    recipient.attach(sinkOf(conn));
    const watcher: Watcher = { accountId, conn, recipient, queued };
    watchers.push(watcher);
    connIndex.set(conn.id, { watcher });
    welcome(conn, recipient, { accountId, slot: SPECTATOR, queued, lastEvSeq: 0, reason: KEY_REASON.join });
  };

  /** Queued late joiners and reclaims take seats at a round start (re-sent WELCOME, then the round keyframe). */
  const processQueue = (): void => {
    for (const watcher of watchers.filter((w) => w.queued)) {
      const own = seats.find((s) => s.owner === watcher.accountId && s.control === 'bot');
      const seat = own ?? freeSeat();
      if (!seat) continue;
      watchers.splice(watchers.indexOf(watcher), 1);
      connIndex.delete(watcher.conn.id);
      watcher.recipient.detach();
      seat.owner = watcher.accountId;
      seat.control = 'human';
      seat.ghostSince = null;
      seat.lastEvSeq = 0;
      runtime.setSeat(seat.slot, 'reclaim');
      attachSeat(seat, watcher.conn, watcher.accountId, KEY_REASON.round);
    }
    d.onChanged();
  };

  // -------------------------------------------------------------- host events

  const persist = (e: Extract<HostEvent, { t: 'persist' | 'end' }>): void => {
    try {
      d.tx(() => def.persist(e, d.persistApi(accountOf)));
    } catch (error) {
      log.error({ err: error, match: d.id, game: def.game, event: e.t }, 'arcade persist failed');
    }
  };

  const handleHostEvent = (e: HostEvent): boolean => {
    switch (e.t) {
      case 'phase':
        phase = { phase: e.phase, reason: e.reason, body: e.body };
        for (const r of allRecipients()) r.pushPhase(e.phase, e.reason, e.body);
        return false;
      case 'seat': {
        const seat = seats.find((s) => s.slot === e.slot);
        if (seat) seat.state = e.state;
        const code = SEAT_STATE[e.state] as SeatStateCode;
        for (const r of allRecipients()) r.pushSeat(runtime.tick, e.slot, code);
        d.onChanged();
        return false;
      }
      case 'rekey': {
        const seat = seats.find((s) => s.slot === e.slot);
        if (seat?.recipient) {
          seat.recipient.view = e.view;
          seat.recipient.rekey(e.reason);
        }
        return false;
      }
      case 'roundStart':
        // A new round (a new layout): every recipient gets a KEYFRAME with reason 3, then queued
        // joiners and reclaims take their seats (their WELCOME brings their own keyframe).
        for (const r of allRecipients()) r.rekey(KEY_REASON.round);
        processQueue();
        return false;
      case 'persist':
        persist(e);
        return false;
      case 'end':
        persist(e);
        finish(e.reason, null);
        return true;
    }
  };

  // -------------------------------------------------------------- ending

  const closeAll = (code: number, reason: string): void => {
    for (const seat of seats) {
      if (!seat.conn) continue;
      const conn = seat.conn;
      detachSeat(seat);
      conn.close(code, reason);
    }
    for (const watcher of watchers.splice(0)) {
      connIndex.delete(watcher.conn.id);
      watcher.conn.close(code, reason);
    }
  };

  const teardown = (reason: string): void => {
    ended = true;
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    d.tickets.revoke(d.id);
    try {
      runtime.dispose();
    } catch (error) {
      log.warn({ err: error, match: d.id }, 'arcade runtime dispose failed');
    }
    d.onEnded(reason);
  };

  const finish = (reason: string, _result: unknown): void => {
    if (ended) return;
    // What is queued (the final phase among it) goes out before the lane closes.
    const input = slotInput(null);
    for (const r of allRecipients()) r.flush({ ...input(r) });
    closeAll(CLOSE.left, 'Match over');
    teardown(reason);
  };

  const abort: ServerMatch['abort'] = (reason) => {
    if (ended) return;
    const phaseReason = reason === 'restart' ? PHASE_REASON.restart : reason === 'admin' ? PHASE_REASON.admin : PHASE_REASON.overload;
    let handover: Uint8Array | null = null;
    try {
      const body = deflateRawSync(runtime.handover());
      if (body.length <= 8 * 1024) handover = writeHandover(SIM[def.game], runtime.tick >>> 0, body);
    } catch (error) {
      log.warn({ err: error, match: d.id }, 'arcade handover failed');
    }
    if (reason === 'overload' || reason === 'error') {
      try {
        log.warn({ match: d.id, game: def.game, reason, replay: b64url(runtime.replay()) }, 'arcade match ended; replay dump');
      } catch {
        /* a broken runtime may not replay */
      }
    }
    const phaseMsg = writePhase(PHASE.ending, phaseReason, new Uint8Array(0));
    for (const r of allRecipients()) {
      r.sendRaw(phaseMsg);
      if (handover) r.sendRaw(handover);
    }
    closeAll(CLOSE.restart, reason === 'restart' ? 'Server restarting' : 'Match stopped');
    // Results are void from here on; progress (Bellwick) is still saved.
    for (const seat of seats) {
      if (seat.control !== 'human') continue;
      try {
        runtime.setSeat(seat.slot, 'left');
      } catch {
        /* ignore */
      }
    }
    try {
      for (const e of runtime.takeHostEvents()) {
        if (e.t === 'persist') persist(e);
        else if (e.t === 'end') persist({ t: 'end', reason: e.reason, result: null });
      }
    } catch (error) {
      log.warn({ err: error, match: d.id }, 'arcade final host events failed');
    }
    teardown(reason);
  };

  // -------------------------------------------------------------- chat first, server side

  /** A main socket with a backlog for over 1 s parks that player as yield; 2 s without one unparks it. */
  const checkMainSockets = (): void => {
    const now = clock.now();
    for (const seat of seats) {
      if (seat.control !== 'human' || !seat.owner || !seat.recipient || !seat.conn) continue;
      const busy = (d.mainBusy as (accountId: string) => boolean)(seat.owner);
      if (busy) {
        seat.calmSince = null;
        seat.busySince ??= now;
        if (!seat.serverYield && seat.recipient.parked === null && now - seat.busySince > 1000) {
          seat.serverYield = true;
          seat.recipient.park('yield');
          seatAway(seat);
        }
      } else {
        seat.busySince = null;
        if (seat.serverYield) {
          seat.calmSince ??= now;
          if (now - seat.calmSince >= 2000) {
            seat.serverYield = false;
            seat.calmSince = null;
            if (seat.recipient.parked === 'yield') {
              seat.recipient.unpark();
              seatBack(seat);
            }
          }
        }
      }
    }
  };

  // -------------------------------------------------------------- ticking

  const slotInput = (_unused: null) => (r: Recipient) => {
    const slot = r.slot;
    const v = { slot, view: r.view };
    return {
      tick: runtime.tick >>> 0,
      snapshot: null as Uint8Array | null,
      ackUp: slot === SPECTATOR ? 0 : runtime.ackUp(slot),
      keyframe: () => runtime.keyframeFor(v),
      phase,
      floor: d.floor(slot === SPECTATOR),
    };
  };

  const match: ServerMatch = {
    id: d.id,
    game: def.game,
    channelId: d.channelId,
    runtime,
    get ended() {
      return ended;
    },
    get active() {
      return !ended && !runtime.idle;
    },
    get sending() {
      if (ended) return false;
      return allRecipients().some((r) => r.parked !== 'away');
    },

    attach(conn, claim) {
      if (ended) return CLOSE.gone;
      if (claim.role === 's') {
        if (def.spectators === 0) return CLOSE.forbidden;
        const counted = watchers.filter((w) => !w.queued).length;
        if (!d.spectatorsAllowed() || counted >= Math.min(def.spectators, d.spectatorCap())) return CLOSE.forbidden;
        addWatcher(conn, claim.accountId, false);
        d.onChanged();
        return 0;
      }
      const seat = seats.find((s) => s.owner === claim.accountId);
      if (seat && seat.control === 'human') {
        attachSeat(seat, conn, claim.accountId, claim.via === 'resume' ? KEY_REASON.resume : KEY_REASON.join);
        d.onChanged();
        arm();
        return 0;
      }
      if (def.join === 'dropIn') {
        const free = seat ?? freeSeat();
        if (!free) return CLOSE.forbidden;
        free.owner = claim.accountId;
        free.control = 'human';
        free.ghostSince = null;
        free.lastEvSeq = 0;
        free.joinedAt = clock.now();
        runtime.setSeat(free.slot, free === seat ? 'reclaim' : 'live');
        attachSeat(free, conn, claim.accountId, KEY_REASON.join);
        d.onChanged();
        arm();
        return 0;
      }
      // Next round: watch until a seat frees up at the round start (also a reclaim after the grace).
      addWatcher(conn, claim.accountId, true);
      d.onChanged();
      return 0;
    },

    onMessage(conn, msg) {
      if (ended) return;
      const entry = connIndex.get(conn.id);
      if (!entry) return;
      if ('watcher' in entry) {
        const r = entry.watcher.recipient;
        if (msg.t === 'ack') r.onAck(msg.ackFrame, msg.ackDelayMs);
        else if (msg.t === 'up') r.onAck(msg.ackFrame, msg.ackDelayMs);
        else if (msg.t === 'ping') r.sendRaw(writePong(msg.clientMs, runtime.tick >>> 0, d.tickPhaseUs()));
        else if (msg.t === 'resync') r.rekey(KEY_REASON.resync);
        else if (msg.t === 'vis') {
          if (msg.state === VIS.live) r.unpark();
          else r.park(msg.state === VIS.yield ? 'yield' : 'away');
        }
        return;
      }
      const seat = entry.seat;
      const r = seat.recipient as Recipient;
      const now = clock.now();
      switch (msg.t) {
        case 'up': {
          r.onAck(msg.ackFrame, msg.ackDelayMs);
          if (seat.lastUpSeq !== null && !seqNewer(msg.upSeq, seat.lastUpSeq)) return;
          seat.lastUpSeq = msg.upSeq;
          r.onUp();
          lastInputAt = now;
          if (seat.control === 'human') runtime.onUp(seat.slot, msg.payload, msg.upSeq);
          return;
        }
        case 'ack':
          r.onAck(msg.ackFrame, msg.ackDelayMs);
          return;
        case 'evt':
          if (!seqNewer(msg.evSeq, seat.lastEvSeq)) return;
          seat.lastEvSeq = msg.evSeq;
          lastInputAt = now;
          if (seat.control === 'human') runtime.onEvent(seat.slot, msg.payload);
          return;
        case 'ping':
          r.sendRaw(writePong(msg.clientMs, runtime.tick >>> 0, d.tickPhaseUs()));
          return;
        case 'resync':
          r.rekey(KEY_REASON.resync);
          return;
        case 'vis':
          if (msg.state === VIS.live) {
            r.unpark();
            seatBack(seat);
          } else {
            r.park(msg.state === VIS.yield ? 'yield' : 'away');
            if (msg.state !== VIS.yield && seat.awaySince === null) seat.awaySince = now;
            seatAway(seat);
          }
          arm();
          return;
      }
    },

    onClose(conn, code) {
      const entry = connIndex.get(conn.id);
      if (!entry) return;
      connIndex.delete(conn.id);
      if ('watcher' in entry) {
        watchers.splice(watchers.indexOf(entry.watcher), 1);
        entry.watcher.recipient.detach();
        d.onChanged();
        return;
      }
      const seat = entry.seat;
      if (seat.conn !== conn) return;
      detachSeat(seat);
      if (code === CLOSE.left) {
        // Leaving releases the seat at once: Fuseyard gives it to a bot, Bellwick's hero leaves.
        seat.ghostSince = null;
        seat.awaySince = null;
        if (def.grace.after === 'bot') {
          runtime.setSeat(seat.slot, 'bot');
          seat.control = 'bot';
        } else {
          runtime.setSeat(seat.slot, 'left');
          seat.control = 'none';
        }
        seat.owner = null;
        d.tickets.revoke(d.id, seat.slot);
      } else {
        seatAway(seat);
      }
      d.onChanged();
      arm();
    },

    step() {
      if (ended) return 0;
      // Real CPU time, not the injected clock: this is what the watchdog limits.
      const started = performance.now();
      try {
        runtime.step();
      } catch (error) {
        log.error({ err: error, match: d.id, game: def.game }, 'arcade match step failed');
        abort('error');
        return 0;
      }
      const ms = performance.now() - started;
      ticks += 1;
      if (ticks % TICK_HZ === 0) {
        for (const seat of seats) if (seat.control === 'human' && seat.recipient && seat.conn) runtime.setRtt(seat.slot, seat.recipient.pacer.rttMs);
      }
      const tick = runtime.tick >>> 0;
      for (const seat of seats) {
        if (!seat.recipient || !seat.conn) continue;
        const chunk = runtime.takeEvents(view(seat.slot, seat.recipient));
        if (chunk) seat.recipient.pushEvents(tick, chunk);
      }
      for (const watcher of watchers) {
        const chunk = runtime.takeEvents({ slot: SPECTATOR, view: watcher.recipient.view });
        if (chunk) watcher.recipient.pushEvents(tick, chunk);
      }
      for (const e of runtime.takeHostEvents()) if (handleHostEvent(e)) break;
      return ms;
    },

    send() {
      if (ended) return;
      if (d.mainBusy && ticks % 8 === 0) checkMainSockets();
      const input = slotInput(null);
      for (const seat of seats) {
        if (!seat.recipient || !seat.conn) continue;
        const base = input(seat.recipient);
        base.snapshot = runtime.snapshotFor(view(seat.slot, seat.recipient));
        seat.recipient.slotTick(base);
        const park = seat.recipient.parked;
        if (park !== seat.seenPark) {
          if (park === 'stalled') seatAway(seat);
          if (seat.seenPark === 'stalled' && park === null) seatBack(seat);
          seat.seenPark = park;
        }
      }
      for (const watcher of watchers) {
        const base = input(watcher.recipient);
        base.snapshot = runtime.snapshotFor({ slot: SPECTATOR, view: watcher.recipient.view });
        watcher.recipient.slotTick(base);
      }
    },

    admit(accountId) {
      if (ended) return 'full';
      if (seats.some((s) => s.owner === accountId && s.control === 'human')) return 'seat';
      if (def.join === 'dropIn') return freeSeat() ? 'seat' : 'full';
      return 'queued';
    },

    release(accountId) {
      const seat = seats.find((s) => s.owner === accountId && s.control === 'human');
      if (!seat) return;
      if (seat.conn) {
        const conn = seat.conn;
        conn.close(CLOSE.left, 'Left the game');
        match.onClose(conn, CLOSE.left);
      } else {
        seat.ghostSince = null;
        if (def.grace.after === 'bot') {
          runtime.setSeat(seat.slot, 'bot');
          seat.control = 'bot';
        } else {
          runtime.setSeat(seat.slot, 'left');
          seat.control = 'none';
        }
        seat.owner = null;
        d.onChanged();
      }
    },

    seats: () =>
      seats.map((s) => ({
        slot: s.slot,
        accountId: s.owner,
        bot: s.control === 'bot',
        state: SEAT_STATE[s.state],
      })),
    watchers: () => watchers.filter((w) => !w.queued).length,
    humans: () => seats.filter((s) => s.control === 'human').length,
    abort,
    dispose() {
      if (ended) return;
      closeAll(CLOSE.left, 'Match over');
      teardown('disposed');
    },
  };

  // Humans are ghosts until their lane connects (they usually do within a second of the start).
  for (const seat of seats) if (seat.control === 'human') runtime.setSeat(seat.slot, 'ghost');
  arm();
  return match;
};
