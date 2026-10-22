/**
 * Per-recipient pacing (server/src/arcade/core/net/pacer.ts, platform.md §6, plan.md §3.2 "Pacer"),
 * in virtual time. A small simulated link carries FRAMEs down with a fixed one-way delay (plus
 * optional jitter, queueing or an outage, always in order, as TCP delivers) and the client's ACKs
 * or UPs back, generated when frames arrive.
 */
import { describe, expect, it } from 'vitest';
import { seqDelta } from '../../src/arcade/core/bytes.js';
import { BUDGETS, bucketDepth, frameWire, keyframeWire, type GameBudget } from '../../src/arcade/core/net/budget.js';
import { DIVISORS, TICK_MS, type Divisor } from '../../src/arcade/core/net/lane.js';
import { PACE, createPacer, type Pacer, type PacerConfig, type ParkReason } from '../../src/arcade/core/net/pacer.js';
import { xorshift32 } from '../../src/arcade/core/rng.js';

const seeded = (seed: number): (() => number) => {
  let s = seed >>> 0 || 1;
  return () => (s = xorshift32(s));
};

const FUSEYARD = BUDGETS.fuseyard;
const config = (budget: GameBudget = FUSEYARD, defaultDivisor: Divisor = 2): PacerConfig => ({ budget, defaultDivisor, stallMs: 2500 });
/** A Fuseyard FRAME: 22 B snapshot plus a few event bytes, framing included (114 B on the wire). */
const FRAME_WIRE = frameWire(1 + 22 + 1 + 6);
/** A typical Fuseyard keyframe (340 B body), framing included. */
const KEYFRAME_WIRE = keyframeWire(340);
/** ackDelay travels in 4 ms units. */
const quant = (ms: number): number => Math.max(0, Math.min(255, Math.round(ms / 4))) * 4;
const tickTime = (tick: number): number => (tick * 1000) / 30;
const EPS = 1e-6;

type ClientKind = 'idle' | 'moving' | 'every';

interface LinkOptions {
  /**
   * 'idle': an ACK at most every 250 ms once a frame arrived (about 4 Hz, platform.md §5.2);
   * 'moving': an UP every 2 ticks, carrying the ack; 'every': an ACK for each frame as it arrives.
   */
  client: ClientKind;
  /** One-way delay each way; 150 ms is the 3G budget's 300 ms RTT. */
  oneWayMs?: number;
  /** ± uniform jitter on each downlink packet (never reordering). */
  jitterMs?: number;
  /** Queueing added to a frame sent at `sentAt`. */
  extraDownMs?: (sentAt: number) => number;
  /** Nothing crosses the link in [from, to); what was on it arrives at `to`. */
  outage?: { from: number; to: number };
  divisor?: Divisor;
  frameWire?: number;
  keyframeWire?: number;
  /** False skips a send slot (nothing changed, so the sender has nothing to send). */
  sendAt?: (tick: number) => boolean;
  seed?: number;
}

interface Packet {
  at: number;
  seq: number;
}
interface Uplink {
  at: number;
  ackFrame: number | null;
  delayMs: number;
  up: boolean;
}

class LinkSim {
  readonly p: Pacer;
  tick = 0;
  now = 0;
  slots = 0;
  /** Set to send a keyframe at the next slot (the sim does so after a 'stalled' park ends). */
  keyframePending = false;
  /** Sends that broke the in-flight cap (only allowed when nothing was in flight). */
  capViolations = 0;
  readonly sentAt = new Map<number, number>();
  readonly sends: { t: number; kind: 'K' | 'F'; bytes: number }[] = [];
  readonly ladder: { t: number; kind: 'stepDown' | 'stepUp'; divisor: Divisor }[] = [];
  readonly stalls: number[] = [];
  readonly unparks: number[] = [];
  /** Server time of every ACK or UP that reached the server. */
  readonly arrivals: number[] = [];
  /** Each RTT sample the pacer takes, as queueing above its minimum RTT. */
  readonly samples: { t: number; q: number }[] = [];
  /** The pacer's smoothed queueing (rttMs − minRttMs) after each poll. */
  readonly smooth: { t: number; q: number }[] = [];

