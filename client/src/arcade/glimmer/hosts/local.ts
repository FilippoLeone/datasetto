/**
 * The offline hall (glimmerhall.md §13–§14): the same `glimmer:*` events the server answers, run on
 * the device against four bot neighbours, with the shared Practice chips. It needs no socket, no
 * /api/config and no account, and costs the server nothing.
 *
 * - Spins run the shared engine with the device's crypto RNG. There is no Glimmer Pot offline.
 * - Bots spin only while the hall is visible: one timer, armed for the soonest bot. Hidden means
 *   frozen, with no catch-up; the offline Dash clock stops too.
 * - A pending vault (its base spin already took the chips) and offline stats live in
 *   `datasetto.arcade.glimmer.v1`.
 * - The offline Dash: the same rules, the bots as entrants, a Practice buy-in held in escrow until it
 *   ends (an escrow left open by a closed page goes back to the balance on the next start).
 */
import { BOTS, botAfterSpin, botBet, botDelay, botReacts, createBot, type BotState } from '@arcade/core/glimmer/bots';
import { dashPayout } from '@arcade/core/glimmer/dash';
import { shuffleDoors } from '@arcade/core/glimmer/feature';
import { DASH_BET, DASH_SPINS, betAllowed, isMachineIdx, machineDef, type MachineIdx } from '@arcade/core/glimmer/machines';
import { openVault, playFeature, spinBase, type FeatureResult, type Rng } from '@arcade/core/glimmer/spin';
import {
  DASH_BUYINS,
  DASH_LENGTHS,
  DASH_LOBBY_MS,
  DASH_ST,
  NOTABLE_X,
  REACT_GAP_MS,
  encodeStops,
  isSpinId,
  wireFeature,
  type DashSpinOk,
  type DashView,
  type EnterOk,
  type FeedEntry,
  type FeedView,
  type MemberRow,
  type PickOk,
  type Refused,
  type SpinOk,
  type WireFeature,
} from '@arcade/core/glimmer/wire';
import { practiceWallet } from '@/arcade/runtime/practiceWallet';
import type { LocalTableServer, PracticeWallet } from '@/arcade/runtime/types';
import { cryptoRng } from '../rng';
import { GLIMMER_KEY, loadDevice, saveDevice, type DeviceState } from '../store';

export const LOCAL_MAX_BET = 500;
/** Bots' account ids on the offline wire: `bot:<name>`. */
export const botAccount = (name: string): string => 'bot:' + name;

export interface LocalHallOptions {
  wallet?: PracticeWallet;
  rng?: Rng;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  storeKey?: string;
  /** Bots in the hall (default all four). */
  bots?: number;
}

interface Member {
  slot: number;
  acct: string;
  bot: BotState | null;
  lw: number;
  lx: number;
  nextAt: number;
}

interface Entrant {
  slot: number;
  score: number;
  left: number;
  finishedAt: number;
  order: number;
  nextAt: number;
}

interface LocalDash {
  id: string;
  st: 0 | 1 | 2 | 3;
  m: MachineIdx;
  len: number;
  buy: number;
  /** Lobby or play time left while frozen; `deadline` while running visibly. */
  remaining: number;
  deadline: number;
  entrants: Entrant[];
  pay: number[] | null;
}

const refuse = (code: string): Refused => ({ ok: false, code });

export interface LocalHall extends LocalTableServer {
  /** Test hooks. */
  readonly debug: {
    members(): readonly { slot: number; acct: string; machine: MachineIdx; bankroll: number | null }[];
    dash(): DashView | null;
    timers(): number;
    /** Tests and dev checks only: the next draws return these values (mod n). */
    rig(values: readonly number[]): void;
    /** Bot spins so far (hall and Dash). */
    botSpins(): number;
  };
}

