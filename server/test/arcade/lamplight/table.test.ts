/**
 * Server tables (lamplight.md §18.2) on a fake TableApi with the real wallet: hidden cards never
 * leak (every message to every socket scanned structurally), the wallet invariant holds after every
 * hand, proofs reveal only what the caller may see, sync replays or snaps, `dup` and `stale` work,
 * and the online bot and idle rules hold.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { legal, type Action } from '../../../src/arcade/core/lamplight/engine.js';
import { verify } from '../../../src/arcade/core/lamplight/proof.js';
import { checkInvariant } from '../../../src/arcade/wallet.js';
import { createLamplight, IDLE_EMPTY_MS, type LamplightGame } from '../../../src/arcade/tables/lamplight.js';
import { makeFakeApi, type FakeHarness, type FakeSocket } from './fakeApi.js';
import { rng } from './helpers.js';

const sha = async (d: Uint8Array) => new Uint8Array(createHash('sha256').update(d).digest());
const KIND: Record<Action['kind'], string> = { fold: 'f', check: 'x', call: 'c', bet: 'b', raise: 'r', allin: 'a' };

/** Cards anywhere under `c`, `hole` or `board` keys. */
const cardsIn = (v: unknown, out: number[] = [], key = ''): number[] => {
  if (Array.isArray(v)) {
    if ((key === 'c' || key === 'hole' || key === 'board') && v.every((x) => typeof x === 'number')) out.push(...(v as number[]));
    else for (const x of v) cardsIn(x, out, key);
  } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) cardsIn(x, out, k);
  return out;
};

const setup = (o: { mode?: string; cfg?: Record<string, unknown>; humans?: number; botCap?: number; seed?: number } = {}) => {
  const h = makeFakeApi({ botCap: o.botCap });
  const r = rng(o.seed ?? 9);
  const game = createLamplight(h.api, { randInt: (n) => r.int(n), secret: () => Uint8Array.from({ length: 32 }, () => r.int(256)), trioDraw: () => r.int(1_000_000) });
  const lobby = h.lobby('tblA', o.mode ?? 'open', o.cfg ?? { tier: 'pebble', seats: 6 });
  const humans = Array.from({ length: o.humans ?? 2 }, (_, i) => h.account('acct' + (i + 1)));
  return { h, game, lobby, humans, r };
};

const table = (game: LamplightGame, id = 'tblA') => game.tables.get(id)!;

/** Humans act at random through intents; bots and clocks run on the virtual clock. */
const playUntil = async (h: FakeHarness, game: LamplightGame, humans: FakeSocket[], r: ReturnType<typeof rng>, hands: number, onHandEnd?: () => void) => {
  const tb = table(game);
  let lastHand = tb.state.handsPlayed;
  for (let step = 0; step < hands * 400 && tb.state.handsPlayed < hands && !tb.closed; step++) {
    const hand = tb.state.hand;
    if (hand && hand.toAct >= 0 && !hand.pending) {
      const s = tb.state.seats[hand.toAct];
      const sock = humans.find((x) => x.accountId === s.player?.accountId);
      if (sock && r.int(4) > 0) {
        const lg = legal(tb.state, hand.toAct)!;
        const roll = r.int(10);
        const a: Action = lg.canRaise && roll < 2 ? { kind: lg.currentBet === 0 ? 'bet' : 'raise', to: lg.minTo } : lg.canCheck ? { kind: 'check' } : roll < 8 ? { kind: 'call' } : { kind: 'fold' };
        const ack = await h.call(sock, 'lamplight:act', { t: tb.id, h: hand.handNo, q: tb.state.q, k: KIND[a.kind], a: 'to' in a ? a.to : undefined });
        expect(ack.ok).toBe(true);
        continue;
      }
    }
    h.clock.run(500);
    if (tb.state.handsPlayed !== lastHand) {
      lastHand = tb.state.handsPlayed;
      onHandEnd?.();
      for (const sock of humans) {
        const seat = tb.state.seats.find((x) => x.player?.accountId === sock.accountId);
        if (seat && seat.stack === 0) await h.call(sock, 'lamplight:topUp', { t: tb.id, amount: tb.state.config.buyInMax, id: 'rebuy-' + sock.id + '-' + lastHand });
      }
    }
  }
};

