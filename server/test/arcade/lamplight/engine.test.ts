/**
 * Scripted betting scenarios (lamplight.md §18.1): the big blind's option, minimum raises, short
 * all-ins that do or do not reopen the betting, heads-up order, rotation from three players to two,
 * uncalled refunds, side pots, the odd chip, the board playing, antes and `turnQ` staleness.
 */
import { describe, expect, it } from 'vitest';
import { act, buildPots, legal, potTotal, tableChips, updateSeat, type EngineEvent } from '../../../src/arcade/core/lamplight/engine.js';
import { drain, makeTable, play, stackedDeck, startHand, toAct } from './helpers.js';

const evs = (events: EngineEvent[], kind: EngineEvent['ev']) => events.filter((e) => e.ev === kind);

describe('preflop order and the big blind option', () => {
  it('gives the big blind its option after limps, then the first seat after the button acts on the flop', () => {
    const state = makeTable([1000, 1000, 1000, 1000]);
    const r = startHand(state, stackedDeck(state, 0, {}), 0, 0);
    expect(r.ok).toBe(true);
    const hand = state.hand!;
    expect([hand.button, hand.sbSeat, hand.bbSeat]).toEqual([0, 1, 2]);
    expect(toAct(state)).toBe(3);
    play(state, 3, { kind: 'call' });
    play(state, 0, { kind: 'call' });
    play(state, 1, { kind: 'call' });
    expect(toAct(state)).toBe(2);
    const lg = legal(state, 2)!;
    expect(lg).toMatchObject({ toCall: 0, canCheck: true, canRaise: true, minTo: 20, maxTo: 1000 });
    play(state, 2, { kind: 'check' });
    expect(hand.street).toBe('flop');
    expect(hand.board).toHaveLength(3);
    expect(toAct(state)).toBe(1);
    expect(potTotal(state)).toBe(40);
  });

  it('sets the minimum raise from the last full raise', () => {
    const state = makeTable([1000, 1000, 1000, 1000]);
    startHand(state, stackedDeck(state, 0, {}), 0, 0);
    expect(legal(state, 3)!.minTo).toBe(20);
    play(state, 3, { kind: 'raise', to: 30 });
    expect(legal(state, 0)!.minTo).toBe(50);
    expect(act(state, 0, { kind: 'raise', to: 49 }, 0)).toEqual({ ok: false, code: 'amount' });
    play(state, 0, { kind: 'raise', to: 80 });
    expect(legal(state, 1)!.minTo).toBe(130);
    expect(act(state, 1, { kind: 'check' }, 0)).toEqual({ ok: false, code: 'illegal' });
    expect(act(state, 2, { kind: 'call' }, 0)).toEqual({ ok: false, code: 'not_your_turn' });
  });
});

describe('short all-ins', () => {
  it('one short all-in does not reopen the betting', () => {
    const state = makeTable([45, 1000, 1000, 1000]);
    startHand(state, stackedDeck(state, 0, {}), 0, 0);
    play(state, 3, { kind: 'raise', to: 30 });
    play(state, 0, { kind: 'allin' });
    expect(state.hand!.currentBet).toBe(45);
    expect(state.hand!.lastFullRaise).toBe(20);
    expect(legal(state, 1)!.minTo).toBe(65);
    play(state, 1, { kind: 'call' });
    play(state, 2, { kind: 'fold' });
    const lg = legal(state, 3)!;
    expect(lg.toCall).toBe(15);
    expect(lg.canRaise).toBe(false);
    expect(act(state, 3, { kind: 'raise', to: 100 }, 0)).toEqual({ ok: false, code: 'illegal' });
    expect(act(state, 3, { kind: 'allin' }, 0)).toEqual({ ok: false, code: 'illegal' });
    play(state, 3, { kind: 'call' });
    expect(state.hand!.street).toBe('flop');
    expect(state.hand!.runout).toBe(false);
  });

  it('two short all-ins that add up to a full raise do reopen it', () => {
    const state = makeTable([60, 1000, 1000, 1000, 45]);
    startHand(state, stackedDeck(state, 0, {}), 0, 0);
    expect(toAct(state)).toBe(3);
    play(state, 3, { kind: 'raise', to: 30 });
    play(state, 4, { kind: 'allin' });
    play(state, 0, { kind: 'allin' });
    expect(state.hand!.lastFullRaise).toBe(20);
    play(state, 1, { kind: 'call' });
    play(state, 2, { kind: 'fold' });
    const lg = legal(state, 3)!;
    expect(lg.toCall).toBe(30);
    expect(lg.canRaise).toBe(true);
    expect(lg.minTo).toBe(80);
  });
});

