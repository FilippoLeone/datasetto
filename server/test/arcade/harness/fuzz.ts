/**
 * The delta-base fuzz (platform.md §6.2 and §15.1, plan.md §3.2 "Delta base"). Seeded schedules drive the
 * REAL sender (`createRecipient`) with a match runtime from `create()`, tick by tick in virtual time, and
 * a client that sees every message the moment it is sent:
 * - skipped slots (the sink's `bufferedAmount` forced over 2 KB), which also lead to `overflow` parks;
 * - VIS 1 / VIS 2 parks (`away`, `yield`) and VIS 0 unparks; ACKs withheld long enough to stall, then
 *   resumed (the `stalled` unpark); the degrade floor moving between 2, 3 and 4;
 * - reconnects: `detach()`, a few ticks without a socket, `attach()` and a new WELCOME (resume);
 * - rekeys: the runtime's own `rekey` host events and client RESYNCs.
 *
 * It throws, naming the schedule, tick and the last operations, on the first violation of:
 * - after every keyframe plus the events after it, the client world (`decode`) equals the server's
 *   public view (`decode(keyframeFor(view), [])`), checked whenever the server had nothing pending
 *   after a send (always just before the next keyframe or WELCOME replaces the base, and at random
 *   points in between);
 * - `frameSeq` is consecutive from each keyframe; no FRAME between a WELCOME and its keyframe;
 * - the first message after an unpark or a rekey is a KEYFRAME; a parked recipient gets no FRAME,
 *   KEYFRAME or PHASE (`away`: nothing at all; `yield`/`stalled`: BEATs at most once a second);
 * - every FRAME carries the effective divisor, max(pacer divisor, floor), and at most 255 events.
 *
 * `decode(k, events)`: `k` is a keyframe body, each `events` entry one FRAME's event section as on the
 * wire (`u8 count`, then the events, At marks and platform kinds included).
 */
import { BUDGETS, type GameBudget } from '../../../src/arcade/core/net/budget.js';
import { SEAT_STATE, type SeatStateCode } from '../../../src/arcade/core/net/events.js';
import { DIVISORS, KEY_REASON, readServer, TICK_HZ, TICK_MS, type Divisor } from '../../../src/arcade/core/net/lane.js';
import type { ParkReason } from '../../../src/arcade/core/net/pacer.js';
import { xorshift32 } from '../../../src/arcade/core/rng.js';
import type { MatchRuntime } from '../../../src/arcade/rooms/types.js';
import { createRecipient, type Recipient } from '../../../src/arcade/sender.js';

export interface DeltaFuzzOptions {
  create(): MatchRuntime;
  schedules: number;
  seed: number;
  decode(k: Uint8Array, events: readonly Uint8Array[]): unknown;
  equal(client: unknown, server: unknown): boolean;
  /** Called after each schedule (for a wall cap's progress). */
  progress?(schedulesDone: number): void;
  /** What the schedules exercised, after the last one. */
  onStats?(s: DeltaFuzzStats): void;
}

export interface DeltaFuzzStats {
  schedules: number;
  ticks: number;
  frames: number;
  keyframes: number;
  worldChecks: number;
  skippedSlots: number;
  parks: Record<ParkReason, number>;
  unparks: number;
  reconnects: number;
  rekeys: number;
  phases: number;
}

type Op = 'block' | 'away' | 'yield' | 'mute' | 'reconnect' | 'resync' | 'floor';
const OPS: readonly Op[] = ['block', 'block', 'away', 'yield', 'mute', 'mute', 'reconnect', 'resync', 'floor'];

export const deltaFuzz = (o: DeltaFuzzOptions): void => {
  const stats: DeltaFuzzStats = {
    schedules: 0,
    ticks: 0,
    frames: 0,
    keyframes: 0,
    worldChecks: 0,
    skippedSlots: 0,
    parks: { away: 0, yield: 0, stalled: 0, overflow: 0 },
    unparks: 0,
    reconnects: 0,
    rekeys: 0,
    phases: 0,
  };
  for (let i = 0; i < o.schedules; i += 1) {
    runSchedule(o, i, stats);
    stats.schedules += 1;
    o.progress?.(i + 1);
  }
  o.onStats?.(stats);
};

