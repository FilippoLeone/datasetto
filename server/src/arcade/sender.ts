/**
 * One recipient's stream on the action lane (platform.md §6): pacing, the ladder, parking, keyframes
 * and egress accounting. The pacing decisions live in the pure `core/net/pacer.ts`; this module
 * applies them to a socket (or, in tests and the link simulator, to any `SendSink`).
 *
 * The delta-base rule (§6.2): the client's world is the last KEYFRAME plus every event block after it,
 * in order. Snapshots are absolute. While LIVE, `frameSeq` is consecutive and every event visible to
 * the recipient after the keyframe's tick is in exactly one FRAME. On parking, pending events are
 * dropped; the next thing the recipient gets is a KEYFRAME, so a lagging client never gets a backlog.
 *
 * Phases are ordered: a PHASE goes out after the events queued before it. A recipient that unparks
 * gets the current phase right after its keyframe when it changed while parked.
 */
import { ByteWriter } from './core/bytes.js';
import { OVERHEAD, LANE_CEILING, type GameBudget } from './core/net/budget.js';
import { PEV } from './core/net/events.js';
import { createPacer, type Pacer, type ParkReason } from './core/net/pacer.js';
import { DIVISORS, frameSize, KEY_REASON, writeBeat, writeFrame, writeKeyframe, writePhase, writeWelcome, type Divisor, type Welcome } from './core/net/lane.js';
import type { EventChunk } from './core/net/match.js';

/** Where a recipient's bytes go: a WebSocket in production, a simulated link in tests. */
export interface SendSink {
  send(bytes: Uint8Array): void;
  readonly bufferedAmount: number;
}

export interface RecipientOptions {
  slot: number;
  spectator: boolean;
  budget: GameBudget;
  defaultDivisor: Divisor;
  skipUnchanged: boolean;
  /** Wall-clock source (ms). */
  now(): number;
  /** Wire bytes sent (including framing overhead), for the egress counter. */
  onEgress?(wireBytes: number): void;
  /** A 10 s window over the lane ceilings (logged once per window by the caller). */
  onCeiling?(info: { downAvgBps: number; peak1s: number }): void;
}

type Outbox = { kind: 'events'; tick: number; bytes: Uint8Array; count: number; at: number } | { kind: 'phase'; phase: number; reason: number; body: Uint8Array };

export interface SlotInput {
  /** Full server tick (u32). */
  tick: number;
  /** This tick's snapshot for the recipient's view (null: unchanged or frozen). */
  snapshot: Uint8Array | null;
  ackUp: number;
  /** Builds the current keyframe body for the recipient's view (called only when one is sent). */
  keyframe(): Uint8Array;
  /** The match's current phase, for a recipient coming back from parking. */
  phase: { phase: number; reason: number; body: Uint8Array } | null;
  /** The lowest divisor allowed right now (degrade ladder: spectators 6, players 3). */
  floor: Divisor;
}

export interface Recipient {
  readonly slot: number;
  view: number;
  readonly pacer: Pacer;
  readonly frameSeq: number;
  readonly parked: ParkReason | null;
  readonly attached: boolean;
  /** Bytes of events waiting for this recipient. */
  readonly pendingBytes: number;
  attach(sink: SendSink): void;
  detach(): void;
  /** WELCOME, then a keyframe at the next opportunity (`reason`). */
  welcome(w: Welcome, reason: number): void;
  /** Drop pending events and send a keyframe for the current view as soon as the in-flight rule allows. */
  rekey(reason: number): void;
  pushEvents(tick: number, chunk: EventChunk): void;
  pushSeat(tick: number, slot: number, state: 0 | 1 | 2 | 3): void;
  pushNotice(tick: number, code: number): void;
  pushPhase(phase: number, reason: number, body: Uint8Array): void;
  park(reason: ParkReason): void;
  /** Leave parking: the next send is a keyframe (reason unpark). */
  unpark(): void;
  /** One tick of the send schedule; returns true when something went out. */
  slotTick(input: SlotInput): boolean;
  onAck(ackFrame: number, ackDelayMs: number): void;
  onUp(): void;
  /** Send a message outside the pacing (PONG, HANDOVER, BYE). */
  sendRaw(bytes: Uint8Array): void;
  /** Flush everything queued now, ignoring pacing (the match is ending). */
  flush(input: SlotInput): void;
}

