/**
 * One recipient's paced stream (server/src/arcade/sender.ts, platform.md §6), driven tick by tick in
 * virtual time against a sink that records every message.
 */
import { describe, expect, it } from 'vitest';
import { ByteReader } from '../../src/arcade/core/bytes.js';
import { BUDGETS, type GameBudget } from '../../src/arcade/core/net/budget.js';
import { forEachEvent, PEV } from '../../src/arcade/core/net/events.js';
import { KEY_REASON, readServer, TICK_HZ, TICK_MS, type Divisor, type ServerMsg } from '../../src/arcade/core/net/lane.js';
import { createRecipient, type Recipient, type SlotInput } from '../../src/arcade/sender.js';
import { withWallCap } from './harness/sim.js';

const KEYFRAME_BODY = Uint8Array.of(1, 2, 3, 4);
const SNAP = Uint8Array.of(9, 9, 9);

interface Rig {
  r: Recipient;
  sent: { t: number; m: ServerMsg }[];
  buffered: number;
  t: number;
  tick: number;
  phase: SlotInput['phase'];
  floor: Divisor;
  snapshot: Uint8Array | null;
  /** Advance one tick (33.33 ms) and run the slot. */
  step(): boolean;
  run(ms: number): void;
  /** `run`, with the client acking everything after each tick. */
  runAcked(ms: number): void;
  /** Ack every frame sent so far. */
  ackAll(): void;
  of<T extends ServerMsg['t']>(t: T, after?: number): (Extract<ServerMsg, { t: T }> & { at: number })[];
}

const rig = (o: { skipUnchanged?: boolean; budget?: GameBudget; welcome?: boolean } = {}): Rig => {
  const h = {} as Rig;
  h.sent = [];
  h.buffered = 0;
  h.t = 0;
  h.tick = 0;
  h.phase = null;
  h.floor = 2;
  h.snapshot = SNAP;
  h.r = createRecipient({ slot: 0, spectator: false, budget: o.budget ?? BUDGETS.fuseyard, defaultDivisor: 2, skipUnchanged: o.skipUnchanged ?? false, now: () => h.t });
  h.r.attach({
    send: (bytes) => {
      const m = readServer(bytes.slice());
      if (!m) throw new Error('undecodable message 0x' + (bytes[0] ?? 0).toString(16));
      h.sent.push({ t: h.t, m });
    },
    get bufferedAmount() {
      return h.buffered;
    },
  });
  h.step = () => {
    h.tick += 1;
    h.t = h.tick * TICK_MS;
    return h.r.slotTick({ tick: h.tick, snapshot: h.snapshot, ackUp: 0, keyframe: () => KEYFRAME_BODY, phase: h.phase, floor: h.floor });
  };
  h.run = (ms) => {
    const end = h.t + ms;
    while (h.t + TICK_MS <= end + 1e-6) h.step();
  };
  h.runAcked = (ms) => {
    const end = h.t + ms;
    while (h.t + TICK_MS <= end + 1e-6) {
      h.step();
      h.ackAll();
    }
  };
  h.ackAll = () => {
    const last = [...h.sent].reverse().find((s) => s.m.t === 'frame' || s.m.t === 'keyframe');
    if (last) h.r.onAck((last.m as { frameSeq: number }).frameSeq, 0);
  };
  h.of = (t, after = -1) => h.sent.filter((s) => s.m.t === t && s.t > after).map((s) => ({ ...(s.m as Extract<ServerMsg, { t: typeof t }>), at: s.t }));
  if (o.welcome !== false) {
    h.r.welcome({ proto: 1, game: 1, codec: 1, slot: 0, queued: false, tick: 0, tickHz: TICK_HZ, divisor: 2, lastEvSeq: 0, resumeToken: new Uint8Array(32), cfg: new Uint8Array(0) }, KEY_REASON.join);
  }
  return h;
};

/** Events of one tick in a toy game format: kind 0x10 + one byte each. */
const chunk = (...values: number[]) => ({ bytes: Uint8Array.from(values.flatMap((v) => [0x10, v])), count: values.length });

/** Walk a FRAME's events: [tick, value] for game events, [tick, -1 − kind] for platform ones. */
const walk = (f: Extract<ServerMsg, { t: 'frame' }>): [number, number][] => {
  const out: [number, number][] = [];
  if (!f.events) return out;
  const ok = forEachEvent(
    { count: f.events.count, r: new ByteReader(f.events.bytes), tick: f.tick },
    (kind, r, tick) => {
      if (kind !== 0x10) return false;
      out.push([tick, r.u8()]);
      return true;
    },
    (e, tick) => out.push([tick, e.k === 'seat' ? -1 - PEV.SeatState : -1 - PEV.Notice]),
  );
  if (!ok) throw new Error('event block does not walk');
  return out;
};

