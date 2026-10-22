/**
 * Per-recipient pacing for the action lane (platform.md §6). Pure and clock-injected: the server's
 * sender (server/src/arcade/sender.ts) drives it with real time and sockets, the lossy-link simulator
 * with virtual time.
 *
 * At each send slot (every `divisor` ticks) a FRAME goes out only if
 *   - the token bucket holds its wire bytes (rate 1.25 × budget.downAvg, depth = one worst keyframe plus
 *     four typical frames, so the largest message always fits and the bucket cannot deadlock);
 *   - the bytes in flight after it stay under the in-flight cap,
 *     `clamp(deliveryRate × (minRtt + 80 ms) + 600, 800, 6144)`;
 *   - the socket's own backlog (`bufferedAmount`) is under 2 KB.
 *
 * Ladder: one step down (2 → 3 → 4 → 6) after `rtt − minRtt > 150 ms` for 1 s, or 3 consecutive slots
 * skipped by the in-flight cap; after 3 s with `rtt − minRtt < 60 ms` and no skips, straight back to the
 * default divisor. One level per 3 s would take 9 s from d = 6 after a collapse; a link that is still
 * short steps down again within 1 s.
 * The step down reads each RTT sample: it fires 1 s after the first sample over 150 ms when every
 * sample since agrees (a smoothed RTT would cross 150 ms seconds later at 4 Hz ACKs, or never for a
 * +160 ms queue). The step up reads the smoothed RTT, so jitter does not keep resetting the 3 s. The
 * smoothing falls faster than it rises (gain 1/2 down, 1/8 up): a rise is smoothed as before, but once
 * a queue drains the calm shows within about 5 samples, not about 20 (4 s at d = 6 after a collapse).
 * Stall: no ACK or UP progress for `stallMs` while frames are outstanding.
 */
import { seqDelta } from '../bytes.js';
import { bucketDepth, type GameBudget } from './budget.js';
import { DIVISORS, type Divisor } from './lane.js';

export type ParkReason = 'away' | 'yield' | 'stalled' | 'overflow';

export interface PacerConfig {
  budget: GameBudget;
  defaultDivisor: Divisor;
  stallMs: 2500;
}

export interface Pacer {
  readonly divisor: Divisor;
  readonly minRttMs: number;
  readonly rttMs: number;
  readonly inflight: number;
  readonly inflightCap: number;
  readonly park: ParkReason | null;
  slotDue(tick: number): boolean;
  /** Bucket ∧ in-flight cap ∧ bufferedAmount < 2048. */
  admit(nowMs: number, wireBytes: number, bufferedAmount: number): boolean;
  sent(nowMs: number, frameSeq: number, wireBytes: number): void;
  acked(nowMs: number, ackFrame: number, ackDelayMs: number): void;
  upProgress(nowMs: number): void;
  setPark(reason: ParkReason | null): void;
  poll(nowMs: number): 'none' | 'stalled' | 'stepDown' | 'stepUp';
}

/** Tuning constants, exported for tests and the simulator. */
export const PACE = {
  bucketRate: 1.25,
  bufferedMax: 2048,
  capMin: 800,
  capMax: 6144,
  capSlackMs: 80,
  capExtra: 600,
  /** RTT assumed before the first sample, for the first in-flight cap (the 3G budget RTT). */
  initialRttMs: 300,
  queueHighMs: 150,
  queueHighForMs: 1000,
  queueCalmMs: 60,
  calmForMs: 3000,
  /** Smoothed-RTT gains for a sample above and below the current value. */
  rttGainUp: 0.125,
  rttGainDown: 0.5,
  skipsToStepDown: 3,
  minRttWindowMs: 10_000,
  rateWindowMs: 1000,
  /** Sent frames remembered for RTT samples; older ones are forgotten (counted as acked). */
  ring: 64,
} as const;

interface SentFrame {
  seq: number;
  at: number;
  bytes: number;
}

