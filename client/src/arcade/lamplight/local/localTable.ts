/**
 * The offline table (lamplight.md §10–11): a `LocalTableServer` that runs the shared engine on the
 * device, with you in seat 0 and bots in the rest, and emits the same events as the server, a
 * microtask later. The shuffle is xoshiro128** seeded from `crypto.getRandomValues` (each hand's
 * seed goes into the history); chips are Practice chips.
 *
 * One timer at a time, armed for the earliest of: a bot's act time, the next runout street, the
 * next hand, or your clock. Hidden means paused: the timer is cleared, bots stop, the Worker is
 * stopped, and on return every clock is shifted by the time spent hidden.
 */
import { BOTS, thinkMs } from '@arcade/core/lamplight/bots';
import { newDeck, shuffle } from '@arcade/core/lamplight/cards';
import {
  act,
  advance,
  canStartHand,
  createTable,
  creditDeadline,
  pendingDelay,
  RUNOUT_MS,
  seat as seatPlayer,
  setLevel,
  showUncontested,
  startBank,
  startHand,
  timeout,
  updateSeat,
  type Action,
  type BotLevel,
  type EngineEvent,
  type Format,
  type TableState,
  type Tier,
} from '@arcade/core/lamplight/engine';
import { bustGroups, cupPercents, settlePlaces, splitPool } from '@arcade/core/lamplight/payouts';
import { BUY_IN_BB, cashLevel, CUP_STACK, levelAt, tableConfig, TIER_BLINDS, TRIO_STACK } from '@arcade/core/lamplight/schedule';
import { DEFAULT_TRIO_TABLE, drawMultiplier, TRIO_SPACE } from '@arcade/core/lamplight/trio';
import { holeEvent, publicEvent, snapFor, stampMs, viewFor } from '@arcade/core/lamplight/views';
import { randInt, seedXoshiro, xoshiro128ss } from '@arcade/core/rng';
import type { LocalTableServer, PracticeWallet } from '../../runtime/types';
import { createThinkService, type ThinkService } from './thinkerMain';

export const ME = 0;
export const LOCAL_ID = 'local';
/** The Firefly reveal runs 3 s; the first hand comes 3.5 s after the draw. */
export const TRIO_DEAL_MS = 3500;

export interface LocalTableOpts {
  mode: Format;
  tier: Tier;
  players: number;
  bots: BotLevel;
  buyIn: number;
  seed: Uint32Array;
  me: { accountId: string | null };
  practice: PracticeWallet;
  fast?: boolean;
  now?: () => number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(h: unknown): void };
  think?: ThinkService;
}

export interface LocalTable extends LocalTableServer {
  readonly state: TableState;
  /** Places at the end of a Cup or Trio (seat → place), or null while it runs. */
  readonly result: { place: number; prize: number } | null;
}

type Wake = 'advance' | 'nextHand' | 'botAct' | 'clock' | 'trioDeal';