const BEAT_AFTER_MS = 1000;
const HEADER_ONLY_EVERY_MS = 500;
const OVERFLOW_AGE_MS = 1500;
const MAX_EVENTS_PER_FRAME = 255;

const sameBytes = (a: Uint8Array | null, b: Uint8Array | null): boolean => {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
};

export const createRecipient = (o: RecipientOptions): Recipient => {
  const pacer = createPacer({ budget: o.budget, defaultDivisor: o.defaultDivisor, stallMs: 2500 }, o.now());
  let sink: SendSink | null = null;
  let frameSeq = 0;
  let outbox: Outbox[] = [];
  let pendingBytes = 0;
  let needKeyframe: number | null = null;
  let welcomed = false;
  let lastSentAt = 0;
  let lastFrameAt = 0;
  let lastSnapshot: Uint8Array | null = null;
  let phaseSent: { phase: number; reason: number } | null = null;
  // The `overflow` park lives here, not in the pacer: the pacer keeps counting the bytes in flight, so
  // the exit rule (in-flight under half the cap) and the stall rule still see what was sent before it.
  let overflow = false;
  // Ceiling accounting: a 10 s window and the current 1 s window.
  let windowStart = o.now();
  let windowBytes = 0;
  let secondStart = o.now();
  let secondBytes = 0;
  let peak = 0;

  const nextSeq = (): number => {
    frameSeq = (frameSeq + 1) & 0xffff;
    return frameSeq;
  };

  const account = (bytes: number): void => {
    const wire = bytes + OVERHEAD.down;
    o.onEgress?.(wire);
    const now = o.now();
    if (now - secondStart >= 1000) {
      peak = Math.max(peak, secondBytes);
      secondStart = now;
      secondBytes = 0;
    }
    secondBytes += wire;
    windowBytes += wire;
    if (now - windowStart >= 10_000) {
      peak = Math.max(peak, secondBytes);
      const avg = (windowBytes * 1000) / (now - windowStart);
      if (avg > LANE_CEILING.downAvgBps || peak > LANE_CEILING.downPeak1s) o.onCeiling?.({ downAvgBps: Math.round(avg), peak1s: peak });
      windowStart = now;
      windowBytes = 0;
      peak = 0;
    }
  };

  const transmit = (bytes: Uint8Array, tracked: boolean): void => {
    if (!sink) return;
    sink.send(bytes);
    const now = o.now();
    lastSentAt = now;
    if (tracked) pacer.sent(now, frameSeq, bytes.length + OVERHEAD.down);
    account(bytes.length);
  };

  const dropPending = (): void => {
    outbox = [];
    pendingBytes = 0;
  };

  const sendKeyframe = (input: SlotInput, reason: number): void => {
    const body = input.keyframe();
    const msg = writeKeyframe(nextSeq(), input.tick & 0xffff, input.ackUp & 0xffff, reason, body);
    // Everything queued so far is part of the state the keyframe carries.
    dropPending();
    lastSnapshot = null;
    transmit(msg, true);
    lastFrameAt = o.now();
    needKeyframe = null;
    if (input.phase && (!phaseSent || phaseSent.phase !== input.phase.phase || phaseSent.reason !== input.phase.reason)) {
      transmit(writePhase(input.phase.phase, input.phase.reason, input.phase.body), false);
      phaseSent = { phase: input.phase.phase, reason: input.phase.reason };
    }
  };

  const effectiveDivisor = (floor: Divisor): Divisor => (DIVISORS.indexOf(pacer.divisor) >= DIVISORS.indexOf(floor) ? pacer.divisor : floor);

  /** Leading event chunks (up to the first phase), merged with At marks relative to `tick`. */
  const takeEvents = (tick: number): { bytes: Uint8Array; count: number; taken: number } | null => {
    let size = 0;
    let count = 0;
    let taken = 0;
    // An At mark goes in front of every chunk whose tick differs from the one before it (the first
    // chunk is compared with the frame's own tick); both passes use the same rule.
    let sizedTick = tick;
    for (const item of outbox) {
      if (item.kind !== 'events') break;
      const needsAt = item.tick !== sizedTick;
      if (count + item.count + (needsAt ? 1 : 0) > MAX_EVENTS_PER_FRAME) break;
      size += item.bytes.length + (needsAt ? 2 : 0);
      count += item.count + (needsAt ? 1 : 0);
      sizedTick = item.tick;
      taken += 1;
    }
    if (taken === 0) return null;
    const w = new ByteWriter(size);
    let markedTick = tick;
    for (let i = 0; i < taken; i += 1) {
      const item = outbox[i] as Extract<Outbox, { kind: 'events' }>;
      if (item.tick !== markedTick) {
        w.u8(PEV.At).u8(Math.max(0, Math.min(255, tick - item.tick)));
        markedTick = item.tick;
      }
      w.bytes(item.bytes);
    }
    return { bytes: w.view(), count, taken };
  };

  const flushPhases = (): void => {
    while (outbox.length > 0 && (outbox[0] as Outbox).kind === 'phase') {
      const p = outbox.shift() as Extract<Outbox, { kind: 'phase' }>;
      transmit(writePhase(p.phase, p.reason, p.body), false);
      phaseSent = { phase: p.phase, reason: p.reason };
    }
  };

  const overflowing = (now: number): boolean => {
    if (pendingBytes > o.budget.overflowEvents) return true;
    const first = outbox.find((item) => item.kind === 'events') as Extract<Outbox, { kind: 'events' }> | undefined;
    return first !== undefined && now - first.at > OVERFLOW_AGE_MS;
  };

  const recipient: Recipient = {
    slot: o.slot,
    view: 0,
    pacer,
    get frameSeq() {
      return frameSeq;
    },
    get parked() {
      return pacer.park ?? (overflow ? 'overflow' : null);
    },
    get attached() {
      return sink !== null;
    },
    get pendingBytes() {
      return pendingBytes;
    },

    attach(next) {
      sink = next;
    },
    detach() {
      sink = null;
    },

    welcome(w, reason) {
      if (!sink) return;
      welcomed = true;
      overflow = false;
      phaseSent = null;
      dropPending();
      transmit(writeWelcome(w), false);
      needKeyframe = reason;
    },

    rekey(reason) {
      dropPending();
      needKeyframe = reason;
    },

    pushEvents(tick, chunk) {
      if (!welcomed || pacer.park || overflow || needKeyframe !== null || chunk.count === 0) return;
      // One tick's events can't be split (only the game knows their lengths) and must leave room for an
      // At mark: a bigger burst becomes a keyframe, whose absolute state stands in for them.
      if (chunk.count >= MAX_EVENTS_PER_FRAME) {
        dropPending();
        needKeyframe = KEY_REASON.resync;
        return;
      }
      // Copied: a runtime may reuse its event buffer at the next step() (CoreMatch contract).
      outbox.push({ kind: 'events', tick, bytes: chunk.bytes.slice(), count: chunk.count, at: o.now() });
      pendingBytes += chunk.bytes.length;
    },

    pushSeat(tick, slot, state) {
      recipient.pushEvents(tick, { bytes: Uint8Array.of(PEV.SeatState, slot, state), count: 1 });
    },

    pushNotice(tick, code) {
      recipient.pushEvents(tick, { bytes: Uint8Array.of(PEV.Notice, code), count: 1 });
    },

    pushPhase(phase, reason, body) {
      if (!welcomed || pacer.park || overflow || needKeyframe !== null) return;
      outbox.push({ kind: 'phase', phase, reason, body });
    },

    park(reason) {
      if (reason === 'overflow') {
        if (pacer.park !== null || overflow) return;
        overflow = true;
        dropPending();
        return;
      }
      overflow = false;
      if (pacer.park === reason) return;
      pacer.setPark(reason);
      dropPending();
    },

    unpark() {
      if (pacer.park === null) return;
      pacer.setPark(null);
      needKeyframe = KEY_REASON.unpark;
    },

    slotTick(input) {
      if (!sink || !welcomed) return false;
      const now = o.now();
      const verdict = pacer.poll(now);
      if (verdict === 'stalled') {
        recipient.park('stalled');
        return false;
      }
      const park = pacer.park;
      if (park === 'away') return false;
      if (park === 'yield' || park === 'stalled') {
        if (now - lastSentAt >= BEAT_AFTER_MS) {
          transmit(writeBeat(input.tick & 0xffff), false);
          return true;
        }
        return false;
      }
      if (overflow) {
        // Leave once in-flight is under half the cap, with a keyframe the pacer admits.
        if (pacer.inflight < pacer.inflightCap / 2 && pacer.admit(now, 10 + o.budget.keyframeMax + OVERHEAD.down, sink.bufferedAmount)) {
          overflow = false;
          sendKeyframe(input, KEY_REASON.unpark);
          return true;
        }
        return false;
      }

      if (needKeyframe !== null) {
        const size = 10 + o.budget.keyframeMax;
        if (pacer.admit(now, size + OVERHEAD.down, sink.bufferedAmount)) {
          sendKeyframe(input, needKeyframe);
          return true;
        }
        return false;
      }

      const divisor = effectiveDivisor(input.floor);
      const due = ((input.tick % divisor) + divisor) % divisor === 0;
      if (!due) {
        // Off-slot: phases with nothing queued before them still go out at once.
        if (outbox.length > 0 && (outbox[0] as Outbox).kind === 'phase') {
          flushPhases();
          return true;
        }
        if (now - lastSentAt >= BEAT_AFTER_MS) {
          transmit(writeBeat(input.tick & 0xffff), false);
          return true;
        }
        return false;
      }

      flushPhases();
      const events = takeEvents(input.tick);
      let snapshot = input.snapshot;
      if (snapshot && o.skipUnchanged && !events && sameBytes(snapshot, lastSnapshot)) snapshot = null;
      if (!snapshot && !events) {
        const headerOnly = o.skipUnchanged && input.snapshot !== null && now - lastFrameAt >= HEADER_ONLY_EVERY_MS;
        if (!headerOnly) {
          if (now - lastSentAt >= BEAT_AFTER_MS) {
            transmit(writeBeat(input.tick & 0xffff), false);
            return true;
          }
          return false;
        }
      }
      const size = frameSize(snapshot, events) + OVERHEAD.down;
      if (!pacer.admit(now, size, sink.bufferedAmount)) {
        if (overflowing(now)) recipient.park('overflow');
        return false;
      }
      const msg = writeFrame({
        frameSeq: nextSeq(),
        tick: input.tick & 0xffff,
        ackUp: input.ackUp & 0xffff,
        divisor,
        lagging: pacer.rttMs - pacer.minRttMs > 150,
        snapshot,
        events: events ? { count: events.count, bytes: events.bytes } : null,
      });
      if (events) {
        for (let i = 0; i < events.taken; i += 1) {
          const item = outbox.shift() as Extract<Outbox, { kind: 'events' }>;
          pendingBytes -= item.bytes.length;
        }
      }
      // A copy, for the same reason: compared with the next tick's snapshot, which may be the same buffer.
      if (snapshot) lastSnapshot = snapshot.slice();
      transmit(msg, true);
      lastFrameAt = now;
      flushPhases();
      return true;
    },

    onAck(ackFrame, ackDelayMs) {
      pacer.acked(o.now(), ackFrame, ackDelayMs);
      if (pacer.park === 'stalled') recipient.unpark();
    },

    onUp() {
      pacer.upProgress(o.now());
      if (pacer.park === 'stalled') recipient.unpark();
    },

    sendRaw(bytes) {
      transmit(bytes, false);
    },

    flush(input) {
      if (!sink || !welcomed) return;
      if (needKeyframe !== null || pacer.park !== null || overflow) return;
      for (let guard = 0; guard < 64 && outbox.length > 0; guard += 1) {
        flushPhases();
        const events = takeEvents(input.tick);
        if (!events) continue;
        transmit(
          writeFrame({ frameSeq: nextSeq(), tick: input.tick & 0xffff, ackUp: input.ackUp & 0xffff, divisor: effectiveDivisor(input.floor), snapshot: null, events: { count: events.count, bytes: events.bytes } }),
          true,
        );
        for (let i = 0; i < events.taken; i += 1) {
          const item = outbox.shift() as Extract<Outbox, { kind: 'events' }>;
          pendingBytes -= item.bytes.length;
        }
      }
    },
  };
  return recipient;
};
