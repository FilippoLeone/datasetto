/**
 * The offline hall (glimmerhall.md §13–§14, §18.1 test 14): spins and Practice chips, the pending
 * vault, resume, reactions, the offline Dash against the bots, a 100k-spin bot soak, freezing while
 * hidden, and storage that throws. Virtual time throughout.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seededRng } from '@arcade/core/glimmer/golden';
import { DASH_ST, type DashSpinOk, type DashView, type EnterOk, type FeedView, type PickOk, type SpinOk } from '@arcade/core/glimmer/wire';
import { createPracticeWallet } from '@/arcade/runtime/practiceWallet';
import { createLocalHall } from './local';

/** A virtual clock with timers, run in order. */
const virtual = () => {
  let t = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      seq += 1;
      timers.set(seq, { at: t + Math.max(0, ms), fn });
      return seq;
    },
    clearTimer: (h: unknown) => {
      timers.delete(h as number);
    },
    /** Runs every timer due within `ms` (bounded). */
    advance(ms: number) {
      const end = t + ms;
      for (let guard = 0; guard < 1_000_000; guard += 1) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of timers) if (!next || entry[1].at < next[1].at) next = entry;
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
    get pending() {
      return timers.size;
    },
  };
};

let seq = 0;
const id = (): string => ('t' + String(++seq).padStart(11, '0')).slice(-12).replace(/[^A-Za-z0-9]/g, 'x');

