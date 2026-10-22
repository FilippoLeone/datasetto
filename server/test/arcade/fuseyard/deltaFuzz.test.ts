/**
 * Fuseyard in the platform's delta-base fuzz (fuseyard.md §12 "fuseyard.view", plan.md §3.2): seeded
 * schedules of skipped slots, all four parks, unparks, reconnects and rekeys drive the REAL sender with
 * Fuseyard's runtime. After every keyframe plus the event blocks after it, the client's `view.ts` world
 * must equal the server's public view.
 *
 * The runtimes start from match states recorded across whole matches (countdowns, play, Closing Time,
 * frozen rounds, result cards, round starts, match ends), with two humans whose inputs and seat changes
 * (ghost, return, bot takeover, leave, reclaim) come from a seeded script.
 *
 * The fuzz hands decoders the keyframe body and each FRAME's event section, not the FRAME ticks or
 * snapshots. So this compares what events and keyframes carry: the board, items, bombs (owner, range,
 * Clicker or fuse, rest cell, slide direction), fighters' seats, lives and powers, the phase, round,
 * winners and scores. Positions (snapshots) and timers (frame ticks) are checked to the byte by
 * view.test.ts, through a stand-in sender that knows every FRAME's tick.
 */
import { describe, expect, it } from 'vitest';
import { ByteReader } from '../../../src/arcade/core/bytes.js';
import { decodeKeyframe, encodeUp } from '../../../src/arcade/core/fuseyard/codec.js';
import { dumpMatch, restoreMatch } from '../../../src/arcade/core/fuseyard/replay.js';
import { createFuseyardCore, type FuseyardCore } from '../../../src/arcade/core/fuseyard/runtime.js';
import { BotLevel, CELLS, EV, EV_SIZE, inputByte, Phase, type ArenaId, type MatchConfig } from '../../../src/arcade/core/fuseyard/rules.js';
import { applyFrame, createWorld, NO_END, type World } from '../../../src/arcade/core/fuseyard/view.js';
import { KEY_REASON } from '../../../src/arcade/core/net/lane.js';
import type { HostEvent, SeatCmd } from '../../../src/arcade/core/net/match.js';
import { xorshift32 } from '../../../src/arcade/core/rng.js';
import { wrapCore } from '../../../src/arcade/rooms/wrap.js';
import type { MatchRuntime } from '../../../src/arcade/rooms/types.js';
import { deltaFuzz, type DeltaFuzzStats } from '../harness/sim.js';
import { cpuMs, withCpuCap } from './cpu.js';

const SCHEDULES = 500;
const HUMANS = [0, 1] as const;

// ------------------------------------------------------------------ scripted humans

/** Seeded human play: a held direction for a while, bombs now and then, a Clicker press sometimes. */
const createHands = (seed: number) => {
  let s = seed >>> 0 || 1;
  const rnd = (n: number): number => (s = xorshift32(s)) % n;
  const dir = [0, 0];
  const hold = [0, 0];
  const seq = [0, 0];
  const one = new Uint8Array(1);
  return (core: FuseyardCore): void => {
    for (const slot of HUMANS) {
      if ((hold[slot] as number) <= 0) {
        dir[slot] = rnd(5);
        hold[slot] = 4 + rnd(40);
      }
      hold[slot] = (hold[slot] as number) - 1;
      one[0] = inputByte(dir[slot] as number, 0, rnd(45) === 0, rnd(70) === 0);
      seq[slot] = ((seq[slot] as number) + 1) & 0xffff;
      core.onUp(slot, encodeUp(one, 1), seq[slot] as number);
    }
  };
};

/** Seat changes the platform makes: drops and returns, bot takeovers, leaves, reclaims. */
const createSeats = (seed: number) => {
  let s = seed >>> 0 || 1;
  const rnd = (n: number): number => (s = xorshift32(s)) % n;
  const state: ('live' | 'ghost' | 'bot' | 'left')[] = ['live', 'live'];
  return (core: FuseyardCore): void => {
    if (rnd(70) !== 0) return;
    const slot = rnd(2);
    const now = state[slot] as 'live' | 'ghost' | 'bot' | 'left';
    let cmd: SeatCmd;
    if (now === 'live') cmd = 'ghost';
    else if (now === 'ghost') cmd = (['live', 'live', 'bot', 'left'] as const)[rnd(4)] as SeatCmd;
    else cmd = 'reclaim';
    core.setSeat(slot, cmd);
    state[slot] = cmd === 'reclaim' ? 'live' : (cmd as 'live' | 'ghost' | 'bot' | 'left');
  };
};

// ------------------------------------------------------------------ recorded starting states

interface Start {
  dump: Uint8Array;
  seed: number;
}

/**
 * Match states every 25 ticks across a few whole matches (some quickfire, for Closing Time), and
 * `edges`: states on result cards, from which a schedule crosses a round start.
 */
