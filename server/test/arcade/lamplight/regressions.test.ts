/**
 * Regressions from the review of the server tables: re-registering after leaving, leaving mid-hand
 * after folding, repeated sit and leave, tournament seats coming back, unstarted lobbies, tables
 * nobody sits at, a seat left mid-hand when no next hand comes, and newcomers who sit out and back in.
 */
import { describe, expect, it } from 'vitest';
import { legal } from '../../../src/arcade/core/lamplight/engine.js';
import { checkInvariant } from '../../../src/arcade/wallet.js';
import { createLamplight, IDLE_EMPTY_MS, REGISTRANT_HOLD_MS, type LamplightGame } from '../../../src/arcade/tables/lamplight.js';
import { makeFakeApi, type FakeHarness, type FakeSocket } from './fakeApi.js';
import { rng } from './helpers.js';

const ctx = (s: FakeSocket) => ({ accountId: s.accountId, socketId: s.id, voiceChannelId: 'ch1' });

const setup = (mode: string, cfg: Record<string, unknown>) => {
  const h = makeFakeApi();
  const r = rng(21);
  const game = createLamplight(h.api, { randInt: (n) => r.int(n), secret: () => Uint8Array.from({ length: 32 }, () => r.int(256)), trioDraw: () => 0 });
  h.lobby('tblR', mode, cfg);
  return { h, game };
};

const shoveOut = async (h: FakeHarness, game: LamplightGame, socks: FakeSocket[]) => {
  const tb = game.tables.get('tblR')!;
  for (let i = 0; i < 20_000 && !tb.closed; i++) {
    const hand = tb.state.hand;
    if (hand && hand.toAct >= 0 && !hand.pending) {
      const sock = socks.find((s) => s.accountId === tb.state.seats[hand.toAct].player?.accountId);
      if (sock) {
        const lg = legal(tb.state, hand.toAct)!;
        await h.call(sock, 'lamplight:act', { t: 'tblR', h: hand.handNo, q: tb.state.q, k: lg.canRaise ? 'a' : lg.canCheck ? 'x' : 'c' });
        continue;
      }
    }
    h.clock.run(1000);
  }
};

