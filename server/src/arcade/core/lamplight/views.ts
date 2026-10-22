/**
 * Serializers and the client mirror (lamplight.md §6, §7.2). These are the only functions that
 * produce anything sent to a client: `publicEvent` for the table room, `holeEvent` for one owner's
 * `acct:` room, and `snapFor` for a joiner. A view never carries another seat's hole cards unless
 * they were turned face up, and never the deck.
 *
 * `applyEvent` is the mirror: it replays wire events on a view with the shared engine, so the client
 * computes turns, pots, refunds and legal actions itself and no "legal actions" or pot messages are
 * needed. A view is a `TableState` with an empty deck.
 */
import type { Card } from './cards.js';
import {
  applyAction,
  beginHand,
  FL,
  nextStreet,
  type ActKind,
  type BlindLevel,
  type EngineEvent,
  type Format,
  type HandState,
  type PostChoice,
  type Seat,
  type SeatStatus,
  type Street,
  type TableConfig,
  type TableState,
  type Tier,
} from './engine.js';

/** Seat status on the wire. */
export const ST_CODE: Readonly<Record<SeatStatus, string>> = { empty: 'e', waiting: 'w', active: 'a', sittingOut: 'o', busted: 'x' };
const ST_FROM: Readonly<Record<string, SeatStatus>> = { e: 'empty', w: 'waiting', a: 'active', o: 'sittingOut', x: 'busted' };
export const statusFrom = (code: unknown): SeatStatus | null => (typeof code === 'string' ? (ST_FROM[code] ?? null) : null);

/** Wire event names without the `lamplight:` prefix, by engine event. */
export const WIRE_NAME: Readonly<Record<EngineEvent['ev'], string>> = {
  hand: 'lamplight:hand',
  act: 'lamplight:act',
  street: 'lamplight:street',
  bank: 'lamplight:bank',
  show: 'lamplight:show',
  end: 'lamplight:end',
  seat: 'lamplight:seat',
  level: 'lamplight:level',
  trio: 'lamplight:trio',
  cupEnd: 'lamplight:cupEnd',
};

export interface WireOut {
  name: string;
  data: Record<string, unknown>;
  /** Absolute deadline to stamp as `ms` when the event leaves the queue; null when the event has no clock. */
  dl: number | null;
}

/** The public form of an engine event for the table room. `ms` is added at send time from `dl`. */
export const publicEvent = (e: EngineEvent, t: string): WireOut => {
  const name = WIRE_NAME[e.ev];
  switch (e.ev) {
    case 'hand': {
      const data: Record<string, unknown> = { t, q: e.q, no: e.no, btn: e.btn, sb: e.sb, bb: e.bb, lv: e.lv, stk: e.stk, n: e.n };
      if (e.xb.length > 0) data.xb = e.xb;
      return { name, data, dl: e.n >= 0 ? e.dl : null };
    }
    case 'act': {
      const data: Record<string, unknown> = { t, q: e.q, s: e.s, k: e.k, a: e.a, st: e.st, cb: e.cb, mr: e.mr, n: e.n };
      if (e.to) data.to = 1;
      return { name, data, dl: e.n >= 0 ? e.dl : null };
    }
    case 'street':
      return { name, data: { t, q: e.q, st: e.st, c: e.c, n: e.n }, dl: e.n >= 0 ? e.dl : null };
    case 'bank': {
      const data: Record<string, unknown> = { t, q: e.q, s: e.s };
      if (e.b) data.b = 1;
      return { name, data, dl: e.dl };
    }
    case 'show': {
      const data: Record<string, unknown> = { t, q: e.q, rv: e.rv };
      if (e.pots) data.pots = e.pots;
      return { name, data, dl: null };
    }
    case 'end': {
      const data: Record<string, unknown> = { t, q: e.q, stk: e.stk, next: e.next };
      if (e.void) data.void = e.void;
      return { name, data, dl: null };
    }
    case 'seat': {
      const data: Record<string, unknown> = { t, q: e.q, s: e.s, st: ST_CODE[e.st], stk: e.stk, tb: e.tb, fl: e.fl };
      if (e.a) data.a = e.a;
      else if (e.b) data.b = e.b;
      return { name, data, dl: null };
    }
    case 'level':
      return { name, data: { t, q: e.q, i: e.i, sb: e.sb, bb: e.bb, an: e.an, ends: e.ends }, dl: null };
    case 'trio':
      return { name, data: { t, q: e.q, mult: e.mult, pool: e.pool, pay: e.pay }, dl: null };
    case 'cupEnd':
      return { name, data: { t, q: e.q, places: e.places }, dl: null };
  }
};