const recordStarts = (): { all: Start[]; edges: Start[] } => {
  const all: Start[] = [];
  const edges: Start[] = [];
  const plans: { arena: ArenaId; mode: MatchConfig['mode']; seed: number }[] = [
    { arena: 'mill', mode: 'quickfire', seed: 101 },
    { arena: 'garden', mode: 'brawl', seed: 202 },
    { arena: 'pond', mode: 'quickfire', seed: 303 },
    { arena: 'depot', mode: 'quickfire', seed: 404 },
  ];
  for (const p of plans) {
    const config: MatchConfig = { mode: p.mode, arena: p.arena, fighters: 4, winsNeeded: 2, botLevel: BotLevel.Scrapper, seed: p.seed };
    const core = createFuseyardCore({
      config,
      seats: [
        { slot: 0, human: true, botLevel: BotLevel.Scrapper },
        { slot: 1, human: true, botLevel: BotLevel.Scrapper },
        { slot: 2, human: false, botLevel: BotLevel.Menace },
        { slot: 3, human: false, botLevel: BotLevel.Scrapper },
      ],
      offline: false,
    });
    const hands = createHands(p.seed);
    for (let t = 0; t < 6000 && core.result() === null; t += 1) {
      hands(core);
      core.step();
      core.takeEvents({ slot: 0, view: 0 });
      core.takeHostEvents();
      if (t % 25 === 0) all.push({ dump: dumpMatch(core.match), seed: p.seed * 7919 + t });
      if (t % 4 === 0 && core.match.current.phase === Phase.RoundEnd) edges.push({ dump: dumpMatch(core.match), seed: p.seed * 7919 + t });
    }
  }
  return { all, edges };
};

// ------------------------------------------------------------------ the runtime under test

interface Tally {
  kinds: Uint32Array;
  roundStarts: number;
  seats: number;
}

const countKinds = (bytes: Uint8Array, count: number, kinds: Uint32Array): void => {
  let i = 0;
  for (let n = 0; n < count && i < bytes.length; n += 1) {
    const kind = bytes[i] as number;
    kinds[kind] = (kinds[kind] as number) + 1;
    const size = (EV_SIZE[kind] as number | undefined) ?? 0;
    if (size === 0) throw new Error(`the runtime emitted an unknown event kind 0x${kind.toString(16)}`);
    i += size;
  }
};

/**
 * A runtime that plays the scripted humans and seat changes, and passes a round start on as the
 * platform's match does (a KEYFRAME, reason 3, to every recipient; the fuzz drives one, slot 0).
 */
const runtimeFrom = (start: Start, tally: Tally): MatchRuntime => {
  const m = restoreMatch(start.dump);
  if (!m) throw new Error('a recorded match does not restore');
  const core = createFuseyardCore({ config: m.config, seats: [], offline: false, match: m });
  const hands = createHands(start.seed);
  const seats = createSeats(start.seed ^ 0x5eed);
  const rt = wrapCore('fuseyard', 'fuzz', core, { handover: () => new Uint8Array(0), replay: () => new Uint8Array(0) });
  return {
    ...rt,
    get tick() {
      return core.tick;
    },
    get idle() {
      return core.idle;
    },
    step() {
      hands(core);
      seats(core);
      core.step();
    },
    takeEvents(r) {
      const chunk = core.takeEvents(r);
      if (chunk) countKinds(chunk.bytes, chunk.count, tally.kinds);
      return chunk;
    },
    takeHostEvents() {
      const evs = core.takeHostEvents();
      if (evs.length === 0) return evs;
      const out: HostEvent[] = [];
      for (const e of evs) {
        if (e.t === 'roundStart') {
          tally.roundStarts += 1;
          out.push({ t: 'rekey', slot: 0, view: 0, reason: KEY_REASON.round as unknown as 4 });
        } else {
          if (e.t === 'seat') tally.seats += 1;
          out.push(e);
        }
      }
      return out;
    },
  };
};

// ------------------------------------------------------------------ client decode and compare

/** Each FRAME is put 256 ticks after the last, so At marks (≤ 255 back) keep events in order. */
const FRAME_GAP = 256;
const T0 = 1 << 20;

/** What keyframes and events both carry, as numbers (see the header for what is left out). */
const canon = (w: World): number[] => {
  const out: number[] = [w.arena, w.round, w.phase, w.winner, w.holdWinner, w.spiralIndex];
  for (let s = 0; s < 4; s += 1) out.push(w.scores[s] as number);
  for (let c = 0; c < CELLS; c += 1) out.push(w.cells[c] as number, (w.items[c] as number) || (w.pending[c] as number));
  for (let s = 0; s < w.fighters; s += 1) {
    const f = w.fight[s];
    if (!f) continue;
    out.push(f.seat, f.alive ? 1 : 0, f.bombsMax, f.range, f.speedLvl, f.glove ? 1 : 0, f.clicker ? 1 : 0);
  }
  const bombs = w.bombs.slice(0, w.bombCount).sort((a, b) => a.id - b.id);
  out.push(bombs.length);
  for (const b of bombs) out.push(b.id, b.owner, b.range, b.fuseEnd === NO_END ? 1 : 0, b.slideDir, b.slideDir === 0 ? b.cell : -1);
  return out;
};

