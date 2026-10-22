/**
 * Online tournaments (lamplight.md §2.2–2.4, §12): registration escrows the buy-in and leaving before
 * the start refunds it; a Cup with bots pays humans only and ends once the human places are settled;
 * the Firefly Trio draws its multiplier on the third registration, cannot be left after the draw and
 * pays the drawn pool with the house covering the difference; an abandoned Cup splits by stack.
 */
import { describe, expect, it } from 'vitest';
import { legal } from '../../../src/arcade/core/lamplight/engine.js';
import { checkInvariant } from '../../../src/arcade/wallet.js';
import { ABANDON_MS, createLamplight, TRIO_DEAL_MS, type LamplightGame } from '../../../src/arcade/tables/lamplight.js';
import { makeFakeApi, type FakeHarness, type FakeSocket } from './fakeApi.js';
import { rng } from './helpers.js';

const ctx = (s: FakeSocket) => ({ accountId: s.accountId, socketId: s.id, voiceChannelId: 'ch1' });

const setup = (mode: 'cup' | 'trio', cfg: Record<string, unknown>, draw = 0) => {
  const h = makeFakeApi();
  const r = rng(4);
  const game = createLamplight(h.api, { randInt: (n) => r.int(n), secret: () => Uint8Array.from({ length: 32 }, () => r.int(256)), trioDraw: () => draw });
  h.lobby('tour1', mode, cfg);
  return { h, game, r };
};

/** Every human shoves or calls until the tournament ends. */
const playOut = async (h: FakeHarness, game: LamplightGame, humans: FakeSocket[]) => {
  const tb = game.tables.get('tour1')!;
  for (let step = 0; step < 20_000 && !tb.closed; step++) {
    const hand = tb.state.hand;
    if (hand && hand.toAct >= 0 && !hand.pending) {
      const sock = humans.find((s) => s.accountId === tb.state.seats[hand.toAct].player?.accountId);
      if (sock) {
        const lg = legal(tb.state, hand.toAct)!;
        await h.call(sock, 'lamplight:act', { t: 'tour1', h: hand.handNo, q: tb.state.q, k: lg.canRaise ? 'a' : lg.canCheck ? 'x' : 'c' });
        continue;
      }
    }
    h.clock.run(1000);
  }
  return tb;
};

describe('the Lamplight Cup online', () => {
  it('escrows buy-ins, refunds a leaver, pays humans only with bots seated, and ends when human places are settled', async () => {
    const { h, game } = setup('cup', { buyIn: 2000, seats: 6, bots: 'regular' });
    const [a, b, c] = [h.account('a'), h.account('b'), h.account('c')];
    const lobby = h.lobbies.get('tour1')!;
    for (const s of [a, b, c]) expect(game.lobby!.onJoin(ctx(s), lobby, 'player')).toEqual({ ok: true });
    expect(h.wallet.view('a')).toMatchObject({ bal: 18_000, esc: 2000 });
    game.lobby!.onLeave(ctx(c), lobby);
    expect(h.wallet.view('c')).toMatchObject({ bal: 20_000, esc: 0 });
    expect(game.lobby!.onStart(lobby)).toEqual({ ok: true });
    const tb = game.tables.get('tour1')!;
    expect(tb.state.seats.filter((s) => s.player?.botId).length).toBe(4);
    expect(tb.tournament!.pool).toBe(4000);
    await playOut(h, game, [a, b]);
    expect(tb.closed).toBe(true);
    const end = a.received.find((m) => m.name === 'lamplight:cupEnd')!.data as { places: { a: string; p: number; won: number }[] };
    // Two humans: 100 % to the better of them, nothing to a bot.
    expect(end.places.map((p) => p.a).sort()).toEqual(['a', 'b']);
    const winner = end.places.find((p) => p.p === 1)!;
    expect(winner.won).toBe(4000);
    expect(h.wallet.view(winner.a).bal).toBe(22_000);
    expect(h.wallet.view(winner.a === 'a' ? 'b' : 'a').bal).toBe(18_000);
    expect(checkInvariant(h.db)).toEqual([]);
    expect(h.bots).toBe(0);
  });

  it('an abandoned Cup splits the unpaid prizes by stack among the humans still in', async () => {
    const { h, game } = setup('cup', { buyIn: 500, seats: 4 });
    const socks = ['a', 'b', 'c', 'd'].map((id) => h.account(id));
    const lobby = h.lobbies.get('tour1')!;
    for (const s of socks) game.lobby!.onJoin(ctx(s), lobby, 'player');
    const tb = game.tables.get('tour1')!;
    expect(tb.started).toBe(true);
    h.clock.run(2000);
    for (const s of socks) {
      h.drop(s);
      game.onSocketGone(s.accountId, s.id);
    }
    h.clock.run(ABANDON_MS + 60_000);
    expect(tb.closed).toBe(true);
    let paid = 0;
    for (const id of ['a', 'b', 'c', 'd']) paid += h.wallet.view(id).bal - 19_500;
    expect(paid).toBe(2000);
    expect(checkInvariant(h.db)).toEqual([]);
  });
});

describe('the Firefly Trio online', () => {
  it('draws on the third registration, refuses leaving after the draw, deals 3.5 s later and pays the pool', async () => {
    // u = 999,950 lands on the ×1000 row (the last 100 of the million).
    const { h, game } = setup('trio', { buyIn: 200 }, 999_950);
    const socks = ['a', 'b', 'c'].map((id) => h.account(id));
    const lobby = h.lobbies.get('tour1')!;
    for (const s of socks) game.lobby!.onJoin(ctx(s), lobby, 'player');
    const tb = game.tables.get('tour1')!;
    const trio = socks[0].received.find((m) => m.name === 'lamplight:trio')!.data;
    expect(trio).toMatchObject({ mult: 1000, pool: 200_000, pay: [160_000, 20_000, 20_000] });
    game.lobby!.onLeave(ctx(socks[0]), lobby);
    expect(h.wallet.view('a').esc).toBe(200);
    h.clock.run(TRIO_DEAL_MS - 500);
    expect(tb.state.hand).toBeNull();
    h.clock.run(1000);
    expect(tb.state.hand).not.toBeNull();
    await playOut(h, game, socks);
    const total = ['a', 'b', 'c'].reduce((x, id) => x + h.wallet.view(id).bal, 0);
    expect(total).toBe(3 * 19_800 + 200_000);
    expect(checkInvariant(h.db)).toEqual([]);
  });

  it('refuses online bots in the Trio', () => {
    const { h, game } = setup('trio', { buyIn: 200 });
    const s = h.account('a');
    game.lobby!.onCreated!(ctx(s), h.lobby('trioB', 'trio', { buyIn: 200, bots: 'greenhorn' }));
    expect(h.closed).toContainEqual({ id: 'trioB', reason: 'bots' });
    expect(game.tables.has('trioB')).toBe(false);
  });
});