  private seq = 1;
  private readonly down: Packet[] = [];
  private readonly upq: Uplink[] = [];
  private lastDownAt = 0;
  private lastUpAt = 0;
  private readonly rnd: () => number;
  private got: number | null = null;
  private gotAt = 0;
  private fresh = false;
  private lastClientSend = Number.NEGATIVE_INFINITY;
  private lastAck: number | null = null;

  constructor(private readonly o: LinkOptions) {
    this.p = createPacer(config(FUSEYARD, o.divisor ?? 2), 0);
    this.rnd = seeded(o.seed ?? 1);
  }

  private get oneWay(): number {
    return this.o.oneWayMs ?? 150;
  }

  private hold(sentAt: number, at: number): number {
    const out = this.o.outage;
    return out && sentAt < out.to && at >= out.from ? Math.max(at, out.to) : at;
  }

  private downArrival(now: number): number {
    const jitter = this.o.jitterMs ? ((this.rnd() / 0x100000000) * 2 - 1) * this.o.jitterMs : 0;
    const at = this.hold(now, now + this.oneWay + (this.o.extraDownMs?.(now) ?? 0) + jitter);
    this.lastDownAt = Math.max(at, this.lastDownAt);
    return this.lastDownAt;
  }

  private upArrival(now: number): number {
    this.lastUpAt = Math.max(this.hold(now, now + this.oneWay), this.lastUpAt);
    return this.lastUpAt;
  }

  private clientSend(now: number, up: boolean): void {
    if (!up && this.got === null) return;
    this.upq.push({ at: this.upArrival(now), ackFrame: this.got, delayMs: this.got === null ? 0 : quant(now - this.gotAt), up });
    this.fresh = false;
    this.lastClientSend = now;
  }

  step(): void {
    this.tick += 1;
    const now = (this.now = tickTime(this.tick));
    const p = this.p;

    // 1. Frames reach the client.
    while (this.down.length > 0 && (this.down[0] as Packet).at <= now) {
      const f = this.down.shift() as Packet;
      this.got = f.seq;
      this.gotAt = f.at;
      this.fresh = true;
    }

    // 2. The client answers.
    const kind = this.o.client;
    if (kind === 'moving') {
      if (this.tick % 2 === 0) this.clientSend(now, true);
    } else if (this.fresh && (kind === 'every' || now - this.lastClientSend >= 250)) this.clientSend(now, false);

    // 3. The server reads its uplink.
    while (this.upq.length > 0 && (this.upq[0] as Uplink).at <= now) {
      const u = this.upq.shift() as Uplink;
      this.arrivals.push(now);
      if (u.up) p.upProgress(now);
      if (u.ackFrame === null) continue;
      p.acked(now, u.ackFrame, u.delayMs);
      const sentAt = this.sentAt.get(u.ackFrame);
      if (sentAt !== undefined && (this.lastAck === null || seqDelta(u.ackFrame, this.lastAck) > 0)) {
        this.samples.push({ t: now, q: now - sentAt - u.delayMs - p.minRttMs });
      }
      if (this.lastAck === null || seqDelta(u.ackFrame, this.lastAck) > 0) this.lastAck = u.ackFrame;
      // A 'stalled' recipient leaves PARKED when an ACK arrives, and gets a keyframe (platform.md §6.2).
      if (p.park === 'stalled') {
        p.setPark(null);
        this.unparks.push(now);
        this.keyframePending = true;
      }
    }

    // 4. Ladder and stall.
    const r = p.poll(now);
    if (r === 'stalled') {
      this.stalls.push(now);
      p.setPark('stalled');
    } else if (r !== 'none') this.ladder.push({ t: now, kind: r, divisor: p.divisor });
    this.smooth.push({ t: now, q: p.rttMs - p.minRttMs });

    // 5. The send slot.
    if (p.park === null && p.slotDue(this.tick) && (this.keyframePending || (this.o.sendAt?.(this.tick) ?? true))) {
      this.slots += 1;
      const keyframe = this.keyframePending;
      const bytes = keyframe ? (this.o.keyframeWire ?? KEYFRAME_WIRE) : (this.o.frameWire ?? FRAME_WIRE);
      const before = p.inflight;
      if (p.admit(now, bytes, 0)) {
        if (before > 0 && before + bytes > p.inflightCap) this.capViolations += 1;
        p.sent(now, this.seq, bytes);
        this.sentAt.set(this.seq, now);
        this.sends.push({ t: now, kind: keyframe ? 'K' : 'F', bytes });
        this.down.push({ seq: this.seq, at: this.downArrival(now) });
        this.seq = (this.seq + 1) & 0xffff;
        this.keyframePending = false;
      }
    }
  }

