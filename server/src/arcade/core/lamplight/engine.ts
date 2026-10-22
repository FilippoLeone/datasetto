/**
 * The no-limit Hold'em rules engine (lamplight.md §3, §6), shared by the server and the device.
 * It has no RNG and no clock: the host passes in the shuffled deck and `now`. The API mutates the
 * host's state in place and returns the public events, each numbered with the table's `q`.
 *
 * The same internals run on the client mirror (views.ts `applyEvent`): there the state is a view
 * with no deck and no hidden cards, and nothing is emitted. Both sides therefore compute blinds,
 * turns, street ends, uncalled refunds and pots with this one piece of code.
 */
import type { Card } from './cards.js';
import { eval7 } from './evaluate.js';

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'done';
export type SeatStatus = 'empty' | 'waiting' | 'active' | 'sittingOut' | 'busted';
export type Format = 'open' | 'cup' | 'trio';
export type Tier = 'pebble' | 'cobble' | 'boulder' | 'summit';
export type BotLevel = 'greenhorn' | 'regular' | 'sharp';
export type ActKind = 'f' | 'x' | 'c' | 'b' | 'r' | 'a';
export type PostChoice = 'now' | 'wait';

export const STREETS: readonly Street[] = ['preflop', 'flop', 'turn', 'river', 'showdown', 'done'];

/** Names are resolved from presence on display; bots by their id. */
export interface PlayerRef {
  accountId: string | null;
  botId: string | null;
  avatarSeed: number;
}

export interface Seat {
  seat: number;
  player: PlayerRef | null;
  status: SeatStatus;
  stack: number;
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  streetBet: number;
  totalBet: number;
  /** `currentBet` at this seat's last voluntary action on this street; null before it acts. Blinds are not actions. */
  actedAt: number | null;
  timeBankMs: number;
  /** Timeouts in a row; two mark the seat as sitting out. */
  timeouts: number;
  connected: boolean;
  /** Cash: the big blind passed this seat while it sat out. */
  missedBB: boolean;
  /** A waiting cash seat: post a big blind now, or wait for the big blind to reach it. */
  post: PostChoice | null;
  /** Host only (a view carries only its own, and shown hands). */
  hole: [Card, Card] | null;
  /** Turned face up this hand (runout or showdown). */
  shown: boolean;
  /** Stack when this hand started (before antes and blinds). */
  startStack: number;
}

export interface Pot {
  amount: number;
  eligible: number[];
}

export interface BlindLevel {
  index: number;
  sb: number;
  bb: number;
  ante: number;
  /** Online tournaments: wall time when this level ends. */
  endsAt: number | null;
  /** Offline tournaments: the hand count after which it ends. */
  endsAfterHand: number | null;
}

export interface TableConfig {
  format: Format;
  tier: Tier | null;
  seats: number;
  buyInMin: number;
  buyInMax: number;
  actionMs: number;
  timeBankMs: number;
  /** Cash: seconds added to every seated bank each 10 hands, up to `timeBankMaxMs`. */
  timeBankAddMs: number;
  timeBankMaxMs: number;
  bots: BotLevel | null;
}

/** One logged action: street index, seat, kind, and the seat's street total after it. */
export type LogEntry = [number, number, ActKind, number];

export interface HandState {
  handNo: number;
  button: number;
  sbSeat: number;
  bbSeat: number;
  street: Street;
  board: Card[];
  currentBet: number;
  lastFullRaise: number;
  /** Last bettor or raiser on this street. */
  lastAggressor: number | null;
  /** −1 when nobody is to act. */
  toAct: number;
  /** `q` of the event that gave `toAct` its turn. */
  turnQ: number;
  /** Absolute deadline of the current turn (host time online, device time on a view). */
  deadline: number;
  /** The time bank is running for `toAct`. */
  bank: boolean;
  bankStart: number;
  pots: Pot[];
  /** Host only; a view has []. */
  deck: Card[];
  deckPos: number;
  /** Seats that posted an extra big blind (late entry). */
  extraBB: number[];
  /** What the host must do next: deal a street, or the showdown. */
  pending: 'street' | 'showdown' | null;
  /** At most one seat can act: the remaining streets are dealt without betting. */
  runout: boolean;
  /** Won without a showdown. */
  uncontested: boolean;
  /** Seat that won uncontested and may still show (4 s). */
  showable: number;
  log: LogEntry[];
}

export interface TableState {
  id: string;
  config: TableConfig;
  seats: Seat[];
  hand: HandState | null;
  q: number;
  level: BlindLevel;
  handsPlayed: number;
  /** The big blind of the last hand, for rotation; null before the first hand. */
  lastBB: number | null;
  prizePool?: number;
  multiplier?: number;
}

export type Action = { kind: 'fold' | 'check' | 'call' | 'allin' } | { kind: 'bet' | 'raise'; to: number };

export type RefusalCode = 'not_your_turn' | 'stale' | 'illegal' | 'amount';
export type Result = { ok: true; events: EngineEvent[] } | { ok: false; code: RefusalCode };