export const createPacer = (cfg: PacerConfig, nowMs: number): Pacer => {
  const depth = bucketDepth(cfg.budget);
  const refillPerMs = (cfg.budget.downAvg * PACE.bucketRate) / 1000;
  const minIndex = DIVISORS.indexOf(cfg.defaultDivisor);

  let tokens = depth;
  let lastRefill = nowMs;
  let index = minIndex;
  let park: ParkReason | null = null;

  const frames: SentFrame[] = [];
  let inflight = 0;
  let lastAcked: number | null = null;

  let rtt = 0;
  let haveRtt = false;
  // Windowed minimum: the smaller of the current and the previous half-window.
  let minCur = Infinity;
  let minPrev = Infinity;
  let minWindowStart = nowMs;

  let deliveryRate = cfg.budget.downAvg;
  let rateBytes = 0;
  let rateStart = nowMs;
  // After an unpark the rate window restarts at the next call (setPark has no clock).
  let rateRestart = false;

  let lastProgress = nowMs;
  let skips = 0;
  let skippedSinceCalm = false;
  // When the current run of RTT samples over the queueing threshold began.
  let highSince: number | null = null;
  let calmSince: number | null = nowMs;

  const minRtt = (): number => {
    const m = Math.min(minCur, minPrev);
    return Number.isFinite(m) ? m : PACE.initialRttMs;
  };

  const cap = (): number => {
    const value = (deliveryRate * (minRtt() + PACE.capSlackMs)) / 1000 + PACE.capExtra;
    return Math.max(PACE.capMin, Math.min(PACE.capMax, value));
  };

  const refill = (now: number): void => {
    if (now > lastRefill) {
      tokens = Math.min(depth, tokens + (now - lastRefill) * refillPerMs);
      lastRefill = now;
    }
  };

  const rollWindows = (now: number): void => {
    if (now - minWindowStart >= PACE.minRttWindowMs / 2) {
      minPrev = minCur;
      minCur = Infinity;
      minWindowStart = now;
    }
    if (park !== null || rateRestart) {
      // Parked means sending nothing at all: there is no rate to measure, so the estimate is kept
      // for the unpark instead of decaying towards 0 and shutting the cap.
      rateBytes = 0;
      rateStart = now;
      rateRestart = park !== null;
      return;
    }
    const elapsed = now - rateStart;
    if (elapsed >= PACE.rateWindowMs) {
      const sample = (rateBytes * 1000) / elapsed;
      // App-limited senders only lower the estimate slowly, so a quiet second does not shut the cap.
      deliveryRate = sample >= deliveryRate ? 0.5 * deliveryRate + 0.5 * sample : 0.875 * deliveryRate + 0.125 * sample;
      rateBytes = 0;
      rateStart = now;
    }
  };

  const pacer: Pacer = {
    get divisor() {
      return DIVISORS[index] as Divisor;
    },
    get minRttMs() {
      return minRtt();
    },
    get rttMs() {
      return haveRtt ? rtt : PACE.initialRttMs;
    },
    get inflight() {
      return inflight;
    },
    get inflightCap() {
      return cap();
    },
    get park() {
      return park;
    },

    slotDue(tick) {
      const d = DIVISORS[index] as number;
      return ((tick % d) + d) % d === 0;
    },

    admit(now, wireBytes, bufferedAmount) {
      refill(now);
      // The cap is judged on its own, so a slot it refuses counts even when the bucket or the socket
      // backlog refuses it too. Before the first RTT sample the cap is a guess and moves nothing.
      const capped = inflight > 0 && inflight + wireBytes > cap();
      if (!capped) skips = 0;
      else if (haveRtt) skips += 1;
      if (capped || bufferedAmount >= PACE.bufferedMax || tokens < Math.min(wireBytes, depth)) {
        // Any skipped slot means "not calm": the step up needs 3 s with no skips at all.
        skippedSinceCalm = true;
        return false;
      }
      return true;
    },

    sent(now, frameSeq, wireBytes) {
      refill(now);
      tokens = Math.max(0, tokens - wireBytes);
      if (frames.length === 0) lastProgress = Math.max(lastProgress, now);
      frames.push({ seq: frameSeq, at: now, bytes: wireBytes });
      inflight += wireBytes;
      if (frames.length > PACE.ring) {
        const old = frames.shift() as SentFrame;
        inflight = Math.max(0, inflight - old.bytes);
      }
    },

    acked(now, ackFrame, ackDelayMs) {
      if (lastAcked !== null && seqDelta(ackFrame, lastAcked) <= 0) {
        lastProgress = now;
        return;
      }
      let sample: number | null = null;
      let bytes = 0;
      let drop = 0;
      for (let i = 0; i < frames.length; i += 1) {
        const f = frames[i] as SentFrame;
        if (seqDelta(f.seq, ackFrame) > 0) break;
        bytes += f.bytes;
        drop = i + 1;
        if (f.seq === ackFrame) sample = Math.max(1, now - f.at - ackDelayMs);
      }
      if (drop > 0) frames.splice(0, drop);
      inflight = Math.max(0, inflight - bytes);
      rateBytes += bytes;
      lastAcked = ackFrame;
      lastProgress = now;
      rollWindows(now);
      if (sample !== null) {
        rtt = haveRtt ? rtt + (sample > rtt ? PACE.rttGainUp : PACE.rttGainDown) * (sample - rtt) : sample;
        haveRtt = true;
        if (sample < minCur) minCur = sample;
        if (sample - minRtt() > PACE.queueHighMs) {
          if (highSince === null) highSince = now;
        } else highSince = null;
      }
    },

    upProgress(now) {
      lastProgress = now;
    },

    setPark(reason) {
      park = reason;
      if (reason !== null) {
        // Nothing outstanding counts any more: the next thing this recipient gets is a keyframe.
        frames.length = 0;
        inflight = 0;
        skips = 0;
        highSince = null;
      } else {
        calmSince = null;
        rateRestart = true;
      }
    },

    poll(now) {
      rollWindows(now);
      if (park === null && frames.length > 0 && now - lastProgress > cfg.stallMs) return 'stalled';
      if (park !== null) return 'none';

      const down = (highSince !== null && now - highSince >= PACE.queueHighForMs) || skips >= PACE.skipsToStepDown;
      if (down) {
        highSince = null;
        skips = 0;
        calmSince = null;
        skippedSinceCalm = false;
        if (index < DIVISORS.length - 1) {
          index += 1;
          return 'stepDown';
        }
        return 'none';
      }

      const queueing = haveRtt ? rtt - minRtt() : 0;
      if (queueing < PACE.queueCalmMs && !skippedSinceCalm) {
        if (calmSince === null) calmSince = now;
        if (now - calmSince >= PACE.calmForMs && index > minIndex) {
          index = minIndex;
          calmSince = now;
          return 'stepUp';
        }
      } else {
        calmSince = null;
        skippedSinceCalm = false;
      }
      return 'none';
    },
  };
  return pacer;
};