export const createLocalHall = (o: LocalHallOptions = {}): LocalHall => {
  const wallet = o.wallet ?? practiceWallet;
  const draw = o.rng ?? cryptoRng();
  const rigged: number[] = [];
  const rng: Rng = (n) => (rigged.length > 0 ? (rigged.shift() as number) % n : draw(n));
  const now = o.now ?? (() => Date.now());
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const key = o.storeKey ?? GLIMMER_KEY;

  let emit: ((ev: string, data: unknown) => void) | null = null;
  let visible = true;
  let disposed = false;
  let botTimer: unknown = null;
  let dashTimer: unknown = null;
  let lastReact = -Infinity;
  const device: DeviceState = loadDevice(key);
  const acks = new Map<string, unknown>();
  let dash: LocalDash | null = null;
  let dashSeq = 0;

  const members: Member[] = [{ slot: 0, acct: 'me', bot: null, lw: 0, lx: 0, nextAt: 0 }];
  const botCount = Math.max(0, Math.min(4, o.bots ?? 4));
  for (let i = 0; i < botCount; i += 1) {
    const def = BOTS[i];
    if (!def) continue;
    members.push({ slot: i + 1, acct: botAccount(def.name), bot: createBot(i, rng), lw: 0, lx: 0, nextAt: 0 });
  }

  const remember = (id: string, ack: unknown): void => {
    acks.set(id, ack);
    if (acks.size > 32) acks.delete(acks.keys().next().value as string);
  };

  const send = (view: FeedView): void => {
    if (!disposed && emit && (view.e || view.r || view.h || view.d || view.p !== undefined)) emit('glimmer:feed', view);
  };

  const machineOf = (m: Member): MachineIdx => (m.bot ? m.bot.machine : 1);

  const playFor = (m: MachineIdx, bet: number, base: { trigger: boolean }, inDash: boolean): { f: FeatureResult | null; pending: number[] | null } => {
    const def = machineDef(m);
    if (!base.trigger) return { f: null, pending: null };
    if (def.feature.kind !== 'vault') return { f: playFeature(def, bet, rng), pending: null };
    const doors = shuffleDoors(rng);
    // Bots and Dash spins open a vault at once (a server-random door).
    if (inDash) return { f: openVault(def, bet, rng, doors, rng(3)), pending: null };
    return { f: null, pending: doors };
  };

  /** A notable result from a member: a feed entry, the friends strip's last win, Wex's sparkle. */
  const notable = (slot: number, m: MachineIdx, bet: number, total: number, feature: boolean, out: FeedView): void => {
    const x100 = Math.floor((total * 100) / bet);
    if (!feature && total < bet * NOTABLE_X) return;
    (out.e ??= []).push([slot, m, bet, total, feature ? 1 : 0] as FeedEntry);
    const member = members.find((x) => x.slot === slot);
    if (member) {
      member.lw = total;
      member.lx = x100;
    }
    for (const b of members) {
      if (b.bot && b.slot !== slot && botReacts(b.bot, x100)) (out.r ??= []).push([b.slot, slot, 0]);
    }
  };

  // ------------------------------------------------------------------ bots

  /** A bot playing its Dash spins takes no hall spins meanwhile. */
  const inDash = (slot: number): boolean => dash?.st === DASH_ST.running && dash.entrants.some((e) => e.slot === slot && e.left > 0);

  const armBots = (): void => {
    if (botTimer !== null) clearTimer(botTimer);
    botTimer = null;
    if (disposed || !visible) return;
    let soonest = Infinity;
    for (const m of members) if (m.bot && !inDash(m.slot) && m.nextAt < soonest) soonest = m.nextAt;
    if (dash?.st === DASH_ST.running) for (const e of dash.entrants) if (e.slot !== 0 && e.left > 0 && e.nextAt < soonest) soonest = e.nextAt;
    if (soonest === Infinity) return;
    botTimer = setTimer(runBots, Math.max(0, soonest - now()));
  };

  let botSpins = 0;
  const botSpin = (m: Member, at: number, out: FeedView): void => {
    botSpins += 1;
    const bot = m.bot as BotState;
    const before = bot.machine;
    const def = machineDef(bot.machine);
    const bet = botBet(bot);
    const base = spinBase(def, bet, rng);
    let total = base.win;
    let f: FeatureResult | null = null;
    if (base.trigger) {
      f = def.feature.kind === 'vault' ? openVault(def, bet, rng, shuffleDoors(rng), rng(3)) : playFeature(def, bet, rng);
      total += f.win;
    }
    notable(m.slot, before, bet, total, base.trigger, out);
    const moved = botAfterSpin(bot, { win: total, bet, feature: base.trigger }, rng, at).moved;
    if (moved) (out.e ??= []).push([m.slot, bot.machine, 0, 0, 3]);
    if (moved) (out.h ??= []).push([m.slot, m.acct, bot.machine, 0]);
    m.nextAt = at + botDelay(bot, rng, at, false);
  };

  const dashBotSpin = (e: Entrant, at: number): void => {
    if (!dash) return;
    botSpins += 1;
    const def = machineDef(dash.m);
    const base = spinBase(def, DASH_BET, rng);
    const { f } = playFor(dash.m, DASH_BET, base, true);
    e.score += base.win + (f?.win ?? 0);
    e.left -= 1;
    if (e.left === 0) e.finishedAt = at;
    const member = members.find((x) => x.slot === e.slot);
    e.nextAt = member?.bot ? at + botDelay(member.bot, rng, at, true) : Infinity;
  };

  const runBots = (): void => {
    botTimer = null;
    if (disposed || !visible) return;
    const at = now();
    const out: FeedView = {};
    // Bounded: each bot spins at most once per wake-up.
    for (const m of members) if (m.bot && m.nextAt <= at && !inDash(m.slot)) botSpin(m, at, out);
    if (dash?.st === DASH_ST.running) {
      for (const e of dash.entrants) if (e.slot !== 0 && e.left > 0 && e.nextAt <= at) dashBotSpin(e, at);
      if (dashDone()) finishDash(at, out);
    }
    send(out);
    armBots();
  };

  const startBots = (at: number): void => {
    for (const m of members) if (m.bot) m.nextAt = at + botDelay(m.bot, rng, at, false);
  };

  // ------------------------------------------------------------------ Dash

  const dashView = (at: number): DashView | null => {
    if (!dash) return null;
    const left = dash.st === DASH_ST.lobby || dash.st === DASH_ST.running ? (visible ? dash.deadline - at : dash.remaining) : 0;
    const s: number[] = [];
    for (const e of dash.entrants) s.push(e.slot, e.score, e.left);
    const view: DashView = { id: dash.id, st: dash.st, m: dash.m, len: dash.len, buy: dash.buy, host: 0, t: Math.max(0, Math.ceil(left / 1000)), s };
    if (dash.pay) view.pay = dash.pay;
    return view;
  };

  const dashDone = (): boolean => !!dash && dash.st === DASH_ST.running && dash.entrants.every((e) => e.left === 0);

  const armDash = (): void => {
    if (dashTimer !== null) clearTimer(dashTimer);
    dashTimer = null;
    if (disposed || !visible || !dash || (dash.st !== DASH_ST.lobby && dash.st !== DASH_ST.running)) return;
    // A 1 s scoreboard tick only while a Dash is open and the hall is visible.
    dashTimer = setTimer(dashTick, Math.max(0, Math.min(1000, dash.deadline - now())));
  };

  const dashTick = (): void => {
    dashTimer = null;
    if (!dash || disposed) return;
    const at = now();
    const out: FeedView = {};
    if (dash.st === DASH_ST.lobby && at >= dash.deadline) startDash(at);
    else if (dash.st === DASH_ST.running && (at >= dash.deadline || dashDone())) finishDash(at, out);
    out.d = dashView(at) ?? undefined;
    send(out);
    armDash();
    armBots();
  };

  const startDash = (at: number): void => {
    if (!dash) return;
    dash.st = DASH_ST.running;
    dash.deadline = at + dash.len * 60_000;
    dash.remaining = dash.len * 60_000;
    for (const e of dash.entrants) {
      const member = members.find((x) => x.slot === e.slot);
      e.nextAt = member?.bot ? at + botDelay(member.bot, rng, at, true) : Infinity;
    }
  };

  const finishDash = (at: number, out: FeedView): void => {
    if (!dash) return;
    for (const e of dash.entrants) if (e.left > 0) e.finishedAt = at;
    const pool = dash.buy * dash.entrants.length;
    const places = dashPayout(
      pool,
      dash.entrants.map((e) => ({ key: String(e.slot), score: e.score, finishedAt: e.finishedAt, order: e.order })),
    );
    const pay: number[] = [];
    for (const p of places) if (p.prize > 0 || (pool === 0 && p.place === 1)) pay.push(Number(p.key), p.prize);
    dash.pay = pay;
    dash.st = DASH_ST.done;
    startBots(at);
    // My buy-in leaves the escrow into the pool; my prize comes back as chips.
    const ref = 'dash:' + dash.id;
    if (wallet.release(ref) > 0) wallet.debit(dash.buy, ref);
    const mine = places.find((p) => p.key === '0');
    if (mine && mine.prize > 0) wallet.credit(mine.prize, ref);
    device.dash.played += 1;
    if (mine && mine.place === 1) device.dash.wins += 1;
    saveDevice(device, key);
    out.d = dashView(at) ?? undefined;
  };

  const voidDash = (): void => {
    if (!dash) return;
    wallet.release('dash:' + dash.id);
    dash.st = DASH_ST.void;
  };

  // ------------------------------------------------------------------ requests

  const enterView = (): EnterOk => {
    const mem: MemberRow[] = members.map((m) => [m.slot, m.slot === 0 ? null : m.acct, m.slot === 0 ? 1 : machineOf(m), 0, m.lw, m.lx]);
    const view: EnterOk = { ok: true, bal: wallet.balance(), pot: 0, me: 0, maxBet: LOCAL_MAX_BET, mem };
    if (device.pend) view.pend = { m: device.pend.m, bet: device.pend.bet };
    const d = dashView(now());
    if (d && d.st !== DASH_ST.void) view.dash = d;
    return view;
  };

  const recordSpin = (m: MachineIdx, bet: number, total: number): void => {
    const s = device.stats[m];
    if (!s) return;
    s.spins += 1;
    s.wagered += bet;
    s.won += total;
    if (total > s.best) s.best = total;
    const x = Math.floor((total * 100) / bet);
    if (x > s.bestx) s.bestx = x;
  };

  const spin = (data: { m?: unknown; b?: unknown; id?: unknown }): SpinOk | Refused => {
    if (!isSpinId(data.id)) return refuse('invalid');
    const seen = acks.get(data.id);
    if (seen) return seen as SpinOk;
    if (!isMachineIdx(data.m) || typeof data.b !== 'number') return refuse('invalid');
    const m = data.m;
    const bet = data.b;
    const def = machineDef(m);
    if (device.pend) return refuse('pending');
    if (!betAllowed(def, bet, LOCAL_MAX_BET)) return refuse('bet');
    if (wallet.balance() < bet || !wallet.debit(bet, 'glimmer:' + def.code)) return refuse('funds');
    const base = spinBase(def, bet, rng);
    const { f, pending } = playFor(m, bet, base, false);
    const total = base.win + (f?.win ?? 0);
    if (total > 0) wallet.credit(total, 'glimmer:' + def.code);
    const ack: SpinOk = { ok: true, id: data.id, st: encodeStops(base.stops), w: base.win, bal: wallet.balance() };
    if (f) ack.f = wireFeature(f.kind, f);
    if (pending) {
      ack.v = 1;
      device.pend = { m, bet, doors: pending };
    }
    recordSpin(m, bet, total);
    saveDevice(device, key);
    remember(data.id, ack);
    const out: FeedView = {};
    if (!pending) notable(0, m, bet, total, base.trigger, out);
    send(out);
    return ack;
  };

  const pick = (data: { door?: unknown; id?: unknown }): PickOk | Refused => {
    if (!isSpinId(data.id)) return refuse('invalid');
    const seen = acks.get(data.id);
    if (seen) return seen as PickOk;
    const door = data.door;
    if (door !== 0 && door !== 1 && door !== 2) return refuse('invalid');
    const pend = device.pend;
    if (!pend) return refuse('state');
    const def = machineDef(pend.m);
    const f = openVault(def, pend.bet, rng, pend.doors, door);
    if (f.win > 0) wallet.credit(f.win, 'glimmer:' + def.code);
    device.pend = null;
    // The feature total includes the trigger's key pay, already credited with the base spin.
    const total = f.win + (def.feature.kind === 'vault' ? def.feature.scatterPay * pend.bet : 0);
    const stats = device.stats[pend.m];
    if (stats) {
      stats.won += f.win;
      if (total > stats.best) stats.best = total;
      stats.bestx = Math.max(stats.bestx, Math.floor((total * 100) / pend.bet));
    }
    saveDevice(device, key);
    const ack: PickOk = { ok: true, id: data.id, dr: pend.doors.slice(), f: wireFeature('vault', f) as Extract<WireFeature, { k: 'v' }>, bal: wallet.balance() };
    remember(data.id, ack);
    const out: FeedView = {};
    notable(0, pend.m, pend.bet, total, true, out);
    send(out);
    return ack;
  };

  const react = (data: { to?: unknown; e?: unknown }): void => {
    const at = now();
    if (at - lastReact < REACT_GAP_MS) return;
    if (typeof data.to !== 'number' || typeof data.e !== 'number' || data.e < 0 || data.e > 5 || !Number.isInteger(data.e)) return;
    if (!members.some((m) => m.slot === data.to)) return;
    lastReact = at;
    send({ r: [[0, data.to, data.e]] });
  };

  const dashCreate = (data: { m?: unknown; len?: unknown; buy?: unknown }): { ok: true; dash: DashView; bal: number } | Refused => {
    if (!isMachineIdx(data.m) || !DASH_LENGTHS.includes(data.len as 3) || !DASH_BUYINS.includes(data.buy as 0)) return refuse('invalid');
    if (dash && (dash.st === DASH_ST.lobby || dash.st === DASH_ST.running)) return refuse('state');
    const buy = data.buy as number;
    if (wallet.balance() < buy) return refuse('funds');
    dashSeq += 1;
    const at = now();
    dash = { id: 'L' + dashSeq, st: DASH_ST.lobby, m: data.m, len: data.len as number, buy, remaining: DASH_LOBBY_MS, deadline: at + DASH_LOBBY_MS, entrants: [], pay: null };
    if (buy > 0) wallet.escrow('dash:' + dash.id, buy);
    // Every bot neighbour joins the offline Dash at once; their buy-ins are play money too.
    const slots = [0, ...members.filter((m) => m.bot).map((m) => m.slot)];
    dash.entrants = slots.map((slot, order) => ({ slot, score: 0, left: DASH_SPINS, finishedAt: Infinity, order, nextAt: Infinity }));
    armDash();
    return { ok: true, dash: dashView(at) as DashView, bal: wallet.balance() };
  };

  const dashStart = (data: { id?: unknown }): { ok: true } | Refused => {
    if (!dash || dash.id !== data.id) return refuse('gone');
    if (dash.st !== DASH_ST.lobby) return refuse('state');
    startDash(now());
    armDash();
    armBots();
    send({ d: dashView(now()) ?? undefined });
    return { ok: true };
  };

  const dashLeave = (data: { id?: unknown }): { ok: true; bal: number } | Refused => {
    if (!dash || dash.id !== data.id) return refuse('gone');
    if (dash.st === DASH_ST.lobby) {
      // The host leaving the lobby cancels it offline: buy-ins go back.
      voidDash();
      armDash();
      send({ d: dashView(now()) ?? undefined });
    }
    return { ok: true, bal: wallet.balance() };
  };

  const dashSpin = (data: { d?: unknown; id?: unknown }): DashSpinOk | Refused => {
    if (!isSpinId(data.id)) return refuse('invalid');
    const seen = acks.get(data.id);
    if (seen) return seen as DashSpinOk;
    if (!dash || dash.id !== data.d) return refuse('gone');
    if (dash.st !== DASH_ST.running) return refuse('state');
    const me = dash.entrants.find((e) => e.slot === 0);
    if (!me || me.left <= 0) return refuse('state');
    const at = now();
    const def = machineDef(dash.m);
    const base = spinBase(def, DASH_BET, rng);
    const { f } = playFor(dash.m, DASH_BET, base, true);
    me.score += base.win + (f?.win ?? 0);
    me.left -= 1;
    if (me.left === 0) me.finishedAt = at;
    const ack: DashSpinOk = { ok: true, id: data.id, st: encodeStops(base.stops), w: base.win, sc: me.score, left: me.left };
    if (f) ack.f = wireFeature(f.kind, f);
    remember(data.id, ack);
    if (dashDone()) {
      const out: FeedView = {};
      finishDash(at, out);
      send(out);
      armDash();
    }
    return ack;
  };

  const handlers: Record<string, (data: Record<string, unknown>) => unknown> = {
    'glimmer:enter': () => enterView(),
    'glimmer:leave': () => ({ ok: true }),
    'glimmer:spin': spin,
    'glimmer:pick': pick,
    'glimmer:resume': (data) => (typeof data.id === 'string' && acks.get(data.id)) || { ok: true, found: false, bal: wallet.balance() },
    'glimmer:react': (data) => {
      react(data);
      return { ok: true };
    },
    'glimmer:away': () => ({ ok: true }),
    'glimmer:dash:create': dashCreate,
    'glimmer:dash:join': (data) => (dash && dash.id === data.id ? { ok: true, bal: wallet.balance() } : refuse('gone')),
    'glimmer:dash:leave': dashLeave,
    'glimmer:dash:start': dashStart,
    'glimmer:dash:spin': dashSpin,
  };

  startBots(now());

  return {
    request(ev, data) {
      if (disposed) return Promise.reject(new Error('closed'));
      const handler = handlers[ev];
      if (!handler) return Promise.resolve(refuse('unknown'));
      try {
        return Promise.resolve(handler((data ?? {}) as Record<string, unknown>));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    attach(fn) {
      emit = fn;
      armBots();
    },
    setVisible(v) {
      if (v === visible || disposed) return;
      const at = now();
      visible = v;
      if (!v) {
        if (dash && (dash.st === DASH_ST.lobby || dash.st === DASH_ST.running)) dash.remaining = Math.max(0, dash.deadline - at);
        if (botTimer !== null) clearTimer(botTimer);
        if (dashTimer !== null) clearTimer(dashTimer);
        botTimer = dashTimer = null;
        return;
      }
      // Back: fresh delays for every bot (no catch-up), the Dash clock resumes where it stopped.
      startBots(at);
      if (dash) {
        if (dash.st === DASH_ST.lobby || dash.st === DASH_ST.running) dash.deadline = at + dash.remaining;
        for (const e of dash.entrants) {
          const member = members.find((x) => x.slot === e.slot);
          if (e.left > 0 && member?.bot) e.nextAt = at + botDelay(member.bot, rng, at, true);
        }
      }
      armBots();
      armDash();
    },
    dispose() {
      disposed = true;
      if (botTimer !== null) clearTimer(botTimer);
      if (dashTimer !== null) clearTimer(dashTimer);
      botTimer = dashTimer = null;
      // A Dash still open when the hall closes is void: the buy-in goes back.
      if (dash && (dash.st === DASH_ST.lobby || dash.st === DASH_ST.running)) voidDash();
      emit = null;
    },
    debug: {
      members: () => members.map((m) => ({ slot: m.slot, acct: m.acct, machine: machineOf(m), bankroll: m.bot ? m.bot.bankroll : null })),
      dash: () => dashView(now()),
      timers: () => (botTimer !== null ? 1 : 0) + (dashTimer !== null ? 1 : 0),
      rig: (values) => {
        rigged.push(...values);
      },
      botSpins: () => botSpins,
    },
  };
};