describe('heads-up and rotation', () => {
  it('heads-up the button posts the small blind and acts first preflop, last after', () => {
    const state = makeTable([1000, 1000]);
    startHand(state, stackedDeck(state, 0, {}), 0, 0);
    const hand = state.hand!;
    expect([hand.button, hand.sbSeat, hand.bbSeat]).toEqual([0, 0, 1]);
    expect(toAct(state)).toBe(0);
    play(state, 0, { kind: 'call' });
    expect(toAct(state)).toBe(1);
    play(state, 1, { kind: 'check' });
    expect(hand.street).toBe('flop');
    expect(toAct(state)).toBe(1);
  });

  it('moves the big blind one seat each hand, from three players down to two', () => {
    const state = makeTable([1000, 1000, 1000]);
    startHand(state, stackedDeck(state, 0, {}), 0, 0);
    expect([state.hand!.button, state.hand!.sbSeat, state.hand!.bbSeat]).toEqual([0, 1, 2]);
    play(state, 0, { kind: 'fold' });
    play(state, 1, { kind: 'fold' });
    expect(state.hand!.street).toBe('done');
    startHand(state, stackedDeck(state, 1, {}), 0);
    expect([state.hand!.button, state.hand!.sbSeat, state.hand!.bbSeat]).toEqual([1, 2, 0]);
    play(state, 1, { kind: 'fold' });
    play(state, 2, { kind: 'fold' });
    // Seat 1 leaves: heads-up, the big blind still moves forward and the other player has the button.
    updateSeat(state, 1, { status: 'sittingOut' });
    startHand(state, stackedDeck(state, 2, {}), 0);
    expect([state.hand!.button, state.hand!.sbSeat, state.hand!.bbSeat]).toEqual([0, 0, 2]);
    expect(state.seats[1].missedBB).toBe(true);
    expect(toAct(state)).toBe(0);
  });
});