const LABELS = ['arena', 'round', 'phase', 'winner', 'holdWinner', 'spiralIndex', 'score0', 'score1', 'score2', 'score3'];
let lastDiff = '';

const decode = (k: Uint8Array, events: readonly Uint8Array[]): number[] => {
  const w = createWorld(4);
  if (!decodeKeyframe(new ByteReader(k), T0, w)) throw new Error(`keyframe (${k.length} B) does not decode`);
  let t = T0;
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i] as Uint8Array;
    t += FRAME_GAP;
    if (!applyFrame(w, t, { count: e[0] ?? 0, r: new ByteReader(e.subarray(1)), tick: t }, null)) throw new Error(`event block ${i} (${e.length} B) does not apply`);
  }
  return canon(w);
};

const equal = (a: unknown, b: unknown): boolean => {
  const x = a as number[];
  const y = b as number[];
  if (x.length === y.length && x.every((v, i) => v === y[i])) return true;
  const i = x.findIndex((v, j) => v !== y[j]);
  const at = i < LABELS.length ? (LABELS[i] as string) : i < LABELS.length + 2 * CELLS ? `cell ${(i - LABELS.length) >> 1} ${(i - LABELS.length) & 1 ? 'item' : 'tile'}` : `index ${i} (fighters and bombs)`;
  lastDiff = `${at}: client ${x[i]} server ${y[i]}; lengths ${x.length}/${y.length}`;
  return false;
};

let shared: { all: Start[]; edges: Start[] } | null = null;

describe('Fuseyard delta base (platform fuzz, real sender)', () => {
  it(`holds over ${SCHEDULES} seeded schedules`, () => {
    const c0 = cpuMs();
    const starts = recordStarts();
    shared = starts;
    expect(cpuMs() - c0).toBeLessThan(1500);
    expect(starts.all.length).toBeGreaterThan(300);
    expect(starts.edges.length).toBeGreaterThan(50);
    const tally: Tally = { kinds: new Uint32Array(256), roundStarts: 0, seats: 0 };
    let made = 0;
    let stats: DeltaFuzzStats | null = null;
    try {
      withCpuCap(2000, (progress) =>
        deltaFuzz({
          create: () => {
            made += 1;
            // Spread the schedules over the recorded states; every other one starts on a result card.
            const pool = made % 2 === 0 ? starts.edges : starts.all;
            return runtimeFrom(pool[(made * 37) % pool.length] as Start, tally);
          },
          schedules: SCHEDULES,
          seed: 0xf05e,
          decode,
          equal,
          progress,
          onStats: (s) => (stats = s),
        }),
      );
    } catch (e) {
      throw new Error(`${(e as Error).message}${lastDiff ? ` (first difference: ${lastDiff})` : ''}`);
    }
    const s = stats as DeltaFuzzStats | null;
    expect(s).not.toBeNull();
    if (!s) return;
    // The schedules exercised the sender's states...
    expect(s.parks.away).toBeGreaterThan(50);
    expect(s.parks.yield).toBeGreaterThan(50);
    expect(s.parks.stalled).toBeGreaterThan(5);
    expect(s.parks.overflow).toBeGreaterThan(2);
    expect(s.reconnects).toBeGreaterThan(50);
    expect(s.worldChecks).toBeGreaterThan(500);
    // ...and the game's events and seat changes.
    expect(tally.roundStarts).toBeGreaterThan(25);
    expect(tally.seats).toBeGreaterThan(100);
    for (const kind of [EV.BombPlaced, EV.Explode, EV.BlockBroken, EV.ItemTaken, EV.Died, EV.Stats, EV.Round, EV.SteelWarn, EV.SteelDrop, EV.BombKicked, EV.Teleport]) {
      expect(tally.kinds[kind], `event kind 0x${kind.toString(16)}`).toBeGreaterThan(0);
    }
  });

  it('catches a client that loses event blocks', () => {
    const starts = shared ?? recordStarts();
    const tally: Tally = { kinds: new Uint32Array(256), roundStarts: 0, seats: 0 };
    let made = 0;
    expect(() =>
      deltaFuzz({
        create: () => runtimeFrom(starts.all[(made += 1) * 7] as Start, tally),
        schedules: 40,
        seed: 3,
        // Drops every event block: the worlds differ once a bomb, block or pickup goes by.
        decode: (k) => decode(k, []),
        equal,
      }),
    ).toThrow(/differs from the server's public view/);
  });
});
