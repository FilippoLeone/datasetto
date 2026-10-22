/**
 * The offline table (lamplight.md §11, §18.4) on a virtual clock with a stub thinker: hands play,
 * the table stack stays in Practice escrow, hidden means fully paused, the Cup and the Trio settle
 * Practice chips, and the Practice wallet keeps working when localStorage throws.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { legal, type Action } from '@arcade/core/lamplight/engine';
import { DEFAULT_TRIO_TABLE } from '@arcade/core/lamplight/trio';
import { createPracticeWallet } from '../../runtime/practiceWallet';
import { createLocalTable, ME, TRIO_DEAL_MS, type LocalTableOpts } from './localTable';
import type { ThinkService } from './thinkerMain';

const virtualClock = () => {
  let now = 1000;
  let id = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    timers: {
      set(fn: () => void, ms: number) {
        const h = ++id;
        queue.set(h, { at: now + Math.max(0, ms), fn });
        return h;
      },
      clear(h: unknown) {
        queue.delete(h as number);
      },
    },
    get pending() {
      return queue.size;
    },
    /** Run due timers up to `ms` from now, flushing microtasks after each. */
    async run(ms: number) {
      const end = now + ms;
      for (let guard = 0; guard < 10_000; guard++) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const e of queue) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
        if (!next) break;
        queue.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
};

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

/** Bots call or check (or shove, for quick tournaments). */
const stubThinker = (style: 'call' | 'shove' = 'call'): ThinkService => ({
  think: (r) => {
    const lg = legal(r.view, r.seat);
    let a: Action = { kind: 'fold' };
    if (lg) a = style === 'shove' && lg.canRaise ? { kind: 'allin' } : lg.canCheck ? { kind: 'check' } : { kind: 'call' };
    return Promise.resolve(a);
  },
  idle: () => undefined,
  dispose: () => undefined,
  mode: 'main',
});

let keyN = 0;
const setup = (o: Partial<LocalTableOpts> & { style?: 'call' | 'shove' } = {}) => {
  const clock = virtualClock();
  const practice = createPracticeWallet('datasetto.arcade.test.' + ++keyN);
  const events: [string, Record<string, unknown>][] = [];
  const table = createLocalTable({
    mode: 'open',
    tier: 'pebble',
    players: 4,
    bots: 'regular',
    buyIn: 1000,
    seed: new Uint32Array([1, 2, 3, 4]),
    me: { accountId: 'me-1' },
    practice,
    fast: true,
    now: clock.now,
    timers: clock.timers,
    think: stubThinker(o.style),
    ...o,
  });
  table.attach((name, data) => events.push([name, data as Record<string, unknown>]));
  /** Your moves: `play` picks one when it is your turn. */
  const step = async (ms: number, play: (lg: NonNullable<ReturnType<typeof legal>>) => Action | null) => {
    for (let t = 0; t < ms; t += 250) {
      const hand = table.state.hand;
      const lg = hand && hand.toAct === ME ? legal(table.state, ME) : null;
      if (lg) {
        const a = play(lg);
        if (a) {
          const k = { fold: 'f', check: 'x', call: 'c', bet: 'b', raise: 'r', allin: 'a' }[a.kind];
          await table.request('lamplight:act', { h: hand!.handNo, q: table.state.q, k, a: 'to' in a ? a.to : undefined });
          await flush();
        }
      }
      await clock.run(250);
    }
  };
  return { clock, practice, events, table, step };
};