describe('refunds, pots and awards', () => {
  it('returns an uncalled bet', () => {
    const state = makeTable([1000, 1000]);
    startHand(state, stackedDeck(state, 0, {}), 0, 0);
    play(state, 0, { kind: 'raise', to: 300 });
    const events = play(state, 1, { kind: 'fold' });
    expect(state.seats.map((s) => s.stack)).toEqual([1010, 990]);
    const show = evs(events, 'show')[0] as Extract<EngineEvent, { ev: 'show' }>;
    expect(show.pots).toEqual([{ a: 20, w: [0], each: 20 }]);
    expect(evs(events, 'end')[0]).toMatchObject({ next: 4000 });
  });

  it('returns the part of an all-in that nobody could call', () => {
    const state = makeTable([1000, 400]);
    startHand(state, stackedDeck(state, 0, { 0: 'As Ad', 1: '7c 2d' }, '3h 8s 9c Jd Kh'), 0, 0);
    play(state, 0, { kind: 'allin' });
    const events = play(state, 1, { kind: 'call' });
    expect(evs(events, 'show')[0]).toMatchObject({ rv: [{ s: 0 }, { s: 1 }] });
    expect(state.seats[0].stack + state.seats[1].stack).toBe(1400);
    expect(state.seats.map((s) => s.stack)).toEqual([1400, 0]);
    expect(state.seats[1].status).toBe('busted');
  });

  it('builds side pots from three and four all-ins with folded chips', () => {
    const pots = buildPots([
      { seat: 0, total: 100, folded: false },
      { seat: 1, total: 200, folded: false },
      { seat: 2, total: 300, folded: false },
      { seat: 3, total: 300, folded: false },
      { seat: 4, total: 50, folded: true },
    ]);
    expect(pots).toEqual([
      { amount: 450, eligible: [0, 1, 2, 3] },
      { amount: 300, eligible: [1, 2, 3] },
      { amount: 200, eligible: [2, 3] },
    ]);
    const four = buildPots([
      { seat: 0, total: 50, folded: false },
      { seat: 1, total: 120, folded: false },
      { seat: 2, total: 400, folded: false },
      { seat: 3, total: 400, folded: false },
      { seat: 4, total: 700, folded: false },
      { seat: 5, total: 90, folded: true },
    ]);
    expect(four.map((p) => p.amount)).toEqual([300, 320, 840, 300]);
    expect(four.reduce((a, p) => a + p.amount, 0)).toBe(50 + 120 + 400 + 400 + 700 + 90);
  });

  it('pays side pots to the best hand eligible for each', () => {
    // Seat 1 (short) has the best hand, seat 2 the second best, seat 3 the worst; seat 0 folds.
    const state = makeTable([1000, 100, 300, 1000]);
    const deck = stackedDeck(state, 0, { 0: '2c 3d', 1: 'As Ah', 2: 'Ks Kh', 3: 'Qs Qh' }, '4c 7d 9h Js 5c');
    startHand(state, deck, 0, 0);
    play(state, 3, { kind: 'raise', to: 300 });
    play(state, 0, { kind: 'fold' });
    play(state, 1, { kind: 'allin' });
    // Seat 2's all-in matches seat 3's raise: nobody is left to act, so the board runs out.
    const events = play(state, 2, { kind: 'allin' });
    expect(state.hand!.runout).toBe(true);
    const show = evs(events, 'show').at(-1) as Extract<EngineEvent, { ev: 'show' }>;
    // Main: 100 × 3 + seat 0's 0 (it folded before posting more) = 300; side: 200 × 2 = 400.
    expect(show.pots).toEqual([
      { a: 300, w: [1], each: 300 },
      { a: 400, w: [2], each: 400 },
    ]);
    expect(state.seats.map((s) => s.stack)).toEqual([1000, 300, 400, 700]);
    expect(tableChips(state)).toBe(2400);
  });

  it('gives the odd chip of a three-way split to the first winner after the button', () => {
    const state = makeTable([1000, 1000, 1000, 1000]);
    startHand(state, stackedDeck(state, 0, { 0: '2c 3d', 1: '2d 3c', 2: '2s 3s', 3: '4c 4d' }, 'Ah Kh Qh Jh Th'), 0, 0);
    play(state, 3, { kind: 'call' });
    play(state, 0, { kind: 'call' });
    play(state, 1, { kind: 'call' });
    play(state, 2, { kind: 'check' });
    play(state, 1, { kind: 'check' });
    play(state, 2, { kind: 'check' });
    play(state, 3, { kind: 'fold' });
    play(state, 0, { kind: 'check' });
    for (const street of ['turn', 'river']) {
      expect(state.hand!.street).toBe(street);
      play(state, 1, { kind: 'check' });
      play(state, 2, { kind: 'check' });
      play(state, 0, { kind: 'check' });
    }
    expect(state.seats.map((s) => s.stack)).toEqual([1003, 1004, 1003, 990]);
  });

  it('splits when the board plays', () => {
    const state = makeTable([1000, 1000]);
    startHand(state, stackedDeck(state, 0, { 0: '2c 3d', 1: '4c 5d' }, 'As Ks Qs Js Ts'), 0, 0);
    play(state, 0, { kind: 'call' });
    play(state, 1, { kind: 'check' });
    for (let i = 0; i < 3; i++) {
      play(state, 1, { kind: 'check' });
      play(state, 0, { kind: 'check' });
    }
    expect(state.seats.map((s) => s.stack)).toEqual([1000, 1000]);
  });

  it('takes antes as dead money outside the street bets', () => {
    const state = makeTable([1000, 1000, 1000, 1000], { ante: 2 });
    startHand(state, stackedDeck(state, 0, {}), 0, 0);
    expect(state.seats.map((s) => s.streetBet)).toEqual([0, 5, 10, 0]);
    expect(potTotal(state)).toBe(23);
    expect(legal(state, 3)).toMatchObject({ toCall: 10, minTo: 20 });
    play(state, 3, { kind: 'fold' });
    play(state, 0, { kind: 'fold' });
    play(state, 1, { kind: 'fold' });
    expect(state.seats.map((s) => s.stack)).toEqual([998, 993, 1011, 998]);
  });
});

describe('stale intents', () => {
  it('a seat event in between does not stale an action, an older q does', () => {
    const state = makeTable([1000, 1000, 1000]);
    startHand(state, stackedDeck(state, 0, {}), 0, 0);
    const turnQ = state.hand!.turnQ;
    expect(act(state, 0, { kind: 'call' }, 0, { h: 1, q: turnQ - 1 })).toEqual({ ok: false, code: 'stale' });
    expect(act(state, 0, { kind: 'call' }, 0, { h: 2, q: turnQ })).toEqual({ ok: false, code: 'stale' });
    updateSeat(state, 2, { connected: false });
    expect(state.q).toBeGreaterThan(turnQ);
    const r = act(state, 0, { kind: 'call' }, 0, { h: 1, q: turnQ });
    expect(r.ok).toBe(true);
    drain(state);
    expect(toAct(state)).toBe(1);
  });
});
