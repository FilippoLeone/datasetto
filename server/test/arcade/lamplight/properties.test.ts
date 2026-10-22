/**
 * Properties over seeded random play (lamplight.md §18.1): chips are conserved after every event,
 * no stack goes negative, the seat to act always has a legal action, every hand ends, the pots sum
 * to the contributions, and `buildPots` makes at most one pot per seat. The client mirror replays
 * every public event (from a snap taken at a random point, mid-hand included) and must agree with
 * the host's view after each one. The same seed gives the same event log.
 */
import { describe, expect, it } from 'vitest';
import { act, advance, buildPots, contribs, legal, pendingDelay, startHand, tableChips, updateSeat, type EngineEvent, type TableState } from '../../../src/arcade/core/lamplight/engine.js';
import { applyEvent, fromSnap, holeEvent, publicEvent, snapFor, stampMs, viewFor } from '../../../src/arcade/core/lamplight/views.js';
import { fnv1a32 } from '../../../src/arcade/core/hash.js';
import { utf8Encode } from '../../../src/arcade/core/bytes.js';
import { makeTable, randomAction, rng, shuffledDeck } from './helpers.js';

/** What the mirror must agree on (everything public, plus the observer's own cards). */
const projection = (s: TableState) => ({
  q: s.q,
  seats: s.seats.map((x) => [x.status, x.stack, x.streetBet, x.totalBet, x.inHand, x.folded, x.allIn, x.actedAt, x.shown, x.hole?.join(',') ?? null]),
  hand: s.hand
    ? [s.hand.handNo, s.hand.button, s.hand.sbSeat, s.hand.bbSeat, s.hand.street, s.hand.board.join(','), s.hand.currentBet, s.hand.lastFullRaise, s.hand.toAct, s.hand.pending, s.hand.runout, s.hand.turnQ]
    : null,
  level: [s.level.sb, s.level.bb, s.level.ante],
});

interface Mirror {
  me: number | null;
  view: TableState | null;
}

/** Feed host events to the mirrors the way the server sends them (public events, then the owner's hole). */
const feed = (state: TableState, events: readonly EngineEvent[], mirrors: Mirror[], now: number) => {
  for (const e of events) {
    const out = publicEvent(e, state.id);
    const data = stampMs(out.data, out.dl, now);
    for (const m of mirrors) {
      if (!m.view) continue;
      const ok = applyEvent(m.view, out.name, data, now, m.me);
      if (!ok) throw new Error('mirror refused ' + out.name + ' ' + JSON.stringify(data));
      if (e.ev === 'hand' && m.me !== null) {
        const hole = holeEvent(state, m.me, state.id);
        if (hole) applyEvent(m.view, 'lamplight:hole', hole, now, m.me);
      }
    }
  }
};

/** Plain checks (Vitest's expect is too slow for every event of 2,000 hands); throws on the first failure. */
const fail = (why: string): never => {
  throw new Error(why);
};
const check = (state: TableState, total: number, mirrors: Mirror[]) => {
  if (tableChips(state) !== total) fail('chips not conserved: ' + tableChips(state) + ' != ' + total);
  for (const s of state.seats) if (s.stack < 0) fail('negative stack at seat ' + s.seat);
  const hand = state.hand;
  if (hand && hand.toAct >= 0 && !legal(state, hand.toAct)) fail('seat ' + hand.toAct + ' to act has no legal action');
  if (hand && hand.street !== 'done') {
    const c = contribs(state);
    const pots = buildPots(c);
    let sum = 0;
    for (const p of pots) sum += p.amount;
    let paid = 0;
    for (const x of c) paid += x.total;
    if (sum !== paid) fail('pots ' + sum + ' != contributions ' + paid);
    if (pots.length > c.length) fail('more pots than seats');
  }
  for (const m of mirrors) {
    if (!m.view) continue;
    const mine = JSON.stringify(projection(m.view));
    const host = JSON.stringify(projection(viewFor(state, m.me)));
    if (mine !== host) fail('mirror ' + m.me + ' differs: mirror ' + mine + ' host ' + host);
  }
};