/** `ms` from an absolute deadline at send time. */
export const stampMs = (data: Record<string, unknown>, dl: number | null, sentAt: number): Record<string, unknown> =>
  dl === null ? data : { ...data, ms: Math.max(0, Math.round(dl - sentAt)) };

/** The private `hole` event for the seat's owner (salts are added by the server). */
export const holeEvent = (state: TableState, seat: number, t: string): { t: string; no: number; c: [Card, Card] } | null => {
  const s = state.seats[seat];
  if (!state.hand || !s?.hole) return null;
  return { t, no: state.hand.handNo, c: [s.hole[0], s.hole[1]] };
};

// ------------------------------------------------------------------------------------------------
// Views and snaps
// ------------------------------------------------------------------------------------------------

const copySeat = (s: Seat, own: boolean): Seat => ({
  ...s,
  player: s.player ? { ...s.player } : null,
  hole: s.hole && (own || s.shown) ? [s.hole[0], s.hole[1]] : null,
});

/**
 * A fresh copy of the table as `seat` may see it (null: a spectator): no deck, no other seat's
 * hole cards unless shown. Bots decide from this, never from the table state.
 */
export const viewFor = (state: TableState, seat: number | null): TableState => {
  const hand = state.hand;
  return {
    id: state.id,
    config: { ...state.config },
    seats: state.seats.map((s) => copySeat(s, s.seat === seat)),
    hand: hand
      ? {
          ...hand,
          board: hand.board.slice(),
          deck: [],
          deckPos: hand.deckPos,
          pots: hand.pots.map((p) => ({ amount: p.amount, eligible: p.eligible.slice() })),
          extraBB: hand.extraBB.slice(),
          log: hand.log.map((l) => [l[0], l[1], l[2], l[3]] as [number, number, ActKind, number]),
        }
      : null,
    q: state.q,
    level: { ...state.level },
    handsPlayed: state.handsPlayed,
    lastBB: state.lastBB,
    prizePool: state.prizePool,
    multiplier: state.multiplier,
  };
};

export interface WireSeat {
  n: number;
  a?: string;
  b?: string;
  st: string;
  stk: number;
  sb: number;
  tot: number;
  /** actedAt, or −1. */
  ac: number;
  tb: number;
  fl: number;
  /** Face-up cards (shown this hand), or own cards in `hole`. */
  c?: [Card, Card];
}

export interface WireSnap {
  t: string;
  q: number;
  cfg: { f: Format; tier: Tier | null; seats: number; act: number; tb: number; tba: number; tbm: number; bi: [number, number]; bots: TableConfig['bots'] };
  lv: { i: number; sb: number; bb: number; an: number; ends: number | null };
  me: number | null;
  hp: number;
  lbb: number | null;
  seats: WireSeat[];
  h: {
    no: number;
    btn: number;
    sb: number;
    bb: number;
    st: Street;
    board: Card[];
    cb: number;
    lfr: number;
    la: number;
    toAct: number;
    tq: number;
    bk: number;
    xb: number[];
    ro: number;
    pend: 'street' | 'showdown' | null;
    ms?: number;
  } | null;
  hole?: [Card, Card];
  pool?: number;
  mult?: number;
}