/** Public event shapes (the wire payloads without the table id `t` and with `dl`, an absolute deadline, where the wire has `ms`). */
export type EngineEvent =
  | { ev: 'hand'; q: number; no: number; btn: number; sb: number; bb: number; lv: number; stk: number[]; xb: number[]; n: number; dl: number }
  | { ev: 'act'; q: number; s: number; k: ActKind; a: number; st: number; cb: number; mr: number; n: number; dl: number; to?: 1 }
  | { ev: 'street'; q: number; st: Street; c: Card[]; n: number; dl: number }
  | { ev: 'bank'; q: number; s: number; dl: number; b?: 1 }
  | { ev: 'show'; q: number; rv: { s: number; c: [Card, Card] }[]; pots?: { a: number; w: number[]; each: number }[] }
  | { ev: 'end'; q: number; stk: number[]; next: number; void?: string }
  | { ev: 'seat'; q: number; s: number; a: string | null; b: string | null; st: SeatStatus; stk: number; tb: number; fl: number }
  | { ev: 'level'; q: number; i: number; sb: number; bb: number; an: number; ends: number | null }
  | { ev: 'trio'; q: number; mult: number; pool: number; pay: number[] }
  | { ev: 'cupEnd'; q: number; places: { a: string | null; b: string | null; p: number; won: number }[] };

/** Pause before the next hand after a showdown with reveals, an uncontested win, or otherwise. */
export const NEXT_MS = { plain: 3000, uncontested: 4000, reveal: 5000 } as const;
/** All-in runout: the remaining streets come this far apart (0 in offline fast mode). */
export const RUNOUT_MS = 900;
/** An uncontested winner may show within this long. */
export const SHOW_MS = 4000;

/** Seat flag bits in `seat` events and snaps. */
export const FL = { connected: 1, missedBB: 2, postNow: 4, inHand: 8, folded: 16, allIn: 32, shown: 64, acted: 128 } as const;

// ------------------------------------------------------------------------------------------------
// Setup
// ------------------------------------------------------------------------------------------------

