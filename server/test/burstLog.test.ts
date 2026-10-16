import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBurstLogger } from '../src/socket/burstLog.js';

describe('burst logger', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (options: { windowMs?: number; maxWindowMs?: number } = {}) => {
    const log = { info: vi.fn(), debug: vi.fn() };
    const bursts = createBurstLogger({ log, windowMs: 200, maxWindowMs: 1000, ...options });
    return { log, bursts };
  };

  it('writes a lone event as the usual line once the window is quiet', () => {
    const { log, bursts } = make();
    bursts.record('socket connected', { socketId: 's1', ip: '10.0.0.1' }, '10.0.0.1');
    expect(log.info).not.toHaveBeenCalled();
    expect(bursts.pending('socket connected')).toBe(1);
    vi.advanceTimersByTime(200);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith({ socketId: 's1', ip: '10.0.0.1' }, 'socket connected');
    expect(log.debug).not.toHaveBeenCalled();
    expect(bursts.pending('socket connected')).toBe(0);
  });

  it('folds a reconnect wave into one line and keeps the detail at debug', () => {
    const { log, bursts } = make();
    for (let i = 0; i < 5; i += 1) {
      bursts.record('socket connected', { socketId: 's' + i, ip: '10.0.0.' + (i % 2) }, '10.0.0.' + (i % 2));
      vi.advanceTimersByTime(50);
    }
    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(200);
    expect(log.info).toHaveBeenCalledTimes(1);
    const [fields, message] = log.info.mock.calls[0];
    expect(message).toBe('socket connected (5 in a burst)');
    expect(fields).toMatchObject({ burst: 5, distinct: 2, firstSocketId: 's0' });
    expect(fields.durationMs).toBeGreaterThanOrEqual(400);
  });

  it('writes a never-ending stream of events at the latest after the maximum window, per kind', () => {
    const { log, bursts } = make({ windowMs: 200, maxWindowMs: 500 });
    for (let i = 0; i < 20; i += 1) {
      bursts.record('socket connected', { socketId: 'c' + i });
      bursts.record('socket disconnected', { socketId: 'd' + i }, 'transport close');
      vi.advanceTimersByTime(100);
    }
    // 2 s of steady events: a line every 500 ms for each kind.
    const messages = log.info.mock.calls.map(([, message]) => message as string);
    expect(messages.filter((message) => message.startsWith('socket connected'))).toHaveLength(4);
    expect(messages.filter((message) => message.startsWith('socket disconnected'))).toHaveLength(4);
    expect(log.info.mock.calls[0][0]).toMatchObject({ burst: 5 });
  });

  it('flushes what is pending on demand (shutdown)', () => {
    const { log, bursts } = make();
    bursts.record('authenticated', { socketId: 's1', accountId: 'a1' }, 'a1');
    bursts.record('authenticated', { socketId: 's2', accountId: 'a1' }, 'a1');
    bursts.flush();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0][0]).toMatchObject({ burst: 2, distinct: 1 });
    vi.advanceTimersByTime(5000);
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});