describe('a cash table online', () => {
  it('never leaks hole cards: 200 hands, two seated humans, bots and a spectator', async () => {
    const { h, game, humans, r } = setup({ cfg: { tier: 'pebble', seats: 6, bots: 'regular' } });
    const watcher = h.account('watcher');
    for (const s of humans) {
      expect(await h.call(s, 'lamplight:sit', { t: 'tblA', buyIn: 1000, post: 'wait', id: 'sit-' + s.id })).toEqual({ ok: true });
    }
    expect(game.lobby!.onJoin({ accountId: watcher.accountId, socketId: watcher.id, voiceChannelId: 'ch1' }, h.lobbies.get('tblA')!, 'spectator')).toEqual({ ok: true });
    const tb = table(game);
    // Bots leave two seats for people.
    expect(tb.state.seats.filter((s) => s.player?.botId).length).toBe(4);
    const sockets = [...humans, watcher];
    const marks = new Map<string, number>(sockets.map((s) => [s.id, 0]));
    let checked = 0;
    const scan = () => {
      // The finished hand: what each socket may know.
      const state = tb.state;
      const board = new Set(state.hand?.board ?? []);
      for (const sock of sockets) {
        const mine = state.seats.find((s) => s.player?.accountId === sock.accountId);
        const own = new Set(mine?.hole ?? []);
        const shown = new Set<number>();
        for (const s of state.seats) if (s.shown && s.hole && s !== mine) for (const c of s.hole) shown.add(c);
        const hidden = new Set<number>();
        for (const s of state.seats) if (s.inHand && s.hole && s !== mine && !s.shown) for (const c of s.hole) hidden.add(c);
        const from = marks.get(sock.id) ?? 0;
        for (const msg of sock.received.slice(from)) {
          const cards = cardsIn(msg.data);
          for (const c of cards) {
            expect(hidden.has(c), msg.name + ' to ' + sock.accountId + ' carries a hidden card').toBe(false);
            if (shown.has(c)) expect(['lamplight:show', 'lamplight:snap']).toContain(msg.name);
          }
          if (msg.name === 'lamplight:hole') {
            expect(sock).not.toBe(watcher);
            for (const c of msg.data.c as number[]) expect(own.has(c)).toBe(true);
          }
          if (msg.name === 'lamplight:street') for (const c of msg.data.c as number[]) expect(board.has(c)).toBe(true);
        }
        marks.set(sock.id, sock.received.length);
      }
      expect(checkInvariant(h.db)).toEqual([]);
      checked++;
    };
    h.clock.run(1000);
    await playUntil(h, game, humans, r, 200, scan);
    expect(tb.state.handsPlayed).toBeGreaterThanOrEqual(200);
    expect(checked).toBeGreaterThanOrEqual(150);
    // Table order: q is consecutive at every socket.
    for (const sock of sockets) {
      const qs = sock.received.filter((m) => m.name !== 'lamplight:snap' && typeof m.data.q === 'number').map((m) => m.data.q as number);
      for (let i = 1; i < qs.length; i++) expect(qs[i]).toBe(qs[i - 1] + 1);
    }
  });

  it('keeps every stack in escrow and conserves chips through bots, hands and leaving', async () => {
    const { h, game, humans, r } = setup({ cfg: { tier: 'cobble', seats: 4, bots: 'greenhorn' } });
    const total = () =>
      (h.db.prepare("SELECT COALESCE(SUM(balance),0) FROM arcade_wallets").pluck().get() as number) +
      (h.db.prepare('SELECT COALESCE(SUM(amount),0) FROM arcade_escrow').pluck().get() as number);
    const house = () => (h.db.prepare("SELECT balance_after FROM arcade_ledger WHERE account = 'house' ORDER BY txn_id DESC LIMIT 1").pluck().get() as number | undefined) ?? 0;
    for (const s of humans) await h.call(s, 'lamplight:sit', { t: 'tblA', buyIn: 5000, id: 'sit-' + s.id });
    const tb = table(game);
    const start = total() + house();
    h.clock.run(1000);
    await playUntil(h, game, humans, r, 40, () => {
      expect(checkInvariant(h.db)).toEqual([]);
      expect(total() + house()).toBe(start);
      for (const s of tb.state.seats) {
        if (!s.player) continue;
        const holder = s.player.accountId ?? 'bot:' + s.seat;
        const esc = h.db.prepare('SELECT amount FROM arcade_escrow WHERE ref = ? AND account_id = ?').pluck().get('lamplight:tblA', holder) as number | undefined;
        expect(esc ?? 0).toBe(s.stack);
      }
    });
    await h.call(humans[0], 'lamplight:leave', { t: 'tblA', id: 'bye' });
    h.clock.run(20_000);
    expect(tb.state.seats.some((s) => s.player?.accountId === humans[0].accountId)).toBe(false);
    expect(total() + house()).toBe(start);
    expect(checkInvariant(h.db)).toEqual([]);
  });

  it('answers a duplicate act with dup, an old q with stale, and a proof with only what you saw', async () => {
    const { h, game, humans } = setup();
    for (const s of humans) await h.call(s, 'lamplight:sit', { t: 'tblA', buyIn: 1000, id: 'sit-' + s.id });
    h.clock.run(1000);
    const tb = table(game);
    const hand = tb.state.hand!;
    const actor = humans.find((s) => s.accountId === tb.state.seats[hand.toAct].player?.accountId)!;
    const other = humans.find((s) => s !== actor)!;
    const payload = { t: 'tblA', h: hand.handNo, q: tb.state.q, k: 'c' };
    expect(await h.call(actor, 'lamplight:act', { ...payload, q: hand.turnQ - 1 })).toEqual({ ok: false, code: 'stale' });
    expect(await h.call(actor, 'lamplight:act', payload)).toEqual({ ok: true });
    expect(await h.call(actor, 'lamplight:act', payload)).toEqual({ ok: true, dup: true });
    expect(await h.call(actor, 'lamplight:proof', { t: 'tblA', h: hand.handNo })).toEqual({ ok: false, code: 'busy' });
    // Fold the hand out so it ends uncontested, then ask for proofs.
    for (let i = 0; i < 20 && tb.state.handsPlayed < 1; i++) {
      const hh = tb.state.hand!;
      if (hh.toAct >= 0) {
        const sock = humans.find((s) => s.accountId === tb.state.seats[hh.toAct].player?.accountId)!;
        // The other player folds, so the hand ends without a showdown and nothing is shown.
        await h.call(sock, 'lamplight:act', { t: 'tblA', h: hh.handNo, q: tb.state.q, k: sock === other ? 'f' : legal(tb.state, hh.toAct)!.canCheck ? 'x' : 'c' });
      }
      h.clock.run(100);
    }
    const proof = (await h.call(actor, 'lamplight:proof', { t: 'tblA', h: hand.handNo })) as { ok: boolean; root: string; L: string; rv: { i: number; c: number; s: string }[] };
    expect(proof.ok).toBe(true);
    const cr = actor.received.find((m) => m.name === 'lamplight:hand')?.data.cr as string;
    expect(cr).toHaveLength(43);
    const holeMsg = actor.received.find((m) => m.name === 'lamplight:hole')!;
    const mine = holeMsg.data.c as number[];
    // Only the board and the caller's own cards (nothing was shown in an uncontested hand).
    const revealed = proof.rv.map((x) => x.c);
    for (const c of mine) expect(revealed).toContain(c);
    const otherHole = other.received.find((m) => m.name === 'lamplight:hole')!.data.c as number[];
    for (const c of otherHole) expect(revealed).not.toContain(c);
    expect(await verify(proof, cr, proof.rv.map((x) => ({ i: x.i, c: x.c })), sha)).toEqual({ ok: true });
    const stranger = h.account('stranger');
    expect(await h.call(stranger, 'lamplight:proof', { t: 'tblA', h: hand.handNo })).toEqual({ ok: false, code: 'forbidden' });
  });

  it('syncs a reconnect from the ring with your cards, or with a snap', async () => {
    const { h, game, humans } = setup();
    for (const s of humans) await h.call(s, 'lamplight:sit', { t: 'tblA', buyIn: 1000, id: 'sit-' + s.id });
    h.clock.run(1000);
    const tb = table(game);
    const [a] = humans;
    const lastQ = (a.received.filter((m) => typeof m.data.q === 'number').at(-1)?.data.q as number) ?? 0;
    const handQ = a.received.find((m) => m.name === 'lamplight:hand')!.data.q as number;
    // The socket drops; the seat stays and is marked disconnected after the coalescing window.
    // The platform calls the hook while presence still lists the closing socket.
    game.onSocketGone(a.accountId, a.id);
    h.drop(a);
    h.clock.run(2500);
    const n = tb.state.seats.findIndex((s) => s.player?.accountId === a.accountId);
    expect(tb.state.seats[n].connected).toBe(false);
    const back = h.account(a.accountId);
    expect(await h.call(back, 'lamplight:sync', { t: 'tblA', since: handQ - 1 })).toEqual({ ok: true, mode: 'events' });
    const names = back.received.map((m) => m.name);
    expect(names[0]).toBe('lamplight:hand');
    expect(names[1]).toBe('lamplight:hole');
    expect(tb.state.seats[n].connected).toBe(true);
    const fresh = h.account(a.accountId);
    expect(await h.call(fresh, 'lamplight:sync', { t: 'tblA', since: -1 })).toEqual({ ok: true, mode: 'snap' });
    const snap = fresh.received[0];
    expect(snap.name).toBe('lamplight:snap');
    expect(snap.data.hole).toEqual(tb.state.seats[n].hole);
    expect((snap.data.s as string[]).length).toBe(2);
    expect(lastQ).toBeGreaterThan(0);
  });
});