const emptySeat = (n: number): Seat => ({
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

export const createTable = (id: string, config: TableConfig, level: BlindLevel): TableState => {
  const seats: Seat[] = [];
  for (let n = 0; n < config.seats; n++) seats.push(emptySeat(n));
  return { id, config, seats, hand: null, q: 0, level, handsPlayed: 0, lastBB: null };
};

const isTournament = (state: TableState): boolean => state.config.format !== 'open';

type Sink = EngineEvent[] | null;

/** Number a public event and add it to the sink (the mirror passes null and numbers nothing). */
const push = <E extends EngineEvent>(state: TableState, sink: Sink, ev: E): E => {
  if (sink) {
    state.q += 1;
    ev.q = state.q;
    sink.push(ev);
  }
  return ev;
};

export const seatFlags = (s: Seat): number =>
  (s.connected ? FL.connected : 0) |
  (s.missedBB ? FL.missedBB : 0) |
  (s.post === 'now' ? FL.postNow : 0) |
  (s.inHand ? FL.inHand : 0) |
  (s.folded ? FL.folded : 0) |
  (s.allIn ? FL.allIn : 0) |
  (s.shown ? FL.shown : 0) |
  (s.actedAt !== null ? FL.acted : 0);

/** A `seat` event with the seat's current public state, added to `sink` (returned). */
export const seatEvent = (state: TableState, n: number, sink: EngineEvent[]): EngineEvent[] => {
  const s = state.seats[n];
  push(state, sink, {
    ev: 'seat',
    q: 0,
    s: n,
    a: s.player?.accountId ?? null,
    b: s.player?.botId ?? null,
    st: s.status,
    stk: s.stack,
    tb: s.timeBankMs,
    fl: seatFlags(s),
  });
  return sink;
};

/**
 * Sit a player down. Cash seats wait for their first hand (post a big blind now, or wait for the big
 * blind); tournament seats are active at once.
 */
export const seat = (state: TableState, n: number, player: PlayerRef, stack: number, post: PostChoice = 'wait'): EngineEvent[] => {
  const s = state.seats[n];
  Object.assign(s, emptySeat(n));
  s.player = player;
  s.stack = stack;
  s.timeBankMs = state.config.timeBankMs;
  s.status = isTournament(state) ? 'active' : 'waiting';
  s.post = isTournament(state) ? null : post;
  return seatEvent(state, n, []);
};

/** Empty a seat (the host folds a live hand first). Returns the chips the seat held. */
export const unseat = (state: TableState, n: number): { stack: number; events: EngineEvent[] } => {
  const s = state.seats[n];
  const stack = s.stack;
  Object.assign(s, emptySeat(n));
  return { stack, events: seatEvent(state, n, []) };
};

/** A change of a seat's status, connection, post choice or stack between hands; emits one `seat` event. */
export const updateSeat = (
  state: TableState,
  n: number,
  patch: Partial<Pick<Seat, 'status' | 'connected' | 'post' | 'missedBB' | 'stack' | 'timeBankMs'>>,
): EngineEvent[] => {
  Object.assign(state.seats[n], patch);
  return seatEvent(state, n, []);
};

/** A blind level change (the host reads levels from wall time or hand counts at each hand start). */
export const setLevel = (state: TableState, level: BlindLevel): EngineEvent[] => {
  state.level = level;
  const out: EngineEvent[] = [];
  push(state, out, { ev: 'level', q: 0, i: level.index, sb: level.sb, bb: level.bb, an: level.ante, ends: level.endsAt ?? level.endsAfterHand });
  return out;
};

// ------------------------------------------------------------------------------------------------
// Rotation and the start of a hand
// ------------------------------------------------------------------------------------------------

const nextWhere = (state: TableState, from: number, pred: (s: Seat) => boolean): number => {
  const n = state.seats.length;
  for (let i = 1; i <= n; i++) {
    const idx = (((from + i) % n) + n) % n;
    if (pred(state.seats[idx])) return idx;
  }
  return -1;
};

const prevWhere = (state: TableState, from: number, pred: (s: Seat) => boolean): number => {
  const n = state.seats.length;
  for (let i = 1; i <= n; i++) {
    const idx = (((from - i) % n) + n) % n;
    if (pred(state.seats[idx])) return idx;
  }
  return -1;
};

/** Seats that will be dealt into the next hand even if the big blind does not reach them. */
const dealable = (state: TableState, s: Seat): boolean => {
  if (!s.player || s.stack <= 0) return false;
  if (isTournament(state)) return s.status === 'active' || s.status === 'sittingOut';
  return s.status === 'active' || (s.status === 'waiting' && s.post === 'now');
};

/** Seats the big blind may land on: the dealable ones plus cash seats waiting for the big blind. */
const bbCandidate = (state: TableState, s: Seat): boolean =>
  dealable(state, s) || (!isTournament(state) && !!s.player && s.stack > 0 && s.status === 'waiting');

/** Can a hand start now? */
export const canStartHand = (state: TableState): boolean => {
  if (state.hand && state.hand.street !== 'done') return false;
  let n = 0;
  for (const s of state.seats) if (bbCandidate(state, s)) n++;
  return n >= 2;
};

export interface Positions {
  button: number;
  sb: number;
  bb: number;
  dealt: number[];
  extraBB: number[];
  /** Seats the big blind passed while they sat out. */
  missed: number[];
}

/** Where the button and blinds go this hand (the big blind moves forward one seat; no dead buttons). */
export const positions = (state: TableState, firstButton: number): Positions | null => {
  const cand = (s: Seat): boolean => bbCandidate(state, s);
  const deal = (s: Seat): boolean => dealable(state, s);
  let count = 0;
  for (const s of state.seats) if (cand(s)) count++;
  if (count < 2) return null;
  const inSet = new Array<boolean>(state.seats.length).fill(false);
  const missed: number[] = [];
  const lastBB = state.lastBB;
  // The big blind moves to the next seat that may take it (a waiting seat included).
  const nextBB = lastBB === null ? -1 : nextWhere(state, lastBB, cand);
  let fresh = lastBB === null;
  if (!fresh) {
    let dealt = 0;
    for (const s of state.seats) if (deal(s)) dealt++;
    // Fewer than two would play: deal every waiting seat in, as at a fresh table.
    if (dealt + (deal(state.seats[nextBB]) ? 0 : 1) < 2) fresh = true;
  }
  for (const s of state.seats) if (fresh ? cand(s) : deal(s)) inSet[s.seat] = true;
  const inHand = (s: Seat): boolean => inSet[s.seat];
  let button: number;
  let sb: number;
  let bb: number;
  if (lastBB === null) {
    button = inSet[firstButton] ? firstButton : nextWhere(state, firstButton, inHand);
    const dealtCount = inSet.filter(Boolean).length;
    sb = dealtCount === 2 ? button : nextWhere(state, button, inHand);
    bb = nextWhere(state, sb, inHand);
  } else {
    bb = nextBB;
    inSet[bb] = true;
    // The big blind skipped these seats while they sat out (cash): they owe a big blind.
    if (!isTournament(state)) {
      const n = state.seats.length;
      for (let i = 1; i < n; i++) {
        const idx = (lastBB + i) % n;
        if (idx === bb) break;
        const s = state.seats[idx];
        if (s.player && s.status === 'sittingOut' && s.stack > 0) missed.push(idx);
      }
    }
    const dealtCount = inSet.filter(Boolean).length;
    sb = prevWhere(state, bb, inHand);
    button = dealtCount === 2 ? sb : prevWhere(state, sb, inHand);
  }
  const dealt: number[] = [];
  // Deal order: from the seat left of the button, clockwise.
  for (let i = 1; i <= state.seats.length; i++) {
    const idx = (button + i) % state.seats.length;
    if (inSet[idx]) dealt.push(idx);
  }
  const extraBB: number[] = [];
  for (const idx of dealt) {
    const s = state.seats[idx];
    if (idx !== bb && idx !== sb && s.status === 'waiting' && s.post === 'now') extraBB.push(idx);
  }
  return { button, sb, bb, dealt, extraBB, missed };
};

const post = (s: Seat, amount: number): number => {
  const paid = Math.min(amount, s.stack);
  s.stack -= paid;
  s.streetBet += paid;
  s.totalBet += paid;
  if (s.stack === 0) s.allIn = true;
  return paid;
};

/**
 * Deal a hand: rotate the blinds, post antes and blinds, deal the hole cards from `deck` (two passes
 * from the seat left of the button; the board takes the next positions) and give the first seat its
 * turn. `firstButton` is used only for a table's first hand (the host draws it at random).
 */
export const startHand = (state: TableState, deck: readonly Card[], now: number, firstButton = 0): Result => {
  if (state.hand && state.hand.street !== 'done') return { ok: false, code: 'illegal' };
  const pos = positions(state, firstButton);
  if (!pos) return { ok: false, code: 'illegal' };
  const out: EngineEvent[] = [];
  for (const idx of pos.missed) {
    state.seats[idx].missedBB = true;
    seatEvent(state, idx, out);
  }
  const stk = state.seats.map((s) => (pos.dealt.includes(s.seat) ? s.stack : 0));
  const runout = beginHand(state, { no: state.handsPlayed + 1, button: pos.button, sb: pos.sb, bb: pos.bb, stk, extraBB: pos.extraBB }, deck, now);
  const hand = state.hand as HandState;
  const ev = push(state, out, {
    ev: 'hand',
    q: 0,
    no: hand.handNo,
    btn: pos.button,
    sb: pos.sb,
    bb: pos.bb,
    lv: state.level.index,
    stk,
    xb: pos.extraBB,
    n: hand.toAct,
    dl: hand.toAct >= 0 ? hand.deadline : 0,
  });
  hand.turnQ = ev.q;
  if (runout) revealLive(state, out);
  return { ok: true, events: out };
};

/**
 * Set up a hand from its positions and starting stacks (`stk[seat] > 0` means dealt in): reset the
 * seats, post antes and blinds, deal the hole cards when there is a deck, and give the first seat
 * its turn. The host's `startHand` and the client mirror's `hand` event both run this. Returns true
 * when the blinds alone put everyone all-in (a runout starts at once).
 */
export const beginHand = (
  state: TableState,
  p: { no: number; button: number; sb: number; bb: number; stk: readonly number[]; extraBB: readonly number[] },
  deck: readonly Card[],
  now: number,
): boolean => {
  const level = state.level;
  for (const s of state.seats) {
    s.inHand = (p.stk[s.seat] ?? 0) > 0;
    s.folded = false;
    s.allIn = false;
    s.streetBet = 0;
    s.totalBet = 0;
    s.actedAt = null;
    s.hole = null;
    s.shown = false;
    if (s.inHand) s.stack = p.stk[s.seat];
    s.startStack = s.stack;
    if (!s.inHand) continue;
    if (s.status === 'waiting') {
      s.status = 'active';
      s.post = null;
    }
    // A blind or a posted big blind settles a missed one.
    if (s.seat === p.bb || s.seat === p.sb || p.extraBB.includes(s.seat)) s.missedBB = false;
  }
  const hand: HandState = {
    handNo: p.no,
    button: p.button,
    sbSeat: p.sb,
    bbSeat: p.bb,
    street: 'preflop',
    board: [],
    currentBet: level.bb,
    lastFullRaise: level.bb,
    lastAggressor: null,
    toAct: -1,
    turnQ: 0,
    deadline: 0,
    bank: false,
    bankStart: 0,
    pots: [],
    deck: deck.slice(),
    deckPos: 0,
    extraBB: p.extraBB.slice(),
    pending: null,
    runout: false,
    uncontested: false,
    showable: -1,
    log: [],
  };
  state.hand = hand;
  state.lastBB = p.bb;
  // Hole cards in deal order: from the seat left of the button, two passes. The board follows.
  const order: number[] = [];
  for (let i = 1; i <= state.seats.length; i++) {
    const idx = (p.button + i) % state.seats.length;
    if (state.seats[idx].inHand) order.push(idx);
  }
  const n = order.length;
  if (hand.deck.length >= 2 * n + 5) {
    order.forEach((idx, i) => {
      state.seats[idx].hole = [hand.deck[i], hand.deck[n + i]];
    });
  }
  hand.deckPos = 2 * n;
  postBlinds(state);
  return settle(state, p.bb, now);
};

/** Deck position of each dealt card (hole cards by seat, then the board), for the deck proof. */
export const dealPositions = (state: TableState): { holes: Map<number, [number, number]>; board: number[] } => {
  const hand = state.hand as HandState;
  const order: number[] = [];
  for (let i = 1; i <= state.seats.length; i++) {
    const idx = (hand.button + i) % state.seats.length;
    if (state.seats[idx].inHand) order.push(idx);
  }
  const n = order.length;
  const holes = new Map<number, [number, number]>();
  order.forEach((idx, i) => holes.set(idx, [i, n + i]));
  const board: number[] = [];
  for (let i = 0; i < hand.board.length; i++) board.push(2 * n + i);
  return { holes, board };
};

/** Antes (dead money), small blind, big blind and posted big blinds. */
const postBlinds = (state: TableState): void => {
  const hand = state.hand as HandState;
  const level = state.level;
  if (level.ante > 0) {
    for (const s of state.seats) {
      if (!s.inHand) continue;
      const paid = Math.min(level.ante, s.stack);
      s.stack -= paid;
      s.totalBet += paid;
      if (s.stack === 0) s.allIn = true;
    }
  }
  const seats = state.seats;
  // Heads-up the button is the small blind; otherwise they differ.
  post(seats[hand.sbSeat], level.sb);
  post(seats[hand.bbSeat], level.bb);
  for (const idx of hand.extraBB) post(seats[idx], level.bb);
};

// ------------------------------------------------------------------------------------------------
// Betting
// ------------------------------------------------------------------------------------------------

const canAct = (s: Seat): boolean => s.inHand && !s.folded && !s.allIn;

const needsAct = (state: TableState, s: Seat): boolean => canAct(s) && (s.actedAt === null || s.streetBet < (state.hand as HandState).currentBet);

const nextToAct = (state: TableState, from: number): number => nextWhere(state, from, (s) => needsAct(state, s));

export interface Legal {
  toCall: number;
  /** Chips a call costs (a short call is all-in). */
  call: number;
  canCheck: boolean;
  /** A bet or raise is possible (betting is open to this seat and it has chips beyond a call). */
  canRaise: boolean;
  /** Smallest bet or raise target; equal to `maxTo` when only an all-in below the minimum is left. */
  minTo: number;
  /** Largest target: all-in. */
  maxTo: number;
  /** Chips in the middle, current street included. */
  pot: number;
  currentBet: number;
  bb: number;
}

export const potTotal = (state: TableState): number => {
  let pot = 0;
  for (const s of state.seats) pot += s.totalBet;
  return pot;
};

/** The legal options of the seat to act (works on a view too); null when it is not that seat's turn. */
export const legal = (state: TableState, n: number): Legal | null => {
  const hand = state.hand;
  if (!hand || hand.toAct !== n || hand.pending) return null;
  const s = state.seats[n];
  if (!canAct(s)) return null;
  const toCall = Math.max(0, hand.currentBet - s.streetBet);
  const maxTo = s.streetBet + s.stack;
  const open = s.actedAt === null || hand.currentBet - s.actedAt >= hand.lastFullRaise;
  // Raising is pointless (and refused) when nobody else could answer it.
  let others = 0;
  for (const o of state.seats) if (o !== s && canAct(o)) others++;
  const fullMin = hand.currentBet + hand.lastFullRaise;
  return {
    toCall,
    call: Math.min(toCall, s.stack),
    canCheck: toCall === 0,
    canRaise: open && others > 0 && maxTo > hand.currentBet,
    minTo: Math.min(fullMin, maxTo),
    maxTo,
    pot: potTotal(state),
    currentBet: hand.currentBet,
    bb: state.level.bb,
  };
};

const KIND_OF: Record<Action['kind'], ActKind> = { fold: 'f', check: 'x', call: 'c', bet: 'b', raise: 'r', allin: 'a' };

/** Validates an action against `legal`; returns the street total it moves the seat to, or a refusal. */
const resolve = (state: TableState, n: number, action: Action): { k: ActKind; to: number } | RefusalCode => {
  const lg = legal(state, n);
  if (!lg) return 'not_your_turn';
  const s = state.seats[n];
  const hand = state.hand as HandState;
  switch (action.kind) {
    case 'fold':
      return { k: 'f', to: s.streetBet };
    case 'check':
      return lg.canCheck ? { k: 'x', to: s.streetBet } : 'illegal';
    case 'call': {
      if (lg.canCheck) return 'illegal';
      const to = s.streetBet + lg.call;
      return { k: to === lg.maxTo ? 'a' : 'c', to };
    }
    case 'allin': {
      if (lg.maxTo > hand.currentBet && !lg.canRaise) return 'illegal';
      return { k: 'a', to: lg.maxTo };
    }
    default: {
      if (action.kind === 'bet' && hand.currentBet > 0) return 'illegal';
      if (action.kind === 'raise' && hand.currentBet === 0) return 'illegal';
      if (!lg.canRaise) return 'illegal';
      const to = action.to;
      if (!Number.isInteger(to) || to < lg.minTo || to > lg.maxTo) return 'amount';
      return { k: to === lg.maxTo ? 'a' : KIND_OF[action.kind], to };
    }
  }
};

/** Applies a validated action (host) or a received one (mirror). */
export const applyAction = (state: TableState, n: number, k: ActKind, to: number, now: number, sink: Sink, timedOut = false): void => {
  const hand = state.hand as HandState;
  const s = state.seats[n];
  if (hand.bank) {
    s.timeBankMs = timedOut ? 0 : Math.max(0, s.timeBankMs - Math.max(0, now - hand.bankStart));
    hand.bank = false;
  }
  if (k === 'f') {
    s.folded = true;
  } else if (k !== 'x') {
    const add = Math.max(0, Math.min(to - s.streetBet, s.stack));
    s.stack -= add;
    s.streetBet += add;
    s.totalBet += add;
    if (s.stack === 0) s.allIn = true;
    const raisedBy = s.streetBet - hand.currentBet;
    if (raisedBy > 0) {
      if (raisedBy >= hand.lastFullRaise) hand.lastFullRaise = raisedBy;
      hand.currentBet = s.streetBet;
      hand.lastAggressor = n;
    }
  }
  if (k !== 'f') s.actedAt = hand.currentBet;
  if (!timedOut) s.timeouts = 0;
  const streetIndex = STREETS.indexOf(hand.street);
  const total = s.streetBet;
  hand.log.push([streetIndex, n, k, total]);
  const runout = settle(state, n, now);
  const ev: Extract<EngineEvent, { ev: 'act' }> = push(state, sink, {
    ev: 'act',
    q: 0,
    s: n,
    k,
    a: total,
    st: s.stack,
    cb: hand.currentBet,
    mr: hand.currentBet + hand.lastFullRaise,
    n: hand.toAct,
    dl: hand.toAct >= 0 ? hand.deadline : 0,
  });
  if (timedOut) ev.to = 1;
  if (sink && hand.toAct >= 0) hand.turnQ = ev.q;
  if (runout && sink) revealLive(state, sink);
};

/**
 * After a blind or an action: give the next seat its turn, or close the street. Closing refunds an
 * uncalled bet and marks what the host must do next. Returns true when an all-in runout just began.
 */
const settle = (state: TableState, from: number, now: number): boolean => {
  const hand = state.hand as HandState;
  let live = 0;
  let actors = 0;
  let single: Seat | null = null;
  for (const s of state.seats) {
    if (!s.inHand || s.folded) continue;
    live++;
    if (!s.allIn) {
      actors++;
      single = s;
    }
  }
  if (live <= 1) {
    refundUncalled(state);
    hand.toAct = -1;
    hand.pending = 'showdown';
    hand.uncontested = true;
    return false;
  }
  let closed: boolean;
  if (actors === 0) closed = true;
  else if (actors === 1 && single) {
    let maxOther = 0;
    for (const s of state.seats) if (s.inHand && !s.folded && s !== single && s.streetBet > maxOther) maxOther = s.streetBet;
    closed = single.streetBet >= maxOther;
  } else {
    closed = true;
    for (const s of state.seats) if (canAct(s) && (s.actedAt === null || s.streetBet !== hand.currentBet)) closed = false;
  }
  if (!closed) {
    hand.toAct = nextToAct(state, from);
    if (hand.toAct >= 0) {
      hand.deadline = now + state.config.actionMs;
      hand.bank = false;
      return false;
    }
  }
  refundUncalled(state);
  hand.toAct = -1;
  hand.pots = buildPots(contribs(state));
  if (hand.street === 'river') {
    hand.pending = 'showdown';
    return false;
  }
  hand.pending = 'street';
  let left = 0;
  for (const s of state.seats) if (canAct(s)) left++;
  if (left <= 1 && !hand.runout) {
    hand.runout = true;
    return true;
  }
  return false;
};

/** The top bettor's chips above the second-highest street bet (folded seats count) go back to them. */
const refundUncalled = (state: TableState): void => {
  let top = -1;
  let topBet = 0;
  let second = 0;
  for (const s of state.seats) {
    if (!s.inHand) continue;
    if (s.streetBet > topBet) {
      second = topBet;
      topBet = s.streetBet;
      top = s.seat;
    } else if (s.streetBet > second) second = s.streetBet;
  }
  if (top < 0 || topBet <= second) return;
  const back = topBet - second;
  const s = state.seats[top];
  s.streetBet -= back;
  s.totalBet -= back;
  s.stack += back;
  if (s.stack > 0) s.allIn = false;
  const hand = state.hand as HandState;
  if (hand.currentBet > s.streetBet) hand.currentBet = s.streetBet;
};

/** Every live hand face up at the start of an all-in runout (host). */
const revealLive = (state: TableState, sink: Sink): void => {
  const rv: { s: number; c: [Card, Card] }[] = [];
  for (const s of state.seats) {
    if (s.inHand && !s.folded && s.hole && !s.shown) {
      s.shown = true;
      rv.push({ s: s.seat, c: s.hole });
    }
  }
  if (rv.length > 0) push(state, sink, { ev: 'show', q: 0, rv });
};

/** Act for a seat. `check` (online) rejects an intent for another hand or one older than the seat's turn. */
export const act = (state: TableState, n: number, action: Action, now: number, check?: { h: number; q: number }): Result => {
  const hand = state.hand;
  if (!hand || hand.toAct !== n) return { ok: false, code: 'not_your_turn' };
  if (check && (check.h !== hand.handNo || check.q < hand.turnQ)) return { ok: false, code: 'stale' };
  const r = resolve(state, n, action);
  if (typeof r === 'string') return { ok: false, code: r };
  const out: EngineEvent[] = [];
  applyAction(state, n, r.k, r.to, now, out);
  return { ok: true, events: out };
};

/** The clock ran out (action clock and time bank): check if possible, else fold. Two in a row sit the seat out. */
export const timeout = (state: TableState, n: number, now: number): Result => {
  const lg = legal(state, n);
  if (!lg) return { ok: false, code: 'not_your_turn' };
  const s = state.seats[n];
  s.timeouts += 1;
  const out: EngineEvent[] = [];
  applyAction(state, n, lg.canCheck ? 'x' : 'f', s.streetBet, now, out, true);
  if (s.timeouts >= 2 && s.status === 'active') {
    s.status = 'sittingOut';
    seatEvent(state, n, out);
  }
  return { ok: true, events: out };
};

/** The action clock ran out and the seat has time bank left: start it. */
export const startBank = (state: TableState, now: number): EngineEvent[] => {
  const hand = state.hand;
  if (!hand || hand.toAct < 0 || hand.bank) return [];
  const s = state.seats[hand.toAct];
  if (s.timeBankMs <= 0) return [];
  hand.bank = true;
  hand.bankStart = now;
  hand.deadline = now + s.timeBankMs;
  const out: EngineEvent[] = [];
  push(state, out, { ev: 'bank', q: 0, s: hand.toAct, dl: hand.deadline, b: 1 });
  return out;
};

/** Extend the current deadline (queue-wait credit on slow links). */
export const creditDeadline = (state: TableState, ms: number): EngineEvent[] => {
  const hand = state.hand;
  if (!hand || hand.toAct < 0 || ms <= 0) return [];
  hand.deadline += ms;
  const out: EngineEvent[] = [];
  push(state, out, { ev: 'bank', q: 0, s: hand.toAct, dl: hand.deadline });
  return out;
};

// ------------------------------------------------------------------------------------------------
// Streets, showdown, awards
// ------------------------------------------------------------------------------------------------

/** How long the host waits before `advance`: null if nothing is pending. */
export const pendingDelay = (state: TableState, runoutMs: number = RUNOUT_MS): number | null => {
  const hand = state.hand;
  if (!hand || !hand.pending) return null;
  return hand.runout && hand.pending === 'street' ? runoutMs : 0;
};

const NEXT_STREET: Partial<Record<Street, Street>> = { preflop: 'flop', flop: 'turn', turn: 'river' };

/** Deal the next street, or run the showdown, whichever is pending. */
export const advance = (state: TableState, now: number): EngineEvent[] => {
  const hand = state.hand;
  if (!hand || !hand.pending) return [];
  const out: EngineEvent[] = [];
  if (hand.pending === 'street') {
    const street = NEXT_STREET[hand.street] as Street;
    const count = street === 'flop' ? 3 : 1;
    const cards = hand.deck.slice(hand.deckPos, hand.deckPos + count);
    hand.deckPos += count;
    nextStreet(state, street, cards, now);
    const ev = push(state, out, { ev: 'street', q: 0, st: street, c: cards, n: hand.toAct, dl: hand.toAct >= 0 ? hand.deadline : 0 });
    if (hand.toAct >= 0) hand.turnQ = ev.q;
    return out;
  }
  showdown(state, out);
  return out;
};

/** Board cards in, street bets reset, first seat after the button to act (none during a runout). */
export const nextStreet = (state: TableState, street: Street, cards: readonly Card[], now: number): void => {
  const hand = state.hand as HandState;
  hand.street = street;
  for (const c of cards) hand.board.push(c);
  for (const s of state.seats) {
    s.streetBet = 0;
    s.actedAt = null;
  }
  hand.currentBet = 0;
  hand.lastFullRaise = state.level.bb;
  hand.lastAggressor = null;
  hand.pending = null;
  if (hand.runout) {
    hand.toAct = -1;
    hand.pending = street === 'river' ? 'showdown' : 'street';
    return;
  }
  hand.toAct = nextToAct(state, hand.button);
  hand.deadline = now + state.config.actionMs;
  hand.bank = false;
  if (hand.toAct < 0) settle(state, hand.button, now);
};

export const contribs = (state: TableState): { seat: number; total: number; folded: boolean }[] =>
  state.seats.filter((s) => s.inHand).map((s) => ({ seat: s.seat, total: s.totalBet, folded: s.folded }));

const sameSet = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Main and side pots from each seat's total contribution (after uncalled refunds). Folded chips feed
 * every level they reach. Bounded by the seat count: every pass empties at least one live seat.
 */
export function buildPots(seats: readonly { seat: number; total: number; folded: boolean }[]): Pot[] {
  const rem = seats.map((s) => s.total);
  const pots: Pot[] = [];
  for (let pass = 0; pass < seats.length; pass++) {
    let level = 0;
    for (let i = 0; i < seats.length; i++) if (!seats[i].folded && rem[i] > 0 && (level === 0 || rem[i] < level)) level = rem[i];
    if (level === 0) break;
    let amount = 0;
    const eligible: number[] = [];
    for (let i = 0; i < seats.length; i++) {
      if (!seats[i].folded && rem[i] > 0) eligible.push(seats[i].seat);
      const take = Math.min(rem[i], level);
      amount += take;
      rem[i] -= take;
    }
    const prev = pots[pots.length - 1];
    if (prev && sameSet(prev.eligible, eligible)) prev.amount += amount;
    else pots.push({ amount, eligible });
  }
  // Folded chips above every live contribution (only possible after a fold that was not facing a
  // bet) go to the last pot, so the pots always sum to the contributions.
  let leftover = 0;
  for (const r of rem) leftover += r;
  if (leftover > 0) {
    if (pots.length > 0) pots[pots.length - 1].amount += leftover;
    else pots.push({ amount: leftover, eligible: seats.filter((s) => !s.folded).map((s) => s.seat) });
  }
  return pots;
}

/** Order seats clockwise starting at `from` (inclusive). */
const clockwiseFrom = (state: TableState, from: number, seats: readonly number[]): number[] => {
  const n = state.seats.length;
  return seats.slice().sort((a, b) => ((a - from + n) % n) - ((b - from + n) % n));
};

/** Seat value at showdown (hole + board); −1 without cards. */
const valueOf = (state: TableState, s: Seat): number => {
  const hand = state.hand as HandState;
  if (!s.hole) return -1;
  const cards = [s.hole[0], s.hole[1], ...hand.board];
  return cards.length >= 5 ? eval7(cards) : -1;
};

export interface Award {
  pot: number;
  amount: number;
  winners: number[];
  each: number;
}

/**
 * Pay the pots, last side pot first: the best value among eligible seats wins; a k-way tie pays
 * floor(amount / k) each, odd chips one each clockwise from the seat after the button.
 */
export const awardPots = (state: TableState, pots: readonly Pot[], values: readonly number[]): Award[] => {
  const hand = state.hand as HandState;
  const awards: Award[] = [];
  for (let p = pots.length - 1; p >= 0; p--) {
    const pot = pots[p];
    let best = -2;
    let winners: number[] = [];
    for (const idx of pot.eligible) {
      const v = values[idx];
      if (v > best) {
        best = v;
        winners = [idx];
      } else if (v === best) winners.push(idx);
    }
    if (winners.length === 0) continue;
    const each = Math.floor(pot.amount / winners.length);
    let odd = pot.amount - each * winners.length;
    for (const w of winners) state.seats[w].stack += each;
    for (const w of clockwiseFrom(state, (hand.button + 1) % state.seats.length, winners)) {
      if (odd <= 0) break;
      state.seats[w].stack += 1;
      odd--;
    }
    awards.unshift({ pot: p, amount: pot.amount, winners, each });
  }
  return awards;
};

/** The showdown (or uncontested win), the awards, and the end of the hand. */
const showdown = (state: TableState, out: EngineEvent[]): void => {
  const hand = state.hand as HandState;
  hand.street = 'showdown';
  hand.pending = null;
  hand.toAct = -1;
  const pots = buildPots(contribs(state));
  hand.pots = pots;
  const live = state.seats.filter((s) => s.inHand && !s.folded);
  const rv: { s: number; c: [Card, Card] }[] = [];
  const values = new Array<number>(state.seats.length).fill(-1);
  let revealed = hand.runout;
  if (live.length === 1) {
    values[live[0].seat] = 0;
    hand.showable = live[0].seat;
  } else {
    for (const s of live) values[s.seat] = valueOf(state, s);
    const aggressor = hand.lastAggressor;
    const first = aggressor !== null && live.some((s) => s.seat === aggressor) ? aggressor : nextWhere(state, hand.button, (s) => s.inHand && !s.folded);
    const order = clockwiseFrom(
      state,
      first,
      live.map((s) => s.seat),
    );
    const bestShown = new Array<number>(pots.length).fill(-1);
    for (const idx of order) {
      const s = state.seats[idx];
      let show = s.shown;
      for (let p = 0; p < pots.length && !show; p++) if (pots[p].eligible.includes(idx) && values[idx] >= bestShown[p]) show = true;
      if (!show) continue;
      for (let p = 0; p < pots.length; p++) if (pots[p].eligible.includes(idx) && values[idx] > bestShown[p]) bestShown[p] = values[idx];
      if (!s.shown && s.hole) {
        s.shown = true;
        rv.push({ s: idx, c: s.hole });
      }
      revealed = true;
    }
    // A hand that could not win anything is mucked: its value must not decide a pot it did not show.
    for (const s of live) if (!s.shown) values[s.seat] = -1;
  }
  const awards = awardPots(state, pots, values);
  push(state, out, { ev: 'show', q: 0, rv, pots: awards.map((a) => ({ a: a.amount, w: a.winners, each: a.each })) });
  finishHand(state, out, live.length === 1 ? NEXT_MS.uncontested : revealed ? NEXT_MS.reveal : NEXT_MS.plain);
};

const finishHand = (state: TableState, out: EngineEvent[], next: number): void => {
  const hand = state.hand as HandState;
  hand.street = 'done';
  hand.pending = null;
  hand.toAct = -1;
  state.handsPlayed += 1;
  // The chips are in the stacks now.
  for (const s of state.seats) {
    s.streetBet = 0;
    s.totalBet = 0;
  }
  push(state, out, { ev: 'end', q: 0, stk: state.seats.map((s) => s.stack), next });
  for (const s of state.seats) {
    if (s.player && s.stack === 0 && s.status !== 'busted' && s.status !== 'empty') {
      s.status = 'busted';
      seatEvent(state, s.seat, out);
    }
  }
  const cfg = state.config;
  if (cfg.timeBankAddMs > 0 && state.handsPlayed % 10 === 0) {
    for (const s of state.seats) if (s.player && s.status !== 'empty') s.timeBankMs = Math.min(cfg.timeBankMaxMs, s.timeBankMs + cfg.timeBankAddMs);
  }
};

/** The uncontested winner taps Show: their cards go face up. */
export const showUncontested = (state: TableState, n: number): EngineEvent[] => {
  const hand = state.hand;
  const s = state.seats[n];
  if (!hand || hand.showable !== n || !s.hole || s.shown) return [];
  s.shown = true;
  hand.showable = -1;
  const out: EngineEvent[] = [];
  push(state, out, { ev: 'show', q: 0, rv: [{ s: n, c: s.hole }] });
  return out;
};

/**
 * Void the hand in progress (server restart, admin void): every stack goes back to its value at
 * the start of the hand. Returns the end event.
 */
export const voidHand = (state: TableState, reason: string): EngineEvent[] => {
  const hand = state.hand;
  const out: EngineEvent[] = [];
  if (!hand || hand.street === 'done') return out;
  for (const s of state.seats) {
    if (s.inHand) s.stack = s.startStack;
    s.inHand = false;
    s.streetBet = 0;
    s.totalBet = 0;
    s.folded = false;
    s.allIn = false;
    s.actedAt = null;
  }
  hand.street = 'done';
  hand.pending = null;
  hand.toAct = -1;
  push(state, out, { ev: 'end', q: 0, stk: state.seats.map((s) => s.stack), next: NEXT_MS.plain, void: reason });
  return out;
};

/** Total chips on the table: stacks plus everything bet this hand. */
export const tableChips = (state: TableState): number => {
  let sum = 0;
  for (const s of state.seats) sum += s.stack + s.totalBet;
  return sum;
};

/** Net result of each seat for the finished hand (final stack minus starting stack). */
export const handNet = (state: TableState): number[] => state.seats.map((s) => (s.inHand ? s.stack - s.startStack : 0));
