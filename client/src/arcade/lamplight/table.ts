/**
 * The client's table model (lamplight.md §7.4, §14): it keeps a view of the table by replaying the
 * events with the shared engine, orders them by `q` (a gap asks for a sync), works out your turn and
 * its legal amounts, runs the pre-actions, and keeps the last 50 hands for the history drawer.
 * Nothing here draws; the renderer and the action bar read from it.
 */
import { botName } from '@arcade/core/lamplight/bots';
import { formatCards, type Card } from '@arcade/core/lamplight/cards';
import { describeHand, eval7 } from '@arcade/core/lamplight/evaluate';
import { dealPositions, legal, potTotal, type Legal, type TableState } from '@arcade/core/lamplight/engine';
import { tierLabel } from '@arcade/core/lamplight/schedule';
import { applyEvent, fromSnap, type WireSnap } from '@arcade/core/lamplight/views';

export const EVENT_NAMES = [
  'lamplight:snap',
  'lamplight:hand',
  'lamplight:hole',
  'lamplight:act',
  'lamplight:street',
  'lamplight:bank',
  'lamplight:show',
  'lamplight:end',
  'lamplight:seat',
  'lamplight:level',
  'lamplight:trio',
  'lamplight:cupEnd',
  'lamplight:emote',
] as const;

export type PreAction = 'checkFold' | 'check' | 'call' | 'callAny' | null;

export interface Turn extends Legal {
  seat: number;
  stack: number;
  sb: number;
}

/** Things the renderer animates or shows briefly. */
export type Effect =
  | { k: 'deal'; seats: number[] }
  | { k: 'act'; s: number; label: string; kind: string; amount: number }
  | { k: 'street'; n: number }
  | { k: 'reveal'; seats: number[] }
  | { k: 'win'; pots: { a: number; w: number[] }[] }
  | { k: 'trio'; mult: number; pool: number }
  | { k: 'cupEnd'; places: { name: string; p: number; won: number; me: boolean }[] }
  | { k: 'emote'; s: number; id: number }
  | { k: 'void'; reason: string };

export interface HandRecord {
  no: number;
  /** Device time when the hand started. */
  at: number;
  label: string;
  lines: string[];
  net: number;
  pot: number;
  /** For the deck proof online: the commitment, your salts, and what you saw by deck position. */
  cr: string | null;
  seen: { i: number; c: Card }[];
  /** Offline: the deck seed. */
  seed: number | null;
  done: boolean;
}

export interface TableModelOpts {
  /** Your account id (null offline before sitting down; the local table uses 'local:me'). */
  me: string | null;
  names(accountIds: readonly string[]): readonly string[];
  now(): number;
  /** Half the recent ack round trip, taken off every `ms` (0 offline). */
  linkMs(): number;
  /** A gap in `q`: ask for the missed events or a snap. */
  sync(since: number): void;
  onEffect(e: Effect): void;
  /** Something visible changed (redraw); `turn` when your turn started or ended. */
  onChange(what: 'view' | 'turn' | 'seat'): void;
  /** Fire a pre-action or an automatic action. */
  act(k: string, a?: number): void;
  /** One line for the screen-reader live region. */
  announce(text: string): void;
}

/** Short chip counts for the table: exact below 10,000, then 12.5k, 125k, 1.2m. */
export const chips = (n: number): string => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '') + 'm';
  if (n >= 100_000) return Math.round(n / 1000) + 'k';
  if (n >= 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
};

export const fullChips = (n: number): string => n.toLocaleString('en-US');

const VERB: Record<string, string> = { f: 'folds', x: 'checks', c: 'calls', b: 'bets', r: 'raises to', a: 'is all-in' };
const VERB_YOU: Record<string, string> = { f: 'fold', x: 'check', c: 'call', b: 'bet', r: 'raise to', a: 'are all-in' };

