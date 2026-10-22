/**
 * Glimmerhall's server authority against the frozen TableApi (glimmerhall.md §18.1 tests 7–13,
 * plan.md §3.4 "Authority", "Lifecycle and Dash", "Pacing"): the real wallet, stats and results over
 * an in-memory database, scripted draws, virtual time. The ledger invariant is checked after every
 * operation that moves chips.
 */
import { describe, expect, it } from 'vitest';
import { DEFS } from '../../../src/arcade/core/version.js';
import { DASH_ST, POT_SEED, SIZE, type DashView, type EnterOk, type FeedView, type PickOk, type SpinOk } from '../../../src/arcade/core/glimmer/wire.js';
import { checkInvariant, clearReceipts } from '../../../src/arcade/wallet.js';
import glimmer, { DASH_ACTIVITY } from '../../../src/arcade/halls/glimmer.js';
import { createHarness, scripted, sid, type Harness } from './harness.js';

const CH = 'chan_voice_1';
const V = DEFS.glimmer;

const sound = (h: Harness): void => expect(checkInvariant(h.db)).toEqual([]);

/** n accounts in voice in CH, each entered. */
const hallOf = (h: Harness, ...ids: string[]): void => {
  h.addAccount(...ids);
  for (const id of ids) {
    h.voice.set(id, CH);
    const ack = h.call<EnterOk>(h.ctx(id), 'glimmer:enter', { ch: CH, v: V });
    expect(ack.ok).toBe(true);
  }
};

const balance = (h: Harness, id: string): number => h.wallet.view(id).bal;
const count = (h: Harness, sql: string, ...args: unknown[]): number => h.db.prepare(sql).pluck().get(...args) as number;

