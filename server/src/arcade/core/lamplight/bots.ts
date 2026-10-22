/**
 * Bots (lamplight.md §13). A bot never decides an outcome: it picks an action from its own view,
 * `viewFor(botSeat)`, exactly as a player would. The thinker is a stepper so core needs no clock:
 *
 *   const th = createThinker(view, seat, level, seed, { maxTrials });
 *   while (!th.step(200) && withinBudget()) yieldToEventLoop();   // host side
 *   const action = th.decide();
 *
 * Preflop it plays a chart over the committed 169-class order; postflop it estimates its equity by
 * Monte Carlo against ranges read from the opponents' actions, then bets, calls or folds by the
 * level's thresholds, noise and bluff rates. Every loop is a `for` over a fixed cap.
 */
import type { Card } from './cards.js';
import { eval7 } from './evaluate.js';
import { legal, type Action, type BotLevel, type Format, type Legal, type TableState } from './engine.js';
import { callShoveRange, DEFEND_BB, GREENHORN, handPct, isSuitedAce, OPEN, positionOf, pushRange, REGULAR_RANGE, THREE_BET } from './ranges.js';
import { xorshift32 } from '../rng.js';

export const BOT_LEVELS: readonly BotLevel[] = ['greenhorn', 'regular', 'sharp'];
export const BOT_LEVEL_NAMES: Readonly<Record<BotLevel, string>> = { greenhorn: 'Greenhorn', regular: 'Regular', sharp: 'Sharp' };

/** The nine bots: id (stored as PlayerRef.botId) and display name. */
export const BOTS: readonly { id: string; name: string }[] = [
  { id: 'marlow', name: 'Marlow Finch' },
  { id: 'brine', name: 'Auntie Brine' },
  { id: 'pip', name: 'Pip Tanager' },
  { id: 'vesna', name: 'Vesna Corr' },
  { id: 'tamsin', name: 'Old Tamsin' },
  { id: 'jory', name: 'Jory Vane' },
  { id: 'nell', name: 'Nell Ashcombe' },
  { id: 'wick', name: 'Captain Wick' },
  { id: 'bramble', name: 'Bramble' },
];

export const botName = (id: string | null): string => BOTS.find((b) => b.id === id)?.name ?? 'Bot';

/** Trial caps per decision: on the server (≤ 2 ms of CPU), in the offline Worker, and on the cheap path. */
export const BOT_TRIALS: Readonly<Record<'server' | 'worker', Readonly<Record<BotLevel, number>>>> = {
  server: { greenhorn: 300, regular: 1000, sharp: 1500 },
  worker: { greenhorn: 300, regular: 1500, sharp: 4000 },
};
export const CHEAP_TRIALS = 100;
/** Trials per slice on the server and in the main-thread fallback. */
export const SLICE_TRIALS = 200;
/** Stop early once the equity's standard error is below this, after `EARLY_AFTER` trials. */
export const EARLY_SE = 0.01;
export const EARLY_AFTER = 300;

const LEVEL = {
  greenhorn: { noise: 0.1, margin: -0.1, bluff: 0.02, betQ: 1.25 },
  regular: { noise: 0.05, margin: 0.03, bluff: 0.08, betQ: 1.25 },
  sharp: { noise: 0.02, margin: 0, bluff: 0.14, betQ: 1.2 },
} as const;

/**
 * Cosmetic think time from a uniform `u` in [0, 1): 700–2,200 ms skewed short, 400–1,000 ms in the
 * Firefly Trio, 150 ms in offline fast mode.
 */
export const thinkMs = (format: Format, fast: boolean, u: number): number =>
  fast ? 150 : format === 'trio' ? Math.round(400 + 600 * u * u) : Math.round(700 + 1500 * u * u);

export interface Thinker {
  /** Run up to `maxTrials` more trials; true when the decision is ready. */
  step(maxTrials: number): boolean;
  decide(): Action;
  readonly trials: number;
  /** Equity estimate so far (postflop), or −1 preflop. */
  readonly equity: number;
}

interface Read {
  /** Preflop: raises made, limpers, the last raiser, its total. */
  raises: number;
  limpers: number;
  raiser: number;
  raiseTo: number;
  /** Per seat: the preflop category and, postflop, the range factor so far. */
  range: number[];
}