  run(untilMs: number): this {
    while (tickTime(this.tick + 1) <= untilMs + EPS) this.step();
    return this;
  }

  firstLadder(kind: 'stepDown' | 'stepUp', after = 0): { t: number; kind: 'stepDown' | 'stepUp'; divisor: Divisor } | undefined {
    return this.ladder.find((e) => e.kind === kind && e.t > after);
  }

  firstHighSample(after: number): number {
    const s = this.samples.find((x) => x.t > after && x.q > PACE.queueHighMs);
    if (!s) throw new Error('no sample showed queueing above ' + PACE.queueHighMs + ' ms');
    return s.t;
  }

  /** Start of the smoothed-calm streak (queueing < 60 ms) that ends at `until`. */
  calmStart(from: number, until: number): number {
    let start = Number.NaN;
    for (const s of this.smooth) {
      if (s.t <= from || s.t > until) continue;
      if (s.q >= PACE.queueCalmMs) start = Number.NaN;
      else if (Number.isNaN(start)) start = s.t;
    }
    return start;
  }
}

/** A pacer that has one RTT sample of 300 ms (so its skips count) and nothing in flight. */
const primed = (budget: GameBudget = FUSEYARD, divisor: Divisor = 2): { p: Pacer; seq: number } => {
  const p = createPacer(config(budget, divisor), 0);
  p.sent(0, 0, FRAME_WIRE);
  p.acked(300, 0, 0);
  return { p, seq: 1 };
};

/** Send 400 B frames one slot apart, never acked, until the in-flight cap refuses one. Returns the time and next seq. */
const fillToCap = (p: Pacer, t0: number, seq0: number): { t: number; seq: number } => {
  let t = t0;
  let seq = seq0;
  for (let i = 0; i < 40 && p.inflight + 400 <= p.inflightCap; i += 1) {
    expect(p.admit(t, 400, 0)).toBe(true);
    p.sent(t, seq, 400);
    seq = (seq + 1) & 0xffff;
    t += 2 * TICK_MS;
  }
  expect(p.inflight + 400).toBeGreaterThan(p.inflightCap);
  return { t, seq };
};

describe('ladder: stepping down on queueing', () => {
  it('steps down exactly 1 s after the samples first show more than 150 ms of queueing (+160 ms)', () => {
    const T0 = 8000;
    const sim = new LinkSim({ client: 'every', extraDownMs: (t) => (t >= T0 && t < T0 + 1500 ? 160 : 0) }).run(T0);
    expect(sim.ladder).toEqual([]);
    sim.run(T0 + 2600);
    const firstHigh = sim.firstHighSample(T0);
    const down = sim.firstLadder('stepDown');
    expect(down).toBeDefined();
    expect(down?.divisor).toBe(3);
    expect((down?.t ?? 0) - firstHigh).toBeGreaterThanOrEqual(PACE.queueHighForMs - EPS);
    expect((down?.t ?? 0) - firstHigh).toBeLessThanOrEqual(PACE.queueHighForMs + TICK_MS + EPS);
    expect(sim.ladder.filter((e) => e.kind === 'stepDown')).toHaveLength(1);
    expect(sim.capViolations).toBe(0);
  });

  it('steps down within 1 s of the queueing showing, for a large jump too (+400 ms)', () => {
    const T0 = 8000;
    const sim = new LinkSim({ client: 'every', extraDownMs: (t) => (t >= T0 && t < T0 + 1200 ? 400 : 0) }).run(T0 + 3000);
    const down = sim.firstLadder('stepDown', T0);
    expect(down).toBeDefined();
    expect((down?.t ?? 0) - sim.firstHighSample(T0)).toBeLessThanOrEqual(PACE.queueHighForMs + TICK_MS + EPS);
  });

  for (const client of ['idle', 'moving'] as const) {
    it(`steps down within 1 s of +200 ms queueing showing, for a ${client} player on 3G`, () => {
      const T0 = 8000;
      const sim = new LinkSim({ client, jitterMs: 10, seed: 11, extraDownMs: (t) => (t >= T0 && t < T0 + 2000 ? 200 : 0) }).run(T0);
      expect(sim.ladder).toEqual([]);
      sim.run(T0 + 3000);
      const down = sim.firstLadder('stepDown', T0);
      expect(down).toBeDefined();
      expect((down?.t ?? 0) - sim.firstHighSample(T0)).toBeLessThanOrEqual(PACE.queueHighForMs + TICK_MS + EPS);
      // Measured from the moment the queue built up on the link: RTT + 200 ms + the ack delay + 1 s.
      expect((down?.t ?? 0) - T0).toBeLessThanOrEqual(2000);
      expect(sim.capViolations).toBe(0);
    });
  }

  it('does not step down for queueing under 150 ms', () => {
    const T0 = 8000;
    const sim = new LinkSim({ client: 'every', extraDownMs: (t) => (t >= T0 ? 120 : 0) }).run(T0 + 8000);
    expect(sim.ladder).toEqual([]);
    expect(sim.p.divisor).toBe(2);
  });

  it('ignores a short spike: one high sample is not 1 s of queueing', () => {
    const T0 = 8000;
    // Three frames held 400 ms: their samples are high, the ones after are not.
    const sim = new LinkSim({ client: 'every', extraDownMs: (t) => (t >= T0 && t < T0 + 150 ? 400 : 0) }).run(T0 + 6000);
    expect(sim.samples.some((s) => s.t > T0 && s.q > PACE.queueHighMs)).toBe(true);
    expect(sim.ladder.filter((e) => e.kind === 'stepDown')).toEqual([]);
  });
});

