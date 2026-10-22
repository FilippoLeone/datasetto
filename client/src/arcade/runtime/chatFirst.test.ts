import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatFirstGuard } from './chatFirst';

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

/** A guard over a fake main socket: probes answer after `latency` ms (null: never). */
const setup = (o: { lastRequestAt?: () => number } = {}) => {
  const probes: number[] = [];
  const yields: boolean[] = [];
  const ackCbs = new Set<(ms: number) => void>();
  let latency: number | null = 50;
  const guard = createChatFirstGuard({
    probe: () => {
      probes.push(performance.now());
      const ms = latency;
      const sent = performance.now();
      return new Promise<number>((resolve) => {
        if (ms !== null) setTimeout(() => resolve(performance.now() - sent), ms);
      });
    },
    onAck: (cb) => {
      ackCbs.add(cb);
      return () => ackCbs.delete(cb);
    },
    lastRequestAt: o.lastRequestAt ?? (() => 0),
    onYield: (y) => yields.push(y),
  });
  return {
    guard,
    probes,
    yields,
    ackCbs,
    ack: (ms: number) => ackCbs.forEach((cb) => cb(ms)),
    setLatency: (ms: number | null) => {
      latency = ms;
    },
  };
};

describe('createChatFirstGuard', () => {
  it('probes after 5 s without a request, at most one per 5 s', async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(4999);
    expect(t.probes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.probes).toEqual([5000]);
    await vi.advanceTimersByTimeAsync(60_000 - 5000);
    // 60 s: probes at 5, 10, … 60 s, never closer than 5 s.
    expect(t.probes.length).toBeLessThanOrEqual(12);
    for (let i = 1; i < t.probes.length; i += 1) expect((t.probes[i] as number) - (t.probes[i - 1] as number)).toBeGreaterThanOrEqual(5000);
    expect(t.yields).toEqual([]);
    t.guard.dispose();
  });

  it('does not probe while requests go out on the main socket', async () => {
    let last = 0;
    const t = setup({ lastRequestAt: () => last });
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(3000);
      last = performance.now();
    }
    expect(t.probes).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.probes).toEqual([last + 5000]);
    t.guard.dispose();
  });

  it('yields on an ack over 2,000 ms, probes every 2 s, resumes after two probes under 600 ms', async () => {
    const t = setup();
    t.ack(1999);
    expect(t.yields).toEqual([]);
    t.ack(2400);
    expect(t.yields).toEqual([true]);
    expect(t.guard.yielding).toBe(true);
    t.setLatency(700);
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.probes).toEqual([2000]);
    await vi.advanceTimersByTimeAsync(700 + 2000);
    expect(t.probes).toEqual([2000, 4700]);
    // 700 ms is not good enough; then one good probe, a slow one (resets the run), and two good ones.
    t.setLatency(100);
    await vi.advanceTimersByTimeAsync(700 + 2000);
    expect(t.yields).toEqual([true]);
    t.setLatency(800);
    await vi.advanceTimersByTimeAsync(100 + 2000);
    t.setLatency(100);
    await vi.advanceTimersByTimeAsync(800 + 2000);
    expect(t.yields).toEqual([true]);
    await vi.advanceTimersByTimeAsync(100 + 2000 + 100);
    expect(t.yields).toEqual([true, false]);
    expect(t.guard.yielding).toBe(false);
    // Back to the idle rate: the next probe 5 s after the last one.
    const lastProbe = t.probes[t.probes.length - 1] as number;
    expect(lastProbe).toBe(14_400);
    await vi.advanceTimersByTimeAsync(lastProbe + 5000 - performance.now() - 1);
    expect(t.probes[t.probes.length - 1]).toBe(lastProbe);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.probes[t.probes.length - 1]).toBe(lastProbe + 5000);
    t.guard.dispose();
  });

  it('yields when a probe has no answer after 3 s, and ignores the late answer', async () => {
    const t = setup();
    t.setLatency(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.probes).toEqual([5000]);
    await vi.advanceTimersByTimeAsync(2999);
    expect(t.yields).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.yields).toEqual([true]);
    // The next probe 2 s after the timeout; the first probe's late answer (at 10 s) changes nothing.
    t.setLatency(null);
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.probes).toEqual([5000, 10_000]);
    expect(t.yields).toEqual([true]);
    t.guard.dispose();
  });

  it('dispose leaves no timer and no ack listener', async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(5100);
    expect(t.probes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    t.guard.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(t.ackCbs.size).toBe(0);
    t.ack(5000);
    expect(t.yields).toEqual([]);
  });
});
