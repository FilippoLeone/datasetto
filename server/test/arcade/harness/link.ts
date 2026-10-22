/**
 * One client's bottleneck link in virtual time (platform.md §15.2), stepped 1 ms at a time.
 *
 * Each direction is one FIFO bottleneck of `queueBytes` (64 KB) drained at the current rate, shared by:
 * - two TCP streams, the action lane (`lane`) and the app socket (`main`). A stream's messages enter
 *   the bottleneck in order while it has room; what does not fit waits at the sender, which is the
 *   WebSocket's `bufferedAmount` (`buffered()`). Each stream delivers in order: a segment is lost with
 *   probability `loss`, and then it and every byte behind it in that stream arrive `RTO = max(200 ms,
 *   2 × RTT)` late (head-of-line blocking; the other stream is not held);
 * - a constant voice flow (`voiceBps`, UDP): fluid bytes that are dropped when the queue is full;
 * - fluid TCP ACK bytes (`fluid()`), which only take capacity.
 * A segment's one-way delay after the bottleneck is RTT/2 plus a seeded uniform jitter of ±jitterMs/2.
 * A rate of 0 is an outage: nothing drains, what already left the bottleneck still arrives.
 */
import { xorshift32 } from '../../../src/arcade/core/rng.js';

export interface LinkProfile {
  /** Bottleneck capacity server → client, bits/s, shared by every flow (voice included). 0 = outage. */
  downBps: number;
  /** Bottleneck capacity client → server, bits/s. */
  upBps: number;
  /** Base round trip, ms (each direction adds half). */
  rttMs: number;
  /** Round-trip jitter: each segment's one-way delay gets a uniform ±jitterMs/2. Default 0. */
  jitterMs?: number;
  /** Probability that a TCP segment is lost (head-of-line). Default 0. */
  loss?: number;
  /** The constant voice flow each way, bits/s. Default 147,000 (3 capped streams with overhead). */
  voiceBps?: number;
  /** Bottleneck queue per direction, bytes. Default 65,536. */
  queueBytes?: number;
  seed?: number;
}

export type Dir = 'down' | 'up';
export type Stream = 'lane' | 'main';

export interface LinkSim<T> {
  /** Virtual time, ms. */
  readonly now: number;
  readonly profile: Readonly<Required<LinkProfile>>;
  /** Change the link from now on. */
  set(p: Partial<LinkProfile>): void;
  /** One message on a TCP stream: `wire` bytes on the link (framing included), `payload` of them counted in `buffered()`. */
  write(dir: Dir, stream: Stream, wire: number, payload: number, data: T): void;
  /** Bytes that only take capacity (TCP ACKs). */
  fluid(dir: Dir, bytes: number): void;
  /** Messages written on the stream in [fromMs, toMs) leave the sender `ms` late (a write buffer that does not drain); those behind wait in order. */
  delay(dir: Dir, stream: Stream, fromMs: number, toMs: number, ms: number): void;
  /** Payload bytes written and not yet accepted by the bottleneck (WebSocket `bufferedAmount`). */
  buffered(dir: Dir, stream: Stream): number;
  /** When the oldest message still waiting at the sender was written (null: nothing waits). */
  oldestBuffered(dir: Dir, stream: Stream): number | null;
  /** Wire bytes of the stream waiting at the sender plus those in the bottleneck queue. */
  backlog(dir: Dir, stream: Stream): number;
  /** Wire bytes of the stream in the bottleneck queue. */
  queuedOf(dir: Dir, stream: Stream): number;
  /** Bytes in the bottleneck queue (every flow). */
  queued(dir: Dir): number;
  /** Advance 1 ms; `deliver` receives each message that reached the far end, in stream order. */
  step(deliver: (dir: Dir, stream: Stream, data: T, sentAt: number) => void): void;
  readonly stats: { voiceDroppedBytes: { down: number; up: number }; lostSegments: number; segments: number };
}

interface Seg<T> {
  wire: number;
  payload: number;
  data: T;
  sentAt: number;
  notBefore: number;
  stream: Stream;
  deliverAt: number;
}

interface Entry<T> {
  left: number;
  seg: Seg<T> | null;
}

interface StreamState<T> {
  pending: Seg<T>[];
  pendingHead: number;
  pendingWire: number;
  pendingPayload: number;
  delays: { from: number; to: number; ms: number }[];
  queued: number;
  flight: Seg<T>[];
  flightHead: number;
  lastDeliver: number;
}

interface DirState<T> {
  queue: Entry<T>[];
  head: number;
  queued: number;
  lane: StreamState<T>;
  main: StreamState<T>;
}

const streamState = <T>(): StreamState<T> => ({ pending: [], pendingHead: 0, pendingWire: 0, pendingPayload: 0, delays: [], queued: 0, flight: [], flightHead: 0, lastDeliver: 0 });

const compact = <X>(list: X[], head: number): number => {
  if (head > 256 && head * 2 > list.length) {
    list.splice(0, head);
    return 0;
  }
  return head;
};

