/**
 * Leaving a cash table on purpose is immediate (lamplight.md §2.1, §5): the seat folds now (or the
 * moment its turn comes, which takes no time), the stack is back in the wallet at once while the
 * chips already in the pot stay there, and the last human to leave closes the table at once, bots
 * and all. A disconnect still keeps the seat for 5 minutes and the empty table 2 minutes more. Chips
 * are conserved at every step, and every event still fits the client's mirror.
 */
import { describe, expect, it } from 'vitest';
import { legal, type Action, type TableState } from '../../../src/arcade/core/lamplight/engine.js';
import { applyEvent, fromSnap, type WireSnap } from '../../../src/arcade/core/lamplight/views.js';
import { checkInvariant } from '../../../src/arcade/wallet.js';
import { createLamplight, IDLE_EMPTY_MS, RELEASE_DISCONNECTED_MS, type LamplightGame } from '../../../src/arcade/tables/lamplight.js';
import { makeFakeApi, type FakeHarness, type FakeSocket } from './fakeApi.js';
import { rng } from './helpers.js';

const KIND: Record<Action['kind'], string> = { fold: 'f', check: 'x', call: 'c', bet: 'b', raise: 'r', allin: 'a' };
const REF = 'lamplight:tblA';
const ctx = (s: FakeSocket) => ({ accountId: s.accountId, socketId: s.id, voiceChannelId: 'ch1' });

const setup = (cfg: Record<string, unknown>, humans: number, seed = 5) => {
  const h = makeFakeApi();
  const r = rng(seed);
  const game = createLamplight(h.api, { randInt: (n) => r.int(n), secret: () => Uint8Array.from({ length: 32 }, () => r.int(256)) });
  h.lobby('tblA', 'open', cfg);
  const socks = Array.from({ length: humans }, (_, i) => h.account('p' + (i + 1)));
  return { h, game, socks, r };
};

/** Wallets, escrow and the house's running total: their sum never changes. */
const ledger = (h: FakeHarness) => {
  const wallets = h.db.prepare('SELECT COALESCE(SUM(balance),0) FROM arcade_wallets').pluck();
  const escrow = h.db.prepare('SELECT COALESCE(SUM(amount),0) FROM arcade_escrow').pluck();
  const house = h.db.prepare("SELECT balance_after FROM arcade_ledger WHERE account = 'house' ORDER BY txn_id DESC LIMIT 1").pluck();
  const row = h.db.prepare('SELECT amount FROM arcade_escrow WHERE ref = ? AND account_id = ?').pluck();
  const atTable = h.db.prepare('SELECT COALESCE(SUM(amount),0) FROM arcade_escrow WHERE ref = ?').pluck();
  const stat = h.db.prepare("SELECT value FROM arcade_stats WHERE account_id = ? AND game = 'lamplight' AND stat = ?").pluck();
  return {
    total: () => (wallets.get() as number) + (escrow.get() as number) + ((house.get() as number | undefined) ?? 0),
    escrowOf: (holder: string, ref = REF) => (row.get(ref, holder) as number | undefined) ?? 0,
    atTable: (ref = REF) => atTable.get(ref) as number,
    stat: (a: string, s: string) => (stat.get(a, s) as number | undefined) ?? null,
  };
};

/** The client's mirror over what a socket received: every event must fit, in order. */
const mirror = (sock: FakeSocket) => {
  let view: TableState | null = null;
  let cursor = 0;
  let applied = 0;
  return {
    drain() {
      for (; cursor < sock.received.length; cursor++) {
        const { name, data } = sock.received[cursor];
        if (!name.startsWith('lamplight:') || name === 'lamplight:emote' || name === 'lamplight:hole') continue;
        if (name === 'lamplight:snap') {
          view = fromSnap(data as unknown as WireSnap, 0);
          continue;
        }
        if (!view) continue;
        expect(data.q, name + ' arrived out of order').toBe(view.q + 1);
        expect(applyEvent(view, name, data, 0, null), name + ' did not fit the mirror (' + JSON.stringify(data) + ')').toBe(true);
        applied++;
      }
    },
    get applied() {
      return applied;
    },
    get view() {
      return view;
    },
  };
};

