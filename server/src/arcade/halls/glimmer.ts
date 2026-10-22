/**
 * Glimmerhall on the server (glimmerhall.md §4–§10): the table-lane game for the three machines.
 *
 * - Every spin is decided here in one database transaction: the draws, the feature, the Glimmer Pot
 *   contribution and draw, one transfer with net legs and an explicit balance-at-least-the-bet
 *   guard, the pending vault, the stats and the stored receipt. A retried spin id returns the
 *   receipt (or `settled` once it was cleared); a throw anywhere rolls the whole spin back.
 * - One hall per voice channel (at most `limits.hallMembers`), opt-in: only people who open it.
 *   Seats are keyed by account; a newer socket takes the seat and the old one gets `glimmer:moved`.
 * - Hall pushes (`glimmer:feed`) go to each member who is not away, per socket, at most once a
 *   second, merged per recipient until the platform reports them sent, in the per-game sub-bucket.
 * - Glimmer Dash lives in dash.ts.
 *
 * Timers: a hall flush timer only while that hall has something to send, a 120 s drop timer per
 * disconnected seat, and the Dash timers. Nothing runs while nothing is open.
 */
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { scatterPayX } from '../core/glimmer/evaluate.js';
import { shuffleDoors } from '../core/glimmer/feature.js';
import { betAllowed, machineDef, type MachineIdx } from '../core/glimmer/machines.js';
import { openVault, playFeature, spinBase, type FeatureResult, type Rng } from '../core/glimmer/spin.js';
import {
  AWAY_GAP_MS,
  EMOTES,
  FEED_GAP_MS,
  FEED_KIND,
  NOTABLE_X,
  POT_E4,
  POT_GAP_MS,
  POT_ODDS,
  POT_SEED,
  PUSH_BUCKET,
  REACT_GAP_MS,
  SEAT_DROP_MS,
  encodeStops,
  emptyPending,
  isSpinId,
  packFeed,
  pendingEmpty,
  wireFeature,
  type DashView,
  type EnterOk,
  type FeedEntry,
  type FeedPending,
  type FeedView,
  type MemberRow,
  type PickOk,
  type Refused,
  type SpinOk,
  type WireFeature,
} from '../core/glimmer/wire.js';
import { DEFS } from '../core/version.js';
import { statBoard } from '../stats.js';
import type { ActivityEntry, CallerCtx, Leg, LobbyRecord, PendingRow, PendingStore, TableApi, TableGame, TableGameDef } from '../tables/types.js';
import { potAccount, walletAccount } from '../wallet.js';
import { createDashes, type Dashes } from './dash.js';

export const GAME = 'glimmer' as const;
export const POT_SCOPE = 'glimmer';
/** A pending vault older than this is opened for its owner (a random door). */
export const VAULT_AUTO_PICK_MS = 24 * 60 * 60_000;
/** The LobbyChip shows "Glimmer Pot won" this long. */
export const POT_CHIP_MS = 60_000;

// ------------------------------------------------------------------ pending vaults

interface VaultData {
  m: MachineIdx;
  bet: number;
  doors: number[];
}

const parseVault = (row: Omit<PendingRow, 'accountId'> | null): VaultData | null => {
  if (!row || row.kind !== 'vault') return null;
  try {
    const d = JSON.parse(row.data) as VaultData;
    if ((d.m === 0 || d.m === 1 || d.m === 2) && Number.isInteger(d.bet) && Array.isArray(d.doors) && d.doors.length === 3) return d;
  } catch {
    /* a broken row is treated as none */
  }
  return null;
};

// ------------------------------------------------------------------ state

export interface Seat {
  accountId: string;
  socketId: string;
  /** Voice channel id of the hall, or null (spinning alone, no feed). */
  hall: string | null;
  slot: number;
  machine: MachineIdx;
  away: boolean;
  /** The away state the hall last saw, when, and the timer that shows a change held back by the 5 s gap. */
  awayShown: boolean;
  awayShownAt: number;
  awayTimer: unknown;
  lastInputAt: number;
  lastReactAt: number;
  /** Last pot value sent to this socket. */
  potSent: number | null;
  lw: number;
  lx: number;
  dropTimer: unknown;
  /** Per-recipient push state: what waits, and what the platform has queued but not sent. */
  feed: FeedPending;
  queued: FeedView | null;
  /** When the platform last sent this member a push (pushes stay at most one a second on the wire). */
  sentAt: number;
}

export interface Hall {
  ch: string;
  members: Map<string, Seat>;
  slots: (string | null)[];
  flushTimer: unknown;
  lastFlushAt: number;
  lastPotAt: number;
  potDirty: boolean;
  potWon: { amt: number; at: number } | null;
}

const refuse = (code: string): Refused => ({ ok: false, code });

const SETTINGS = z.object({ slotsMaxBet: z.number().int().min(5).max(500) });
type GlimmerSettings = z.infer<typeof SETTINGS>;
const SETTINGS_DEFAULTS: GlimmerSettings = { slotsMaxBet: 500 };

export interface GlimmerOptions {
  rng?: Rng;
  /** The pot draw's random source (`randomInt(POT_ODDS)` by default). */
  potRng?: Rng;
}