export const createLocalTable = (o: LocalTableOpts): LocalTable => {
  const now = o.now ?? (() => performance.now());
  const timers = o.timers ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const think = o.think ?? createThinkService();
  const rngState = new Uint32Array(4);
  rngState.set(o.seed.subarray(0, 4));
  if ((rngState[0] | rngState[1] | rngState[2] | rngState[3]) === 0) seedXoshiro(1, rngState);
  const u32 = () => xoshiro128ss(rngState);
  const unit = () => u32() / 4294967296;

  const format = o.mode;
  const tier = o.tier;
  const players = format === 'trio' ? 3 : Math.max(2, Math.min(9, o.players));
  const config = tableConfig({ format, tier, seats: players, bots: o.bots });
  const level0 = format === 'open' ? cashLevel(tier) : levelAt(format, { hands: 0 });
  const state = createTable(LOCAL_ID, config, level0);
  const ref = 'lamplight:' + format;
  const bb = TIER_BLINDS[tier].bb;
  let fast = o.fast ?? false;

  let emitFn: ((ev: string, data: unknown) => void) | null = null;
  let outbox: [string, unknown][] = [];
  let flushing = false;
  const send = (name: string, data: unknown): void => {
    outbox.push([name, data]);
    if (flushing) return;
    flushing = true;
    queueMicrotask(() => {
      flushing = false;
      const batch = outbox;
      outbox = [];
      for (const [n, d] of batch) emitFn?.(n, d);
    });
  };
  /** Public events, plus your hole cards after each deal, with `ms` stamped now. */
  const emitAll = (events: readonly EngineEvent[], extra?: Record<string, unknown>): void => {
    const t = now();
    for (const e of events) {
      const out = publicEvent(e, LOCAL_ID);
      const data = stampMs(out.data, out.dl, t);
      if (e.ev === 'hand' && extra) Object.assign(data, extra);
      send(out.name, data);
      if (e.ev === 'hand') {
        const hole = holeEvent(state, ME, LOCAL_ID);
        if (hole && state.seats[ME].inHand) send('lamplight:hole', hole);
      }
    }
  };

  // ---------------------------------------------------------------- seats
  const order = BOTS.map((b) => b.id);
  shuffle(order, (n) => randInt(u32, n));
  const botIds: (string | null)[] = new Array(players).fill(null);
  const seatBot = (n: number, stack: number): void => {
    const id = botIds[n] ?? order[(n - 1) % order.length];
    botIds[n] = id;
    seatPlayer(state, n, { accountId: null, botId: id, avatarSeed: n * 977 }, stack);
    state.seats[n].status = 'active';
    state.seats[n].post = null;
  };
  const meRef = { accountId: o.me.accountId ?? 'local:me', botId: null, avatarSeed: 1 };
  const cashBuyIn = BUY_IN_BB.default * bb;
  let joined = false;

  /** Keep the open escrow equal to your table stack, so closing the app mid-table returns it. */
  const syncEscrow = (stack: number): void => {
    const p = o.practice;
    const held = p.release(ref);
    if (stack > held) p.credit(stack - held, ref);
    else if (held > stack) p.debit(held - stack, ref);
    if (stack > 0) p.escrow(ref, stack);
  };

  const join = (buyIn: number): boolean => {
    if (joined) return true;
    const cost = format === 'open' ? Math.max(config.buyInMin, Math.min(config.buyInMax, buyIn)) : o.buyIn;
    if (o.practice.balance() < cost) return false;
    o.practice.escrow(ref, cost);
    const stack = format === 'open' ? cost : format === 'cup' ? CUP_STACK : TRIO_STACK;
    seatPlayer(state, ME, meRef, stack);
    state.seats[ME].status = 'active';
    state.seats[ME].post = null;
    for (let n = 1; n < players; n++) seatBot(n, format === 'open' ? cashBuyIn : stack);
    joined = true;
    return true;
  };

  // ---------------------------------------------------------------- tournament results
  let result: { place: number; prize: number } | null = null;
  let over = false;
  /** Prize per place (1st first). */
  let prizes: number[] = [];
  let remaining = players;
  const placesBySeat = new Map<number, number>();

  const startTournament = (): EngineEvent[] => {
    const pool = o.buyIn * players;
    if (format === 'cup') {
      prizes = splitPool(pool, cupPercents(players));
      state.prizePool = pool;
      return [];
    }
    const row = drawMultiplier(DEFAULT_TRIO_TABLE, randInt(u32, TRIO_SPACE));
    const trioPool = o.buyIn * row.mult;
    prizes = splitPool(trioPool, row.pay);
    state.prizePool = trioPool;
    state.multiplier = row.mult;
    const out: EngineEvent[] = [];
    state.q += 1;
    out.push({ ev: 'trio', q: state.q, mult: row.mult, pool: trioPool, pay: prizes });
    return out;
  };

  /** After a tournament hand: record busts, and end when you are out or have won. */
  const settleTournament = (): EngineEvent[] => {
    const hand = state.hand;
    if (!hand) return [];
    const busted = state.seats.filter((s) => s.inHand && s.stack === 0 && !placesBySeat.has(s.seat));
    if (busted.length > 0) {
      const groups = bustGroups(
        busted.map((s) => ({ id: String(s.seat), startStack: s.startStack, seat: s.seat })),
        hand.button,
        players,
      );
      const left = remaining - busted.length;
      let place = left + 1;
      for (const g of groups) {
        for (const id of g) placesBySeat.set(Number(id), place);
        place += g.length;
      }
      remaining = left;
    }
    const meOut = placesBySeat.has(ME);
    if (!meOut && remaining > 1) return [];
    if (!meOut) placesBySeat.set(ME, 1);
    for (const s of state.seats) if (!placesBySeat.has(s.seat) && s.stack > 0) placesBySeat.set(s.seat, 1);
    // Prizes by place groups (ties share), best first.
    const byPlace = new Map<number, string[]>();
    for (const [s, p] of placesBySeat) byPlace.set(p, [...(byPlace.get(p) ?? []), String(s)]);
    const groups = [...byPlace.entries()].sort((a, b) => a[0] - b[0]).map(([, ids]) => ids);
    const won = settlePlaces(prizes, groups);
    const myPlace = placesBySeat.get(ME) ?? players;
    const myPrize = won.get(String(ME)) ?? 0;
    result = { place: myPlace, prize: myPrize };
    over = true;
    o.practice.release(ref);
    o.practice.debit(o.buyIn, ref);
    if (myPrize > 0) o.practice.credit(myPrize, ref);
    state.q += 1;
    const places = state.seats
      .filter((s) => s.player)
      .map((s) => ({ a: s.player?.accountId ?? null, b: s.player?.botId ?? null, p: placesBySeat.get(s.seat) ?? players, won: won.get(String(s.seat)) ?? 0 }))
      .sort((a, b) => a.p - b.p);
    return [{ ev: 'cupEnd', q: state.q, places }];
  };

  // ---------------------------------------------------------------- the clock
  let paused = false;
  let pausedAt = 0;
  let disposed = false;
  let timer: unknown = null;
  let wake: { at: number; what: Wake } | null = null;
  let nextHandAt = 0;
  let trioDealAt = 0;
  let handDone = true;
  let bot: { key: string; startedAt: number; thinkMs: number; action: Action | null; readyAt: number } | null = null;

  const disarm = (): void => {
    if (timer !== null) timers.clear(timer);
    timer = null;
    wake = null;
  };
  const arm = (at: number, what: Wake): void => {
    disarm();
    wake = { at, what };
    timer = timers.set(onWake, Math.max(0, at - now()));
  };

  const turnKey = (): string => (state.hand ? state.hand.handNo + ':' + state.hand.turnQ : '');

  const nextHand = (): void => {
    if (over || disposed) return;
    if (format !== 'open') {
      const lv = levelAt(format, { hands: state.handsPlayed });
      if (lv.index !== state.level.index) emitAll(setLevel(state, lv));
    }
    if (!canStartHand(state)) return;
    const handSeed = u32();
    const deckRng = seedXoshiro(handSeed);
    const deck = shuffle(newDeck(), (n) => randInt(() => xoshiro128ss(deckRng), n));
    const r = startHand(state, deck, now(), randInt(u32, players));
    if (!r.ok) return;
    handDone = false;
    emitAll(r.events, { sd: handSeed });
  };

  const endOfHand = (): void => {
    handDone = true;
    const events: EngineEvent[] = [];
    if (format === 'open') {
      syncEscrow(state.seats[ME].stack);
      // Bots buy back in at 100 big blinds.
      for (let n = 1; n < players; n++) {
        const s = state.seats[n];
        if (s.player && s.stack === 0) events.push(...updateSeat(state, n, { status: 'active', stack: cashBuyIn }));
      }
    } else events.push(...settleTournament());
    emitAll(events);
  };

  /** Run whatever is due now, then arm the timer for the next thing. */
  const pump = (): void => {
    if (paused || disposed || !joined) return;
    for (let guard = 0; guard < 16; guard++) {
      const delay = pendingDelay(state, fast ? 0 : RUNOUT_MS);
      if (delay === null) break;
      if (delay > 0) {
        arm(now() + delay, 'advance');
        return;
      }
      const events = advance(state, now());
      emitAll(events);
      const end = events.find((e) => e.ev === 'end');
      if (end && end.ev === 'end') {
        endOfHand();
        nextHandAt = now() + (fast ? end.next / 2 : end.next);
      }
    }
    const hand = state.hand;
    if (over) {
      disarm();
      return;
    }
    if (!hand || hand.street === 'done') {
      if (!handDone) {
        endOfHand();
        nextHandAt = now() + 3000;
      }
      // Offline the bots never play on without you: a busted or sitting-out cash seat pauses the table.
      const mine = state.seats[ME];
      const ready = format !== 'open' || (mine.stack > 0 && (mine.status === 'active' || mine.status === 'waiting'));
      if (trioDealAt > now()) arm(trioDealAt, 'trioDeal');
      else if (ready && canStartHand(state)) arm(Math.max(now(), nextHandAt), 'nextHand');
      else disarm();
      return;
    }
    const seatNo = hand.toAct;
    if (seatNo < 0) {
      disarm();
      return;
    }
    if (seatNo === ME) {
      bot = null;
      arm(hand.deadline, 'clock');
      return;
    }
    const s = state.seats[seatNo];
    // Sitting out (two timeouts) acts at once.
    if (!s.player?.botId) {
      arm(hand.deadline, 'clock');
      return;
    }
    const key = turnKey();
    if (!bot || bot.key !== key) {
      bot = { key, startedAt: now(), thinkMs: thinkMs(format, fast, unit()), action: null, readyAt: 0 };
      const mine = bot;
      void think.think({ view: viewFor(state, seatNo), seat: seatNo, level: o.bots, seed: u32() || 1 }).then((action) => {
        if (bot !== mine || disposed) return;
        mine.action = action;
        mine.readyAt = Math.max(mine.startedAt + mine.thinkMs, now());
        pump();
      });
    }
    if (bot.action) arm(bot.readyAt, 'botAct');
    else disarm();
  };

  const onWake = (): void => {
    timer = null;
    const w = wake;
    wake = null;
    if (!w || paused || disposed) return;
    const hand = state.hand;
    if (w.what === 'advance') {
      const events = advance(state, now());
      emitAll(events);
      const end = events.find((e) => e.ev === 'end');
      if (end && end.ev === 'end') {
        endOfHand();
        nextHandAt = now() + (fast ? end.next / 2 : end.next);
      }
    } else if (w.what === 'nextHand' || w.what === 'trioDeal') {
      trioDealAt = 0;
      nextHand();
    } else if (w.what === 'botAct' && hand && bot?.action && bot.key === turnKey()) {
      const seatNo = hand.toAct;
      const r = act(state, seatNo, bot.action, now());
      bot = null;
      emitAll(r.ok ? r.events : timeoutEvents(seatNo));
    } else if (w.what === 'clock' && hand && hand.toAct >= 0) {
      const seatNo = hand.toAct;
      const s = state.seats[seatNo];
      const bank = !hand.bank && s.timeBankMs > 0 && s.timeouts < 2 ? startBank(state, now()) : [];
      emitAll(bank.length > 0 ? bank : timeoutEvents(seatNo));
    }
    pump();
  };

  const timeoutEvents = (seatNo: number): EngineEvent[] => {
    const r = timeout(state, seatNo, now());
    return r.ok ? r.events : [];
  };

  // ---------------------------------------------------------------- requests
  const ok = (extra?: Record<string, unknown>) => Promise.resolve({ ok: true, ...extra });
  const no = (code: string) => Promise.resolve({ ok: false, code });

  const snap = (): Record<string, unknown> => {
    const s = snapFor(state, joined ? ME : null, LOCAL_ID, now()) as unknown as Record<string, unknown>;
    s.local = 1;
    s.bal = o.practice.balance();
    if (format !== 'open') {
      s.bi = o.buyIn;
      s.pay = prizes;
    }
    if (result) s.res = result;
    return s;
  };

  const KIND: Record<string, Action['kind']> = { f: 'fold', x: 'check', c: 'call', b: 'bet', r: 'raise', a: 'allin' };

  const request = (ev: string, data: unknown): Promise<unknown> => {
    if (disposed) return no('closed');
    const d = (data ?? {}) as Record<string, unknown>;
    switch (ev) {
      case 'lamplight:sync': {
        send('lamplight:snap', snap());
        return ok({ mode: 'snap' });
      }
      case 'lamplight:join':
      case 'lamplight:sit': {
        if (joined) return ok();
        if (!join(typeof d.buyIn === 'number' ? d.buyIn : cashBuyIn)) return no('funds');
        let extra: EngineEvent[] = [];
        if (format !== 'open') extra = startTournament();
        send('lamplight:snap', snap());
        emitAll(extra);
        if (format === 'trio') trioDealAt = now() + (fast ? 1500 : TRIO_DEAL_MS);
        else nextHandAt = now() + 600;
        handDone = true;
        pump();
        return ok();
      }
      case 'lamplight:act': {
        const kind = KIND[String(d.k)];
        if (!kind) return no('illegal');
        const action = (kind === 'bet' || kind === 'raise' ? { kind, to: Number(d.a) } : { kind }) as Action;
        const r = act(state, ME, action, now(), { h: Number(d.h), q: Number(d.q) });
        if (!r.ok) return no(r.code);
        emitAll(r.events);
        pump();
        return ok();
      }
      case 'lamplight:sitOut': {
        if (format !== 'open' || !joined) return no('illegal');
        const s = state.seats[ME];
        const on = d.on === true;
        if (on && (s.status === 'active' || s.status === 'waiting')) emitAll(updateSeat(state, ME, { status: 'sittingOut' }));
        else if (!on && s.status === 'sittingOut') {
          s.timeouts = 0;
          emitAll(updateSeat(state, ME, s.missedBB ? { status: 'waiting', post: d.post === 'now' ? 'now' : 'wait' } : { status: 'active' }));
        }
        pump();
        return ok();
      }
      case 'lamplight:topUp': {
        if (format !== 'open' || !joined) return no('illegal');
        const s = state.seats[ME];
        if (state.hand && state.hand.street !== 'done' && s.inHand) return no('busy');
        const room = config.buyInMax - s.stack;
        const want = Math.max(0, Math.min(room, Math.floor(Number(d.amount) || 0)));
        if (s.stack === 0 && want < config.buyInMin) return no('amount');
        if (want === 0 || o.practice.balance() < want) return no('funds');
        o.practice.escrow(ref, want);
        emitAll(updateSeat(state, ME, { stack: s.stack + want, status: s.status === 'busted' ? 'active' : s.status }));
        pump();
        return ok();
      }
      case 'lamplight:refill': {
        o.practice.refill(format === 'open' ? config.buyInMin : o.buyIn);
        return ok({ bal: o.practice.balance() });
      }
      case 'lamplight:show': {
        emitAll(showUncontested(state, ME));
        return ok();
      }
      case 'lamplight:fast': {
        fast = d.on === true;
        return ok();
      }
      case 'lamplight:leave': {
        if (format === 'open') o.practice.release(ref);
        return ok();
      }
      case 'lamplight:emote': {
        // Offline the emote shows on your own seat only.
        if (joined) send('lamplight:emote', { t: LOCAL_ID, s: ME, id: Number(d.id) || 0 });
        return ok();
      }
      default:
        return no('unknown');
    }
  };

  return {
    state,
    get result() {
      return result;
    },
    request,
    attach(emit) {
      emitFn = emit;
    },
    setVisible(visible) {
      if (disposed) return;
      if (!visible) {
        if (paused) return;
        paused = true;
        pausedAt = now();
        disarm();
        think.idle();
        bot = null;
        return;
      }
      if (!paused) return;
      paused = false;
      const shift = now() - pausedAt;
      nextHandAt += shift;
      if (trioDealAt > 0) trioDealAt += shift;
      const hand = state.hand;
      if (hand && hand.toAct >= 0 && shift > 0) {
        if (hand.bank) hand.bankStart += shift;
        emitAll(creditDeadline(state, shift));
      }
      pump();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      disarm();
      think.dispose();
      emitFn = null;
      outbox = [];
      // A cash stack goes back to the balance; an unfinished tournament buy-in too (as a restart would).
      if (joined && !over) o.practice.release(ref);
    },
  };
};