describe('Glimmerhall on the server', () => {
  it('registers as the glimmer table game with its admin setting and boards', () => {
    expect(glimmer.game).toBe('glimmer');
    expect(glimmer.proto).toBe(V);
    expect(glimmer.modes).toEqual(['hall', 'dash']);
    expect(glimmer.settings?.schema.safeParse({ slotsMaxBet: 100 }).success).toBe(true);
    expect(glimmer.settings?.schema.safeParse({ slotsMaxBet: 1000 }).success).toBe(false);
    expect(glimmer.boards?.map((b) => b.id)).toEqual(['bestx', 'best', 'dash']);
  });

  it('enters: a definitions mismatch, a hidden account and a disabled game are refused; voice members get a hall slot', () => {
    const h = createHarness();
    h.addAccount('a', 'b', 'x');
    expect(h.call(h.ctx('a'), 'glimmer:enter', { ch: CH, v: V + 1 })).toEqual({ ok: false, code: 'update' });
    h.hidden.add('x');
    expect(h.call(h.ctx('x'), 'glimmer:enter', { ch: CH, v: V })).toEqual({ ok: false, code: 'hidden' });
    h.voice.set('a', CH);
    const a = h.call<EnterOk>(h.ctx('a'), 'glimmer:enter', { ch: CH, v: V });
    // The first enter seeds a pot that never held a chip (once per database).
    expect([a.ok, a.me, a.bal, a.pot, a.maxBet]).toEqual([true, 0, 20_000, POT_SEED, 500]);
    expect(count(h, "SELECT COUNT(*) FROM arcade_txns WHERE kind = 'pot_seed'")).toBe(1);
    // Not in that call: plays alone, no hall.
    const b = h.call<EnterOk>(h.ctx('b'), 'glimmer:enter', { ch: CH, v: V });
    expect([b.ok, b.me, b.mem.length]).toEqual([true, -1, 0]);
    h.voice.set('b', CH);
    const b2 = h.call<EnterOk>(h.ctx('b'), 'glimmer:enter', { ch: CH, v: V });
    expect(b2.me).toBe(1);
    expect(b2.mem.map((m) => [m[0], m[1]])).toEqual([
      [0, 'a'],
      [1, 'b'],
    ]);
    expect(h.game.activity(CH)).toEqual([{ g: 'glimmer', id: 'hall:' + CH, st: 'open', n: 2, max: 16, w: 0 }]);
    h.settings.games = { ...h.settings.games, glimmer: false };
    expect(h.call(h.ctx('a'), 'glimmer:spin', { m: 1, b: 20, id: sid() })).toEqual({ ok: false, code: 'disabled' });
  });

  it('is the channel lobby: one per channel, live at once, seats for the whole hall, no spectators, closed when empty', () => {
    const h = createHarness({ rng: scripted(2).rng, potRng: () => 999_999 });
    const ids = Array.from({ length: 12 }, (_, i) => 'm' + i);
    h.addAccount(...ids, 'outside');
    for (const id of ids) h.voice.set(id, CH);
    expect(h.createLobby(h.ctx('outside'))).toEqual({ ok: false, code: 'not-in-voice' });
    const created = h.createLobby(h.ctx('m0'));
    expect(created.ok).toBe(true);
    const id = (created as { id: string }).id;
    // Live at once, so the stage opens for the creator and for everyone who joins.
    expect(h.lobbies.get(id)?.state).toBe('live');
    expect(h.createLobby(h.ctx('m1'))).toEqual({ ok: false, code: 'exists' });
    expect(h.game.lobby?.onJoin(h.ctx('m1'), h.lobbies.get(id) as never, 'spectator')).toEqual({ ok: false, code: 'no-spectators' });
    // More people than the hub's 9 table seats: the hall keeps the record padded to its size.
    for (const m of ids) {
      if (m !== 'm0') expect(h.joinLobby(h.ctx(m), id)).toEqual({ ok: true });
      expect(h.call<EnterOk>(h.ctx(m), 'glimmer:enter', { ch: CH, v: V }).ok).toBe(true);
    }
    const record = h.lobbies.get(id);
    expect(record?.seats.length).toBeGreaterThanOrEqual(16);
    expect(record?.seats.filter((s) => s.accountId).map((s) => s.accountId).sort()).toEqual(ids.slice().sort());
    expect(h.game.activity(CH)).toEqual([{ g: 'glimmer', id, st: 'open', n: 12, max: 16, w: 0 }]);
    // Leaving the call frees the seat; leaving the lobby leaves the hall.
    h.game.onVoiceLeft('m11', CH);
    expect(h.lobbies.get(id)?.seats.some((s) => s.accountId === 'm11')).toBe(false);
    h.leaveLobby(h.ctx('m10'), id);
    expect(h.game.debug.halls.get(CH)?.members.has('m10')).toBe(false);
    // The last one out closes the lobby; the next "Start" makes a new one.
    for (const m of ids.slice(0, 10)) h.call(h.ctx(m), 'glimmer:leave', {});
    expect(h.lobbies.get(id)?.state).toBe('ended');
    expect(h.game.activity(CH)).toEqual([]);
    expect(h.createLobby(h.ctx('m0')).ok).toBe(true);
  });

  it('settles each spin in one transaction with net legs; the books balance after every spin', () => {
    const r = scripted(7);
    const h = createHarness({ rng: r.rng, potRng: () => 999_999 });
    hallOf(h, 'a');
    let expected = balance(h, 'a');
    for (let i = 0; i < 400; i += 1) {
      const m = (i % 3) as 0 | 1 | 2;
      const bet = m === 0 ? 25 : 40;
      if (m === 2 && i % 5 === 0) r.push(0, 1, 0, 1, 0, 0, 0);
      const ack = h.call<SpinOk>(h.ctx('a'), 'glimmer:spin', { m, b: bet, id: sid() });
      expect(ack.ok).toBe(true);
      expected += ack.w + (ack.f?.w ?? 0) - bet;
      if (ack.v) {
        const pick = h.call<PickOk>(h.ctx('a'), 'glimmer:pick', { door: 2, id: sid() });
        expect(pick.ok).toBe(true);
        expected += pick.f.w;
        expect(pick.bal).toBe(expected);
      } else expect(ack.bal).toBe(expected);
      if (i % 50 === 0) sound(h);
    }
    expect(balance(h, 'a')).toBe(expected);
    sound(h);
    // One txn per spin (and per pick), at most three ledger legs each.
    const legs = h.db.prepare("SELECT MAX(c) FROM (SELECT COUNT(*) AS c FROM arcade_ledger l JOIN arcade_txns t ON t.id = l.txn_id WHERE t.kind IN ('spin', 'feature') GROUP BY l.txn_id)").pluck().get();
    expect(legs).toBeLessThanOrEqual(3);
    expect(count(h, "SELECT COUNT(*) FROM arcade_txns WHERE kind = 'spin'")).toBe(400);
  });

  it('answers a retried spin with its receipt, `settled` once the receipt is cleared, and `found: false` for an unknown id', () => {
    const h = createHarness({ rng: scripted(3).rng, potRng: () => 999_999 });
    hallOf(h, 'a');
    const id = sid();
    const first = h.call<SpinOk>(h.ctx('a'), 'glimmer:spin', { m: 1, b: 20, id });
    const again = h.call<SpinOk>(h.ctx('a'), 'glimmer:spin', { m: 1, b: 20, id });
    expect(again).toEqual(first);
    expect(h.call(h.ctx('a'), 'glimmer:resume', { id })).toEqual(first);
    expect(count(h, "SELECT COUNT(*) FROM arcade_txns WHERE kind = 'spin'")).toBe(1);
    clearReceipts(h.db, h.clock.now() + 25 * 3_600_000);
    const bal = balance(h, 'a');
    expect(h.call(h.ctx('a'), 'glimmer:spin', { m: 1, b: 20, id })).toEqual({ ok: true, settled: true, bal });
    expect(h.call(h.ctx('a'), 'glimmer:resume', { id })).toEqual({ ok: true, settled: true, bal });
    expect(h.call(h.ctx('a'), 'glimmer:resume', { id: sid() })).toEqual({ ok: true, found: false, bal });
    expect(balance(h, 'a')).toBe(bal);
    sound(h);
  });

  it('refuses a spin when the balance is below the bet, even when the spin would win more than the bet', () => {
    const r = scripted(5);
    const h = createHarness({ rng: r.rng, potRng: () => 999_999 });
    hallOf(h, 'a');
    // Spend down to 19 chips (one transfer to the house).
    const bal = balance(h, 'a');
    h.wallet.transfer('admin', 'test', 'system', 'drain', [
      { account: 'w:a', delta: -(bal - 19) },
      { account: 'house', delta: bal - 19 },
    ]);
    // Five octopus on the middle line would pay 2,500.
    r.push(11, 11, 12, 11, 11);
    expect(h.call(h.ctx('a'), 'glimmer:spin', { m: 1, b: 20, id: sid() })).toEqual({ ok: false, code: 'funds' });
    expect(balance(h, 'a')).toBe(19);
    expect(r.calls).toBe(0);
    expect(h.call(h.ctx('a'), 'glimmer:spin', { m: 1, b: 30, id: sid() })).toEqual({ ok: false, code: 'bet' });
    h.settings.gameSettings = { glimmer: { slotsMaxBet: 40 } };
    h.wallet.transfer('admin', 'test', 'system', 'fill', [
      { account: 'house', delta: -1000 },
      { account: 'w:a', delta: 1000 },
    ]);
    expect(h.call(h.ctx('a'), 'glimmer:spin', { m: 1, b: 100, id: sid() })).toEqual({ ok: false, code: 'bet' });
    expect(h.call<SpinOk>(h.ctx('a'), 'glimmer:spin', { m: 1, b: 40, id: sid() }).ok).toBe(true);
    sound(h);
  });

  it('rolls everything back on a throw after the guard or after the draws', () => {
    let boomRng = false;
    let boomPot = false;
    const r = scripted(9);
    const h = createHarness({
      rng: (n) => {
        if (boomRng) throw new Error('rng failed');
        return r.rng(n);
      },
      potRng: (n) => {
        if (boomPot) throw new Error('pot draw failed');
        return n - 1;
      },
    });
    hallOf(h, 'a');
    h.call(h.ctx('a'), 'glimmer:spin', { m: 1, b: 20, id: sid() });
    const snapshot = () => ({
      bal: balance(h, 'a'),
      pot: h.wallet.pot('glimmer'),
      txns: count(h, 'SELECT COUNT(*) FROM arcade_txns'),
      legs: count(h, 'SELECT COUNT(*) FROM arcade_ledger'),
      stats: count(h, "SELECT COALESCE(SUM(value), 0) FROM arcade_stats WHERE stat = 'tidepool.spins'"),
      pending: count(h, 'SELECT COUNT(*) FROM arcade_pending'),
    });
    const before = snapshot();
    boomRng = true;
    expect(() => h.call(h.ctx('a'), 'glimmer:spin', { m: 1, b: 20, id: sid() })).toThrow('rng failed');
    expect(snapshot()).toEqual(before);
    boomRng = false;
    boomPot = true;
    // After the draws and the pot carry: the carry is rolled back too.
    expect(() => h.call(h.ctx('a'), 'glimmer:spin', { m: 1, b: 100, id: sid() })).toThrow('pot draw failed');
    expect(snapshot()).toEqual(before);
    boomPot = false;
    // A vault trigger that fails after its draws leaves no pending row.
    r.push(0, 1, 0, 1, 0, 0, 0);
    boomPot = true;
    expect(() => h.call(h.ctx('a'), 'glimmer:spin', { m: 2, b: 20, id: sid() })).toThrow();
    expect(snapshot()).toEqual(before);
    sound(h);
  });

  it('pays the whole pot on a pot win, reseeds 7,500 and shows it in the activity for 60 s', () => {
    const r = scripted(13);
    const potQueue: number[] = [];
    const h = createHarness({ rng: r.rng, potRng: (n) => (potQueue.length ? (potQueue.shift() as number) : n - 1) });
    hallOf(h, 'a', 'b');
    for (let i = 0; i < 200; i += 1) h.call(h.ctx('b'), 'glimmer:spin', { m: 1, b: 500, id: sid() });
    // a's hall push carries the grown pot, so a's spin ack has to say it is back at the seed.
    h.clock.advance(3000);
    const pool = h.wallet.pot('glimmer').pool;
    expect(pool).toBe(POT_SEED + Math.floor((200 * 500 * 75) / 10_000));
    const before = balance(h, 'a');
    potQueue.push(0);
    const ack = h.call<SpinOk>(h.ctx('a'), 'glimmer:spin', { m: 1, b: 20, id: sid() });
    const contribution = Math.floor((((200 * 500 * 75) % 10_000) + 20 * 75) / 10_000);
    expect(ack.pt).toBe(pool + contribution);
    expect(ack.pot).toBe(POT_SEED);
    expect(ack.bal).toBe(before - 20 + ack.w + (ack.f?.w ?? 0) + (ack.pt ?? 0));
    const pot = h.wallet.pot('glimmer');
    expect(pot.pool).toBe(POT_SEED);
    expect(pot.last?.accountId).toBe('a');
    expect(pot.last?.amount).toBe(ack.pt);
    // The first seed and the reseed after the win.
    expect(count(h, "SELECT COUNT(*) FROM arcade_txns WHERE kind = 'pot_seed'")).toBe(2);
    expect(h.game.activity(CH)[0]?.j).toEqual({ amt: ack.pt });
    h.clock.advance(61_000);
    expect(h.game.activity(CH)[0]?.j).toBeUndefined();
    // Everyone in the hall sees the pot win as a feed entry.
    const feed = h.to('s-b', 'glimmer:feed') as FeedView[];
    expect(feed.flatMap((f) => f.e ?? []).some((e) => e[0] === 0 && e[4] === 2 && e[3] === ack.pt)).toBe(true);
    sound(h);
  });

  it('keeps a Three Vaults trigger pending server-side, refuses spins meanwhile, and opens it on a pick or after 24 h', () => {
    const r = scripted(17);
    const h = createHarness({ rng: r.rng, potRng: () => 999_999 });
    hallOf(h, 'a', 'b');
    r.push(0, 1, 0, 1, 0, 0, 0);
    const spin = h.call<SpinOk>(h.ctx('a'), 'glimmer:spin', { m: 2, b: 20, id: sid() });
    expect([spin.v, spin.w]).toEqual([1, 90]);
    sound(h);
    expect(h.call(h.ctx('a'), 'glimmer:spin', { m: 1, b: 20, id: sid() })).toEqual({ ok: false, code: 'pending' });
    // Re-entering (another device, a restart) shows the doors again.
    expect(h.call<EnterOk>(h.ctx('a', 's-a2'), 'glimmer:enter', { ch: CH, v: V }).pend).toEqual({ m: 2, bet: 20 });
    // Door contents never left the server before the pick.
    for (const e of h.emits) expect(JSON.stringify(e.data)).not.toMatch(/"dr"|doors/);
    const before = balance(h, 'a');
    const pick = h.call<PickOk>(h.ctx('a', 's-a2'), 'glimmer:pick', { door: 1, id: sid() });
    expect(pick.dr).toEqual([1, 2, 0]);
    expect([pick.f.d, pick.f.x]).toEqual([1, 4]);
    expect(pick.bal).toBe(before + pick.f.w);
    expect(count(h, "SELECT COUNT(*) FROM arcade_txns WHERE kind = 'feature'")).toBe(1);
    expect(count(h, 'SELECT COUNT(*) FROM arcade_pending')).toBe(0);
    sound(h);
    // A vault left alone opens itself after 24 h (on the daily job, at boot and on enter).
    r.push(0, 1, 0, 1, 0, 0, 0);
    h.call(h.ctx('b'), 'glimmer:spin', { m: 2, b: 20, id: sid() });
    expect(count(h, 'SELECT COUNT(*) FROM arcade_pending')).toBe(1);
    h.game.daily(h.clock.now());
    expect(count(h, 'SELECT COUNT(*) FROM arcade_pending')).toBe(1);
    h.clock.advance(24 * 3_600_000 + 1000);
    const bBefore = balance(h, 'b');
    h.game.daily(h.clock.now());
    expect(count(h, 'SELECT COUNT(*) FROM arcade_pending')).toBe(0);
    expect(balance(h, 'b')).toBeGreaterThanOrEqual(bBefore);
    sound(h);
  });

  it('shows away and back to the hall at most once per 5 s, and a change inside the gap when the gap ends', () => {
    const h = createHarness({ rng: scripted(23).rng, potRng: () => 999_999 });
    hallOf(h, 'a', 'b');
    h.clock.advance(2000);
    h.emits.length = 0;
    // What a sees of b's away flag, push by push.
    const seenByA = (): number[] =>
      h.emits
        .filter((e) => e.socketId === 's-a' && e.ev === 'glimmer:feed')
        .flatMap((e) => (e.data as FeedView).h ?? [])
        .filter((m) => m[0] === 1)
        .map((m) => m[3]);
    h.call(h.ctx('b'), 'glimmer:away', {});
    h.clock.advance(1100);
    expect(seenByA()).toEqual([1]);
    // Back 1 s later: held until the gap ends, then shown (it used to be dropped, leaving b "away").
    h.call(h.ctx('b'), 'glimmer:enter', { ch: CH, v: V });
    h.clock.advance(2000);
    expect(seenByA()).toEqual([1]);
    h.clock.advance(3000);
    expect(seenByA()).toEqual([1, 0]);
    // Away and back again inside one gap: the hall saw nothing change, so nothing goes out.
    h.call(h.ctx('b'), 'glimmer:away', {});
    h.call(h.ctx('b'), 'glimmer:enter', { ch: CH, v: V });
    h.clock.advance(6000);
    expect(seenByA()).toEqual([1, 0]);
    // Leaving with a change held back clears its timer.
    h.call(h.ctx('b'), 'glimmer:away', {});
    h.clock.advance(1100);
    h.call(h.ctx('b'), 'glimmer:enter', { ch: CH, v: V });
    const seat = h.game.debug.seats.get('b');
    expect(seat?.awayTimer).not.toBeNull();
    h.call(h.ctx('b'), 'glimmer:leave', {});
    expect(seat?.awayTimer).toBeNull();
  });

  it('never sends a balance, door contents or a quiet spin to anyone else; away members and non-members get nothing', () => {
    const r = scripted(19);
    const h = createHarness({ rng: r.rng, potRng: () => 999_999 });
    hallOf(h, 'a', 'b', 'c');
    h.addAccount('d');
    h.call(h.ctx('d'), 'glimmer:enter', { ch: null, v: V });
    h.call(h.ctx('c'), 'glimmer:away', {});
    h.emits.length = 0;
    let bigs = 0;
    for (let i = 0; i < 300; i += 1) {
      if (i === 100) r.push(0, 1, 0, 1, 0, 0, 0);
      const ack = h.call<SpinOk>(h.ctx('a'), 'glimmer:spin', { m: (i % 3) as 0 | 1 | 2, b: i % 3 === 0 ? 25 : 40, id: sid() });
      if (ack.v) h.call(h.ctx('a'), 'glimmer:pick', { door: 0, id: sid() });
      if (ack.w + (ack.f?.w ?? 0) >= 5 * (i % 3 === 0 ? 25 : 40) || ack.f) bigs += 1;
      h.clock.advance(500);
    }
    const created = h.call<{ ok: true; dash: DashView }>(h.ctx('a'), 'glimmer:dash:create', { m: 1, len: 3, buy: 100 });
    h.call(h.ctx('b'), 'glimmer:dash:join', { id: created.dash.id });
    h.clock.advance(5000);
    expect(bigs).toBeGreaterThan(5);
    const others = h.emits.filter((e) => e.socketId !== 's-a');
    expect(others.length).toBeGreaterThan(0);
    for (const e of others) {
      const text = JSON.stringify(e.data);
      expect(text).not.toMatch(/"bal"|"dr"|"doors"|"st":"/);
      for (const entry of (e.data as FeedView).e ?? []) {
        const [, , bet, win, k] = entry;
        if (k === 0) expect(win).toBeGreaterThanOrEqual(bet * 5);
      }
    }
    expect(h.to('s-c')).toEqual([]);
    expect(h.to('s-d')).toEqual([]);
    expect(h.to('s-b', 'glimmer:feed').length).toBeGreaterThan(0);
  });

  it('pushes at most once a second per member, at most 400 B, merged while the platform still holds one', () => {
    const r = scripted(23);
    const h = createHarness({ rng: r.rng, potRng: () => 999_999 });
    const ids = Array.from({ length: 16 }, (_, i) => 'p' + i);
    hallOf(h, ...ids);
    h.emits.length = 0;
    // 16 members at the 2-per-second cap for 10 s.
    for (let step = 0; step < 20; step += 1) {
      for (const id of ids) h.call(h.ctx(id), 'glimmer:spin', { m: (step % 3) as 0 | 1 | 2, b: step % 3 === 0 ? 100 : 500, id: sid() });
      if (step % 4 === 0) for (const id of ids) h.call(h.ctx(id), 'glimmer:react', { to: (Number(id.slice(1)) + 1) % 16, e: 1 });
      h.clock.advance(500);
    }
    h.clock.advance(3000);
    for (const id of ids) {
      const feeds = h.emits.filter((e) => e.socketId === 's-' + id && e.ev === 'glimmer:feed');
      for (let i = 1; i < feeds.length; i += 1) expect((feeds[i] as { at: number }).at - (feeds[i - 1] as { at: number }).at).toBeGreaterThanOrEqual(1000);
      let bytes = 0;
      for (const f of feeds) {
        const size = Buffer.byteLength(JSON.stringify(f.data));
        expect(size).toBeLessThanOrEqual(SIZE.feed);
        bytes += size + 92;
      }
      // Hall pushes stay within the 200 B/s push budget on average (wire bytes over the 13 s).
      expect(bytes / 13).toBeLessThanOrEqual(492);
    }
    // While the platform still holds a push, the next one carries its content too.
    const m = createHarness({ rng: scripted(29).rng, potRng: () => 999_999 });
    hallOf(m, 'a', 'b');
    m.emits.length = 0;
    m.autoSent = false;
    m.call(m.ctx('a'), 'glimmer:react', { to: 1, e: 2 });
    m.clock.advance(1000);
    m.clock.advance(3100);
    m.call(m.ctx('a'), 'glimmer:react', { to: 1, e: 3 });
    m.clock.advance(1100);
    const toB = m.emits.filter((e) => e.socketId === 's-b' && e.ev === 'glimmer:feed');
    expect(toB).toHaveLength(1);
    expect((toB[0]?.data as FeedView).r).toEqual([
      [0, 1, 2],
      [0, 1, 3],
    ]);
  });

  it('moves the seat to a newer socket, drops a disconnected seat after 120 s, and deletes an empty hall', () => {
    const h = createHarness({ rng: scripted(31).rng, potRng: () => 999_999 });
    hallOf(h, 'a', 'b');
    h.call(h.ctx('a', 's-new'), 'glimmer:enter', { ch: CH, v: V });
    expect(h.to('s-a', 'glimmer:moved')).toEqual([{}]);
    expect(h.call(h.ctx('a', 's-a'), 'glimmer:spin', { m: 1, b: 20, id: sid() })).toEqual({ ok: false, code: 'moved' });
    expect(h.call<SpinOk>(h.ctx('a', 's-new'), 'glimmer:spin', { m: 1, b: 20, id: sid() }).ok).toBe(true);
    h.game.onSocketGone('b', 's-b');
    h.clock.advance(119_000);
    expect(h.game.debug.halls.get(CH)?.members.size).toBe(2);
    h.clock.advance(2000);
    expect(h.game.debug.halls.get(CH)?.members.size).toBe(1);
    expect(h.game.debug.seats.has('b')).toBe(false);
    // Leaving the call: out of the hall, still spinning alone.
    h.game.onVoiceLeft('a', CH);
    expect(h.game.debug.halls.has(CH)).toBe(false);
    expect(h.call<SpinOk>(h.ctx('a', 's-new'), 'glimmer:spin', { m: 1, b: 20, id: sid() }).ok).toBe(true);
    h.game.stop();
    expect(h.clock.pending).toBe(0);
  });

  it('runs a Dash: 2-entrant minimum, the 60 s cancel, exact payouts, a freeroll trophy and an immediate vault', () => {
    const r = scripted(37);
    const h = createHarness({ rng: r.rng, potRng: () => 999_999 });
    hallOf(h, 'a', 'b', 'c');
    const start = { a: balance(h, 'a'), b: balance(h, 'b'), c: balance(h, 'c') };
    // Alone in the lobby for 60 s: cancelled, buy-in back.
    const lone = h.call<{ ok: true; dash: DashView }>(h.ctx('a'), 'glimmer:dash:create', { m: 1, len: 3, buy: 500 });
    expect(balance(h, 'a')).toBe(start.a - 500);
    expect(h.call(h.ctx('a'), 'glimmer:dash:start', { id: lone.dash.id })).toEqual({ ok: false, code: 'few' });
    h.clock.advance(60_000);
    expect(balance(h, 'a')).toBe(start.a);
    expect(h.game.debug.dashes.viewFor(CH)?.st).toBe(DASH_ST.void);
    sound(h);
    // Three entrants at 1,000: 70/30 of 3,000.
    const d = h.call<{ ok: true; dash: DashView }>(h.ctx('a'), 'glimmer:dash:create', { m: 2, len: 5, buy: 1000 }).dash;
    expect(h.call(h.ctx('b'), 'glimmer:dash:join', { id: d.id })).toMatchObject({ ok: true });
    expect(h.call(h.ctx('c'), 'glimmer:dash:join', { id: d.id })).toMatchObject({ ok: true });
    expect(h.call(h.ctx('b'), 'glimmer:dash:start', { id: d.id })).toEqual({ ok: false, code: 'host' });
    expect(h.call(h.ctx('a'), 'glimmer:dash:start', { id: d.id })).toEqual({ ok: true });
    // Still 'open' while the platform's sheet would hide Open for 'dash' (DASH_ACTIVITY).
    expect(h.game.activity(CH)[0]?.st).toBe(DASH_ACTIVITY ? 'dash' : 'open');
    const spinsBefore = count(h, "SELECT COUNT(*) FROM arcade_txns WHERE kind = 'spin'");
    const potBefore = h.wallet.pot('glimmer');
    // An immediate vault for a: keys on reels 1, 3 and 5, doors shuffled, door drawn.
    r.push(0, 1, 0, 1, 0, 0, 0, 2);
    const vault = h.call<{ ok: true; f?: { k: string; d: number; x: number } }>(h.ctx('a'), 'glimmer:dash:spin', { d: d.id, id: sid() });
    expect(vault.f?.k).toBe('v');
    expect([vault.f?.d, vault.f?.x]).toEqual([2, 2]);
    for (const id of ['a', 'b', 'c']) {
      for (let i = id === 'a' ? 1 : 0; i < 100; i += 1) {
        const ack = h.call<{ ok: boolean; left: number }>(h.ctx(id), 'glimmer:dash:spin', { d: d.id, id: sid() });
        expect(ack.ok).toBe(true);
      }
    }
    // Every spin played: the Dash is over.
    expect(h.call(h.ctx('a'), 'glimmer:dash:spin', { d: d.id, id: sid() })).toEqual({ ok: false, code: 'gone' });
    // No wallet, pot or ledger traffic from Dash spins.
    expect(count(h, "SELECT COUNT(*) FROM arcade_txns WHERE kind = 'spin'")).toBe(spinsBefore);
    expect(h.wallet.pot('glimmer')).toEqual(potBefore);
    const done = h.game.debug.dashes.viewFor(CH) as DashView;
    expect(done.st).toBe(DASH_ST.done);
    const paid = (done.pay ?? []).filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0);
    expect(paid).toBe(3000);
    const total = balance(h, 'a') + balance(h, 'b') + balance(h, 'c');
    expect(total).toBe(start.a + start.b + start.c);
    expect(count(h, "SELECT COUNT(*) FROM arcade_results WHERE game = 'glimmer' AND mode = 'dash'")).toBe(1);
    expect(count(h, 'SELECT SUM(chips_delta) FROM arcade_result_players')).toBe(0);
    sound(h);
    // A freeroll: no chips move, the winner gets the trophy.
    const free = h.call<{ ok: true; dash: DashView }>(h.ctx('b'), 'glimmer:dash:create', { m: 0, len: 3, buy: 0 }).dash;
    h.call(h.ctx('c'), 'glimmer:dash:join', { id: free.id });
    h.call(h.ctx('b'), 'glimmer:dash:start', { id: free.id });
    const txns = count(h, 'SELECT COUNT(*) FROM arcade_txns');
    h.clock.advance(3 * 60_000 + 1000);
    expect(h.game.debug.dashes.viewFor(CH)?.st).toBe(DASH_ST.done);
    expect(count(h, 'SELECT COUNT(*) FROM arcade_txns')).toBe(txns);
    expect(count(h, "SELECT COUNT(*) FROM arcade_stats WHERE stat = 'dash.wins'")).toBeGreaterThanOrEqual(2);
    sound(h);
  }, 15_000);

  it('voids and refunds a Dash on restart, refunds leftover buy-ins at boot, and closes the halls when the game is switched off', () => {
    const r = scripted(41);
    const h = createHarness({ rng: r.rng, potRng: () => 999_999 });
    hallOf(h, 'a', 'b');
    const start = balance(h, 'a') + balance(h, 'b');
    const d = h.call<{ ok: true; dash: DashView }>(h.ctx('a'), 'glimmer:dash:create', { m: 1, len: 5, buy: 500 }).dash;
    h.call(h.ctx('b'), 'glimmer:dash:join', { id: d.id });
    h.call(h.ctx('a'), 'glimmer:dash:start', { id: d.id });
    h.game.onRestarting();
    expect(balance(h, 'a') + balance(h, 'b')).toBe(start);
    expect(count(h, "SELECT COUNT(*) FROM arcade_txns WHERE kind = 'restart-refund'")).toBeGreaterThan(0);
    expect((h.to('s-b', 'glimmer:feed') as FeedView[]).some((f) => f.d?.st === DASH_ST.void)).toBe(true);
    sound(h);
    // Boot after a crash: escrow left behind goes back.
    h.wallet.transfer('buyin', 'dash:old', 'a', 'stale', [
      { account: 'w:a', delta: -100 },
      { account: 'e:dash:old:a', delta: 100 },
    ]);
    h.game.onBoot();
    expect(h.wallet.escrowRows('dash:')).toEqual([]);
    sound(h);
    // Switched off: pending vaults open and pay, halls close.
    const g = createHarness({ rng: scripted(43).rng, potRng: () => 999_999 });
    hallOf(g, 'a');
    g.call(g.ctx('a'), 'glimmer:spin', { m: 1, b: 20, id: sid() });
    g.game.onDisable();
    expect(g.to('s-a', 'glimmer:closed')).toEqual([{ r: 'disabled' }]);
    expect(g.game.debug.halls.size).toBe(0);
    sound(g);
  });

  it('opens pending vaults when switched off', () => {
    const r = scripted(53);
    const h = createHarness({ rng: r.rng, potRng: () => 999_999 });
    hallOf(h, 'a');
    r.push(0, 1, 0, 1, 0, 0, 0);
    expect(h.call<SpinOk>(h.ctx('a'), 'glimmer:spin', { m: 2, b: 20, id: sid() }).v).toBe(1);
    const before = balance(h, 'a');
    h.game.onDisable();
    expect(count(h, 'SELECT COUNT(*) FROM arcade_pending')).toBe(0);
    expect(count(h, "SELECT COUNT(*) FROM arcade_txns WHERE kind = 'feature'")).toBe(1);
    expect(balance(h, 'a')).toBeGreaterThanOrEqual(before);
    sound(h);
  });
});