describe('ladder: stepping down on in-flight cap skips', () => {
  it('steps down after 3 consecutive slots skipped by the in-flight cap', () => {
    const { p, seq } = primed();
    const filled = fillToCap(p, 300, seq);
    // Let the bucket refill completely, so the cap is the only thing refusing.
    let t = filled.t + 800;
    for (let i = 1; i <= 3; i += 1) {
      expect(p.admit(t, 400, 0)).toBe(false);
      const r = p.poll(t);
      expect(r, 'after skip ' + i).toBe(i < 3 ? 'none' : 'stepDown');
      t += 2 * TICK_MS;
    }
    expect(p.divisor).toBe(3);
  });

  it('a slot the cap lets through breaks the run', () => {
    const { p, seq } = primed();
    const filled = fillToCap(p, 300, seq);
    let t = filled.t + 800;
    for (let i = 0; i < 2; i += 1) {
      expect(p.admit(t, 400, 0)).toBe(false);
      expect(p.poll(t)).toBe('none');
      t += 2 * TICK_MS;
    }
    // A frame that still fits under the cap goes out: the run of cap skips is over.
    const room = Math.floor(p.inflightCap - p.inflight);
    expect(room).toBeGreaterThan(0);
    expect(p.admit(t, room, 0)).toBe(true);
    p.sent(t, filled.seq, room);
    t += 2 * TICK_MS;
    for (let i = 0; i < 2; i += 1) {
      expect(p.admit(t, 400, 0)).toBe(false);
      expect(p.poll(t)).toBe('none');
      t += 2 * TICK_MS;
    }
    expect(p.divisor).toBe(2);
  });

  it('cap skips before the first RTT sample do not move the ladder (the cap is still a guess)', () => {
    const p = createPacer(config(), 0);
    let seq = 0;
    while (p.inflight + 400 <= p.inflightCap) {
      expect(p.admit(0, 400, 0)).toBe(true);
      p.sent(0, seq, 400);
      seq += 1;
    }
    for (let i = 0; i < 6; i += 1) {
      const t = 700 + i * 2 * TICK_MS;
      expect(p.admit(t, 400, 0)).toBe(false);
      expect(p.poll(t)).toBe('none');
    }
    expect(p.divisor).toBe(2);
  });

  it('slots refused by the bucket or by the socket backlog alone are not cap skips', () => {
    const { p } = primed();
    // Empty the bucket with one large message (nothing else in flight), and get it acked.
    expect(p.admit(400, bucketDepth(FUSEYARD), 0)).toBe(true);
    p.sent(400, 1, bucketDepth(FUSEYARD));
    p.acked(700, 1, 0);
    expect(p.inflight).toBe(0);
    for (let i = 0; i < 5; i += 1) {
      const t = 700 + i * 2 * TICK_MS;
      expect(p.admit(t, 1900, 0)).toBe(false); // the bucket is short
      expect(p.admit(t, 20, 4096)).toBe(false); // the socket's own backlog is over 2 KB
      expect(p.poll(t)).toBe('none');
    }
    expect(p.divisor).toBe(2);
    expect(p.admit(700 + 1000, 1900, 0)).toBe(true);
  });

  it('a slot refused by the cap counts even when the socket backlog refuses it too', () => {
    const { p, seq } = primed();
    const filled = fillToCap(p, 300, seq);
    let t = filled.t + 800;
    const results: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      expect(p.admit(t, 400, 4096)).toBe(false);
      results.push(p.poll(t));
      t += 2 * TICK_MS;
    }
    expect(results).toEqual(['none', 'none', 'stepDown']);
  });

  it('stops at d = 6: more congestion gives no further step', () => {
    const { p } = primed();
    let seq = 1;
    let t = 400;
    p.sent(t, seq, 400);
    seq += 1;
    const divisors: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      t += 2 * TICK_MS;
      // Far over any cap while something is in flight.
      expect(p.admit(t, PACE.capMax + 1, 0)).toBe(false);
      const r = p.poll(t);
      if (r === 'stepDown') divisors.push(p.divisor);
      else expect(r).toBe('none');
    }
    expect(divisors).toEqual([3, 4, 6]);
    expect(p.divisor).toBe(6);
  });
});