export interface GlimmerGame extends TableGame {
  readonly debug: { seats: Map<string, Seat>; halls: Map<string, Hall>; dashes: Dashes; pending: PendingStore };
}

const machineSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const idSchema = z.string().length(12);

export const startGlimmer = (api: TableApi, o: GlimmerOptions = {}): GlimmerGame => {
  const rng: Rng = o.rng ?? ((n) => randomInt(n));
  const potRng: Rng = o.potRng ?? ((n) => randomInt(n));
  const clock = api.clock;
  const pending: PendingStore = api.pending;
  const seats = new Map<string, Seat>();
  const halls = new Map<string, Hall>();
  /** Each channel's Glimmerhall lobby (the hub's record; the hall is that lobby, live from the start). */
  const lobbyOf = new Map<string, string>();
  let stopped = false;

  const settings = (): GlimmerSettings => (api.settings().gameSettings.glimmer as GlimmerSettings | undefined) ?? SETTINGS_DEFAULTS;
  const enabled = (): boolean => {
    const s = api.settings();
    return s.enabled && s.games.glimmer !== false;
  };
  const maxMembers = (): number => api.hub.limits().hallMembers;

  // ---------------------------------------------------------------- pushes

  const mergeInto = (p: FeedPending, v: FeedView): void => {
    if (v.e) p.e.unshift(...v.e);
    if (v.r) p.r.unshift(...v.r);
    if (v.h) for (const h of v.h) if (!p.h.some((x) => x[0] === h[0])) p.h.unshift(h);
    if (v.d && p.d === undefined) p.d = v.d;
    if (v.p !== undefined && p.p === undefined) p.p = v.p;
  };

  const sendFeed = (seat: Seat, hall: Hall): void => {
    // A push still waiting in the platform's queue is replaced (newest wins): merge it back first.
    if (seat.queued) {
      mergeInto(seat.feed, seat.queued);
      seat.queued = null;
    }
    const view = packFeed(seat.feed);
    if (!view) return;
    seat.queued = view;
    const deadline = view.d ? dashes.deadlineOf(view.d.id) : null;
    api.emit(seat.socketId, 'glimmer:feed', view, {
      queue: 'glimmer',
      coalesce: 'glimmer:feed',
      sub: { rateBps: PUSH_BUCKET.rateBps, depth: PUSH_BUCKET.depth },
      stamp: deadline === null ? undefined : (data, sentAt) => ({ ...(data as FeedView), d: { ...(data as FeedView).d, t: Math.max(0, Math.ceil((deadline - sentAt) / 1000)) } }),
      onSent: () => {
        seat.sentAt = clock.now();
        if (seat.queued === view) seat.queued = null;
      },
    });
    void hall;
  };

  const flush = (hall: Hall): void => {
    hall.flushTimer = null;
    if (stopped || !halls.has(hall.ch)) return;
    const now = clock.now();
    hall.lastFlushAt = now;
    let pot: number | undefined;
    if (hall.potDirty && now - hall.lastPotAt >= POT_GAP_MS) {
      pot = api.wallet.pot(POT_SCOPE).pool;
      hall.lastPotAt = now;
      hall.potDirty = false;
    }
    let later = Infinity;
    for (const seat of hall.members.values()) {
      if (seat.away) continue;
      if (pot !== undefined && seat.potSent !== pot) {
        seat.feed.p = pot;
        seat.potSent = pot;
      }
      if (pendingEmpty(seat.feed) && !seat.queued) continue;
      // The last push left the server less than a second ago (it waited behind chat): this one waits too.
      if (now - seat.sentAt < FEED_GAP_MS) {
        later = Math.min(later, seat.sentAt + FEED_GAP_MS);
        continue;
      }
      sendFeed(seat, hall);
    }
    // Pot changes held back by the 2 s rule, members held by the 1 s rule, and leftovers that did not fit, go next.
    if (later !== Infinity || hall.potDirty || [...hall.members.values()].some((s) => !s.away && !pendingEmpty(s.feed))) arm(hall, later);
  };

  const arm = (hall: Hall, notBefore = 0): void => {
    if (hall.flushTimer !== null || stopped) return;
    const now = clock.now();
    const at = Math.max(hall.lastFlushAt + FEED_GAP_MS, now, notBefore === Infinity ? now : notBefore, hall.potDirty ? hall.lastPotAt + POT_GAP_MS : now);
    hall.flushTimer = clock.setTimeout(() => flush(hall), at - now);
  };

  /** Queue something for every member who is not away (optionally not the one who caused it). */
  const toHall = (hall: Hall, add: (p: FeedPending, seat: Seat) => void, except?: string): void => {
    let any = false;
    for (const seat of hall.members.values()) {
      if (seat.away || seat.accountId === except) continue;
      add(seat.feed, seat);
      any = true;
    }
    if (any) arm(hall);
  };

  const keepTop = (list: FeedEntry[]): void => {
    if (list.length <= 12) return;
    list.sort((a, b) => b[3] / Math.max(1, b[2]) - a[3] / Math.max(1, a[2]));
    list.length = 12;
  };

  const entry = (seat: Seat, e: FeedEntry): void => {
    const hall = seat.hall ? halls.get(seat.hall) : undefined;
    if (!hall) return;
    toHall(hall, (p) => {
      p.e.push(e);
      keepTop(p.e);
    });
  };

  const memberDelta = (hall: Hall, seat: Seat, gone: boolean): void => {
    toHall(
      hall,
      (p) => {
        p.h = p.h.filter((x) => x[0] !== seat.slot);
        p.h.push([seat.slot, gone ? null : seat.accountId, seat.machine, seat.away ? 1 : 0]);
      },
      seat.accountId,
    );
    if (!gone) seat.awayShown = seat.away;
  };

  /**
   * The hall sees a member's away state change at most once per AWAY_GAP_MS. A change inside the gap
   * is held back, not dropped: when the gap ends the hall gets the state as it is then.
   */
  const showAway = (seat: Seat): void => {
    const hall = seat.hall ? halls.get(seat.hall) : undefined;
    if (!hall || seat.awayShown === seat.away) return;
    const now = clock.now();
    const wait = seat.awayShownAt + AWAY_GAP_MS - now;
    if (wait > 0) {
      if (seat.awayTimer === null) {
        seat.awayTimer = clock.setTimeout(() => {
          seat.awayTimer = null;
          showAway(seat);
        }, wait);
      }
      return;
    }
    seat.awayShownAt = now;
    memberDelta(hall, seat, false);
  };

  const clearSeatTimers = (seat: Seat): void => {
    if (seat.dropTimer !== null) clock.clearTimeout(seat.dropTimer);
    seat.dropTimer = null;
    if (seat.awayTimer !== null) clock.clearTimeout(seat.awayTimer);
    seat.awayTimer = null;
  };

  const markPot = (): void => {
    for (const hall of halls.values()) {
      hall.potDirty = true;
      if ([...hall.members.values()].some((s) => !s.away)) arm(hall);
    }
  };

  // ---------------------------------------------------------------- the hub's lobby record

  /** The channel's hall lobby, if the hub still has it. */
  const liveLobby = (ch: string): LobbyRecord | null => {
    const id = lobbyOf.get(ch);
    if (!id) return null;
    const record = api.hub.get(id);
    if (!record || record.state === 'ended') {
      lobbyOf.delete(ch);
      return null;
    }
    return record;
  };

  /**
   * Keeps the lobby's seats in step with the hall: the people in it plus anyone the hub seated who has
   * not entered yet, padded to the hall's size so joining never runs out of seats.
   */
  const syncSeats = (ch: string, add: string | null, remove: string | null): void => {
    const record = liveLobby(ch);
    if (!record) return;
    const ids: string[] = [];
    for (const s of record.seats) if (s.accountId && s.accountId !== remove && !ids.includes(s.accountId)) ids.push(s.accountId);
    const hall = halls.get(ch);
    if (hall) for (const id of hall.members.keys()) if (id !== remove && !ids.includes(id)) ids.push(id);
    if (add && !ids.includes(add)) ids.push(add);
    const size = Math.max(maxMembers(), ids.length + 1);
    const seatsOut: LobbyRecord['seats'] = Array.from({ length: size }, (_, i) => ({ accountId: ids[i] ?? null, bot: false, state: 0 }));
    api.hub.update(record.id, { seats: seatsOut });
  };

  // ---------------------------------------------------------------- halls and seats

  const memberRows = (hall: Hall | undefined): MemberRow[] =>
    hall ? [...hall.members.values()].sort((a, b) => a.slot - b.slot).map((s) => [s.slot, s.accountId, s.machine, s.away ? 1 : 0, s.lw, s.lx]) : [];

  const leaveHall = (seat: Seat): void => {
    const hall = seat.hall ? halls.get(seat.hall) : undefined;
    seat.hall = null;
    if (seat.awayTimer !== null) clock.clearTimeout(seat.awayTimer);
    seat.awayTimer = null;
    seat.feed = emptyPending();
    seat.queued = null;
    if (!hall) return;
    hall.members.delete(seat.accountId);
    hall.slots[seat.slot] = null;
    memberDelta(hall, seat, true);
    seat.slot = -1;
    dashes.onMemberLeft(hall.ch, seat.accountId);
    if (hall.members.size === 0) {
      if (hall.flushTimer !== null) clock.clearTimeout(hall.flushTimer);
      halls.delete(hall.ch);
      dashes.onHallClosed(hall.ch);
      // The last one out closes the channel's hall lobby.
      const record = liveLobby(hall.ch);
      if (record && !record.seats.some((s) => s.accountId && s.accountId !== seat.accountId)) {
        lobbyOf.delete(hall.ch);
        api.hub.close(record.id, 'empty');
      } else syncSeats(hall.ch, null, seat.accountId);
    } else syncSeats(hall.ch, null, seat.accountId);
    api.hub.activityChanged(hall.ch);
  };

  const dropSeat = (seat: Seat): void => {
    clearSeatTimers(seat);
    leaveHall(seat);
    seats.delete(seat.accountId);
  };

  const joinHall = (seat: Seat, ch: string): boolean => {
    let hall = halls.get(ch);
    if (!hall) {
      hall = { ch, members: new Map(), slots: new Array<string | null>(Math.max(1, maxMembers())).fill(null), flushTimer: null, lastFlushAt: 0, lastPotAt: 0, potDirty: false, potWon: null };
      halls.set(ch, hall);
    }
    if (hall.members.has(seat.accountId)) return true;
    if (hall.members.size >= maxMembers()) return false;
    // A live Dash names its entrants by seat: an entrant coming back gets theirs again, and nobody
    // else gets one of theirs until the Dash ends.
    const { own, held } = dashes.seatsFor(ch, seat.accountId);
    let slot = own !== null && (hall.slots[own] ?? null) === null ? own : hall.slots.findIndex((s, i) => s === null && !held.has(i));
    if (slot < 0) {
      slot = hall.slots.length;
      while (held.has(slot)) slot += 1;
    }
    while (hall.slots.length <= slot) hall.slots.push(null);
    hall.slots[slot] = seat.accountId;
    hall.members.set(seat.accountId, seat);
    seat.hall = ch;
    seat.slot = slot;
    seat.feed = emptyPending();
    seat.queued = null;
    memberDelta(hall, seat, false);
    syncSeats(ch, seat.accountId, null);
    api.hub.activityChanged(ch);
    return true;
  };

  const seatFor = (c: CallerCtx): Seat | null => seats.get(c.accountId) ?? null;

  /** The caller's seat if this socket holds it; a refusal otherwise. */
  const own = (c: CallerCtx): Seat | Refused => {
    const seat = seatFor(c);
    if (!seat) return refuse('state');
    if (seat.socketId !== c.socketId) return refuse('moved');
    seat.lastInputAt = clock.now();
    return seat;
  };

  // ---------------------------------------------------------------- wallet helpers

  const balanceOf = (accountId: string): number => api.wallet.view(accountId).bal;

  /** Net legs: one per account; zero legs dropped (the wallet leg always stays). */
  const legs = (accountId: string, walletDelta: number, potDelta: number): Leg[] => {
    const out: Leg[] = [{ account: walletAccount(accountId), delta: walletDelta }];
    if (potDelta !== 0) out.push({ account: potAccount(POT_SCOPE), delta: potDelta });
    const house = -(walletDelta + potDelta);
    if (house !== 0) out.push({ account: 'house', delta: house });
    return out;
  };

  const stat = (accountId: string, m: MachineIdx, bet: number, total: number, spins: number, wagered: number): void => {
    const code = machineDef(m).code;
    if (spins) api.stats.add(accountId, GAME, code + '.spins', spins);
    if (wagered) api.stats.add(accountId, GAME, code + '.wagered', wagered);
    if (total) {
      api.stats.add(accountId, GAME, code + '.won', total);
      const x = Math.floor((total * 100) / bet);
      api.stats.max(accountId, GAME, code + '.best', total);
      api.stats.max(accountId, GAME, code + '.bestx', x);
      api.stats.max(accountId, GAME, 'best', total);
      api.stats.max(accountId, GAME, 'bestx', x);
    }
  };

  const notable = (seat: Seat, m: MachineIdx, bet: number, total: number, feature: boolean): void => {
    if (!feature && total < bet * NOTABLE_X) return;
    seat.lw = total;
    seat.lx = Math.floor((total * 100) / bet);
    entry(seat, [seat.slot, m, bet, total, feature ? FEED_KIND.feature : FEED_KIND.win]);
  };

  // ---------------------------------------------------------------- spins

  /** A transfer refused after the draws rolls the whole transaction back through this error. */
  class SpinRefused extends Error {
    constructor(readonly code: string) {
      super('glimmer: spin refused: ' + code);
    }
  }

  /** `wallet.tx` with refusals from inside the transaction turned into acks, and an after-commit step. */
  const txSpin = <T extends { ok: boolean }>(fn: () => T | Refused, after: (out: T | Refused) => void): T | Refused => {
    let out: T | Refused;
    try {
      out = api.wallet.tx(fn);
    } catch (err) {
      if (err instanceof SpinRefused) return refuse(err.code);
      throw err;
    }
    after(out);
    return out;
  };

  const spin = (c: CallerCtx, p: { m: MachineIdx; b: number; id: string }): SpinOk | Refused | { ok: true; settled: true; bal: number } => {
    const seat = own(c);
    if ('ok' in seat) return seat;
    if (!enabled()) return refuse('disabled');
    if (!isSpinId(p.id)) return refuse('invalid');
    const def = machineDef(p.m);
    const bet = p.b;
    return txSpin<SpinOk | { ok: true; settled: true; bal: number }>(() => {
      const idem = 'g:' + p.id;
      // A retry: the stored receipt, or `settled` once it was cleared.
      const probe = api.wallet.transfer('spin', 'glimmer:' + def.code, c.accountId, idem, []);
      if (probe.ok && probe.dup) return probe.receipt ? (JSON.parse(probe.receipt) as SpinOk) : { ok: true as const, settled: true as const, bal: balanceOf(c.accountId) };
      if (parseVault(pending.get(c.accountId, GAME))) return refuse('pending');
      if (!betAllowed(def, bet, settings().slotsMaxBet)) return refuse('bet');
      const before = balanceOf(c.accountId);
      if (before < bet) return refuse('funds');
      const base = spinBase(def, bet, rng);
      let f: FeatureResult | null = null;
      let doors: number[] | null = null;
      if (base.trigger) {
        if (def.feature.kind === 'vault') doors = shuffleDoors(rng);
        else f = playFeature(def, bet, rng);
      }
      const win = base.win + (f?.win ?? 0);
      // The Glimmer Pot: 0.75 % of the bet in e4-units with the carry kept by the house, then the draw.
      const whole = api.wallet.addCarry(POT_SCOPE, bet * POT_E4);
      const pool = api.wallet.pot(POT_SCOPE).pool + whole;
      const potWin = potRng(POT_ODDS) < bet ? pool : 0;
      const bal = before - bet + win + potWin;
      const ack: SpinOk = { ok: true, id: p.id, st: encodeStops(base.stops), w: base.win, bal };
      if (f) ack.f = wireFeature(f.kind, f);
      if (doors) ack.v = 1;
      if (potWin > 0) ack.pt = potWin;
      const potAfter = potWin > 0 ? POT_SEED : pool;
      if (seat.potSent !== potAfter) {
        ack.pot = potAfter;
        seat.potSent = potAfter;
      }
      const t = api.wallet.transfer('spin', 'glimmer:' + def.code, c.accountId, idem, legs(c.accountId, win - bet + potWin, whole - potWin), {
        min: { [walletAccount(c.accountId)]: bet },
        receipt: JSON.stringify(ack),
      });
      if (!t.ok) throw new SpinRefused(t.code === 'min' ? 'funds' : t.code);
      if (t.dup) return t.receipt ? (JSON.parse(t.receipt) as SpinOk) : { ok: true as const, settled: true as const, bal: balanceOf(c.accountId) };
      if (doors) pending.put(c.accountId, GAME, 'vault', t.txnId, JSON.stringify({ m: p.m, bet, doors } satisfies VaultData));
      if (potWin > 0) {
        const seed = api.wallet.transfer('pot_seed', POT_SCOPE, 'system', 'ps:' + c.accountId + ':' + p.id, [
          { account: 'house', delta: -POT_SEED },
          { account: potAccount(POT_SCOPE), delta: POT_SEED },
        ]);
        if (!seed.ok) throw new Error('glimmer: pot seed refused');
        api.wallet.potWon(POT_SCOPE, c.accountId, potWin, clock.now());
        api.stats.add(c.accountId, GAME, 'pot.wins', 1);
        api.stats.max(c.accountId, GAME, 'pot.best', potWin);
      }
      stat(c.accountId, p.m, bet, win + potWin, 1, bet);
      return ack;
    }, (ack) => afterSpin(seat, p.m, bet, ack));
  };

  /** Feed and pot bookkeeping once a spin committed. */
  const afterSpin = (seat: Seat, m: MachineIdx, bet: number, ack: SpinOk | Refused | { ok: true; settled: true; bal: number }): void => {
    if (!ack.ok || !('st' in ack)) return;
    if (seat.machine !== m) {
      seat.machine = m;
      entry(seat, [seat.slot, m, 0, 0, FEED_KIND.machine]);
      const hall = seat.hall ? halls.get(seat.hall) : undefined;
      if (hall) memberDelta(hall, seat, false);
    }
    if (ack.pt) {
      entry(seat, [seat.slot, m, bet, ack.pt, FEED_KIND.pot]);
      const hall = seat.hall ? halls.get(seat.hall) : undefined;
      if (hall) {
        hall.potWon = { amt: ack.pt, at: clock.now() };
        api.hub.activityChanged(hall.ch);
      }
    }
    if (!ack.v) notable(seat, m, bet, ack.w + (ack.f?.w ?? 0), ack.f !== undefined);
    markPot();
  };

  const pick = (c: CallerCtx, p: { door: 0 | 1 | 2; id: string }): PickOk | Refused | { ok: true; settled: true; bal: number } => {
    const seat = own(c);
    if ('ok' in seat) return seat;
    if (!isSpinId(p.id)) return refuse('invalid');
    let total = 0;
    let vault: VaultData | null = null;
    const out = txSpin(
      () => {
        const idem = 'g:' + p.id;
        const probe = api.wallet.transfer('feature', 'glimmer:embervault', c.accountId, idem, []);
        if (probe.ok && probe.dup) return probe.receipt ? (JSON.parse(probe.receipt) as PickOk) : { ok: true as const, settled: true as const, bal: balanceOf(c.accountId) };
        vault = parseVault(pending.get(c.accountId, GAME));
        if (!vault) return refuse('state');
        const res = openVaultFor(c.accountId, vault, p.door, idem, p.id);
        total = res.total;
        return res.ack;
      },
      () => undefined,
    );
    if (out.ok && 'dr' in out && vault) {
      const v = vault as VaultData;
      notable(seat, v.m, v.bet, total, true);
    }
    return out;
  };

  /** Opens a pending vault (inside a transaction): Forge Spins credited as a `feature` txn, the row removed. */
  const openVaultFor = (accountId: string, vault: VaultData, door: 0 | 1 | 2, idem: string, id: string): { ack: PickOk; total: number } => {
    const def = machineDef(vault.m);
    const f = openVault(def, vault.bet, rng, vault.doors, door);
    const bal = balanceOf(accountId) + f.win;
    const ack: PickOk = { ok: true, id, dr: vault.doors.slice(), f: wireFeature('vault', f) as Extract<WireFeature, { k: 'v' }>, bal };
    const t = api.wallet.transfer('feature', 'glimmer:' + def.code, accountId, idem, legs(accountId, f.win, 0), { receipt: JSON.stringify(ack) });
    if (!t.ok) throw new SpinRefused(t.code);
    pending.remove(accountId, GAME);
    // The feature total includes the key pay already credited with the base spin.
    const total = f.win + scatterPayX(def) * vault.bet;
    const x = Math.floor((total * 100) / vault.bet);
    if (f.win > 0) api.stats.add(accountId, GAME, def.code + '.won', f.win);
    api.stats.max(accountId, GAME, def.code + '.best', total);
    api.stats.max(accountId, GAME, def.code + '.bestx', x);
    api.stats.max(accountId, GAME, 'best', total);
    api.stats.max(accountId, GAME, 'bestx', x);
    return { ack, total };
  };

  /** Pending vaults older than 24 h open themselves (a random door), so value is never held hostage. */
  const autoPick = (accountId: string | null): number => {
    const due = pending.olderThan(GAME, VAULT_AUTO_PICK_MS).filter((r) => accountId === null || r.accountId === accountId);
    let n = 0;
    for (const row of due) {
      const vault = parseVault(row);
      if (!vault) {
        pending.remove(row.accountId, GAME);
        continue;
      }
      try {
        api.wallet.tx(() => openVaultFor(row.accountId, vault, rng(3) as 0 | 1 | 2, 'gauto:' + row.txnId, ''));
        n += 1;
      } catch (err) {
        api.log.error({ err, accountId: row.accountId }, '[glimmer] vault auto-pick failed');
      }
    }
    return n;
  };

  const pickAll = (): number => {
    let n = 0;
    for (const row of pending.olderThan(GAME, -1)) {
      const vault = parseVault(row);
      if (!vault) continue;
      try {
        api.wallet.tx(() => openVaultFor(row.accountId, vault, rng(3) as 0 | 1 | 2, 'gauto:' + row.txnId, ''));
        n += 1;
      } catch (err) {
        api.log.error({ err }, '[glimmer] vault pick on disable failed');
      }
    }
    return n;
  };

  const resume = (c: CallerCtx, p: { id: string }): unknown => {
    const seat = own(c);
    if ('ok' in seat) return seat;
    if (!isSpinId(p.id)) return refuse('invalid');
    const probe = api.wallet.transfer('spin', 'glimmer:resume', c.accountId, 'g:' + p.id, []);
    const bal = balanceOf(c.accountId);
    if (probe.ok && probe.dup) return probe.receipt ? JSON.parse(probe.receipt) : { ok: true, settled: true, bal };
    return { ok: true, found: false, bal };
  };

  // ---------------------------------------------------------------- enter, leave, away, react

  /**
   * The pot starts at the seed, as it does after every win; the 1.5 % return (glimmerhall.md §4.1)
   * counts on it. Once per database: the txn's key is fixed, and a pot that was ever won is reseeded.
   */
  let potChecked = false;
  const seedFirstPot = (): void => {
    if (potChecked) return;
    potChecked = true;
    if (api.wallet.pot(POT_SCOPE).last) return;
    const t = api.wallet.transfer('pot_seed', POT_SCOPE, 'system', 'ps:first', [
      { account: 'house', delta: -POT_SEED },
      { account: potAccount(POT_SCOPE), delta: POT_SEED },
    ]);
    if (!t.ok) api.log.error({ code: t.code }, '[glimmer] first pot seed refused');
  };

  const enter = (c: CallerCtx, p: { ch: string | null; v: number }): EnterOk | Refused => {
    if (p.v !== DEFS.glimmer) return refuse('update');
    if (!enabled()) return refuse('disabled');
    if (api.prefs.hidden(c.accountId, GAME)) return refuse('hidden');
    seedFirstPot();
    autoPick(c.accountId);
    let seat = seats.get(c.accountId);
    const now = clock.now();
    if (seat && seat.socketId !== c.socketId) {
      api.emit(seat.socketId, 'glimmer:moved', {}, { queue: 'glimmer' });
      seat.socketId = c.socketId;
      seat.queued = null;
    }
    if (!seat) {
      seat = { accountId: c.accountId, socketId: c.socketId, hall: null, slot: -1, machine: 1, away: false, awayShown: false, awayShownAt: -1e12, awayTimer: null, lastInputAt: now, lastReactAt: -1e12, potSent: null, lw: 0, lx: 0, dropTimer: null, feed: emptyPending(), queued: null, sentAt: -1e12 };
      seats.set(c.accountId, seat);
    }
    if (seat.dropTimer !== null) clock.clearTimeout(seat.dropTimer);
    seat.dropTimer = null;
    seat.lastInputAt = now;
    const wanted = p.ch && c.voiceChannelId === p.ch && api.presence.isVoiceMember(c.accountId, p.ch) ? p.ch : null;
    if (seat.hall && seat.hall !== wanted) leaveHall(seat);
    if (wanted && !seat.hall && !joinHall(seat, wanted)) return refuse('full');
    const hall = seat.hall ? halls.get(seat.hall) : undefined;
    if (seat.away) {
      seat.away = false;
      showAway(seat);
    }
    // A fresh snapshot replaces whatever was waiting for this member.
    seat.feed = emptyPending();
    seat.queued = null;
    const pot = api.wallet.pot(POT_SCOPE).pool;
    seat.potSent = pot;
    const view = api.wallet.view(c.accountId);
    const ack: EnterOk = { ok: true, bal: view.bal, pot, me: hall ? seat.slot : -1, maxBet: settings().slotsMaxBet, mem: memberRows(hall) };
    const vault = parseVault(pending.get(c.accountId, GAME));
    if (vault) ack.pend = { m: vault.m, bet: vault.bet };
    const d = hall ? dashes.viewFor(hall.ch) : null;
    if (d) ack.dash = d;
    return ack;
  };

  const leave = (c: CallerCtx): { ok: true } => {
    const seat = seats.get(c.accountId);
    if (seat && seat.socketId === c.socketId) dropSeat(seat);
    return { ok: true };
  };

  const away = (c: CallerCtx): void => {
    const seat = seats.get(c.accountId);
    if (!seat || seat.socketId !== c.socketId || seat.away) return;
    seat.away = true;
    seat.feed = emptyPending();
    seat.queued = null;
    showAway(seat);
  };

  const react = (c: CallerCtx, p: { to: number; e: number }): void => {
    const seat = seats.get(c.accountId);
    if (!seat || seat.socketId !== c.socketId || !seat.hall) return;
    const now = clock.now();
    if (now - seat.lastReactAt < REACT_GAP_MS) return;
    const hall = halls.get(seat.hall);
    if (!hall || hall.slots[p.to] === null || hall.slots[p.to] === undefined) return;
    seat.lastReactAt = now;
    seat.lastInputAt = now;
    toHall(hall, (f) => {
      f.r.push([seat.slot, p.to, p.e]);
      if (f.r.length > 16) f.r.splice(0, f.r.length - 16);
    }, seat.accountId);
  };

  // ---------------------------------------------------------------- Dash

  const dashes: Dashes = createDashes({
    api,
    rng,
    hallOf: (ch) => halls.get(ch) ?? null,
    seatOf: (accountId) => seats.get(accountId) ?? null,
    pushDash: (ch, view) => {
      const hall = halls.get(ch);
      if (hall)
        toHall(hall, (p) => {
          p.d = view;
        });
    },
  });

  // ---------------------------------------------------------------- handlers

  const spinSchema = z.object({ m: machineSchema, b: z.number().int().min(1).max(100_000), id: idSchema });
  api.on('glimmer:enter', { schema: z.object({ ch: z.string().min(1).max(64).nullable(), v: z.number().int() }), limiter: 'arcade', acked: true }, enter);
  api.on('glimmer:leave', { schema: z.object({}).passthrough(), limiter: 'arcade', acked: true }, (c) => leave(c));
  api.on('glimmer:spin', { schema: spinSchema, limiter: 'spin', acked: true }, spin);
  api.on('glimmer:pick', { schema: z.object({ door: z.union([z.literal(0), z.literal(1), z.literal(2)]), id: idSchema }), limiter: 'spin', acked: true }, pick);
  api.on('glimmer:resume', { schema: z.object({ id: idSchema }), limiter: 'arcade', acked: true }, resume);
  // Away and reactions are acknowledged with a bare {ok: true}: the client's TableHost only has
  // request(), and an unanswered request would time out and count in the app's ack round-trip ring.
  api.on('glimmer:away', { schema: z.object({}).passthrough(), limiter: 'arcade', acked: true }, (c) => {
    away(c);
    return { ok: true };
  });
  api.on('glimmer:react', { schema: z.object({ to: z.number().int().min(0).max(63), e: z.number().int().min(0).max(EMOTES.length - 1) }), limiter: 'arcade', acked: true }, (c, p) => {
    react(c, p);
    return { ok: true };
  });
  api.on('glimmer:dash:create', { schema: z.object({ m: machineSchema, len: z.number().int(), buy: z.number().int() }), limiter: 'arcade', acked: true }, (c, p) => dashes.create(c, p));
  api.on('glimmer:dash:join', { schema: z.object({ id: z.string().min(1).max(16) }), limiter: 'arcade', acked: true }, (c, p) => dashes.join(c, p.id));
  api.on('glimmer:dash:leave', { schema: z.object({ id: z.string().min(1).max(16) }), limiter: 'arcade', acked: true }, (c, p) => dashes.leave(c, p.id));
  api.on('glimmer:dash:start', { schema: z.object({ id: z.string().min(1).max(16) }), limiter: 'arcade', acked: true }, (c, p) => dashes.start(c, p.id));
  api.on('glimmer:dash:spin', { schema: z.object({ d: z.string().min(1).max(16), id: idSchema }), limiter: 'spin', acked: true }, (c, p) => {
    const seat = own(c);
    if ('ok' in seat) return seat;
    return dashes.spin(c, p.d, p.id);
  });

  const closeAll = (reason: string): void => {
    for (const hall of halls.values()) {
      for (const seat of hall.members.values()) api.emit(seat.socketId, 'glimmer:closed', { r: reason }, { queue: 'glimmer' });
      if (hall.flushTimer !== null) clock.clearTimeout(hall.flushTimer);
      api.hub.activityChanged(hall.ch);
    }
    halls.clear();
    for (const seat of seats.values()) clearSeatTimers(seat);
    seats.clear();
  };

  return {
    lobby: {
      onCreate(c) {
        if (!enabled()) return refuse('disabled');
        if (!c.voiceChannelId) return refuse('not-in-voice');
        // One hall per voice channel: open the one that is there.
        if (liveLobby(c.voiceChannelId)) return refuse('exists');
        return { ok: true };
      },
      onCreated(c, record) {
        lobbyOf.set(record.channelId, record.id);
        // Live at once: the stage opens for whoever creates or joins the hall.
        api.hub.update(record.id, { state: 'live' });
        syncSeats(record.channelId, c.accountId, null);
      },
      onJoin(_c, _lobby, as) {
        return as === 'spectator' ? refuse('no-spectators') : { ok: true };
      },
      onLeave(c, lobby) {
        const seat = seats.get(c.accountId);
        if (seat && seat.hall === lobby.channelId) leaveHall(seat);
      },
      onStart() {
        return { ok: true };
      },
    },
    onAway() {},
    onBack() {},
    onVoiceLeft(accountId, channelId) {
      const seat = seats.get(accountId);
      if (seat && seat.hall === channelId) leaveHall(seat);
    },
    onSocketGone(accountId, socketId) {
      const seat = seats.get(accountId);
      if (!seat || seat.socketId !== socketId || seat.dropTimer !== null) return;
      seat.dropTimer = clock.setTimeout(() => {
        seat.dropTimer = null;
        if (seats.get(accountId) === seat && seat.socketId === socketId) dropSeat(seat);
      }, SEAT_DROP_MS);
    },
    onRestarting() {
      dashes.voidAll('restart-refund');
      // The void Dash views go out first, then the halls close (clients re-enter after reconnecting).
      for (const hall of halls.values()) for (const seat of hall.members.values()) if (!seat.away && !pendingEmpty(seat.feed)) sendFeed(seat, hall);
      for (const hall of halls.values()) if (hall.flushTimer !== null) clock.clearTimeout(hall.flushTimer);
      halls.clear();
      for (const seat of seats.values()) clearSeatTimers(seat);
      seats.clear();
    },
    onBoot() {
      const refunded = api.wallet.refund('dash:', 'restart-refund');
      if (refunded > 0) api.log.info({ refunded }, '[glimmer] refunded leftover Dash buy-ins');
      seedFirstPot();
      autoPick(null);
    },
    daily() {
      autoPick(null);
    },
    onDisable() {
      dashes.voidAll('refund');
      pickAll();
      closeAll('disabled');
    },
    activity(channelId): readonly ActivityEntry[] {
      const hall = halls.get(channelId);
      if (!hall || hall.members.size === 0) return [];
      // 'dash' while a Dash forms or runs; the sheet and chip still offer Open, since the hall stays open.
      const e: ActivityEntry = { g: GAME, id: liveLobby(channelId)?.id ?? 'hall:' + channelId, st: dashes.live(channelId) ? 'dash' : 'open', n: hall.members.size, max: maxMembers(), w: 0 };
      if (hall.potWon && clock.now() - hall.potWon.at < POT_CHIP_MS) e.j = { amt: hall.potWon.amt };
      return [e];
    },
    stop() {
      stopped = true;
      dashes.stop();
      for (const hall of halls.values()) if (hall.flushTimer !== null) clock.clearTimeout(hall.flushTimer);
      for (const seat of seats.values()) clearSeatTimers(seat);
    },
    debug: { seats, halls, dashes, pending },
  };
};

const glimmer: TableGameDef = {
  game: GAME,
  proto: DEFS.glimmer,
  modes: ['hall', 'dash'],
  cfgSchema: null,
  settings: {
    schema: SETTINGS,
    defaults: SETTINGS_DEFAULTS,
    fields: [{ key: 'slotsMaxBet', label: 'Highest slots bet', help: 'Bet steps above this are hidden and refused (5 to 500 chips).', kind: 'number', min: 5, max: 500, step: 5 }],
  },
  boards: [statBoard(GAME, 'bestx', 'bestx', 'Glimmerhall best win (× bet)'), statBoard(GAME, 'best', 'best', 'Glimmerhall best win (chips)'), statBoard(GAME, 'dash.wins', 'dash', 'Glimmer Dash wins')],
  start: (api) => startGlimmer(api),
};

export default glimmer;

export type { DashView };