const kinds = (h: Rig, after = -1): string[] => h.sent.filter((s) => s.t > after).map((s) => s.m.t);

describe('sender', () => {
  it('sends WELCOME, then a keyframe at the next slot, then consecutive FRAMEs', () => {
    withWallCap(1000, () => {
      const h = rig();
      expect(kinds(h)).toEqual(['welcome']);
      h.step();
      const kf = h.of('keyframe');
      expect(kf).toHaveLength(1);
      expect(kf[0]?.reason).toBe(KEY_REASON.join);
      expect(Array.from(kf[0]?.body ?? [])).toEqual(Array.from(KEYFRAME_BODY));
      h.run(1000);
      h.ackAll();
      const frames = h.of('frame');
      expect(frames.length).toBeGreaterThanOrEqual(14);
      frames.forEach((f, i) => expect(f.frameSeq).toBe(((kf[0]?.frameSeq ?? 0) + 1 + i) & 0xffff));
    });
  });

  it('merges the events of several ticks into one FRAME with At marks', () => {
    const h = rig();
    h.step(); // tick 1: the keyframe
    h.r.pushEvents(2, chunk(1));
    h.r.pushEvents(3, chunk(2, 3));
    h.r.pushEvents(4, chunk(4));
    h.tick = 3;
    h.step(); // tick 4: a slot at d = 2
    const f = h.of('frame').at(-1);
    expect(f?.tick).toBe(4);
    if (!f) return;
    expect(walk(f)).toEqual([
      [2, 1],
      [3, 2],
      [3, 3],
      [4, 4],
    ]);
    // Three At marks (back 2, 1, 0) plus four events.
    expect(f.events?.count).toBe(7);
  });

  it('sizes [t − 1, t, t] chunks right (the frame tick repeats after an older chunk)', () => {
    const h = rig();
    h.step();
    h.r.pushEvents(5, chunk(1));
    h.r.pushEvents(6, chunk(2));
    h.r.pushEvents(6, { bytes: Uint8Array.of(PEV.SeatState, 1, 1), count: 1 });
    h.tick = 5;
    expect(() => h.step()).not.toThrow();
    const f = h.of('frame').at(-1);
    if (!f) throw new Error('no FRAME');
    expect(f.tick).toBe(6);
    expect(walk(f)).toEqual([
      [5, 1],
      [6, 2],
      [6, -1 - PEV.SeatState],
    ]);
    expect(f.events?.count).toBe(5);
  });

  it('keeps its own copy of event bytes and of the last snapshot (runtimes may reuse their buffers)', () => {
    const h = rig({ skipUnchanged: true });
    h.step();
    const shared = Uint8Array.of(0x10, 7);
    h.r.pushEvents(2, { bytes: shared, count: 1 }); // queued for the slot at tick 2
    shared[1] = 99; // the runtime rewrites its buffer at the next step
    h.step();
    expect(walk(h.of('frame').at(-1) as Extract<ServerMsg, { t: 'frame' }>)).toEqual([[2, 7]]);
    // One snapshot buffer, rewritten every tick: each change goes out.
    const snap = Uint8Array.of(1, 2, 3);
    h.snapshot = snap;
    const before = h.of('frame').length;
    for (let i = 0; i < 10; i += 1) {
      snap[0] = 10 + i;
      h.step();
      h.ackAll();
    }
    const frames = h.of('frame').slice(before);
    expect(frames).toHaveLength(5);
    expect(frames.map((f) => f.snapshot?.[0])).toEqual([11, 13, 15, 17, 19]);
  });

  it('sends a PHASE after the events queued before it, and one with nothing before it at once', () => {
    const h = rig();
    h.step(); // tick 1 keyframe
    h.r.pushEvents(2, chunk(1));
    h.r.pushPhase(3, 0, Uint8Array.of(7));
    h.r.pushEvents(2, chunk(2));
    h.step(); // tick 2: slot
    const order = h.sent.slice(2).map((s) => (s.m.t === 'frame' ? 'frame:' + walk(s.m).map((e) => e[1]).join('') : s.m.t));
    expect(order).toEqual(['frame:1', 'phase']);
    h.step(); // tick 3: off-slot, the event after the phase waits
    h.step(); // tick 4: slot
    expect(walk(h.of('frame').at(-1) as Extract<ServerMsg, { t: 'frame' }>)).toEqual([[2, 2]]);
    // Off-slot with nothing queued before it: at once.
    h.step(); // tick 5
    const n = h.sent.length;
    h.r.pushPhase(4, 0, new Uint8Array(0));
    h.step(); // tick 6 is a slot; tick 7 below is not
    h.r.pushPhase(5, 0, new Uint8Array(0));
    h.step(); // tick 7: off-slot
    expect(h.sent.slice(n).filter((s) => s.m.t === 'phase').map((s) => (s.m as { phase: number }).phase)).toEqual([4, 5]);
    expect(h.sent.at(-1)?.m.t).toBe('phase');
  });

  it('a parked recipient gets no events; on unpark a keyframe, then the phase that changed while parked', () => {
    const h = rig();
    h.step();
    h.ackAll();
    h.phase = { phase: 2, reason: 0, body: new Uint8Array(0) };
    h.r.pushPhase(2, 0, new Uint8Array(0));
    h.run(200);
    h.r.park('away');
    const parkedAt = h.t;
    h.r.pushEvents(h.tick + 1, chunk(1));
    expect(h.r.pendingBytes).toBe(0);
    h.phase = { phase: 3, reason: 1, body: Uint8Array.of(5) };
    h.r.pushPhase(3, 1, Uint8Array.of(5));
    h.run(3000);
    expect(kinds(h, parkedAt)).toEqual([]);
    h.r.unpark();
    const at = h.t;
    h.step();
    expect(kinds(h, at)).toEqual(['keyframe', 'phase']);
    expect(h.of('keyframe', at)[0]?.reason).toBe(KEY_REASON.unpark);
    expect(h.of('phase', at)[0]?.phase).toBe(3);
    // Unchanged phase: only the keyframe.
    h.ackAll();
    h.r.park('away');
    h.run(500);
    h.r.unpark();
    const again = h.t;
    h.step();
    expect(kinds(h, again)).toEqual(['keyframe']);
  });

  it("'yield' and 'stalled' get a BEAT once a second, 'away' gets nothing", () => {
    for (const reason of ['yield', 'away'] as const) {
      const h = rig();
      h.step();
      h.ackAll();
      h.r.park(reason);
      const from = h.t;
      h.run(5000);
      const beats = h.of('beat', from);
      expect(kinds(h, from).filter((k) => k !== 'beat')).toEqual([]);
      if (reason === 'away') expect(beats).toEqual([]);
      else {
        expect(beats.length).toBeGreaterThanOrEqual(4);
        expect(beats.length).toBeLessThanOrEqual(5);
        for (let i = 1; i < beats.length; i += 1) expect((beats[i]?.at ?? 0) - (beats[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(1000);
      }
    }
    // Stalled: frames flow, no ACK comes back.
    const h = rig();
    h.run(4000);
    expect(h.r.parked).toBe('stalled');
    const stalledAt = [...h.sent].reverse().find((s) => s.m.t === 'frame')?.t ?? 0;
    h.run(4000);
    expect(h.of('frame', stalledAt)).toEqual([]);
    expect(h.of('beat', stalledAt).length).toBeGreaterThanOrEqual(3);
    // An ACK ends it with a keyframe.
    h.ackAll();
    expect(h.r.parked).toBeNull();
    const at = h.t;
    h.step();
    expect(kinds(h, at)).toEqual(['keyframe']);
  });

  it("parks as 'overflow' when pending events pass the budget's bytes, and leaves at the first slot with in-flight under half the cap", () => {
    const h = rig({ budget: { ...BUDGETS.fuseyard, overflowEvents: 1024 } });
    h.step();
    h.ackAll();
    // Frames in flight, unacked: more than half the cap.
    h.run(700);
    expect(h.r.pacer.inflight).toBeGreaterThan(h.r.pacer.inflightCap / 2);
    // The socket backs up: slots are skipped and events pile up past 1 KB.
    h.buffered = 4096;
    for (let i = 0; i < 30 && h.r.parked === null; i += 1) {
      h.r.pushEvents(h.tick + 1, { bytes: new Uint8Array(200).fill(0x10), count: 100 });
      h.step();
    }
    expect(h.r.parked).toBe('overflow');
    expect(h.r.pendingBytes).toBe(0);
    const parkedAt = h.t;
    h.buffered = 0;
    h.r.pushEvents(h.tick + 1, chunk(1)); // not queued while parked
    expect(h.r.pendingBytes).toBe(0);
    h.run(300);
    expect(h.r.parked).toBe('overflow'); // in-flight is still over half the cap
    expect(kinds(h, parkedAt)).toEqual([]);
    h.ackAll();
    const at = h.t;
    h.step();
    expect(h.r.parked).toBeNull();
    expect(kinds(h, at)).toEqual(['keyframe']);
    expect(h.of('keyframe', at)[0]?.reason).toBe(KEY_REASON.unpark);
  });

  it("parks as 'overflow' when the oldest pending event is over 1.5 s old", () => {
    const h = rig();
    h.step();
    h.ackAll();
    h.buffered = 4096;
    h.r.pushEvents(h.tick + 1, chunk(1));
    const pushedAt = h.t;
    while (h.r.parked === null && h.t < pushedAt + 3000) h.step();
    expect(h.r.parked).toBe('overflow');
    expect(h.t - pushedAt).toBeGreaterThan(1500);
    expect(h.t - pushedAt).toBeLessThanOrEqual(1500 + 2 * TICK_MS + 1e-6);
    // Nothing in flight: it leaves at the next slot once the socket drains.
    h.buffered = 0;
    const at = h.t;
    h.step();
    expect(kinds(h, at)).toEqual(['keyframe']);
  });

  it('skipUnchanged: an unchanged snapshot is not resent, but a header-only FRAME goes out every 500 ms', () => {
    const h = rig({ skipUnchanged: true });
    h.step();
    h.runAcked(3000);
    const frames = h.of('frame');
    expect(frames[0]?.snapshot).not.toBeNull();
    const headerOnly = frames.slice(1);
    expect(headerOnly.length).toBeGreaterThanOrEqual(5);
    expect(headerOnly.length).toBeLessThanOrEqual(6);
    for (const f of headerOnly) {
      expect(f.snapshot).toBeNull();
      expect(f.events).toBeNull();
    }
    for (let i = 1; i < frames.length; i += 1) {
      const gap = (frames[i]?.at ?? 0) - (frames[i - 1]?.at ?? 0);
      expect(gap).toBeGreaterThanOrEqual(500);
      expect(gap).toBeLessThan(500 + 2 * TICK_MS + 1e-6);
    }
    // Events go out at the next slot, and the snapshot rides along with them.
    const at = h.t;
    h.r.pushEvents(h.tick + 1, chunk(3));
    h.step();
    h.step();
    const f = h.of('frame', at)[0];
    expect(f?.events?.count).toBe(1);
    expect(f?.snapshot).not.toBeNull();
  });

  it('never puts more than 255 events in a FRAME; the rest follow in order', () => {
    const h = rig();
    h.step();
    h.ackAll();
    const values: number[] = [];
    // Three ticks of 100 events each while the socket is backed up, then it drains.
    h.buffered = 4096;
    const from = h.t;
    for (let k = 0; k < 3; k += 1) {
      const vs = Array.from({ length: 100 }, (_, i) => (k * 100 + i) & 0xff);
      values.push(...vs);
      h.r.pushEvents(h.tick + 1, chunk(...vs));
      h.step();
    }
    h.buffered = 0;
    h.runAcked(400);
    const frames = h.of('frame', from).filter((f) => f.events);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (const f of frames) expect(f.events?.count).toBeLessThanOrEqual(255);
    expect(frames.flatMap((f) => walk(f).map((e) => e[1]))).toEqual(values);
  });

  it('turns one tick of 255 or more events (unsplittable) into a resync keyframe', () => {
    const h = rig();
    h.step();
    h.ackAll();
    const from = h.t;
    h.r.pushEvents(h.tick + 1, chunk(...Array.from({ length: 254 }, (_, i) => i & 0xff)));
    h.step();
    h.ackAll();
    expect(h.of('frame', from).map((f) => f.events?.count)).toEqual([254]);
    const later = h.t;
    h.r.pushEvents(h.tick + 1, chunk(...Array.from({ length: 300 }, (_, i) => i & 0xff)));
    h.runAcked(200);
    expect(h.of('keyframe', later).map((k) => k.reason)).toEqual([KEY_REASON.resync]);
    expect(h.of('frame', later).every((f) => !f.events)).toBe(true);
  });

  it('respects the degrade floor and carries the divisor in the FRAME flags', () => {
    for (const floor of [2, 3, 4, 6] as const) {
      const h = rig();
      h.floor = floor;
      h.step();
      const from = h.t;
      for (let i = 0; i < 60; i += 1) {
        h.step();
        h.ackAll();
      }
      const frames = h.of('frame', from);
      expect(frames.length).toBeGreaterThan(0);
      for (const f of frames) {
        expect(f.divisor).toBe(floor);
        expect(f.tick % floor).toBe(0);
      }
      // Ticks 2–61 ran; a FRAME at every multiple of the floor.
      expect(frames.length).toBe(Math.floor(61 / floor) - Math.floor(1 / floor));
    }
  });
});