describe('ladder: stepping up', () => {
  it('steps up exactly 3 s after the smoothed queueing falls under 60 ms', () => {
    const T0 = 8000;
    const sim = new LinkSim({ client: 'every', extraDownMs: (t) => (t >= T0 && t < T0 + 1500 ? 160 : 0) }).run(T0 + 12_000);
    const down = sim.firstLadder('stepDown', T0);
    const up = sim.firstLadder('stepUp', T0);
    expect(down).toBeDefined();
    expect(up).toBeDefined();
    if (!down || !up) return;
    expect(up.divisor).toBe(2);
    const calm = sim.calmStart(down.t, up.t);
    expect(up.t - calm).toBeGreaterThanOrEqual(PACE.calmForMs - EPS);
    expect(up.t - calm).toBeLessThanOrEqual(PACE.calmForMs + TICK_MS + EPS);
    // Back at the default divisor: no further step up, ever.
    expect(sim.ladder.filter((e) => e.kind === 'stepUp')).toHaveLength(1);
  });

  for (const [client, settleMs] of [['idle', 3500], ['moving', 1500]] as const) {
    it(`steps up after 3 s of calm once the queue is gone, for a ${client} player`, () => {
      const T0 = 8000;
      const T1 = T0 + 2000;
      const sim = new LinkSim({ client, jitterMs: 10, seed: 5, extraDownMs: (t) => (t >= T0 && t < T1 ? 200 : 0) }).run(T0 + 16_000);
      const down = sim.firstLadder('stepDown', T0);
      expect(down).toBeDefined();
      const up = sim.firstLadder('stepUp', T0);
      expect(up).toBeDefined();
      if (!down || !up) return;
      // The first sample after the queue drained, as the pacer sees it.
      const quiet = sim.samples.find((s) => s.t > T1 && s.q < PACE.queueCalmMs);
      expect(quiet).toBeDefined();
      const sinceQuiet = up.t - (quiet?.t ?? 0);
      // Never before 3 s of calm; at most 3 s plus the time the smoothed RTT takes to settle.
      expect(sinceQuiet).toBeGreaterThanOrEqual(PACE.calmForMs - EPS);
      expect(sinceQuiet).toBeLessThanOrEqual(PACE.calmForMs + settleMs);
      expect(sim.p.divisor).toBe(2);
    });
  }

  it('a skip during the calm restarts the 3 s', () => {
    const T0 = 8000;
    const sim = new LinkSim({ client: 'every', extraDownMs: (t) => (t >= T0 && t < T0 + 1500 ? 160 : 0) }).run(T0 + 2000);
    const down = sim.firstLadder('stepDown', T0);
    expect(down).toBeDefined();
    // Run into the calm, then force one cap skip (frames are always outstanding on a 300 ms RTT).
    sim.run(T0 + 4500);
    expect(sim.p.inflight).toBeGreaterThan(0);
    expect(sim.p.admit(sim.now, PACE.capMax + 1, 0)).toBe(false);
    const skipAt = sim.now;
    sim.run(T0 + 12_000);
    const up = sim.firstLadder('stepUp', T0);
    expect(up).toBeDefined();
    expect((up?.t ?? 0) - skipAt).toBeGreaterThanOrEqual(PACE.calmForMs);
  });

  it('a spectator (default d = 3) never steps above its default', () => {
    const sim = new LinkSim({ client: 'idle', divisor: 3 }).run(15_000);
    expect(sim.ladder).toEqual([]);
    expect(sim.p.divisor).toBe(3);
  });
});