export const lossyLink = <T = unknown>(p: LinkProfile): LinkSim<T> => {
  const profile: Required<LinkProfile> = { jitterMs: 0, loss: 0, voiceBps: 147_000, queueBytes: 65_536, seed: 1, ...p };
  let rng = profile.seed >>> 0 || 1;
  const unit = (): number => (rng = xorshift32(rng)) / 0x100000000;
  let now = 0;
  const dirs: Record<Dir, DirState<T>> = {
    down: { queue: [], head: 0, queued: 0, lane: streamState(), main: streamState() },
    up: { queue: [], head: 0, queued: 0, lane: streamState(), main: streamState() },
  };
  const stats = { voiceDroppedBytes: { down: 0, up: 0 }, lostSegments: 0, segments: 0 };

  const pushFluid = (d: DirState<T>, bytes: number): boolean => {
    if (d.queued + bytes > profile.queueBytes) return false;
    const tail = d.queue.length > d.head ? (d.queue[d.queue.length - 1] as Entry<T>) : null;
    if (tail && tail.seg === null) tail.left += bytes;
    else d.queue.push({ left: bytes, seg: null });
    d.queued += bytes;
    return true;
  };

  const admit = (d: DirState<T>, s: StreamState<T>): void => {
    while (s.pendingHead < s.pending.length) {
      const seg = s.pending[s.pendingHead] as Seg<T>;
      if (seg.notBefore > now || d.queued + seg.wire > profile.queueBytes) break;
      s.pendingHead += 1;
      s.pendingWire -= seg.wire;
      s.pendingPayload -= seg.payload;
      s.queued += seg.wire;
      d.queued += seg.wire;
      d.queue.push({ left: seg.wire, seg });
    }
    s.pendingHead = compact(s.pending, s.pendingHead);
  };

  const serve = (d: DirState<T>, rateBpms: number): void => {
    let budget = rateBpms;
    let used = 0;
    while (budget > 1e-9 && d.head < d.queue.length) {
      const e = d.queue[d.head] as Entry<T>;
      const take = Math.min(e.left, budget);
      e.left -= take;
      budget -= take;
      used += take;
      d.queued -= take;
      if (e.left > 1e-9) break;
      d.head += 1;
      const seg = e.seg;
      if (!seg) continue;
      const s = d[seg.stream];
      s.queued -= seg.wire;
      const done = now - 1 + used / rateBpms;
      const jitter = profile.jitterMs > 0 ? (unit() - 0.5) * profile.jitterMs : 0;
      let arrive = done + profile.rttMs / 2 + jitter;
      stats.segments += 1;
      if (profile.loss > 0 && unit() < profile.loss) {
        stats.lostSegments += 1;
        arrive += Math.max(200, 2 * profile.rttMs);
      }
      seg.deliverAt = Math.max(arrive, s.lastDeliver);
      s.lastDeliver = seg.deliverAt;
      s.flight.push(seg);
    }
    if (d.queued < 1e-6 && d.head >= d.queue.length) d.queued = 0;
    d.head = compact(d.queue, d.head);
  };

  const deliverStream = (dir: Dir, s: StreamState<T>, deliver: (dir: Dir, stream: Stream, data: T, sentAt: number) => void): void => {
    while (s.flightHead < s.flight.length && (s.flight[s.flightHead] as Seg<T>).deliverAt <= now) {
      const seg = s.flight[s.flightHead] as Seg<T>;
      s.flightHead += 1;
      deliver(dir, seg.stream, seg.data, seg.sentAt);
    }
    s.flightHead = compact(s.flight, s.flightHead);
  };

  return {
    get now() {
      return now;
    },
    profile,
    set(next) {
      Object.assign(profile, next);
    },
    write(dir, stream, wire, payload, data) {
      const s = dirs[dir][stream];
      let notBefore = 0;
      for (const w of s.delays) if (now >= w.from && now < w.to) notBefore = Math.max(notBefore, now + w.ms);
      s.pending.push({ wire, payload, data, sentAt: now, notBefore, stream, deliverAt: 0 });
      s.pendingWire += wire;
      s.pendingPayload += payload;
    },
    fluid(dir, bytes) {
      pushFluid(dirs[dir], bytes);
    },
    delay(dir, stream, fromMs, toMs, ms) {
      dirs[dir][stream].delays.push({ from: fromMs, to: toMs, ms });
    },
    buffered: (dir, stream) => dirs[dir][stream].pendingPayload,
    oldestBuffered(dir, stream) {
      const st = dirs[dir][stream];
      return st.pendingHead < st.pending.length ? (st.pending[st.pendingHead] as Seg<T>).sentAt : null;
    },
    backlog: (dir, stream) => dirs[dir][stream].pendingWire + dirs[dir][stream].queued,
    queuedOf: (dir, stream) => dirs[dir][stream].queued,
    queued: (dir) => dirs[dir].queued,
    step(deliver) {
      now += 1;
      for (const dir of ['down', 'up'] as const) {
        const d = dirs[dir];
        admit(d, d.lane);
        admit(d, d.main);
        const voice = profile.voiceBps / 8000;
        if (voice > 0 && !pushFluid(d, voice)) stats.voiceDroppedBytes[dir] += voice;
        const rate = (dir === 'down' ? profile.downBps : profile.upBps) / 8000;
        if (rate > 0) serve(d, rate);
        deliverStream(dir, d.lane, deliver);
        deliverStream(dir, d.main, deliver);
      }
    },
    stats,
  };
};