const callOrCheck = (lg: NonNullable<ReturnType<typeof legal>>): Action => (lg.canCheck ? { kind: 'check' } : { kind: 'call' });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the offline Open Table', () => {
  it('plays hands against bots and keeps your table stack in Practice escrow', async () => {
    const { table, practice, events, step } = setup();
    await table.request('lamplight:sync', {});
    await flush();
    expect(events[0][0]).toBe('lamplight:snap');
    expect(await table.request('lamplight:join', { buyIn: 1000 })).toEqual({ ok: true });
    expect(practice.balance()).toBe(9000);
    let ends = 0;
    for (let round = 0; round < 40 && ends < 6; round++) {
      await step(2000, callOrCheck);
      const n = events.filter((e) => e[0] === 'lamplight:end').length;
      if (n > ends) {
        ends = n;
        const me = table.state.seats[ME];
        expect(practice.escrowed('lamplight:open')).toBe(me.stack);
        expect(practice.balance()).toBe(9000);
      }
      if (table.state.seats[ME].stack === 0) break;
    }
    expect(ends).toBeGreaterThanOrEqual(3);
    // Every hand's events reach the client in table order; your hole cards follow each deal.
    const qs = events.filter((e) => typeof e[1].q === 'number' && e[0] !== 'lamplight:snap').map((e) => e[1].q as number);
    for (let i = 1; i < qs.length; i++) expect(qs[i]).toBe(qs[i - 1] + 1);
    const deals = events.filter((e) => e[0] === 'lamplight:hand').length;
    expect(events.filter((e) => e[0] === 'lamplight:hole').length).toBe(deals);
    expect(events.find((e) => e[0] === 'lamplight:hand')?.[1].sd).toEqual(expect.any(Number));
    table.dispose();
    expect(practice.escrowed('lamplight:open')).toBe(0);
  });

  it('pauses completely while hidden and shifts your clock on return', async () => {
    const { table, events, clock, step } = setup({ fast: false });
    await table.request('lamplight:join', { buyIn: 1000 });
    // Wait for your turn without acting.
    for (let i = 0; i < 80 && table.state.hand?.toAct !== ME; i++) await step(250, () => null);
    expect(table.state.hand?.toAct).toBe(ME);
    const deadline = table.state.hand!.deadline;
    table.setVisible(false);
    expect(clock.pending).toBe(0);
    const before = events.length;
    await clock.run(60_000);
    expect(events.length).toBe(before);
    expect(table.state.hand!.toAct).toBe(ME);
    table.setVisible(true);
    await flush();
    expect(table.state.hand!.deadline).toBe(deadline + 60_000);
    expect(events.at(-1)?.[0]).toBe('lamplight:bank');
    expect(clock.pending).toBe(1);
    table.dispose();
  });

  it('folds you on time, then sits you out after two timeouts', async () => {
    const { table, step } = setup();
    await table.request('lamplight:join', { buyIn: 1000 });
    await step(400_000, () => null);
    expect(table.state.seats[ME].status).toBe('sittingOut');
    table.dispose();
  });
});

describe('offline tournaments', () => {
  it('a Lamplight Cup ends when you bust or win, and pays your place in Practice chips', async () => {
    const { table, practice, events, step } = setup({ mode: 'cup', players: 3, buyIn: 500, style: 'shove' });
    await table.request('lamplight:join', {});
    expect(practice.balance()).toBe(9500);
    for (let i = 0; i < 200 && !table.result; i++) await step(1000, (lg) => (lg.canRaise ? { kind: 'allin' } : callOrCheck(lg)));
    expect(table.result).not.toBeNull();
    const end = events.find((e) => e[0] === 'lamplight:cupEnd');
    expect(end).toBeTruthy();
    const { place, prize } = table.result!;
    // Three players: the winner takes the whole 1,500.
    expect(prize).toBe(place === 1 ? 1500 : 0);
    expect(practice.balance()).toBe(10_000 - 500 + prize);
    expect(practice.escrowed('lamplight:cup')).toBe(0);
    table.dispose();
  });

  it('the Firefly Trio draws a multiplier from the default table before the first hand', async () => {
    const { table, events, clock } = setup({ mode: 'trio', buyIn: 1000 });
    await table.request('lamplight:join', {});
    await flush();
    const trio = events.find((e) => e[0] === 'lamplight:trio')?.[1];
    expect(trio).toBeTruthy();
    expect(DEFAULT_TRIO_TABLE.map((r) => r.mult)).toContain(trio!.mult);
    expect(trio!.pool).toBe(1000 * (trio!.mult as number));
    expect((trio!.pay as number[]).reduce((a, b) => a + b, 0)).toBe(trio!.pool);
    await clock.run(1000);
    expect(events.some((e) => e[0] === 'lamplight:hand')).toBe(false);
    await clock.run(TRIO_DEAL_MS);
    expect(events.some((e) => e[0] === 'lamplight:hand')).toBe(true);
    table.dispose();
  });
});

describe('Practice chips', () => {
  it('fall back to memory when localStorage throws, and an open escrow comes back on the next start', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const key = 'datasetto.arcade.test.throwing';
    const wallet = createPracticeWallet(key);
    expect(wallet.balance()).toBe(10_000);
    wallet.escrow('lamplight:open', 1000);
    expect(wallet.balance()).toBe(9000);
    // The app closes mid-table; the next start finds the escrow and returns it.
    const again = createPracticeWallet(key);
    expect(again.balance()).toBe(10_000);
    expect(again.escrowed('lamplight:open')).toBe(0);
  });

  it('offers a refill only below the minimum buy-in', async () => {
    const { table, practice } = setup();
    practice.debit(9700, 'test');
    expect(await table.request('lamplight:join', { buyIn: 1000 })).toEqual({ ok: false, code: 'funds' });
    await table.request('lamplight:refill', {});
    expect(practice.balance()).toBe(10_000);
    expect(await table.request('lamplight:join', { buyIn: 1000 })).toEqual({ ok: true });
    table.dispose();
  });
});