describe('review regressions', () => {
  it('re-registering after leaving a Cup escrows again, and everyone is paid at the end', async () => {
    const { h, game } = setup('cup', { buyIn: 500, seats: 3 });
    const lobby = h.lobbies.get('tblR')!;
    const [a, b, c] = ['a', 'b', 'c'].map((id) => h.account(id));
    // b keeps the lobby open (a Cup nobody is registered for closes at once).
    game.lobby!.onJoin(ctx(b), lobby, 'player');
    game.lobby!.onJoin(ctx(a), lobby, 'player');
    game.lobby!.onLeave(ctx(a), lobby);
    expect(h.wallet.view('a')).toMatchObject({ bal: 20_000, esc: 0 });
    expect(game.lobby!.onJoin(ctx(a), lobby, 'player')).toEqual({ ok: true });
    expect(h.wallet.view('a')).toMatchObject({ bal: 19_500, esc: 500 });
    game.lobby!.onJoin(ctx(c), lobby, 'player');
    await shoveOut(h, game, [a, b, c]);
    const bal = ['a', 'b', 'c'].map((id) => h.wallet.view(id));
    expect(bal.reduce((x, v) => x + v.bal, 0)).toBe(60_000);
    expect(bal.every((v) => v.esc === 0)).toBe(true);
    expect(bal.some((v) => v.bal === 21_000)).toBe(true);
    expect(checkInvariant(h.db)).toEqual([]);
  });

  it('a folded player who leaves mid-hand is paid at once, their chips stay in the pot, and records keep the deal order', async () => {
    const { h, game } = setup('open', { tier: 'pebble', seats: 3 });
    const socks = ['a', 'b', 'c'].map((id) => h.account(id));
    for (const s of socks) await h.call(s, 'lamplight:sit', { t: 'tblR', buyIn: 1000, id: 'sit-' + s.id });
    h.clock.run(1000);
    const tb = game.tables.get('tblR')!;
    const hand = tb.state.hand!;
    const sb = socks.find((s) => s.accountId === tb.state.seats[hand.sbSeat].player?.accountId)!;
    // The button calls, the small blind folds and leaves at once; the other two check it down.
    for (let i = 0; i < 20 && tb.state.hand!.street !== 'done'; i++) {
      const hh = tb.state.hand!;
      const sock = socks.find((s) => s.accountId === tb.state.seats[hh.toAct].player?.accountId)!;
      const k = sock === sb ? 'f' : legal(tb.state, hh.toAct)!.canCheck ? 'x' : 'c';
      await h.call(sock, 'lamplight:act', { t: 'tblR', h: hh.handNo, q: tb.state.q, k });
      if (sock === sb) {
        await h.call(sb, 'lamplight:leave', { t: 'tblR', id: 'bye' });
        // The seat is released and the stack is back at once; the 5 in the pot stays in escrow until the hand ends.
        expect(tb.state.seats.some((s) => s.player?.accountId === sb.accountId)).toBe(false);
        expect(tb.state.seats[hand.sbSeat]).toMatchObject({ inHand: true, folded: true });
        expect(h.wallet.view(sb.accountId)).toMatchObject({ bal: 19_995, esc: 5 });
      }
      h.clock.run(10);
    }
    expect(tb.state.seats[hand.sbSeat].player).toBeNull();
    // The small blind's 5 stayed in the pot: the other two hold 2,005 between them.
    const bb = tb.state.seats[hand.bbSeat];
    const btn = tb.state.seats[hand.button];
    expect(bb.stack + btn.stack).toBe(2005);
    expect(h.wallet.view(sb.accountId)).toMatchObject({ bal: 19_995, esc: 0 });
    // The stored record serves the viewer its own cards from the deal-time positions, the leaver included.
    for (const viewer of [socks.find((s) => s.accountId === bb.player?.accountId)!, sb]) {
      const rec = (await h.call(viewer, 'lamplight:record', { t: 'tblR', h: hand.handNo })) as { ok: boolean; record: { own: number[] } };
      const hole = viewer.received.find((m) => m.name === 'lamplight:hole')!.data.c as number[];
      expect(rec.record.own).toEqual(hole);
    }
    expect(checkInvariant(h.db)).toEqual([]);
  });

  it('sitting down and leaving twice at a waiting table returns every chip', async () => {
    const { h } = setup('open', { tier: 'pebble', seats: 3 });
    const [a, b] = ['a', 'b'].map((id) => h.account(id));
    // b sits and stays out (sitting out, no hand runs), so the table stays open while a comes and goes.
    expect(await h.call(b, 'lamplight:sit', { t: 'tblR', buyIn: 1000, id: 'sit-b' })).toEqual({ ok: true });
    await h.call(b, 'lamplight:sitOut', { t: 'tblR', on: true });
    for (let i = 0; i < 2; i++) {
      expect(await h.call(a, 'lamplight:sit', { t: 'tblR', buyIn: 1000, id: 'sit-' + i })).toEqual({ ok: true });
      await h.call(a, 'lamplight:leave', { t: 'tblR', id: 'leave-' + i });
    }
    expect(h.wallet.view('a')).toMatchObject({ bal: 20_000, esc: 0 });
  });

  it('a tournament seat that sat out plays again after sitting back in', async () => {
    const { h, game } = setup('cup', { buyIn: 500, seats: 3 });
    const lobby = h.lobbies.get('tblR')!;
    const socks = ['a', 'b', 'c'].map((id) => h.account(id));
    for (const s of socks) game.lobby!.onJoin(ctx(s), lobby, 'player');
    const tb = game.tables.get('tblR')!;
    // Nobody acts: each seat times out twice (15 s clock plus 30 s bank, then 15 s) and sits out.
    for (let i = 0; i < 40 && !tb.state.seats.some((s) => s.status === 'sittingOut'); i++) h.clock.run(15_000);
    const away = tb.state.seats.find((s) => s.status === 'sittingOut' && s.player?.accountId);
    expect(away).toBeTruthy();
    const sock = socks.find((s) => s.accountId === away!.player!.accountId)!;
    expect(await h.call(sock, 'lamplight:sitOut', { t: 'tblR', on: true })).toEqual({ ok: false, code: 'illegal' });
    expect(await h.call(sock, 'lamplight:sitOut', { t: 'tblR', on: false })).toEqual({ ok: true });
    expect(away!.status).toBe('active');
  });

  it('an unstarted Cup waits for the lobby limit, and a registrant gone 30 s is refunded', () => {
    const { h, game } = setup('cup', { buyIn: 500, seats: 6 });
    const lobby = h.lobbies.get('tblR')!;
    const [a, b] = ['a', 'b'].map((id) => h.account(id));
    game.lobby!.onJoin(ctx(a), lobby, 'player');
    game.lobby!.onJoin(ctx(b), lobby, 'player');
    h.clock.run(150_000);
    const tb = game.tables.get('tblR')!;
    expect(tb.closed).toBe(false);
    game.onSocketGone('b', b.id);
    h.drop(b);
    h.clock.run(REGISTRANT_HOLD_MS + 3000);
    expect(h.wallet.view('b')).toMatchObject({ bal: 20_000, esc: 0 });
    expect(tb.registered).toEqual(['a']);
    h.clock.run(10 * 60_000);
    expect(tb.closed).toBe(true);
    expect(h.wallet.view('a')).toMatchObject({ bal: 20_000, esc: 0 });
    expect(checkInvariant(h.db)).toEqual([]);
  });

  it('a bot table nobody sits at closes after 2 minutes and gives its bots back', () => {
    const { h, game } = setup('open', { tier: 'pebble', seats: 6, bots: 'regular' });
    const w = h.account('w');
    game.lobby!.onJoin(ctx(w), h.lobbies.get('tblR')!, 'spectator');
    expect(h.bots).toBe(4);
    h.clock.run(IDLE_EMPTY_MS + 1000);
    expect(game.tables.get('tblR')).toBeUndefined();
    expect(h.bots).toBe(0);
    expect(checkInvariant(h.db)).toEqual([]);
  });

  it('a seat left while the other player is to act is settled when the hand ends, even when no next hand comes', async () => {
    const { h, game } = setup('open', { tier: 'pebble', seats: 2 });
    const [a, b] = ['a', 'b'].map((id) => h.account(id));
    for (const s of [a, b]) await h.call(s, 'lamplight:sit', { t: 'tblR', buyIn: 1000, id: 'sit-' + s.id });
    h.clock.run(1000);
    const tb = game.tables.get('tblR')!;
    const hand = tb.state.hand!;
    const actor = [a, b].find((s) => s.accountId === tb.state.seats[hand.toAct].player?.accountId)!;
    const other = actor === a ? b : a;
    await h.call(other, 'lamplight:leave', { t: 'tblR', id: 'later' });
    // The big blind's 990 is back at once; the 10 posted stays in the pot.
    expect(h.wallet.view(other.accountId)).toMatchObject({ bal: 19_990, esc: 10 });
    // The actor folds to the seat that left, which wins the blinds; they follow it to the wallet.
    await h.call(actor, 'lamplight:act', { t: 'tblR', h: hand.handNo, q: tb.state.q, k: 'f' });
    expect(h.wallet.view(other.accountId)).toMatchObject({ bal: 20_005, esc: 0 });
    await h.call(actor, 'lamplight:leave', { t: 'tblR', id: 'now' });
    expect(tb.closed).toBe(true);
    expect(tb.state.seats.every((s) => !s.player)).toBe(true);
    expect(h.wallet.view('a').esc + h.wallet.view('b').esc).toBe(0);
    expect(h.wallet.view('a').bal + h.wallet.view('b').bal).toBe(40_000);
    expect(checkInvariant(h.db)).toEqual([]);
  });

  it('a newcomer who sits out and back in still waits for the big blind', async () => {
    const { h, game } = setup('open', { tier: 'pebble', seats: 3 });
    const a = h.account('a');
    await h.call(a, 'lamplight:sit', { t: 'tblR', buyIn: 1000, post: 'wait', id: 's' });
    await h.call(a, 'lamplight:sitOut', { t: 'tblR', on: true });
    await h.call(a, 'lamplight:sitOut', { t: 'tblR', on: false });
    expect(game.tables.get('tblR')!.state.seats.find((s) => s.player?.accountId === 'a')!.status).toBe('waiting');
  });

  it('refuses a new table, with a code the sheet explains, while you hold a registration elsewhere', () => {
    const { h, game } = setup('cup', { buyIn: 500, seats: 3 });
    const a = h.account('a');
    expect(game.lobby!.onJoin(ctx(a), h.lobbies.get('tblR')!, 'player')).toEqual({ ok: true });
    expect(game.lobby!.onCreate(ctx(a), { tier: 'pebble' })).toEqual({ ok: false, code: 'already' });
    h.lobby('tblT', 'trio', { buyIn: 200 });
    expect(game.lobby!.onJoin(ctx(a), h.lobbies.get('tblT')!, 'player')).toEqual({ ok: false, code: 'already' });
    // Unregistered (refunded), and the Cup nobody is registered for any more closed at once: the
    // channel holds one table, so nothing refuses a new one.
    game.lobby!.onLeave(ctx(a), h.lobbies.get('tblR')!);
    expect(game.tables.has('tblR')).toBe(false);
    expect(h.closed).toContainEqual({ id: 'tblR', reason: 'empty' });
    expect(game.lobby!.onCreate(ctx(a), { tier: 'pebble' })).toEqual({ ok: true });
    // With a second table in the channel, its limit is the refusal.
    h.lobby('tblU', 'open', { tier: 'pebble', seats: 3 });
    game.lobby!.onJoin(ctx(h.account('b')), h.lobbies.get('tblU')!, 'spectator');
    expect(game.lobby!.onCreate(ctx(a), { tier: 'pebble' })).toEqual({ ok: false, code: 'channel-limit' });
    expect(h.wallet.view('a').esc).toBe(0);
  });

  it('lists a table in the channel activity only once its lobby is live (the hub lists forming lobbies itself)', () => {
    const { h, game } = setup('trio', { buyIn: 200 });
    const lobby = h.lobbies.get('tblR')!;
    const [a, b, c] = ['a', 'b', 'c'].map((id) => h.account(id));
    game.lobby!.onCreated!(ctx(a), lobby);
    game.lobby!.onJoin(ctx(b), lobby, 'player');
    h.clock.run(10);
    expect(game.activity('ch1')).toEqual([]);
    game.lobby!.onJoin(ctx(c), lobby, 'player');
    h.clock.run(10);
    expect(game.activity('ch1').map((e) => e.id)).toEqual(['tblR']);
    // A cash table is live at once.
    h.lobby('tblO', 'open', { tier: 'pebble', seats: 3 });
    game.lobby!.onCreated!(ctx(h.account('d')), h.lobbies.get('tblO')!);
    expect(game.activity('ch1').map((e) => e.id)).toEqual(['tblR']);
    h.clock.run(10);
    expect(game.activity('ch1').map((e) => e.id).sort()).toEqual(['tblO', 'tblR']);
  });
});