/** What the log says about the opponents. */
const readTable = (view: TableState, level: BotLevel): Read => {
  const hand = view.hand;
  const n = view.seats.length;
  const range = new Array<number>(n).fill(1);
  const read: Read = { raises: 0, limpers: 0, raiser: -1, raiseTo: 0, range };
  if (!hand) return read;
  const bb = view.level.bb;
  let top = bb;
  const pre = new Array<'none' | 'limped' | 'called' | 'raised' | 'reraised'>(n).fill('none');
  const log = hand.log;
  for (let i = 0; i < log.length; i++) {
    const [street, seat, kind, amount] = log[i];
    if (street !== 0) continue;
    if (kind === 'f' || kind === 'x') continue;
    if (amount > top) {
      pre[seat] = read.raises === 0 ? 'raised' : 'reraised';
      read.raises++;
      read.raiser = seat;
      read.raiseTo = amount;
      top = amount;
    } else if (read.raises === 0) {
      pre[seat] = 'limped';
      read.limpers++;
    } else pre[seat] = 'called';
  }
  for (let s = 0; s < n; s++) {
    if (level === 'greenhorn') continue;
    const p = pre[s];
    if (level === 'regular') {
      range[s] = p === 'raised' || p === 'reraised' ? REGULAR_RANGE.raised : p === 'called' ? REGULAR_RANGE.called : p === 'limped' ? REGULAR_RANGE.limped : REGULAR_RANGE.none;
      continue;
    }
    // Sharp: by action and position, narrowed each street.
    range[s] = p === 'reraised' ? 0.07 : p === 'raised' ? OPEN.sharp[positionOf(view, s)] : p === 'called' ? 0.25 : p === 'limped' ? 0.6 : 1;
  }
  if (level === 'sharp') {
    for (let i = 0; i < log.length; i++) {
      const [street, seat, kind] = log[i];
      if (street === 0) continue;
      if (kind === 'b' || kind === 'r' || kind === 'a') range[seat] *= 0.6;
      else if (kind === 'c') range[seat] *= 0.8;
    }
    for (let s = 0; s < n; s++) range[s] = Math.max(0.04, range[s]);
  }
  return read;
};

/** A dry board: no pair, no three of a suit, no three cards within a 4-rank span. */
export const isDry = (board: readonly Card[]): boolean => {
  const suits = [0, 0, 0, 0];
  let mask = 0;
  for (const c of board) {
    const bit = 1 << (c >> 2);
    if (mask & bit) return false;
    mask |= bit;
    if (++suits[c & 3] >= 3) return false;
  }
  const withLowAce = (mask << 1) | ((mask >> 12) & 1);
  for (let lo = 0; lo <= 10; lo++) {
    const span = (withLowAce >> lo) & 15;
    let bits = 0;
    for (let b = 0; b < 4; b++) bits += (span >> b) & 1;
    if (bits >= 3) return false;
  }
  return true;
};

/** A flush draw or an open-ended straight draw that uses a hole card. */
export const hasDraw = (hole: readonly Card[], board: readonly Card[]): boolean => {
  if (board.length >= 5) return false;
  const suits = [0, 0, 0, 0];
  for (const c of board) suits[c & 3]++;
  for (const c of hole) suits[c & 3]++;
  for (const c of hole) if (suits[c & 3] === 4) return true;
  let boardMask = 0;
  for (const c of board) boardMask |= 1 << (c >> 2);
  let all = boardMask;
  for (const c of hole) all |= 1 << (c >> 2);
  const lowAce = (m: number): number => (m << 1) | ((m >> 12) & 1);
  const a = lowAce(all);
  const b = lowAce(boardMask);
  for (let lo = 1; lo <= 9; lo++) {
    // Four in a row with both ends open, not all on the board.
    if (((a >> lo) & 15) === 15 && ((b >> lo) & 15) !== 15 && ((a >> (lo + 4)) & 1) === 0 && ((a >> (lo - 1)) & 1) === 0) return true;
  }
  return false;
};

