/**
 * Client-side estimate of the server tick from PING/PONG (platform.md §8.4). Floats are fine here:
 * this is rendering support, not a sim. The estimate comes from the sample with the smallest RTT
 * among the last 8, so queueing spikes do not drag the clock.
 */
import { TICK_MS } from './lane.js';

export interface TickClock {
  /** `sentMs` is the PING's clientMs, `nowMs` when the PONG arrived (same clock). */
  onPong(sentMs: number, nowMs: number, serverTick: number, phaseUs: number): void;
  /** Estimated (fractional) server tick at `nowMs`. */
  serverTickAt(nowMs: number): number;
  readonly rttMs: number;
  readonly jitterP90Ms: number;
  readonly ready: boolean;
}

const SAMPLES = 8;

export const createTickClock = (): TickClock => {
  const rtts: number[] = [];
  const anchors: { ms: number; tick: number }[] = [];
  let smoothed = 0;
  let best: { ms: number; tick: number } | null = null;
  let jitter = 0;

  const recompute = (): void => {
    let bestIndex = 0;
    for (let i = 1; i < rtts.length; i += 1) if ((rtts[i] as number) < (rtts[bestIndex] as number)) bestIndex = i;
    best = anchors[bestIndex] ?? null;
    const min = rtts[bestIndex] ?? 0;
    const spread = rtts.map((r) => r - min).sort((a, b) => a - b);
    jitter = spread.length ? (spread[Math.min(spread.length - 1, Math.floor(spread.length * 0.9))] as number) : 0;
  };

  return {
    onPong(sentMs, nowMs, serverTick, phaseUs) {
      const rtt = Math.max(0, nowMs - sentMs);
      // The server read its clock half an RTT ago (assuming a symmetric path).
      const tick = serverTick + phaseUs / (TICK_MS * 1000) + rtt / 2 / TICK_MS;
      rtts.push(rtt);
      anchors.push({ ms: nowMs, tick });
      if (rtts.length > SAMPLES) {
        rtts.shift();
        anchors.shift();
      }
      smoothed = rtts.length === 1 ? rtt : 0.875 * smoothed + 0.125 * rtt;
      recompute();
    },
    serverTickAt(nowMs) {
      if (!best) return 0;
      return best.tick + (nowMs - best.ms) / TICK_MS;
    },
    get rttMs() {
      return smoothed;
    },
    get jitterP90Ms() {
      return jitter;
    },
    get ready() {
      return best !== null;
    },
  };
};