export interface TableModel {
  readonly view: TableState | null;
  readonly me: number | null;
  readonly lastQ: number;
  readonly turn: Turn | null;
  readonly history: readonly HandRecord[];
  readonly local: boolean;
  readonly balance: number | null;
  readonly result: { place: number; prize: number } | null;
  readonly payouts: readonly number[];
  readonly buyIn: number;
  preAction: PreAction;
  /** The call amount a 'call' pre-action was armed for. */
  preCall: number;
  handle(name: string, data: unknown): void;
  name(seat: number): string;
  /** Your best hand right now, as words ("Pair of kings"), or null. */
  myHand(): string | null;
}

export const createTableModel = (o: TableModelOpts): TableModel => {
  let view: TableState | null = null;
  let me: number | null = null;
  let lastQ = -1;
  let turn: Turn | null = null;
  let local = false;
  let balance: number | null = null;
  let result: { place: number; prize: number } | null = null;
  let payouts: number[] = [];
  let buyIn = 0;
  const history: HandRecord[] = [];
  const nameCache = new Map<string, string>();
  let current: HandRecord | null = null;

  const name = (seat: number): string => {
    const s = view?.seats[seat];
    if (!s?.player) return 'Seat ' + (seat + 1);
    if (seat === me) return 'You';
    if (s.player.botId) return botName(s.player.botId);
    const id = s.player.accountId as string;
    let n = nameCache.get(id);
    if (!n) {
      n = o.names([id])[0] ?? 'Player';
      nameCache.set(id, n);
    }
    return n;
  };

  const findMe = (): number | null => {
    if (!view || !o.me) return null;
    const s = view.seats.find((x) => x.player?.accountId === o.me);
    return s ? s.seat : null;
  };

  const model: TableModel = {
    get view() {
      return view;
    },
    get me() {
      return me;
    },
    get lastQ() {
      return lastQ;
    },
    get turn() {
      return turn;
    },
    get history() {
      return history;
    },
    get local() {
      return local;
    },
    get balance() {
      return balance;
    },
    get result() {
      return result;
    },
    get payouts() {
      return payouts;
    },
    get buyIn() {
      return buyIn;
    },
    preAction: null,
    preCall: 0,
    handle,
    name,
    myHand() {
      if (!view?.hand || me === null) return null;
      const s = view.seats[me];
      if (!s.hole || !s.inHand || view.hand.board.length < 3) return null;
      return describeHand(eval7([s.hole[0], s.hole[1], ...view.hand.board]));
    },
  };

  /** Your turn starts or ends: write the turn at most twice per turn, and run a pre-action. */
  const refreshTurn = (): void => {
    const next = view && me !== null && view.hand && view.hand.toAct === me ? legal(view, me) : null;
    if (!next) {
      if (turn) {
        turn = null;
        o.onChange('turn');
      }
      return;
    }
    if (turn && turn.currentBet === next.currentBet && turn.toCall === next.toCall && view?.hand?.turnQ === turnQ) return;
    turnQ = view?.hand?.turnQ ?? -1;
    const s = (view as TableState).seats[me as number];
    turn = { ...next, seat: me as number, stack: s.stack, sb: (view as TableState).level.sb };
    o.onChange('turn');
    firePreAction(turn);
  };
  let turnQ = -1;

  const firePreAction = (t: Turn): void => {
    const p = model.preAction;
    if (!p) return;
    model.preAction = null;
    if (p === 'checkFold') o.act(t.canCheck ? 'x' : 'f');
    else if (p === 'check') {
      if (t.canCheck) o.act('x');
    } else if (p === 'call') {
      if (t.canCheck) o.act('x');
      else if (t.toCall === model.preCall) o.act(t.call >= t.stack ? 'a' : 'c');
    } else if (p === 'callAny') o.act(t.canCheck ? 'x' : t.call >= t.stack ? 'a' : 'c');
  };

  /** A "Call X" pre-action is cleared when the amount changes. */
  const checkPreCall = (): void => {
    if (model.preAction !== 'call' || !view?.hand || me === null) return;
    const s = view.seats[me];
    if (view.hand.currentBet - s.streetBet !== model.preCall) {
      model.preAction = null;
      o.onChange('seat');
    }
  };

  const startRecord = (no: number, d: Record<string, unknown>): void => {
    const v = view as TableState;
    const cfg = v.config;
    const label =
      cfg.format === 'open' && cfg.tier
        ? tierLabel(cfg.tier)
        : (cfg.format === 'cup' ? 'Lamplight Cup ' : 'Firefly Trio ') + v.level.sb + '/' + v.level.bb;
    current = {
      no,
      at: o.now(),
      label,
      lines: [],
      net: 0,
      pot: 0,
      cr: typeof d.cr === 'string' ? d.cr : null,
      seen: [],
      seed: typeof d.sd === 'number' ? d.sd : null,
      done: false,
    };
    history.unshift(current);
    if (history.length > 50) history.length = 50;
  };

  const line = (text: string, speak = true): void => {
    current?.lines.push(text);
    if (speak) o.announce(text);
  };

  /** What you saw of the deck, by position, for the proof. */
  const recordSeen = (): void => {
    if (!current || !view?.hand) return;
    const pos = dealPositions(view);
    const seen: { i: number; c: Card }[] = [];
    view.seats.forEach((s) => {
      const at = pos.holes.get(s.seat);
      if (!at || !s.hole || !(s.seat === me || s.shown)) return;
      seen.push({ i: at[0], c: s.hole[0] }, { i: at[1], c: s.hole[1] });
    });
    view.hand.board.forEach((c, k) => seen.push({ i: pos.board[k], c }));
    current.seen = seen;
  };

  function handle(nameIn: string, data: unknown): void {
    const d = (data ?? {}) as Record<string, unknown>;
    const now = o.now() - o.linkMs();
    if (nameIn === 'lamplight:snap') {
      view = fromSnap(d as unknown as WireSnap, now);
      lastQ = view.q;
      me = typeof d.me === 'number' ? d.me : findMe();
      local = d.local === 1;
      balance = typeof d.bal === 'number' ? d.bal : balance;
      payouts = Array.isArray(d.pay) ? (d.pay as number[]) : payouts;
      buyIn = typeof d.bi === 'number' ? d.bi : buyIn;
      if (d.res && typeof d.res === 'object') result = d.res as { place: number; prize: number };
      o.onChange('seat');
      o.onChange('view');
      refreshTurn();
      return;
    }
    if (!view) return;
    if (nameIn === 'lamplight:hole') {
      if (!applyEvent(view, nameIn, d, now, me)) return;
      if (current && me !== null && view.seats[me].hole) line('Your cards: ' + formatCards(view.seats[me].hole as Card[]), false);
      o.onChange('view');
      return;
    }
    if (nameIn === 'lamplight:emote') {
      o.onEffect({ k: 'emote', s: Number(d.s), id: Number(d.id) });
      return;
    }
    const q = typeof d.q === 'number' ? d.q : -1;
    if (q <= lastQ) return;
    if (q > lastQ + 1) {
      o.sync(lastQ);
      return;
    }
    const before = view.hand ? view.hand.street : null;
    const ok = applyEvent(view, nameIn, d, now, me);
    if (!ok) {
      o.sync(-1);
      return;
    }
    lastQ = q;
    const v = view;
    switch (nameIn) {
      case 'lamplight:hand': {
        me = me ?? findMe();
        startRecord(Number(d.no), d);
        const dealt = v.seats.filter((s) => s.inHand).map((s) => s.seat);
        line('Hand ' + d.no + ' · ' + (current?.label ?? '') + ' · ' + name(Number(d.btn)) + ' has the button', false);
        o.onEffect({ k: 'deal', seats: dealt });
        break;
      }
      case 'lamplight:act': {
        const s = Number(d.s);
        const k = String(d.k);
        const amount = Number(d.a);
        const verb = (s === me ? VERB_YOU[k] : VERB[k]) ?? k;
        const text = name(s) + ' ' + verb + (k === 'c' || k === 'b' || k === 'r' ? ' ' + fullChips(amount) : k === 'a' ? ' (' + fullChips(amount) + ')' : '') + (d.to === 1 ? ' (time)' : '');
        line(text);
        const label = k === 'f' ? 'Fold' : k === 'x' ? 'Check' : k === 'c' ? 'Call ' + chips(amount) : k === 'b' ? 'Bet ' + chips(amount) : k === 'r' ? 'Raise ' + chips(amount) : 'All-in';
        o.onEffect({ k: 'act', s, label, kind: k, amount });
        checkPreCall();
        break;
      }
      case 'lamplight:street': {
        const cards = (d.c as Card[]) ?? [];
        const st = String(d.st);
        line(st[0].toUpperCase() + st.slice(1) + ': ' + formatCards(cards));
        o.onEffect({ k: 'street', n: cards.length });
        if (before !== v.hand?.street) checkPreCall();
        break;
      }
      case 'lamplight:show': {
        const rv = Array.isArray(d.rv) ? (d.rv as { s: number; c: Card[] }[]) : [];
        const board = v.hand?.board ?? [];
        for (const r of rv) {
          const words = board.length >= 3 ? ' · ' + describeHand(eval7([...r.c, ...board])) : '';
          line(name(r.s) + ' shows ' + formatCards(r.c) + words);
        }
        if (rv.length > 0) o.onEffect({ k: 'reveal', seats: rv.map((r) => r.s) });
        if (Array.isArray(d.pots)) {
          const pots = d.pots as { a: number; w: number[]; each: number }[];
          let total = 0;
          for (const p of pots) {
            total += p.a;
            line(p.w.map(name).join(' and ') + (p.w.length > 1 ? ' split ' : p.w[0] === me ? ' win ' : ' wins ') + fullChips(p.a) + (pots.length > 1 ? ' (' + (pots.indexOf(p) === 0 ? 'main pot' : 'side pot') + ')' : ''));
          }
          if (current) current.pot = total;
          recordSeen();
          o.onEffect({ k: 'win', pots: pots.map((p) => ({ a: p.a, w: p.w })) });
        }
        break;
      }
      case 'lamplight:end': {
        if (current && me !== null) {
          const s = v.seats[me];
          current.net = s.inHand ? s.stack - s.startStack : 0;
        }
        if (current) {
          current.done = true;
          if (!current.seen.length) recordSeen();
        }
        if (typeof d.void === 'string') {
          line('This hand is void; the chips went back as they were at the start of the hand.');
          o.onEffect({ k: 'void', reason: d.void });
        }
        break;
      }
      case 'lamplight:seat': {
        const s = Number(d.s);
        if (s === me && v.seats[s].status === 'empty') me = null;
        if (me === null) me = findMe();
        if (s === me) o.onChange('seat');
        break;
      }
      case 'lamplight:trio': {
        o.onEffect({ k: 'trio', mult: Number(d.mult), pool: Number(d.pool) });
        payouts = Array.isArray(d.pay) ? (d.pay as number[]) : payouts;
        line('Firefly multiplier ×' + d.mult + ': the pool is ' + fullChips(Number(d.pool)));
        break;
      }
      case 'lamplight:cupEnd': {
        const places = Array.isArray(d.places) ? (d.places as { a: string | null; b: string | null; p: number; won: number }[]) : [];
        const shown = places.map((p) => {
          const seatOf = v.seats.find((s) => (p.a && s.player?.accountId === p.a) || (p.b && s.player?.botId === p.b));
          return { name: seatOf ? name(seatOf.seat) : p.b ? botName(p.b) : 'Player', p: p.p, won: p.won, me: seatOf?.seat === me };
        });
        const mine = shown.find((p) => p.me);
        if (mine) result = { place: mine.p, prize: mine.won };
        o.onEffect({ k: 'cupEnd', places: shown });
        o.onChange('seat');
        break;
      }
      default:
        break;
    }
    o.onChange('view');
    refreshTurn();
  }

  return model;
};

/** The pot in the middle, current bets included. */
export const potOf = (view: TableState): number => potTotal(view);

