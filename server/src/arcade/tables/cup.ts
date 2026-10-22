/**
 * Tournaments on the server (lamplight.md §2.2–2.4): the Lamplight Cup and the Firefly Trio share
 * this bookkeeping. Places and prizes count humans only: bots buy in nothing and never take a prize,
 * and a tournament ends as soon as the human places are settled (at most one human left with chips).
 * Busts in the same hand: the bigger starting stack places higher; equal stacks share those prizes,
 * the odd chip to the first of them clockwise from the button. An abandoned tournament splits the
 * unpaid prizes by stack among the humans still in.
 */
import { abandonedSplit, bustGroups, cupPercents, settlePlaces, splitPool } from '../core/lamplight/payouts.js';
import type { TableState } from '../core/lamplight/engine.js';
import type { Leg, LedgerAccount, Wallet } from './types.js';
import { escrowAccount, walletAccount } from '../wallet.js';

export interface Tournament {
  kind: 'cup' | 'trio';
  ref: string;
  buyIn: number;
  startedAt: number;
  /** Humans who bought in, by account. */
  humans: string[];
  pool: number;
  /** Prize by human place, 1st first. */
  prizes: number[];
  mult: number | null;
  /** Human finishing groups, worst first as they bust (each group shares its places). */
  busted: string[][];
  ended: boolean;
}

export const createTournament = (o: { kind: 'cup' | 'trio'; ref: string; buyIn: number; humans: readonly string[]; startedAt: number; trio?: { mult: number; pool: number; pay: number[] } }): Tournament => {
  const humans = o.humans.slice();
  const pool = o.trio ? o.trio.pool : o.buyIn * humans.length;
  return {
    kind: o.kind,
    ref: o.ref,
    buyIn: o.buyIn,
    startedAt: o.startedAt,
    humans,
    pool,
    prizes: o.trio ? o.trio.pay.slice() : splitPool(pool, cupPercents(humans.length)),
    mult: o.trio?.mult ?? null,
    busted: [],
    ended: false,
  };
};

/** Humans still holding chips. */
export const humansIn = (t: Tournament, state: TableState): string[] =>
  t.humans.filter((a) => {
    const s = state.seats.find((x) => x.player?.accountId === a);
    return !!s && s.stack > 0 && s.status !== 'busted';
  });

/** After a hand: record the humans who just busted. Returns true when the human places are settled. */
export const recordBusts = (t: Tournament, state: TableState): boolean => {
  const hand = state.hand;
  const out = new Set(t.busted.flat());
  const now = state.seats.filter((s) => s.player?.accountId && s.inHand && s.stack === 0 && !out.has(s.player.accountId));
  if (now.length > 0 && hand) {
    const groups = bustGroups(
      now.map((s) => ({ id: s.player?.accountId as string, startStack: s.startStack, seat: s.seat })),
      hand.button,
      state.seats.length,
    );
    // Best first within this hand; stored worst first overall.
    for (let i = groups.length - 1; i >= 0; i--) t.busted.push(groups[i]);
  }
  return humansIn(t, state).length <= 1;
};

/** Prize per human, best first: the humans still in place above everyone who busted. */
export const finalPrizes = (t: Tournament, state: TableState): Map<string, number> => {
  const remaining = humansIn(t, state);
  // Still-in humans (at most one when settled normally) place by stack.
  const ordered = remaining
    .map((a) => ({ a, stack: state.seats.find((s) => s.player?.accountId === a)?.stack ?? 0 }))
    .sort((x, y) => y.stack - x.stack)
    .map((x) => [x.a]);
  const groups: string[][] = [...ordered, ...t.busted.slice().reverse()];
  return settlePlaces(t.prizes, groups);
};

/** Place by human (1 = first), the same grouping as `finalPrizes`. */
export const finalPlaces = (t: Tournament, state: TableState): Map<string, number> => {
  const remaining = humansIn(t, state).sort((a, b) => (state.seats.find((s) => s.player?.accountId === b)?.stack ?? 0) - (state.seats.find((s) => s.player?.accountId === a)?.stack ?? 0));
  const places = new Map<string, number>();
  let place = 1;
  for (const a of remaining) places.set(a, place++);
  for (let i = t.busted.length - 1; i >= 0; i--) {
    for (const a of t.busted[i]) places.set(a, place);
    place += t.busted[i].length;
  }
  return places;
};

/**
 * Abandoned (every human disconnected for 10 minutes): busted humans keep the prizes of their places;
 * the unpaid rest goes to the humans still in, by stack.
 */
export const abandonedPrizes = (t: Tournament, state: TableState): Map<string, number> => {
  const remaining = humansIn(t, state);
  const out = new Map<string, number>();
  let place = remaining.length;
  let paid = 0;
  for (let i = t.busted.length - 1; i >= 0; i--) {
    const g = t.busted[i];
    let total = 0;
    for (let k = 0; k < g.length; k++) total += t.prizes[place + k] ?? 0;
    const each = Math.floor(total / g.length);
    let odd = total - each * g.length;
    for (const a of g) {
      const v = each + (odd-- > 0 ? 1 : 0);
      out.set(a, v);
      paid += v;
    }
    place += g.length;
  }
  const stacks = remaining.map((a) => state.seats.find((s) => s.player?.accountId === a)?.stack ?? 0);
  const shares = abandonedSplit(t.pool - paid, stacks);
  remaining.forEach((a, i) => out.set(a, shares[i]));
  return out;
};

/**
 * Pay out in one `prize` txn: every human's buy-in escrow to 0, each prize to its wallet, and the
 * house covers the difference (only the Trio: pool ≠ buy-ins).
 */
export const settle = (wallet: Wallet, t: Tournament, prizes: ReadonlyMap<string, number>, key: string): boolean => {
  const legs: Leg[] = [];
  let paidIn = 0;
  let paidOut = 0;
  for (const a of t.humans) {
    legs.push({ account: escrowAccount(t.ref, a), delta: -t.buyIn });
    paidIn += t.buyIn;
  }
  for (const [a, v] of prizes) {
    if (v <= 0) continue;
    legs.push({ account: walletAccount(a), delta: v });
    paidOut += v;
  }
  if (paidIn !== paidOut) legs.push({ account: 'house' as LedgerAccount, delta: paidIn - paidOut });
  const r = wallet.transfer('prize', t.ref, 'system', key, legs);
  t.ended = true;
  return r.ok && !r.dup;
};