describe('online rules', () => {
  it('refuses bots at Boulder and Summit and in the Trio, and holds the server-wide bot cap', () => {
    const { h, game } = setup({ botCap: 4 });
    const host = h.account('host');
    const c = { accountId: host.accountId, socketId: host.id, voiceChannelId: 'ch1' };
    expect(game.lobby!.onCreate(c, { mode: 'open', tier: 'boulder', bots: 'regular' })).toEqual({ ok: false, code: 'bots' });
    expect(game.lobby!.onCreate(c, { mode: 'open', tier: 'summit', bots: 'sharp' })).toEqual({ ok: false, code: 'bots' });
    // The Trio's refusal needs the mode: the hub's onCreated closes such a lobby.
    game.lobby!.onCreated!(c, h.lobby('trioX', 'trio', { buyIn: 1000, bots: 'regular' }));
    expect(h.closed).toContainEqual({ id: 'trioX', reason: 'bots' });
    expect(game.lobby!.onCreate(c, { mode: 'open', tier: 'cobble', bots: 'regular' })).toEqual({ ok: true });
    h.setSettings({ serverBots: false });
    expect(game.lobby!.onCreate(c, { mode: 'open', tier: 'pebble', bots: 'regular' })).toEqual({ ok: false, code: 'bots' });
    h.setSettings({ serverBots: true });
    // Five-seat tables want three bots each (two seats stay for people); against a cap of 4 the second gets one.
    h.lobby('tblB', 'open', { tier: 'pebble', seats: 5, bots: 'regular' });
    game.lobby!.onJoin(c, h.lobbies.get('tblA')!, 'spectator');
    expect(h.bots).toBe(0);
    game.lobby!.onJoin(c, h.lobbies.get('tblB')!, 'spectator');
    expect(h.bots).toBe(3);
    h.lobby('tblC', 'open', { tier: 'pebble', seats: 5, bots: 'regular' });
    h.lobby('tblD', 'open', { tier: 'pebble', seats: 5, bots: 'regular' });
    game.lobby!.onJoin(c, h.lobbies.get('tblC')!, 'spectator');
    game.lobby!.onJoin(c, h.lobbies.get('tblD')!, 'spectator');
    expect(h.bots).toBe(4);
    const botsAt = (id: string) => game.tables.get(id)!.state.seats.filter((s) => s.player?.botId).length;
    expect([botsAt('tblB'), botsAt('tblC'), botsAt('tblD')]).toEqual([3, 1, 0]);
  });

  it('a bot gives its seat to a person at a full table: after the hand it is in, or at once', async () => {
    const { h, game, humans, r } = setup({ cfg: { tier: 'pebble', players: 4, bots: 'greenhorn' }, humans: 4, botCap: 6 });
    for (const s of humans.slice(0, 2)) expect(await h.call(s, 'lamplight:sit', { t: 'tblA', buyIn: 1000, post: 'now', id: 'sit-' + s.id })).toEqual({ ok: true });
    const tb = table(game);
    const bots = () => tb.state.seats.filter((s) => s.player?.botId).length;
    expect(bots()).toBe(2);
    for (let i = 0; i < 40 && !(tb.state.hand && tb.state.hand.street !== 'done'); i++) h.clock.run(250);
    expect(tb.state.hand?.street).not.toBe('done');
    // Mid-hand with both bots dealt in: one promises its seat and leaves when the hand ends.
    const [, , third, fourth] = humans;
    expect(await h.call(third, 'lamplight:sit', { t: 'tblA', buyIn: 1000, post: 'wait', id: 'sit-3a' })).toEqual({ ok: false, code: 'soon' });
    expect(tb.info.filter((x) => x.leaveAfter).length).toBe(1);
    const played = tb.state.handsPlayed;
    await playUntil(h, game, humans.slice(0, 2), r, played + 1);
    for (let i = 0; i < 40 && bots() === 2; i++) h.clock.run(250);
    expect(bots()).toBe(1);
    expect(await h.call(third, 'lamplight:sit', { t: 'tblA', buyIn: 1000, post: 'wait', id: 'sit-3b' })).toEqual({ ok: true });
    // Between hands the last bot stands up at once.
    for (let i = 0; i < 400 && tb.state.hand && tb.state.hand.street !== 'done'; i++) await playUntil(h, game, humans.slice(0, 3), r, tb.state.handsPlayed + 1);
    expect(await h.call(fourth, 'lamplight:sit', { t: 'tblA', buyIn: 1000, post: 'wait', id: 'sit-4' })).toEqual({ ok: true });
    expect(bots()).toBe(0);
    expect(tb.state.seats.filter((s) => s.player?.accountId).length).toBe(4);
    expect(await h.call(h.account('late'), 'lamplight:sit', { t: 'tblA', buyIn: 1000, post: 'wait', id: 'sit-5' })).toEqual({ ok: false, code: 'full' });
    expect(h.bots).toBe(0);
    expect(checkInvariant(h.db)).toEqual([]);
  });

  it('closes an empty table after 2 minutes and arms no timer between hands when nobody can play', async () => {
    const { h, game, humans } = setup();
    await h.call(humans[0], 'lamplight:sit', { t: 'tblA', buyIn: 1000, id: 'sit-1' });
    const tb = table(game);
    // One human alone: no hand can run, so the only timer is none at all.
    h.clock.run(5000);
    expect(tb.state.hand).toBeNull();
    expect(h.clock.pending()).toBe(0);
    await h.call(humans[0], 'lamplight:leave', { t: 'tblA', id: 'bye' });
    h.clock.run(IDLE_EMPTY_MS + 1000);
    expect(tb.closed).toBe(true);
    expect(h.closed.map((c) => c.id)).toContain('tblA');
    expect(checkInvariant(h.db)).toEqual([]);
    expect(h.wallet.view(humans[0].accountId).bal).toBe(20_000);
  });

  it('a restart voids the hand and refunds every stack as it was when the hand began', async () => {
    const { h, game, humans } = setup();
    for (const s of humans) await h.call(s, 'lamplight:sit', { t: 'tblA', buyIn: 1000, id: 'sit-' + s.id });
    h.clock.run(1000);
    const tb = table(game);
    const hand = tb.state.hand!;
    const sock = humans.find((s) => s.accountId === tb.state.seats[hand.toAct].player?.accountId)!;
    await h.call(sock, 'lamplight:act', { t: 'tblA', h: hand.handNo, q: tb.state.q, k: 'r', a: 300 });
    game.onRestarting();
    for (const s of humans) expect(h.wallet.view(s.accountId)).toMatchObject({ bal: 20_000, esc: 0 });
    expect(sock.received.some((m) => m.name === 'lamplight:end' && m.data.void === 'restart')).toBe(true);
    expect(checkInvariant(h.db)).toEqual([]);
    expect(h.clock.pending()).toBe(0);
  });
});
