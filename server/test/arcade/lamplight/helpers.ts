/** Test helpers for the Lamplight core: tables with given stacks, stacked decks, random play. */
import { newDeck, parseCards, shuffle, type Card } from '../../../src/arcade/core/lamplight/cards.js';
import {
  act,
  advance,
  createTable,
  legal,
  pendingDelay,
  seat,
  startHand,
  type Action,
  type BlindLevel,
  type EngineEvent,
  type Format,
  type TableState,
} from '../../../src/arcade/core/lamplight/engine.js';
import { tableConfig } from '../../../src/arcade/core/lamplight/schedule.js';
import { randInt, seedXoshiro, xoshiro128ss } from '../../../src/arcade/core/rng.js';

export const level = (sb: number, bb: number, ante = 0): BlindLevel => ({ index: 0, sb, bb, ante, endsAt: null, endsAfterHand: null });

/**
 * A table with the given stacks in seats 0…n−1 (null = empty seat), all active, blinds sb/bb.
 * `button` is the first button. Cash by default.
 */
export const makeTable = (stacks: readonly (number | null)[], o: { sb?: number; bb?: number; ante?: number; format?: Format; id?: string } = {}): TableState => {
  const format = o.format ?? 'open';
  const cfg = tableConfig({ format, tier: 'pebble', seats: stacks.length, bots: null });
  cfg.seats = stacks.length;
  const state = createTable(o.id ?? 'tbl00001', cfg, level(o.sb ?? 5, o.bb ?? 10, o.ante ?? 0));
  stacks.forEach((stack, n) => {
    if (stack === null) return;
    seat(state, n, { accountId: 'acct' + n, botId: null, avatarSeed: n }, stack);
    state.seats[n].status = 'active';
    state.seats[n].post = null;
  });
  return state;
};

/** Seats dealt in, in deal order (from the seat left of the button). */
const dealOrder = (state: TableState, button: number): number[] => {
  const out: number[] = [];
  for (let i = 1; i <= state.seats.length; i++) {
    const idx = (button + i) % state.seats.length;
    const s = state.seats[idx];
    if (s.player && s.stack > 0 && (s.status === 'active' || (state.config.format !== 'open' && s.status === 'sittingOut'))) out.push(idx);
  }
  return out;
};

/** A deck that deals `holes[seat]` and then `board`, the rest filled with unused cards. */
export const stackedDeck = (state: TableState, button: number, holes: Record<number, string>, board = ''): Card[] => {
  const order = dealOrder(state, button);
  const n = order.length;
  const deck: (Card | null)[] = new Array(52).fill(null);
  const used = new Set<Card>();
  order.forEach((seatNo, i) => {
    const text = holes[seatNo];
    if (!text) return;
    const [a, b] = parseCards(text);
    deck[i] = a;
    deck[n + i] = b;
    used.add(a);
    used.add(b);
  });
  parseCards(board).forEach((c, i) => {
    deck[2 * n + i] = c;
    used.add(c);
  });
  const rest = newDeck().filter((c) => !used.has(c));
  for (let i = 0; i < 52; i++) if (deck[i] === null) deck[i] = rest.shift() as Card;
  return deck as Card[];
};

/** Run every pending step at once (no runout delays), collecting events. */
export const drain = (state: TableState, now = 0): EngineEvent[] => {
  const out: EngineEvent[] = [];
  for (let i = 0; i < 10; i++) {
    if (pendingDelay(state) === null) break;
    out.push(...advance(state, now));
  }
  return out;
};

/** Act and drain; throws on a refusal (scripted tests). */
export const play = (state: TableState, seatNo: number, action: Action, now = 0): EngineEvent[] => {
  const r = act(state, seatNo, action, now);
  if (!r.ok) throw new Error('seat ' + seatNo + ' ' + action.kind + ' refused: ' + r.code);
  return [...r.events, ...drain(state, now)];
};

export const toAct = (state: TableState): number => state.hand?.toAct ?? -1;

export const rng = (seed: number) => {
  const st = seedXoshiro(seed);
  const next = () => xoshiro128ss(st);
  return { int: (n: number) => randInt(next, n), u32: next };
};

export const shuffledDeck = (r: ReturnType<typeof rng>): Card[] => shuffle(newDeck(), r.int);

/** A random legal action for the seat to act (weights favour calls, so hands reach showdowns). */
export const randomAction = (state: TableState, r: ReturnType<typeof rng>): Action => {
  const lg = legal(state, toAct(state));
  if (!lg) throw new Error('no legal action for seat ' + toAct(state));
  const roll = r.int(100);
  if (lg.canRaise && roll < 18) {
    if (roll < 3) return { kind: 'allin' };
    const span = lg.maxTo - lg.minTo;
    const to = lg.minTo + (span > 0 ? r.int(Math.min(span, lg.pot + lg.toCall) + 1) : 0);
    return { kind: lg.currentBet === 0 ? 'bet' : 'raise', to };
  }
  if (lg.canCheck) return roll < 90 ? { kind: 'check' } : { kind: 'fold' };
  return roll < 75 ? { kind: 'call' } : { kind: 'fold' };
};

export { startHand };