describe('stall and idle players', () => {
  it('an idle player sending only ACKs is never stalled in 60 simulated seconds', () => {
    const sim = new LinkSim({ client: 'idle', jitterMs: 20, seed: 3 }).run(60_000);
    expect(sim.stalls).toEqual([]);
    expect(sim.ladder).toEqual([]);
    expect(sim.p.divisor).toBe(2);
    expect(sim.sends.length).toBeGreaterThanOrEqual(0.97 * sim.slots);
    // ACKs flow at about 4 Hz.
    expect(sim.arrivals.length / 60).toBeGreaterThan(3.5);
    expect(sim.arrivals.length / 60).toBeLessThan(4.1);
    expect(sim.capViolations).toBe(0);
  });

  it('nor when the sender only has a header-only FRAME every ~500 ms (nothing changed)', () => {
    const sim = new LinkSim({ client: 'idle', sendAt: (tick) => tick % 16 === 0, frameWire: frameWire(0) }).run(60_000);
    expect(sim.stalls).toEqual([]);
    expect(sim.sends.length).toBeGreaterThan(100);
  });

  it("poll says 'stalled' 2.5 s after the last ACK while frames are outstanding", () => {
    const T0 = 5000;
    const sim = new LinkSim({ client: 'idle', outage: { from: T0, to: T0 + 10_000 } }).run(T0 + 4000);
    expect(sim.stalls).toHaveLength(1);
    const lastAck = Math.max(...sim.arrivals);
    const stalledAt = sim.stalls[0] as number;
    expect(stalledAt - lastAck).toBeGreaterThan(2500);
    expect(stalledAt - lastAck).toBeLessThanOrEqual(2500 + TICK_MS + EPS);
  });

  it('UP progress alone keeps a recipient out of the stall; it stalls 2.5 s after the last UP', () => {
    const { p } = primed();
    p.sent(400, 1, FRAME_WIRE);
    for (let t = 500; t <= 10_000; t += 100) {
      p.upProgress(t);
      expect(p.poll(t)).toBe('none');
    }
    expect(p.poll(12_500)).toBe('none');
    expect(p.poll(12_501)).toBe('stalled');
  });

  it('a long silence with nothing outstanding is not a stall', () => {
    const { p } = primed();
    expect(p.poll(60_000)).toBe('none');
    // The stall clock starts with the first frame sent after the silence.
    p.sent(60_000, 1, FRAME_WIRE);
    expect(p.poll(62_500)).toBe('none');
    expect(p.poll(62_501)).toBe('stalled');
  });

  it('a 10 s silence costs exactly one keyframe', () => {
    const T0 = 5000;
    const sim = new LinkSim({ client: 'idle', outage: { from: T0, to: T0 + 10_000 } }).run(T0 + 25_000);
    expect(sim.stalls).toHaveLength(1);
    expect(sim.unparks).toHaveLength(1);
    const stalledAt = sim.stalls[0] as number;
    const unparkAt = sim.unparks[0] as number;
    expect(sim.sends.filter((s) => s.t > stalledAt && s.t < unparkAt)).toEqual([]);
    const after = sim.sends.filter((s) => s.t >= unparkAt);
    expect(after[0]?.kind).toBe('K');
    expect(sim.sends.filter((s) => s.kind === 'K')).toHaveLength(1);
    expect(after[0]?.bytes).toBeLessThanOrEqual(keyframeWire(FUSEYARD.keyframeMax));
    // The keyframe takes the first slot after the unpark.
    expect((after[0]?.t ?? 0) - unparkAt).toBeLessThanOrEqual(6 * TICK_MS + EPS);
    // Frames flow again, and the ladder climbs back to the default.
    expect(after.filter((s) => s.t > unparkAt + 1000 && s.t <= unparkAt + 6000).length).toBeGreaterThanOrEqual(25);
    expect(sim.p.divisor).toBe(2);
    expect(sim.capViolations).toBe(0);
  });
});