const seatOf = (game: LamplightGame, a: string): number => game.tables.get('tblA')?.state.seats.findIndex((s) => s.player?.accountId === a) ?? -1;
const sockAt = (game: LamplightGame, socks: FakeSocket[], n: number): FakeSocket | undefined =>
  socks.find((s) => s.accountId === game.tables.get('tblA')?.state.seats[n]?.player?.accountId);

/** The seat to act checks or calls (humans through intents). */
const passive = async (h: FakeHarness, game: LamplightGame, sock: FakeSocket) => {
  const tb = game.tables.get('tblA')!;
  const hand = tb.state.hand!;
  const lg = legal(tb.state, hand.toAct)!;
  const ack = await h.call(sock, 'lamplight:act', { t: 'tblA', h: hand.handNo, q: tb.state.q, k: lg.canCheck ? 'x' : 'c' });
  expect(ack.ok).toBe(true);
};

/** Humans check or call until the hand ends (bots and runouts on the virtual clock). */
const finishHand = async (h: FakeHarness, game: LamplightGame, socks: FakeSocket[]) => {
  const tb = game.tables.get('tblA')!;
  const no = tb.state.hand!.handNo;
  for (let i = 0; i < 400 && tb.state.hand?.handNo === no && tb.state.hand.street !== 'done'; i++) {
    const hand = tb.state.hand;
    const sock = hand.toAct >= 0 && !hand.pending ? sockAt(game, socks, hand.toAct) : undefined;
    if (sock) await passive(h, game, sock);
    else h.clock.run(250);
  }
  expect(tb.state.hand?.handNo !== no || tb.state.hand.street === 'done').toBe(true);
};