/** A full snap for a joiner (`me` is their seat, or null for a spectator). `ms` is relative to `now`. */
export const snapFor = (state: TableState, me: number | null, t: string, now: number): WireSnap => {
  const hand = state.hand;
  const c = state.config;
  const seats: WireSeat[] = [];
  for (const s of state.seats) {
    if (s.status === 'empty') continue;
    const w: WireSeat = { n: s.seat, st: ST_CODE[s.status], stk: s.stack, sb: s.streetBet, tot: s.totalBet, ac: s.actedAt ?? -1, tb: s.timeBankMs, fl: seatFlagsOf(s) };
    if (s.player?.accountId) w.a = s.player.accountId;
    else if (s.player?.botId) w.b = s.player.botId;
    if (s.shown && s.hole) w.c = [s.hole[0], s.hole[1]];
    seats.push(w);
  }
  const snap: WireSnap = {
    t,
    q: state.q,
    cfg: { f: c.format, tier: c.tier, seats: c.seats, act: c.actionMs, tb: c.timeBankMs, tba: c.timeBankAddMs, tbm: c.timeBankMaxMs, bi: [c.buyInMin, c.buyInMax], bots: c.bots },
    lv: { i: state.level.index, sb: state.level.sb, bb: state.level.bb, an: state.level.ante, ends: state.level.endsAt ?? state.level.endsAfterHand },
    me,
    hp: state.handsPlayed,
    lbb: state.lastBB,
    seats,
    h: hand
      ? {
          no: hand.handNo,
          btn: hand.button,
          sb: hand.sbSeat,
          bb: hand.bbSeat,
          st: hand.street,
          board: hand.board.slice(),
          cb: hand.currentBet,
          lfr: hand.lastFullRaise,
          la: hand.lastAggressor ?? -1,
          toAct: hand.toAct,
          tq: hand.turnQ,
          bk: hand.bank ? 1 : 0,
          xb: hand.extraBB.slice(),
          ro: hand.runout ? 1 : 0,
          pend: hand.pending,
        }
      : null,
  };
  if (snap.h && hand && hand.toAct >= 0) snap.h.ms = Math.max(0, Math.round(hand.deadline - now));
  const own = me !== null ? state.seats[me] : null;
  if (own?.hole && own.inHand) snap.hole = [own.hole[0], own.hole[1]];
  if (state.prizePool !== undefined) snap.pool = state.prizePool;
  if (state.multiplier !== undefined) snap.mult = state.multiplier;
  return snap;
};

const seatFlagsOf = (s: Seat): number =>
  (s.connected ? FL.connected : 0) |
  (s.missedBB ? FL.missedBB : 0) |
  (s.post === 'now' ? FL.postNow : 0) |
  (s.inHand ? FL.inHand : 0) |
  (s.folded ? FL.folded : 0) |
  (s.allIn ? FL.allIn : 0) |
  (s.shown ? FL.shown : 0) |
  (s.actedAt !== null ? FL.acted : 0);

const blankSeat = (n: number): Seat => ({
  seat: n,
  player: null,
  status: 'empty',
  stack: 0,
  inHand: false,
  folded: false,
  allIn: false,
  streetBet: 0,
  totalBet: 0,
  actedAt: null,
  timeBankMs: 0,
  timeouts: 0,
  connected: true,
  missedBB: false,
  post: null,
  hole: null,
  shown: false,
  startStack: 0,
});

const hashSeed = (id: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
};

const levelFrom = (lv: { i: number; sb: number; bb: number; an: number; ends: number | null }, format: Format): BlindLevel => ({
  index: lv.i,
  sb: lv.sb,
  bb: lv.bb,
  ante: lv.an,
  endsAt: format === 'open' ? null : lv.ends,
  endsAfterHand: null,
});