describe('parking', () => {
  for (const reason of ['away', 'yield', 'stalled', 'overflow'] as const) {
    it(`parking as '${reason}' clears in-flight; the keyframe goes out at once on unpark`, () => {
      const { p, seq } = primed();
      const filled = fillToCap(p, 300, seq);
      expect(p.inflight).toBeGreaterThan(0);
      p.setPark(reason);
      expect(p.park).toBe(reason);
      expect(p.inflight).toBe(0);
      // Parked: no stall and no ladder move, however long.
      expect(p.poll(filled.t + 10_000)).toBe('none');
      // Acks for frames sent before the park change nothing.
      p.acked(filled.t + 10_100, (filled.seq - 1) & 0xffff, 0);
      expect(p.inflight).toBe(0);
      p.setPark(null);
      expect(p.park).toBeNull();
      expect(p.admit(filled.t + 10_200, keyframeWire(FUSEYARD.keyframeMax), 0)).toBe(true);
      expect(p.poll(filled.t + 10_200)).toBe('none');
    });
  }

  it('parking also clears a run of cap skips', () => {
    const { p, seq } = primed();
    const filled = fillToCap(p, 300, seq);
    let t = filled.t + 800;
    for (let i = 0; i < 2; i += 1) {
      expect(p.admit(t, 400, 0)).toBe(false);
      t += 2 * TICK_MS;
    }
    p.setPark('away');
    p.setPark(null);
    // Two skips before the park plus one after are not three in a row.
    p.sent(t, filled.seq, 400);
    t += 2 * TICK_MS;
    expect(p.admit(t, PACE.capMax + 1, 0)).toBe(false);
    expect(p.poll(t)).toBe('none');
    expect(p.divisor).toBe(2);
  });

  it('a long park keeps the delivery-rate estimate, so the cap does not shrink and the unpark is clean', () => {
    const sim = new LinkSim({ client: 'idle', keyframeWire: keyframeWire(FUSEYARD.keyframeMax) }).run(10_000);
    const capBefore = sim.p.inflightCap;
    sim.p.setPark('away');
    sim.run(40_000);
    sim.p.setPark(null);
    expect(sim.p.inflightCap).toBeGreaterThanOrEqual(0.9 * capBefore);
    sim.keyframePending = true;
    const unparkAt = sim.now;
    sim.run(unparkAt + 4000);
    expect(sim.sends.filter((s) => s.t > unparkAt)[0]?.kind).toBe('K');
    expect(sim.ladder).toEqual([]);
  });
});

describe('slots', () => {
  it('slotDue fires every d ticks', () => {
    const p = createPacer(config(FUSEYARD, 3), 0);
    const due = Array.from({ length: 10 }, (_, tick) => p.slotDue(tick));
    expect(due).toEqual([true, false, false, true, false, false, true, false, false, true]);
    expect(p.slotDue(-3)).toBe(true);
    expect(p.slotDue(-1)).toBe(false);
  });
});