describe('leaving a cash table', () => {
  it('on your turn: you fold at once, your stack is back at once, and your device stops getting the table', async () => {
    const { h, game, socks } = setup({ tier: 'pebble', seats: 3 }, 3);
    const book = ledger(h);
    for (const s of socks) expect(await h.call(s, 'lamplight:sit', { t: 'tblA', buyIn: 1000, id: 'sit-' + s.id })).toEqual({ ok: true });
    const start = book.total();
    h.clock.run(1000);
    const tb = game.tables.get('tblA')!;
    const hand = tb.state.hand!;
    // The button calls; the small blind (5 posted) is to act and leaves.
    await passive(h, game, sockAt(game, socks, hand.toAct)!);
    expect(tb.state.hand!.toAct).toBe(hand.sbSeat);
    const sb = sockAt(game, socks, hand.sbSeat)!;
    const others = socks.filter((s) => s !== sb);
    const t0 = h.clock.t;
    expect(await h.call(sb, 'lamplight:leave', { t: 'tblA', now: true, id: 'bye' })).toEqual({ ok: true });
    // Nothing waited: the fold went out, the seat is nobody's, 995 is back and 5 stays in the pot.
    expect(h.clock.t).toBe(t0);
    for (const o of others) expect(o.received.filter((m) => m.name === 'lamplight:act').at(-1)?.data).toMatchObject({ s: hand.sbSeat, k: 'f' });
    expect(tb.state.seats[hand.sbSeat]).toMatchObject({ inHand: true, folded: true, player: { accountId: null } });
    expect(h.wallet.view(sb.accountId)).toMatchObject({ bal: 19_995, esc: 5 });
    expect(book.total()).toBe(start);
    // The leaver may sit anywhere at once.
    h.lobby('tblB', 'open', { tier: 'pebble', seats: 3 });
    expect(await h.call(sb, 'lamplight:sit', { t: 'tblB', buyIn: 1000, id: 'sit-b' })).toEqual({ ok: true });
    const heard = sb.received.filter((m) => m.name !== 'lamplight:snap' && m.data.t === 'tblA').length;
    // The hand goes on for the other two, and the leaver's device gets none of it.
    await finishHand(h, game, others);
    expect(sb.received.filter((m) => m.name !== 'lamplight:snap' && m.data.t === 'tblA').length).toBe(heard);
    expect(seatOf(game, sb.accountId)).toBe(-1);
    expect(tb.state.seats[hand.sbSeat].player).toBeNull();
    expect(book.escrowOf(sb.accountId)).toBe(0);
    expect(book.atTable()).toBe(tb.state.seats.reduce((x, s) => x + s.stack, 0));
    expect(book.total()).toBe(start);
    expect(checkInvariant(h.db)).toEqual([]);
  });

  it('while another player is to act: your stack is back at once and the seat folds the moment its turn comes', async () => {
    const { h, game, socks } = setup({ tier: 'pebble', seats: 3 }, 3);
    const book = ledger(h);
    for (const s of socks) await h.call(s, 'lamplight:sit', { t: 'tblA', buyIn: 1000, id: 'sit-' + s.id });
    const start = book.total();
    h.clock.run(1000);
    const tb = game.tables.get('tblA')!;
    const hand = tb.state.hand!;
    const spectator = h.account('watcher');
    game.lobby!.onJoin(ctx(spectator), h.lobbies.get('tblA')!, 'spectator');
    const view = mirror(spectator);
    const bb = sockAt(game, socks, hand.bbSeat)!;
    expect(hand.toAct).not.toBe(hand.bbSeat);
    await h.call(bb, 'lamplight:leave', { t: 'tblA', now: true, id: 'bye' });
    expect(h.wallet.view(bb.accountId)).toMatchObject({ bal: 19_990, esc: 10 });
    expect(tb.state.seats[hand.bbSeat].folded).toBe(false);
    // The button and the small blind call; then it is the big blind's turn, and it folds in no time.
    await passive(h, game, sockAt(game, socks, tb.state.hand!.toAct)!);
    await passive(h, game, sockAt(game, socks, tb.state.hand!.toAct)!);
    expect(tb.state.hand!.toAct).toBe(hand.bbSeat);
    const t0 = h.clock.t;
    h.clock.run(0);
    expect(h.clock.t).toBe(t0);
    expect(tb.state.seats[hand.bbSeat].folded).toBe(true);
    expect(tb.state.hand!.street).toBe('flop');
    await finishHand(h, game, socks.filter((s) => s !== bb));
    view.drain();
    expect(view.applied).toBeGreaterThan(5);
    // The 10 posted is lost, and the hand counts in the leaver's stats and history.
    expect(h.wallet.view(bb.accountId)).toMatchObject({ bal: 19_990, esc: 0 });
    expect(book.stat(bb.accountId, 'net:all')).toBe(-10);
    expect(book.stat(bb.accountId, 'hands')).toBe(1);
    const rows = (await h.call(bb, 'lamplight:hands', {})) as { rows: { h: number; net: number }[] };
    expect(rows.rows).toContainEqual(expect.objectContaining({ h: hand.handNo, net: -10 }));
    // Coming back within 10 minutes takes at least the stack you left with.
    expect(await h.call(bb, 'lamplight:sit', { t: 'tblA', buyIn: 500, id: 'back-1' })).toEqual({ ok: false, code: 'amount' });
    expect(await h.call(bb, 'lamplight:sit', { t: 'tblA', buyIn: 990, id: 'back-2' })).toEqual({ ok: true });
    expect(book.total()).toBe(start);
    expect(checkInvariant(h.db)).toEqual([]);
  });

  it('all-in: the hand plays to the showdown and what it wins follows you to the wallet', async () => {
    const { h, game, socks } = setup({ tier: 'pebble', seats: 3 }, 3, 11);
    const book = ledger(h);
    for (const s of socks) await h.call(s, 'lamplight:sit', { t: 'tblA', buyIn: 1000, id: 'sit-' + s.id });
    const start = book.total();
    h.clock.run(1000);
    const tb = game.tables.get('tblA')!;
    const hand = tb.state.hand!;
    const shover = sockAt(game, socks, hand.toAct)!;
    const n = hand.toAct;
    await h.call(shover, 'lamplight:act', { t: 'tblA', h: hand.handNo, q: tb.state.q, k: 'a' });
    // The small blind calls all-in, the big blind folds: a runout between two all-in seats.
    await h.call(sockAt(game, socks, tb.state.hand!.toAct)!, 'lamplight:act', { t: 'tblA', h: hand.handNo, q: tb.state.q, k: 'c' });
    await h.call(sockAt(game, socks, tb.state.hand!.toAct)!, 'lamplight:act', { t: 'tblA', h: hand.handNo, q: tb.state.q, k: 'f' });
    expect(tb.state.hand!.runout).toBe(true);
    const watcher = socks.find((s) => s !== shover)!;
    await h.call(shover, 'lamplight:leave', { t: 'tblA', id: 'bye' });
    expect(h.wallet.view(shover.accountId)).toMatchObject({ bal: 19_000, esc: 1000 });
    expect(tb.state.seats[n]).toMatchObject({ inHand: true, folded: false, allIn: true });
    const mark = watcher.received.length;
    h.clock.run(10_000);
    const end = watcher.received.slice(mark).find((m) => m.name === 'lamplight:end')!.data as { stk: number[] };
    expect(h.wallet.view(shover.accountId)).toMatchObject({ bal: 19_000 + end.stk[n], esc: 0 });
    expect(tb.state.seats[n].player).toBeNull();
    expect(book.total()).toBe(start);
    expect(checkInvariant(h.db)).toEqual([]);
  });

  it.each(['on their turn', 'while a bot is to act', 'from the lobby, between hands'] as const)(
    'the last human leaving a bot table (%s) closes it at once: bots out, lobby ended, every chip settled',
    async (when) => {
      const { h, game, socks } = setup({ tier: 'pebble', seats: 6, bots: 'regular' }, 1, when.length);
      const [me] = socks;
      const book = ledger(h);
      const watcher = h.account('watcher');
      game.lobby!.onJoin(ctx(watcher), h.lobbies.get('tblA')!, 'spectator');
      const view = mirror(watcher);
      expect(h.bots).toBe(4);
      expect(await h.call(me, 'lamplight:sit', { t: 'tblA', buyIn: 1000, post: 'now', id: 'sit' })).toEqual({ ok: true });
      const start = book.total();
      const tb = game.tables.get('tblA')!;
      const mine = () => seatOf(game, me.accountId);
      let handNo = 0;
      if (when !== 'from the lobby, between hands') {
        // Wait for the moment: the human in a running hand, not folded, and to act (or a bot to act).
        for (let i = 0; i < 4000; i++) {
          const hand = tb.state.hand;
          const s = mine() >= 0 ? tb.state.seats[mine()] : null;
          const ready = hand && hand.street !== 'done' && !hand.pending && s?.inHand && !s.folded && hand.toAct >= 0;
          if (ready && (when === 'on their turn' ? hand.toAct === mine() : hand.toAct !== mine())) break;
          if (hand && hand.toAct === mine() && !hand.pending) await passive(h, game, me);
          else h.clock.run(50);
        }
        handNo = tb.state.hand!.handNo;
        expect(tb.state.hand!.street).not.toBe('done');
        await h.call(me, 'lamplight:leave', { t: 'tblA', now: true, id: 'bye' });
      } else {
        game.lobby!.onLeave(ctx(me), h.lobbies.get('tblA')!);
      }
      // Closed in the same call: nothing ran on the clock, no timer is left.
      expect(tb.closed).toBe(true);
      expect(game.tables.has('tblA')).toBe(false);
      expect(h.closed).toContainEqual({ id: 'tblA', reason: 'empty' });
      expect(h.lobbies.has('tblA')).toBe(false);
      expect(game.activity('ch1')).toEqual([]);
      expect(h.clock.pending()).toBe(0);
      expect(h.bots).toBe(0);
      // The hand in progress was played to its end at once: the stored row has the leaver's net, which is all they lost.
      expect(book.atTable()).toBe(0);
      if (handNo > 0) {
        const rows = (await h.call(me, 'lamplight:hands', {})) as { rows: { h: number; net: number }[] };
        expect(rows.rows.length).toBeLessThan(20);
        const row = rows.rows.find((x) => x.h === handNo)!;
        expect(row.net).toBeLessThanOrEqual(0);
        const before = rows.rows.filter((x) => x.h !== handNo).reduce((x, y) => x + y.net, 0);
        expect(h.wallet.view(me.accountId).bal).toBe(20_000 + before + row.net);
      } else expect(h.wallet.view(me.accountId).bal).toBe(20_000);
      view.drain();
      expect(book.total()).toBe(start);
      expect(checkInvariant(h.db)).toEqual([]);
    },
  );

  it('a disconnect keeps the seat for 5 minutes and the empty table 2 minutes more', async () => {
    const { h, game, socks } = setup({ tier: 'pebble', seats: 6, bots: 'regular' }, 1);
    const [me] = socks;
    const book = ledger(h);
    await h.call(me, 'lamplight:sit', { t: 'tblA', buyIn: 1000, post: 'now', id: 'sit' });
    const start = book.total();
    h.clock.run(1000);
    const tb = game.tables.get('tblA')!;
    expect(tb.state.hand?.street).not.toBe('done');
    game.onSocketGone(me.accountId, me.id);
    h.drop(me);
    h.clock.run(RELEASE_DISCONNECTED_MS - 10_000);
    expect(seatOf(game, me.accountId)).toBeGreaterThanOrEqual(0);
    expect(tb.closed).toBe(false);
    h.clock.run(20_000);
    // Released, but the table waits for someone to sit down.
    expect(seatOf(game, me.accountId)).toBe(-1);
    expect(book.escrowOf(me.accountId)).toBe(0);
    expect(tb.closed).toBe(false);
    expect(h.bots).toBe(4);
    h.clock.run(IDLE_EMPTY_MS - 20_000);
    expect(tb.closed).toBe(false);
    h.clock.run(20_000);
    expect(tb.closed).toBe(true);
    expect(h.closed).toContainEqual({ id: 'tblA', reason: 'idle' });
    expect(h.bots).toBe(0);
    expect(book.atTable()).toBe(0);
    expect(book.total()).toBe(start);
    expect(checkInvariant(h.db)).toEqual([]);
  });

  it('conserves every chip and keeps every event valid while players leave and come back at random', async () => {
    const { h, game, socks, r } = setup({ tier: 'pebble', seats: 8, bots: 'greenhorn' }, 3, 77);
    const [anchor, ...movers] = socks;
    const book = ledger(h);
    const watcher = h.account('watcher');
    game.lobby!.onJoin(ctx(watcher), h.lobbies.get('tblA')!, 'spectator');
    const view = mirror(watcher);
    for (const s of socks) expect(await h.call(s, 'lamplight:sit', { t: 'tblA', buyIn: 1000, post: 'now', id: 'sit-' + s.id })).toEqual({ ok: true });
    const start = book.total();
    const tb = game.tables.get('tblA')!;
    const lobby = () => h.lobbies.get('tblA')!;
    let leaves = 0;
    let midHand = 0;
    let lastHand = tb.state.handsPlayed;
    let sits = 0;
    for (let step = 0; step < 6000 && tb.state.handsPlayed < 80; step++) {
      const hand = tb.state.hand;
      const running = !!hand && hand.street !== 'done';
      const roll = r.int(100);
      const seated = movers.filter((s) => seatOf(game, s.accountId) >= 0);
      const standing = movers.filter((s) => seatOf(game, s.accountId) < 0);
      if (roll < 3 && seated.length > 0) {
        const who = seated[r.int(seated.length)];
        if (running && tb.state.seats[seatOf(game, who.accountId)].inHand) midHand++;
        if (r.int(3) === 0) game.lobby!.onLeave(ctx(who), lobby());
        else expect(await h.call(who, 'lamplight:leave', { t: 'tblA', now: true, id: 'out-' + step })).toEqual({ ok: true });
        expect(seatOf(game, who.accountId)).toBe(-1);
        leaves++;
      } else if (roll < 8 && standing.length > 0) {
        const who = standing[r.int(standing.length)];
        const ack = await h.call(who, 'lamplight:sit', { t: 'tblA', buyIn: 1000, post: r.int(2) ? 'now' : 'wait', id: 'in-' + step });
        if (ack.ok) sits++;
      } else if (hand && running && hand.toAct >= 0 && !hand.pending && sockAt(game, socks, hand.toAct) && roll < 80) {
        const sock = sockAt(game, socks, hand.toAct)!;
        const lg = legal(tb.state, hand.toAct)!;
        const pick = r.int(10);
        const a: Action =
          lg.canRaise && pick < 2 ? (pick === 0 ? { kind: 'allin' } : { kind: lg.currentBet === 0 ? 'bet' : 'raise', to: lg.minTo }) : lg.canCheck ? { kind: 'check' } : pick < 8 ? { kind: 'call' } : { kind: 'fold' };
        expect((await h.call(sock, 'lamplight:act', { t: 'tblA', h: hand.handNo, q: tb.state.q, k: KIND[a.kind], a: 'to' in a ? a.to : undefined })).ok).toBe(true);
      } else h.clock.run(300);
      // No chip appears or disappears at any moment, mid-hand included.
      expect(book.total()).toBe(start);
      view.drain();
      if (tb.state.handsPlayed !== lastHand) {
        lastHand = tb.state.handsPlayed;
        expect(checkInvariant(h.db)).toEqual([]);
        // Between hands every seat's stack is exactly its escrow row.
        if (!tb.state.hand || tb.state.hand.street === 'done') {
          for (const s of tb.state.seats) if (s.player) expect(book.escrowOf(s.player.accountId ?? 'bot:' + s.seat), 'seat ' + s.seat).toBe(s.stack);
        }
        for (const s of socks) {
          const n = seatOf(game, s.accountId);
          if (n >= 0 && tb.state.seats[n].stack === 0 && (!tb.state.hand || tb.state.hand.street === 'done')) await h.call(s, 'lamplight:topUp', { t: 'tblA', amount: 1000, id: 'top-' + s.id + '-' + lastHand });
        }
      }
    }
    expect(tb.state.handsPlayed).toBeGreaterThanOrEqual(80);
    expect(leaves).toBeGreaterThanOrEqual(10);
    expect(midHand).toBeGreaterThanOrEqual(5);
    expect(sits).toBeGreaterThanOrEqual(5);
    // Everyone leaves, the anchor last (mid-hand or not): the table closes at once with nothing left in escrow.
    for (const s of [...movers, anchor]) if (seatOf(game, s.accountId) >= 0) await h.call(s, 'lamplight:leave', { t: 'tblA', id: 'last-' + s.id });
    expect(tb.closed).toBe(true);
    view.drain();
    expect(view.applied).toBeGreaterThan(500);
    expect(book.atTable()).toBe(0);
    expect(h.bots).toBe(0);
    expect(book.total()).toBe(start);
    expect(checkInvariant(h.db)).toEqual([]);
  });
});