const runSchedule = (o: DeltaFuzzOptions, index: number, stats: DeltaFuzzStats): void => {
  let rng = (Math.imul(o.seed ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(index + 1, 0xc2b2ae35)) >>> 0 || 1;
  const next = (): number => (rng = xorshift32(rng));
  const chance = (p: number): boolean => next() / 0x100000000 < p;
  const rt = o.create();
  const budget: GameBudget = { ...BUDGETS.fuseyard, overflowEvents: 48 + (next() % 1024) };
  // Mostly short schedules (1–2 s); a fifth long enough (2.5–8 s) to stall and come back.
  const ticks = next() % 5 === 0 ? 75 + (next() % 170) : 25 + (next() % 40);
  let t = 0;
  const now = (): number => t;
  const view = { slot: 0, view: 0 };
  const ops: string[] = [];
  let tick = 0;

  const fail = (what: string): never => {
    throw new Error(`deltaFuzz: schedule ${index} (seed ${o.seed}) at tick ${tick}: ${what}. Last operations: ${ops.slice(-10).join(', ') || 'none'}`);
  };

  // ------------------------------------------------------------ client
  let base: Uint8Array | null = null;
  let events: Uint8Array[] = [];
  let expected = 0;
  let awaitingKeyframe = true;
  let mustKeyframe: string | null = null;
  let lastBeatAt = -Infinity;
  let checkpoint: { server: Uint8Array; n: number; tick: number } | null = null;
  const acks: { at: number; seq: number }[] = [];
  let muteUntil = -1;

  const verify = (cp: { server: Uint8Array; n: number; tick: number }): void => {
    if (!base) return;
    stats.worldChecks += 1;
    let client: unknown;
    let server: unknown;
    try {
      client = o.decode(base, events.slice(0, cp.n));
    } catch (e) {
      fail(`the client world does not decode: ${(e as Error).message}`);
    }
    try {
      server = o.decode(cp.server, []);
    } catch (e) {
      fail(`the server's keyframe does not decode: ${(e as Error).message}`);
    }
    if (!o.equal(client, server)) fail(`the client world (keyframe + ${cp.n} event blocks) differs from the server's public view at tick ${cp.tick}`);
  };

  // ------------------------------------------------------------ server
  let blocked = 0;
  let floor: Divisor = 2;
  let recipient: Recipient;
  let lastPark: ParkReason | null = null;
  let sentThisTick = false;

  const sink = {
    send(bytes: Uint8Array) {
      const m = readServer(bytes);
      if (!m) return fail(`message 0x${(bytes[0] ?? 0).toString(16)} (${bytes.length} B) does not decode`);
      observePark();
      const park = recipient.parked;
      if (m.t === 'welcome') {
        if (checkpoint) verify(checkpoint);
        checkpoint = null;
        base = null;
        events = [];
        awaitingKeyframe = true;
        return;
      }
      if (m.t === 'pong' || m.t === 'handover' || m.t === 'bye') return;
      if (park !== null) {
        if (m.t !== 'beat' || park === 'away' || park === 'overflow') fail(`${m.t.toUpperCase()} sent while parked '${park}'`);
        if (t - lastBeatAt < 1000 - 1e-6) fail(`BEATs ${Math.round(t - lastBeatAt)} ms apart while parked '${park}'`);
        lastBeatAt = t;
        return;
      }
      if (m.t === 'beat') return;
      if (mustKeyframe !== null && m.t !== 'keyframe') fail(`the first message after ${mustKeyframe === 'unpark' ? 'an unpark' : 'a rekey'} was a ${m.t.toUpperCase()}, not a KEYFRAME`);
      if (m.t === 'phase') return;
      if (m.t === 'keyframe') {
        if (checkpoint) verify(checkpoint);
        checkpoint = null;
        base = m.body.slice();
        events = [];
        expected = (m.frameSeq + 1) & 0xffff;
        awaitingKeyframe = false;
        mustKeyframe = null;
        stats.keyframes += 1;
      } else {
        if (awaitingKeyframe) fail('FRAME between a WELCOME and its KEYFRAME');
        if (m.frameSeq !== expected) fail(`frameSeq ${m.frameSeq}, expected ${expected} (consecutive since the keyframe)`);
        expected = (m.frameSeq + 1) & 0xffff;
        const d = recipient.pacer.divisor;
        const effective = DIVISORS.indexOf(d) >= DIVISORS.indexOf(floor) ? d : floor;
        if (m.divisor !== effective) fail(`FRAME divisor ${m.divisor}, effective divisor ${effective} (pacer ${d}, floor ${floor})`);
        if (m.events) {
          const section = new Uint8Array(1 + m.events.bytes.length);
          section[0] = m.events.count;
          section.set(m.events.bytes, 1);
          events.push(section);
        }
        stats.frames += 1;
      }
      sentThisTick = true;
      acks.push({ at: tick + 1 + (next() % 8), seq: m.frameSeq });
    },
    get bufferedAmount() {
      return blocked > 0 ? 4096 : next() % 1500;
    },
  };

  const make = (): Recipient => createRecipient({ slot: 0, spectator: false, budget, defaultDivisor: chance(0.8) ? 2 : 3, skipUnchanged: chance(0.5), now });
  const welcome = (r: Recipient, reason: number): void => {
    r.welcome({ proto: 1, game: 1, codec: 1, slot: 0, queued: false, tick: rt.tick >>> 0, tickHz: TICK_HZ, divisor: 2, lastEvSeq: 0, resumeToken: new Uint8Array(32), cfg: rt.welcomeCfg() }, reason);
  };
  recipient = make();
  recipient.attach(sink);
  welcome(recipient, KEY_REASON.join);

  let vis: 'live' | 'away' | 'yield' = 'live';
  let visUntil = 0;
  let detachedUntil = -1;
  let phase: { phase: number; reason: number; body: Uint8Array } | null = null;

  function observePark(): void {
    const p = recipient.parked;
    if (p !== lastPark) {
      ops.push(`t${tick} ${p === null ? 'unparked' : 'parked ' + p}`);
      if (p !== null) stats.parks[p] += 1;
      else {
        stats.unparks += 1;
        mustKeyframe ??= 'unpark';
      }
      lastPark = p;
    }
  }

  for (tick = 1; tick <= ticks; tick += 1) {
    t = tick * TICK_MS;
    stats.ticks += 1;

    // The match steps; its events and host events go to the recipient (as match.ts does).
    rt.step();
    const st = rt.tick >>> 0;
    const chunk = rt.takeEvents(view);
    if (chunk) recipient.pushEvents(st, chunk);
    for (const e of rt.takeHostEvents()) {
      if (e.t === 'phase') {
        phase = { phase: e.phase, reason: e.reason, body: e.body };
        recipient.pushPhase(e.phase, e.reason, e.body);
        stats.phases += 1;
      } else if (e.t === 'seat') recipient.pushSeat(st, e.slot, SEAT_STATE[e.state] as SeatStateCode);
      else if (e.t === 'rekey' && e.slot === 0) {
        recipient.view = e.view;
        recipient.rekey(e.reason);
        if (recipient.attached) mustKeyframe ??= 'rekey';
        stats.rekeys += 1;
        ops.push(`t${tick} rekey`);
      }
    }

    // One random operation now and then.
    if (chance(0.06)) {
      const op = OPS[next() % OPS.length] as Op;
      if (op === 'block') {
        blocked = 5 + (next() % 70);
        ops.push(`t${tick} block ${blocked}`);
      } else if ((op === 'away' || op === 'yield') && vis === 'live' && detachedUntil < 0) {
        vis = op;
        visUntil = tick + 3 + (next() % 60);
        recipient.park(op);
        ops.push(`t${tick} VIS ${op}`);
      } else if (op === 'mute' && muteUntil < tick) {
        muteUntil = tick + 30 + (next() % 120);
        ops.push(`t${tick} no ACKs until t${muteUntil}`);
      } else if (op === 'reconnect' && detachedUntil < 0) {
        recipient.detach();
        detachedUntil = tick + 1 + (next() % 30);
        ops.push(`t${tick} detach until t${detachedUntil}`);
      } else if (op === 'resync' && recipient.attached && recipient.parked === null) {
        recipient.rekey(KEY_REASON.resync);
        mustKeyframe ??= 'rekey';
        stats.rekeys += 1;
        ops.push(`t${tick} RESYNC`);
      } else if (op === 'floor') {
        floor = DIVISORS[next() % 3] as Divisor;
        ops.push(`t${tick} floor ${floor}`);
      }
    }
    if (vis !== 'live' && tick >= visUntil) {
      vis = 'live';
      recipient.unpark();
      ops.push(`t${tick} VIS live`);
    }
    if (detachedUntil >= 0 && tick >= detachedUntil) {
      detachedUntil = -1;
      if (chance(0.25)) {
        // A fresh recipient, as server/src/arcade/match.ts builds one on every attach.
        recipient = make();
        lastPark = null;
        vis = 'live';
      }
      recipient.attach(sink);
      welcome(recipient, KEY_REASON.resume);
      acks.length = 0;
      stats.reconnects += 1;
      ops.push(`t${tick} reattach`);
    }
    observePark();

    // ACKs (and now and then an UP) reach the server.
    if (tick >= muteUntil) {
      for (let k = 0; k < acks.length; ) {
        const a = acks[k] as { at: number; seq: number };
        if (a.at <= tick) {
          recipient.onAck(a.seq, (next() % 64) * 4);
          acks.splice(k, 1);
        } else k += 1;
      }
      if (chance(0.2)) recipient.onUp();
    }
    observePark();

    // The send slot.
    if (blocked > 0) blocked -= 1;
    sentThisTick = false;
    const sent = recipient.slotTick({ tick: st, snapshot: rt.snapshotFor(view), ackUp: rt.ackUp(0), keyframe: () => rt.keyframeFor(view), phase, floor });
    if (!sent && recipient.attached && recipient.parked === null && recipient.pendingBytes > 0) stats.skippedSlots += 1;
    observePark();
    if (sentThisTick && base && recipient.parked === null && recipient.pendingBytes === 0) {
      checkpoint = { server: rt.keyframeFor(view).slice(), n: events.length, tick };
      if (chance(0.04)) verify(checkpoint);
    }
  }
  if (checkpoint) verify(checkpoint);
  rt.dispose();
};