describe('bucket fuzz', () => {
  it('never deadlocks: over 2,000 seeded budgets and schedules, a keyframe-sized message goes out once nothing is in flight', () => {
    const next = seeded(0xb0c4e7);
    const reasons: readonly ParkReason[] = ['away', 'yield', 'stalled', 'overflow'];
    const problems: string[] = [];
    let admitted = 0;
    let refused = 0;
    for (let c = 0; c < 2000 && problems.length < 10; c += 1) {
      const budget: GameBudget = {
        downAvg: 50 + (next() % 8000),
        downPeak1s: 0,
        upAvg: 0,
        keyframeMax: 8 + (next() % 1200),
        snapshotMax: 0,
        frameTypMax: next() % 600,
        upMax: 0,
        overflowEvents: 0,
      };
      const divisor = DIVISORS[next() % DIVISORS.length] as Divisor;
      let now = next() % 1_000_000;
      const p = createPacer(config(budget, divisor), now);
      const depth = bucketDepth(budget);
      const maxWire = keyframeWire(budget.keyframeMax);
      // What the pacer should count in flight: frames since the last park, newer than the newest
      // ack, at most PACE.ring of them.
      let mirror: { seq: number; bytes: number }[] = [];
      const sentSeqs: number[] = [];
      let seq = next() & 0xffff;
      let lastAck: number | null = null;
      const steps = 40 + (next() % 260);
      for (let i = 0; i < steps; i += 1) {
        now += next() % 150;
        const op = next() % 12;
        if (op < 6) {
          const r = next() % 4;
          const size = r === 0 ? maxWire : r === 1 ? 1 + (next() % (2 * depth)) : frameWire(next() % (budget.frameTypMax + 1));
          const buffered = next() % 8 === 0 ? 2048 + (next() % 4096) : next() % 2048;
          if (p.park === null) {
            if (p.admit(now, size, buffered)) {
              admitted += 1;
              p.sent(now, seq, size);
              mirror.push({ seq, bytes: size });
              if (mirror.length > PACE.ring) mirror.shift();
              sentSeqs.push(seq);
              seq = (seq + 1) & 0xffff;
            } else refused += 1;
          }
        } else if (op < 10) {
          if (sentSeqs.length > 0) {
            // The client acks the newest frame it has: usually recent, sometimes stale or repeated.
            const k = next() % 4 === 0 ? next() % sentSeqs.length : Math.max(0, sentSeqs.length - 1 - (next() % 4));
            const ackFrame = sentSeqs[k] as number;
            p.acked(now, ackFrame, (next() % 64) * 4);
            if (lastAck === null || seqDelta(ackFrame, lastAck) > 0) {
              lastAck = ackFrame;
              mirror = mirror.filter((f) => seqDelta(f.seq, ackFrame) > 0);
            }
          }
        } else if (op === 10) {
          const r = p.poll(now);
          if (r === 'stalled') {
            p.setPark('stalled');
            mirror = [];
          }
        } else if (p.park === null) {
          p.setPark(reasons[next() % reasons.length] as ParkReason);
          mirror = [];
        } else p.setPark(null);

        const expected = mirror.reduce((sum, f) => sum + f.bytes, 0);
        if (p.inflight !== expected) problems.push(`case ${c} step ${i}: inflight ${p.inflight}, expected ${expected}`);
        if (!(p.inflightCap >= PACE.capMin && p.inflightCap <= PACE.capMax)) problems.push(`case ${c}: cap ${p.inflightCap}`);
        if (!DIVISORS.includes(p.divisor) || p.divisor < divisor) problems.push(`case ${c}: divisor ${p.divisor}`);
        if (!Number.isFinite(p.rttMs) || !Number.isFinite(p.minRttMs) || p.minRttMs <= 0) problems.push(`case ${c}: rtt ${p.rttMs} / ${p.minRttMs}`);
      }

      // Let everything land: the client acks the newest frame, and a parked recipient is unparked.
      if (sentSeqs.length > 0) p.acked(now, sentSeqs[sentSeqs.length - 1] as number, 0);
      if (p.park !== null) p.setPark(null);
      if (p.inflight !== 0) problems.push(`case ${c}: ${p.inflight} B still in flight after the final ack`);
      // After one full refill of the bucket, the largest keyframe goes out, and so does anything bigger.
      now += Math.ceil(depth / ((budget.downAvg * PACE.bucketRate) / 1000)) + 1;
      if (!p.admit(now, maxWire, 0)) problems.push(`case ${c}: a ${maxWire} B keyframe was refused (depth ${depth})`);
      if (!p.admit(now, 2 * depth, 0)) problems.push(`case ${c}: an oversize message was refused with a full bucket`);
    }
    expect(problems).toEqual([]);
    // The schedules exercised both outcomes.
    expect(admitted).toBeGreaterThan(30_000);
    expect(refused).toBeGreaterThan(10_000);
  });
});