/** Play one hand with random legal actions; returns its events. */
const playHand = (state: TableState, r: ReturnType<typeof rng>, total: number, mirrors: Mirror[], startMirrorAt: number): EngineEvent[] => {
  const log: EngineEvent[] = [];
  let now = 1000;
  let step = 0;
  const attachMirrors = () => {
    for (const m of mirrors) if (!m.view) m.view = fromSnap(JSON.parse(JSON.stringify(snapFor(state, m.me, state.id, now))), now);
  };
  if (startMirrorAt === 0) attachMirrors();
  const started = startHand(state, shuffledDeck(r), now, r.int(state.seats.length));
  if (!started.ok) return log;
  log.push(...started.events);
  feed(state, started.events, mirrors, now);
  check(state, total, mirrors);
  for (let guard = 0; guard < 400; guard++) {
    if (state.hand!.street === 'done') return log;
    step++;
    if (step === startMirrorAt) attachMirrors();
    now += 500;
    let events: EngineEvent[];
    if (pendingDelay(state) !== null) events = advance(state, now);
    else {
      const seatNo = state.hand!.toAct;
      const res = act(state, seatNo, randomAction(state, r), now);
      if (!res.ok) fail('random action refused: ' + res.code);
      events = res.ok ? res.events : [];
    }
    log.push(...events);
    feed(state, events, mirrors, now);
    check(state, total, mirrors);
  }
  throw new Error('hand did not end');
};

const randomTable = (r: ReturnType<typeof rng>, id: string) => {
  const n = 2 + r.int(8);
  const stacks = Array.from({ length: n }, () => (r.int(10) === 0 ? null : 1 + r.int(r.int(3) === 0 ? 60 : 2000)));
  // At least two players.
  if (stacks.filter((s) => s !== null).length < 2) {
    stacks[0] = 500;
    stacks[1] = 500;
  }
  return makeTable(stacks, { ante: r.int(4) === 0 ? 1 + r.int(3) : 0, format: r.int(3) === 0 ? 'cup' : 'open', id });
};

describe('random play', () => {
  it('keeps every invariant over 2,000 seeded single hands, with mirrors attached mid-hand', () => {
    const r = rng(20261022);
    for (let i = 0; i < 2000; i++) {
      const state = randomTable(r, 't' + i);
      const total = tableChips(state);
      const players = state.seats.filter((s) => s.player).map((s) => s.seat);
      const mirrors: Mirror[] = [{ me: players[r.int(players.length)], view: null }, { me: null, view: null }];
      playHand(state, r, total, mirrors, r.int(3) === 0 ? 0 : 1 + r.int(8));
      expect(state.hand!.street).toBe('done');
    }
  });

  it('rotates through long sessions with sit-outs and returns', () => {
    const r = rng(77);
    for (let t = 0; t < 40; t++) {
      const state = randomTable(r, 's' + t);
      const total = tableChips(state);
      const players = state.seats.filter((s) => s.player).map((s) => s.seat);
      const mirrors: Mirror[] = [{ me: players[0], view: null }];
      for (let h = 0; h < 40; h++) {
        // Someone sits out or comes back between hands now and then.
        if (r.int(5) === 0) {
          const n = players[r.int(players.length)];
          const s = state.seats[n];
          const now = 0;
          const events =
            s.status === 'active' && state.config.format === 'open'
              ? updateSeat(state, n, { status: 'sittingOut' })
              : s.status === 'sittingOut'
                ? updateSeat(state, n, s.missedBB ? { status: 'waiting', post: r.int(2) === 0 ? 'now' : 'wait' } : { status: 'active' })
                : [];
          feed(state, events, mirrors, now);
        }
        playHand(state, r, total, mirrors, 0);
        if (state.seats.filter((s) => s.player && s.stack > 0).length < 2) break;
      }
    }
  });
});

describe('determinism', () => {
  const run = (seed: number): number => {
    const r = rng(seed);
    const state = makeTable([1500, 1500, 1500, 1500, 1500, 1500], { id: 'det00001' });
    const total = tableChips(state);
    let h = 0x811c9dc5;
    for (let i = 0; i < 500; i++) {
      // Refill busted seats so the table keeps six players.
      for (const s of state.seats) if (s.stack === 0) updateSeat(state, s.seat, { status: 'active', stack: 1500 });
      const before = tableChips(state);
      const events = playHand(state, r, before, [], -1);
      h = fnv1a32(utf8Encode(JSON.stringify(events)), h);
    }
    expect(total).toBe(9000);
    return h >>> 0;
  };

  it('gives the same event-log hash over 500 hands for the same seed', () => {
    const a = run(5);
    expect(run(5)).toBe(a);
    expect(run(6)).not.toBe(a);
  });
});