/** A view from a snap; `now` is the device clock the deadline is measured against. */
export const fromSnap = (snap: WireSnap, now: number): TableState => {
  const config: TableConfig = {
    format: snap.cfg.f,
    tier: snap.cfg.tier,
    seats: snap.cfg.seats,
    buyInMin: snap.cfg.bi[0],
    buyInMax: snap.cfg.bi[1],
    actionMs: snap.cfg.act,
    timeBankMs: snap.cfg.tb,
    timeBankAddMs: snap.cfg.tba,
    timeBankMaxMs: snap.cfg.tbm,
    bots: snap.cfg.bots,
  };
  const seats: Seat[] = [];
  for (let n = 0; n < config.seats; n++) seats.push(blankSeat(n));
  for (const w of snap.seats) {
    const s = seats[w.n];
    if (!s) continue;
    const id = w.a ?? w.b ?? null;
    s.player = id ? { accountId: w.a ?? null, botId: w.b ?? null, avatarSeed: hashSeed(id) } : null;
    s.status = statusFrom(w.st) ?? 'active';
    s.stack = w.stk;
    s.streetBet = w.sb;
    s.totalBet = w.tot;
    s.actedAt = w.ac >= 0 ? w.ac : null;
    s.timeBankMs = w.tb;
    applyFlags(s, w.fl, true);
    s.startStack = w.stk + w.tot;
    if (w.c) s.hole = [w.c[0], w.c[1]];
  }
  if (snap.me !== null && snap.hole && seats[snap.me]) seats[snap.me].hole = [snap.hole[0], snap.hole[1]];
  const h = snap.h;
  const hand: HandState | null = h
    ? {
        handNo: h.no,
        button: h.btn,
        sbSeat: h.sb,
        bbSeat: h.bb,
        street: h.st,
        board: h.board.slice(),
        currentBet: h.cb,
        lastFullRaise: h.lfr,
        lastAggressor: h.la >= 0 ? h.la : null,
        toAct: h.toAct,
        turnQ: h.tq,
        deadline: now + (h.ms ?? 0),
        bank: h.bk === 1,
        bankStart: now,
        pots: [],
        deck: [],
        deckPos: 0,
        extraBB: h.xb.slice(),
        pending: h.pend,
        runout: h.ro === 1,
        uncontested: false,
        showable: -1,
        log: [],
      }
    : null;
  return {
    id: snap.t,
    config,
    seats,
    hand,
    q: snap.q,
    level: levelFrom(snap.lv, config.format),
    handsPlayed: snap.hp,
    lastBB: snap.lbb,
    prizePool: snap.pool,
    multiplier: snap.mult,
  };
};

const applyFlags = (s: Seat, fl: number, inHandToo: boolean): void => {
  s.connected = (fl & FL.connected) !== 0;
  s.missedBB = (fl & FL.missedBB) !== 0;
  s.post = (fl & FL.postNow) !== 0 ? 'now' : s.status === 'waiting' ? ('wait' as PostChoice) : null;
  if (!inHandToo) return;
  s.inHand = (fl & FL.inHand) !== 0;
  s.folded = (fl & FL.folded) !== 0;
  s.allIn = (fl & FL.allIn) !== 0;
  s.shown = (fl & FL.shown) !== 0;
};

// ------------------------------------------------------------------------------------------------
// The mirror
// ------------------------------------------------------------------------------------------------

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map((x) => num(x)) : []);
const isCardPair = (v: unknown): v is [Card, Card] => Array.isArray(v) && v.length === 2 && v.every((x) => Number.isInteger(x) && x >= 0 && x < 52);

/**
 * Apply one wire event (by name) to a view. `now` is the device clock (deadlines are `now + ms`,
 * with the caller's link correction already taken off `ms`). Returns false when the event does not
 * fit the view (the caller then asks for a sync).
 */