const setup = (o: { rngSeed?: number; key?: string; bots?: number } = {}) => {
  const clock = virtual();
  const key = o.key ?? 'test.practice.' + Math.random();
  const wallet = createPracticeWallet(key);
  const hall = createLocalHall({ wallet, rng: seededRng(o.rngSeed ?? 1), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, storeKey: key + '.glimmer', bots: o.bots });
  const feeds: FeedView[] = [];
  hall.attach((ev, data) => {
    if (ev === 'glimmer:feed') feeds.push(data as FeedView);
  });
  const ask = <T>(ev: string, data: unknown = {}) => hall.request(ev, data) as Promise<T>;
  return { clock, wallet, hall, feeds, ask };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the offline hall', () => {
  it('enters with the four bot neighbours and the Practice balance', async () => {
    const { ask, hall } = setup();
    const enter = await ask<EnterOk>('glimmer:enter', { ch: null, v: 1 });
    expect(enter.ok).toBe(true);
    expect(enter.bal).toBe(10_000);
    expect(enter.pot).toBe(0);
    expect(enter.mem.map((m) => m[1])).toEqual([null, 'bot:Juniper', 'bot:Wex', 'bot:Saffi', 'bot:Gus']);
    hall.dispose();
  });

  it('debits the bet, credits the win and keeps the books in step with the acks', async () => {
    const { ask, wallet, hall } = setup({ rngSeed: 9 });
    let expected = wallet.balance();
    for (let i = 0; i < 300; i += 1) {
      const m = (i % 2) as 0 | 1;
      const bet = m === 0 ? 10 : 40;
      const ack = await ask<SpinOk | { ok: false; code: string }>('glimmer:spin', { m, b: bet, id: id() });
      if (!ack.ok) throw new Error('refused ' + (ack as { code: string }).code);
      expected += ack.w + (ack.f?.w ?? 0) - bet;
      expect(ack.bal).toBe(expected);
    }
    expect(wallet.balance()).toBe(expected);
    hall.dispose();
  });

  it('refuses bets off the ladder and above the balance, and replays a retried id', async () => {
    const { ask, wallet, hall } = setup();
    expect(await ask('glimmer:spin', { m: 1, b: 30, id: id() })).toEqual({ ok: false, code: 'bet' });
    expect(await ask('glimmer:spin', { m: 1, b: 20, id: 'short' })).toEqual({ ok: false, code: 'invalid' });
    wallet.debit(wallet.balance() - 30, 'test');
    expect(await ask('glimmer:spin', { m: 1, b: 40, id: id() })).toEqual({ ok: false, code: 'funds' });
    const sid = id();
    const first = await ask<SpinOk>('glimmer:spin', { m: 1, b: 20, id: sid });
    const again = await ask<SpinOk>('glimmer:spin', { m: 1, b: 20, id: sid });
    expect(again).toEqual(first);
    expect(await ask('glimmer:resume', { id: sid })).toEqual(first);
    expect(await ask('glimmer:resume', { id: id() })).toEqual({ ok: true, found: false, bal: wallet.balance() });
    hall.dispose();
  });

  it('holds a Three Vaults trigger on the device until a door is picked', async () => {
    const key = 'test.practice.vault';
    const a = setup({ key });
    a.hall.debug.rig([0, 1, 0, 1, 0, 0, 0]);
    const spin = await a.ask<SpinOk>('glimmer:spin', { m: 2, b: 20, id: id() });
    expect(spin.v).toBe(1);
    // The key pay (3 × 20) plus five Frost Runes on one way (30 coins).
    expect(spin.w).toBe(90);
    expect(await a.ask('glimmer:spin', { m: 1, b: 20, id: id() })).toEqual({ ok: false, code: 'pending' });
    a.hall.dispose();
    // A new hall on the same device still has the vault waiting.
    const b = setup({ key });
    const enter = await b.ask<EnterOk>('glimmer:enter', { ch: null, v: 1 });
    expect(enter.pend).toEqual({ m: 2, bet: 20 });
    const before = b.wallet.balance();
    const pick = await b.ask<PickOk>('glimmer:pick', { door: 1, id: id() });
    expect(pick.dr).toEqual([1, 2, 0]);
    expect(pick.f.d).toBe(1);
    expect(pick.f.x).toBe(4);
    expect(pick.bal).toBe(before + pick.f.w);
    expect((await b.ask<EnterOk>('glimmer:enter', { ch: null, v: 1 })).pend).toBeUndefined();
    b.hall.dispose();
  });

  it('limits reactions to one per 3 s and echoes them in the feed', async () => {
    const { ask, clock, feeds, hall } = setup({ bots: 0 });
    await ask('glimmer:react', { to: 0, e: 2 });
    await ask('glimmer:react', { to: 0, e: 3 });
    clock.advance(3000);
    await ask('glimmer:react', { to: 0, e: 4 });
    expect(feeds.flatMap((f) => f.r ?? [])).toEqual([
      [0, 0, 2],
      [0, 0, 4],
    ]);
    hall.dispose();
  });

  it('runs bots only while visible, with no catch-up, and leaves no timer when closed', () => {
    const { clock, feeds, hall } = setup({ rngSeed: 4 });
    clock.advance(60_000);
    const seen = feeds.length;
    expect(clock.pending).toBe(1);
    hall.setVisible(false);
    expect(clock.pending).toBe(0);
    expect(hall.debug.timers()).toBe(0);
    clock.advance(10 * 60_000);
    expect(feeds.length).toBe(seen);
    hall.setVisible(true);
    expect(clock.pending).toBe(1);
    hall.dispose();
    expect(clock.pending).toBe(0);
  });

  it('plays an offline Dash with 4 bots × 100 spins to the end; the payout sums to the pool', async () => {
    const { ask, clock, feeds, wallet, hall } = setup({ rngSeed: 12 });
    const start = wallet.balance();
    const created = await ask<{ ok: true; dash: DashView }>('glimmer:dash:create', { m: 1, len: 10, buy: 100 });
    expect(created.dash.st).toBe(DASH_ST.lobby);
    expect(wallet.balance()).toBe(start - 100);
    expect(await ask('glimmer:dash:start', { id: created.dash.id })).toEqual({ ok: true });
    let mine: DashSpinOk | null = null;
    for (let i = 0; i < 100; i += 1) {
      mine = await ask<DashSpinOk>('glimmer:dash:spin', { d: created.dash.id, id: id() });
      expect(mine.ok).toBe(true);
      clock.advance(1800);
    }
    expect(mine?.left).toBe(0);
    clock.advance(4 * 60_000);
    const done = hall.debug.dash();
    expect(done?.st).toBe(DASH_ST.done);
    expect(done?.s.filter((_, i) => i % 3 === 2)).toEqual([0, 0, 0, 0, 0]);
    const pay = done?.pay ?? [];
    let paid = 0;
    let mineWon = 0;
    for (let i = 0; i < pay.length; i += 2) {
      paid += pay[i + 1] as number;
      if (pay[i] === 0) mineWon = pay[i + 1] as number;
    }
    expect(paid).toBe(500);
    expect(wallet.balance()).toBe(start - 100 + mineWon);
    expect(feeds.some((f) => f.d?.st === DASH_ST.done)).toBe(true);
    hall.dispose();
  });

  it('freezes the Dash clock while hidden and refunds a Dash left open', async () => {
    const { ask, clock, wallet, hall } = setup({ rngSeed: 3 });
    const start = wallet.balance();
    const { dash } = await ask<{ ok: true; dash: DashView }>('glimmer:dash:create', { m: 0, len: 3, buy: 500 });
    await ask('glimmer:dash:start', { id: dash.id });
    clock.advance(30_000);
    const t1 = hall.debug.dash()?.t ?? 0;
    hall.setVisible(false);
    clock.advance(10 * 60_000);
    expect(hall.debug.dash()?.t).toBe(t1);
    hall.setVisible(true);
    clock.advance(1000);
    expect(hall.debug.dash()?.t).toBe(t1 - 1);
    hall.dispose();
    // Closed mid-Dash: the buy-in goes back.
    expect(wallet.balance()).toBe(start);
  });

  it('soak: 100k bot spins keep every bankroll whole', () => {
    const { clock, feeds, hall } = setup({ rngSeed: 21 });
    clock.advance(100_000 * 600);
    expect(hall.debug.botSpins()).toBeGreaterThanOrEqual(100_000);
    const bots = hall.debug.members().filter((m) => m.bankroll !== null);
    for (const b of bots) {
      expect(Number.isFinite(b.bankroll)).toBe(true);
      expect(b.bankroll as number).toBeGreaterThanOrEqual(0);
    }
    const entries = feeds.flatMap((f) => f.e ?? []);
    expect(entries.length).toBeGreaterThan(1000);
    for (const e of entries) expect(Number.isInteger(e[3]) && e[3] >= 0).toBe(true);
    hall.dispose();
  }, 10_000);

  it('works when localStorage throws (in-memory fallback)', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { ask, hall } = setup();
    hall.debug.rig([0, 1, 0, 1, 0, 2, 1]);
    const spin = await ask<SpinOk>('glimmer:spin', { m: 2, b: 20, id: id() });
    expect(spin.v).toBe(1);
    expect((await ask<EnterOk>('glimmer:enter', { ch: null, v: 1 })).pend).toEqual({ m: 2, bet: 20 });
    const pick = await ask<PickOk>('glimmer:pick', { door: 0, id: id() });
    expect(pick.ok).toBe(true);
    hall.dispose();
  });
});