export const createThinker = (view: TableState, seat: number, level: BotLevel, seed: number, opts: { maxTrials: number }): Thinker => {
  let s = seed >>> 0 || 0x2545f491;
  const unit = (): number => {
    s = xorshift32(s);
    return (s >>> 0) / 4294967296;
  };
  const hand = view.hand;
  const me = view.seats[seat];
  const lg = legal(view, seat);
  const hole = me.hole;
  const read = readTable(view, level);
  const preflop = !hand || hand.street === 'preflop';
  const opponents: number[] = [];
  for (const o of view.seats) if (o.inHand && !o.folded && o.seat !== seat) opponents.push(o.seat);

  // Monte Carlo state (postflop only).
  const pool: Card[] = [];
  if (hole && hand) for (let c = 0; c < 52; c++) if (c !== hole[0] && c !== hole[1] && !hand.board.includes(c)) pool.push(c);
  const cards = new Int32Array(7);
  const opp = new Int32Array(14);
  let trials = 0;
  let sum = 0;
  let sumSq = 0;
  const needEquity = !preflop && lg !== null && hole !== null && opponents.length > 0;
  let done = !needEquity || opts.maxTrials <= 0;

  const trial = (): number => {
    const board = (hand as NonNullable<typeof hand>).board;
    let m = pool.length;
    const take = (): Card => {
      const i = Math.floor(unit() * m);
      const c = pool[i];
      pool[i] = pool[m - 1];
      pool[m - 1] = c;
      m--;
      return c;
    };
    for (let k = 0; k < opponents.length; k++) {
      const r = read.range[opponents[k]];
      let a = take();
      let b = take();
      // Rejection sampling: up to 20 tries for a hand inside the range, then whatever came.
      for (let tries = 0; tries < 20 && r < 1 && handPct(a, b) > r; tries++) {
        m += 2;
        a = take();
        b = take();
      }
      opp[2 * k] = a;
      opp[2 * k + 1] = b;
    }
    const h = hole as [Card, Card];
    cards[0] = h[0];
    cards[1] = h[1];
    let nb = 0;
    for (; nb < board.length; nb++) cards[2 + nb] = board[nb];
    for (; nb < 5; nb++) cards[2 + nb] = take();
    const mine = eval7(cards, 7);
    let ties = 1;
    for (let k = 0; k < opponents.length; k++) {
      const save0 = cards[0];
      const save1 = cards[1];
      cards[0] = opp[2 * k];
      cards[1] = opp[2 * k + 1];
      const v = eval7(cards, 7);
      cards[0] = save0;
      cards[1] = save1;
      if (v > mine) return 0;
      if (v === mine) ties++;
    }
    return 1 / ties;
  };

  const equity = (): number => (trials > 0 ? sum / trials : 0.5);

  const bb = view.level.bb;
  const sb = Math.max(1, view.level.sb);
  const roundTo = (to: number, l: Legal): number => {
    const r = Math.round(to / sb) * sb;
    return Math.max(l.minTo, Math.min(l.maxTo, r));
  };

  /** A bet or raise to `to`, as a legal action (all-in when it reaches the stack, a call or check when raising is closed). */
  const aggress = (to: number, l: Legal): Action => {
    if (!l.canRaise) return l.canCheck ? { kind: 'check' } : { kind: 'call' };
    const t = roundTo(to, l);
    if (t >= l.maxTo) return { kind: 'allin' };
    return { kind: l.currentBet === 0 ? 'bet' : 'raise', to: t };
  };
  const passive = (l: Legal): Action => (l.canCheck ? { kind: 'check' } : { kind: 'fold' });
  const call = (l: Legal): Action => (l.canCheck ? { kind: 'check' } : l.call >= me.stack ? { kind: 'allin' } : { kind: 'call' });
  const shove = (l: Legal): Action => (l.canRaise ? { kind: 'allin' } : call(l));

  const decidePreflop = (l: Legal): Action => {
    const pct = hole ? handPct(hole[0], hole[1]) : 1;
    const pos = positionOf(view, seat);
    let maxOther = 0;
    for (const o of opponents) maxOther = Math.max(maxOther, view.seats[o].stack + view.seats[o].streetBet);
    const effBB = Math.min(me.stack + me.streetBet, maxOther) / bb;
    const openTo = (2.5 + read.limpers) * bb;
    if (level === 'greenhorn') {
      if (pct <= GREENHORN.raise) return aggress(read.raises === 0 ? openTo : read.raiseTo * 3, l);
      return pct <= GREENHORN.play ? call(l) : passive(l);
    }
    const key = level === 'sharp' ? 'sharp' : 'regular';
    if (effBB <= 15) {
      if (read.raises === 0) {
        let left = 0;
        for (const o of opponents) if (view.seats[o].actedAt === null && !view.seats[o].allIn) left++;
        const onlyBB = left === 1 && pos === 'SB';
        return pct <= pushRange(effBB) * (onlyBB ? 2 : 1) ? shove(l) : passive(l);
      }
      return pct <= callShoveRange(read.raiseTo / bb) ? shove(l) : passive(l);
    }
    if (read.raises === 0) {
      if (pct <= OPEN[key][pos]) return aggress(openTo, l);
      return passive(l);
    }
    const three = THREE_BET[level];
    const callCost = l.call / Math.max(1, me.stack + l.call);
    if (read.raises === 1) {
      const bluff = level === 'sharp' && hole !== null && isSuitedAce(hole[0], hole[1]) && pct > three;
      if ((pct <= three || bluff) && l.canRaise) {
        const n = view.seats.length;
        const dist = (x: number): number => (x - (hand as NonNullable<typeof hand>).button - 1 + n * 2) % n;
        const inPosition = dist(seat) > dist(read.raiser);
        return aggress(read.raiseTo * (inPosition ? 3 : 3.5), l);
      }
      if (callCost > 0.33) return pct <= callShoveRange(read.raiseTo / bb) ? call(l) : passive(l);
      if (pct <= three * 2 || (pos === 'BB' && pct <= DEFEND_BB)) return call(l);
      return passive(l);
    }
    // Facing a 3-bet or more.
    if (pct <= 0.025) return shove(l);
    if (pct <= 0.05 && callCost <= 0.33) return call(l);
    return passive(l);
  };

  const decidePostflop = (l: Legal): Action => {
    const p = LEVEL[level];
    const h = hand as NonNullable<typeof hand>;
    const n = opponents.length;
    const e = Math.max(0, Math.min(1, equity() + p.noise * (2 * unit() - 1)));
    const q = e * (n + 1);
    const pot = l.pot;
    const dry = isDry(h.board);
    const river = h.street === 'river';
    const draw = hole !== null && h.street !== 'river' && hasDraw(hole, h.board);
    const planned = (size: number): Action => {
      const bet = Math.max(bb, Math.round(pot * size));
      // Shove when the stack is at most 1.2× the planned bet, or under 1.2× the pot.
      if (me.stack <= bet * 1.2 || me.stack < pot * 1.2) return shove(l);
      return aggress(l.currentBet + bet, l);
    };
    const valueSize = river ? 0.75 : dry ? 1 / 3 : 2 / 3;
    if (l.toCall === 0) {
      const cbet = level === 'sharp' && h.street === 'flop' && n === 1 && read.raiser === seat && unit() < 0.65;
      if (cbet || q >= p.betQ) return planned(valueSize);
      if (n <= 2 && unit() < (dry ? p.bluff : p.bluff / 2)) return planned(dry ? 1 / 3 : 2 / 3);
      return { kind: 'check' };
    }
    const odds = l.toCall / (pot + l.toCall);
    const margin = level === 'sharp' && draw ? -0.03 : p.margin;
    if (q >= 1.5 && l.canRaise) {
      const raiseTo = l.currentBet + Math.max(h.lastFullRaise, Math.round((pot + l.toCall) * 0.8));
      if (me.stack + me.streetBet <= raiseTo * 1.2) return shove(l);
      return aggress(raiseTo, l);
    }
    if (level === 'sharp' && h.street === 'flop' && draw && e >= 0.33 && l.canRaise && unit() < 0.25) {
      return aggress(l.currentBet + Math.max(h.lastFullRaise, Math.round((pot + l.toCall) * 0.8)), l);
    }
    if (e >= odds + margin) return call(l);
    return { kind: 'fold' };
  };

  return {
    step(maxTrials) {
      if (done) return true;
      const cap = Math.min(maxTrials, opts.maxTrials - trials);
      for (let i = 0; i < cap; i++) {
        const x = trial();
        sum += x;
        sumSq += x * x;
        trials++;
        if (trials >= EARLY_AFTER) {
          const mean = sum / trials;
          const se = Math.sqrt(Math.max(0, sumSq / trials - mean * mean) / trials);
          if (se < EARLY_SE) {
            done = true;
            break;
          }
        }
      }
      if (trials >= opts.maxTrials) done = true;
      return done;
    },
    decide() {
      if (!lg) return { kind: 'fold' };
      const action = preflop ? decidePreflop(lg) : decidePostflop(lg);
      // Never fold when checking is free.
      if (action.kind === 'fold' && lg.canCheck) return { kind: 'check' };
      return action;
    },
    get trials() {
      return trials;
    },
    get equity() {
      return preflop ? -1 : equity();
    },
  };
};