export const applyEvent = (view: TableState, name: string, d: Record<string, unknown>, now: number, me: number | null = null): boolean => {
  const q = num(d.q, -1);
  const hand = view.hand;
  const deadline = (): number => now + num(d.ms);
  switch (name) {
    case 'lamplight:hand': {
      const stk = nums(d.stk);
      if (stk.length !== view.seats.length) return false;
      beginHand(view, { no: num(d.no), button: num(d.btn), sb: num(d.sb), bb: num(d.bb), stk, extraBB: nums(d.xb) }, [], now);
      const h = view.hand as HandState;
      if (h.toAct !== num(d.n, -1)) return false;
      h.deadline = deadline();
      h.turnQ = q;
      view.handsPlayed = num(d.no) - 1;
      break;
    }
    case 'lamplight:hole': {
      if (!hand || me === null || num(d.no) !== hand.handNo || !isCardPair(d.c)) return false;
      view.seats[me].hole = [d.c[0], d.c[1]];
      return true;
    }
    case 'lamplight:act': {
      if (!hand || hand.toAct !== num(d.s, -1)) return false;
      const k = d.k as ActKind;
      applyAction(view, num(d.s), k, num(d.a), now, null, d.to === 1);
      if (hand.toAct !== num(d.n, -1) || view.seats[num(d.s)].stack !== num(d.st, -1)) return false;
      if (hand.toAct >= 0) {
        hand.deadline = deadline();
        hand.turnQ = q;
      }
      break;
    }
    case 'lamplight:street': {
      if (!hand || hand.pending !== 'street') return false;
      nextStreet(view, d.st as Street, nums(d.c), now);
      if (hand.toAct !== num(d.n, -1)) return false;
      if (hand.toAct >= 0) {
        hand.deadline = deadline();
        hand.turnQ = q;
      }
      break;
    }
    case 'lamplight:bank': {
      if (!hand || hand.toAct !== num(d.s, -1)) return false;
      if (d.b === 1) {
        hand.bank = true;
        hand.bankStart = now;
      }
      hand.deadline = deadline();
      break;
    }
    case 'lamplight:show': {
      if (!hand) return false;
      if (Array.isArray(d.rv)) {
        for (const r of d.rv as { s: unknown; c: unknown }[]) {
          const s = view.seats[num(r.s, -1)];
          if (s && isCardPair(r.c)) {
            s.hole = [r.c[0], r.c[1]];
            s.shown = true;
          }
        }
      }
      if (Array.isArray(d.pots)) {
        hand.street = 'showdown';
        hand.pending = null;
        hand.toAct = -1;
      }
      break;
    }
    case 'lamplight:end': {
      const stk = nums(d.stk);
      if (stk.length !== view.seats.length) return false;
      view.seats.forEach((s, i) => {
        s.stack = stk[i];
        s.streetBet = 0;
        s.totalBet = 0;
      });
      if (hand) {
        hand.street = 'done';
        hand.pending = null;
        hand.toAct = -1;
        view.handsPlayed = hand.handNo;
        if (typeof d.void === 'string') for (const s of view.seats) s.inHand = false;
      }
      break;
    }
    case 'lamplight:seat': {
      const s = view.seats[num(d.s, -1)];
      if (!s) return false;
      const status = statusFrom(d.st) ?? 'active';
      if (status === 'empty') {
        Object.assign(s, blankSeat(s.seat));
        break;
      }
      const id = typeof d.a === 'string' ? d.a : typeof d.b === 'string' ? d.b : null;
      if (id && (s.player?.accountId ?? s.player?.botId) !== id) {
        Object.assign(s, blankSeat(s.seat));
        s.player = { accountId: typeof d.a === 'string' ? d.a : null, botId: typeof d.b === 'string' ? d.b : null, avatarSeed: hashSeed(id) };
      }
      s.status = status;
      s.stack = num(d.stk);
      s.timeBankMs = num(d.tb);
      applyFlags(s, num(d.fl), false);
      break;
    }
    case 'lamplight:level': {
      view.level = levelFrom({ i: num(d.i), sb: num(d.sb), bb: num(d.bb), an: num(d.an), ends: typeof d.ends === 'number' ? d.ends : null }, view.config.format);
      break;
    }
    case 'lamplight:trio': {
      view.multiplier = num(d.mult);
      view.prizePool = num(d.pool);
      break;
    }
    case 'lamplight:cupEnd':
      break;
    default:
      return false;
  }
  if (q >= 0) view.q = q;
  return true;
};
