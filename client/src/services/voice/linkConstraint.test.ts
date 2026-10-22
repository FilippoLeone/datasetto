import { signal } from '@preact/signals';
import { describe, expect, it } from 'vitest';
import type { DataSaverVoice } from '@/state/settings';
import {
  CALL_BANDWIDTH_HOLD_MS,
  CALL_BANDWIDTH_RETEST_MAX_MS,
  CALL_BANDWIDTH_RETEST_MS,
  createLinkConstraint,
  type ConnectionInfo,
  type LinkReason,
} from './linkConstraint';

/** A `navigator.connection` stand-in whose fields the test changes. */
const fakeConnection = (initial: Partial<ConnectionInfo>) => {
  const listeners = new Set<() => void>();
  const connection = {
    ...initial,
    addEventListener: (_type: 'change', listener: () => void) => listeners.add(listener),
    set(next: Partial<ConnectionInfo>) {
      Object.assign(this, { type: undefined, effectiveType: undefined, saveData: undefined, downlink: undefined }, next);
      listeners.forEach((listener) => listener());
    },
  };
  return connection;
};

const setup = (connection: Partial<ConnectionInfo> | null = { effectiveType: '4g', downlink: 10 }, choice: DataSaverVoice = 'auto') => {
  const fake = connection ? fakeConnection(connection) : null;
  const preference = signal<DataSaverVoice>(choice);
  const link = createLinkConstraint({ connection: fake, preference });
  return { fake, preference, link };
};

describe('link constraint: the connection', () => {
  const matrix: Array<[Partial<ConnectionInfo>, LinkReason | null]> = [
    [{ type: 'cellular', effectiveType: '4g', downlink: 10 }, 'cellular'],
    [{ type: 'wifi', effectiveType: '4g', downlink: 10 }, null],
    [{ effectiveType: 'slow-2g' }, 'slow-network'],
    [{ effectiveType: '2g' }, 'slow-network'],
    [{ effectiveType: '3g', downlink: 10 }, 'slow-network'],
    [{ effectiveType: '4g', downlink: 10 }, null],
    [{ effectiveType: '4g', saveData: true, downlink: 10 }, 'save-data'],
    [{ effectiveType: '4g', downlink: 1.9 }, 'low-downlink'],
    [{ effectiveType: '4g', downlink: 2 }, null],
    [{ effectiveType: '4g', downlink: 0 }, null],
    [{}, null],
  ];

  it.each(matrix)('%o gives %s', (connection, reason) => {
    const { link } = setup(connection);
    expect(link.autoReason.value).toBe(reason);
    expect(link.constrained.value).toBe(reason !== null);
  });

  it('follows connection changes', () => {
    const { fake, link } = setup({ type: 'wifi', effectiveType: '4g', downlink: 10 });
    const seen: boolean[] = [];
    const stop = link.constrained.subscribe((value) => seen.push(value));
    fake!.set({ type: 'cellular', effectiveType: '4g', downlink: 10 });
    fake!.set({ type: 'wifi', effectiveType: '4g', downlink: 10 });
    stop();
    expect(seen).toEqual([false, true, false]);
  });

  it('is not constrained without the Network Information API (Safari, Firefox)', () => {
    const { link } = setup(null);
    expect(link.constrained.value).toBe(false);
  });

  it('applies On and Off over the detection', () => {
    const { preference, link } = setup({ type: 'cellular' });
    expect(link.constrained.value).toBe(true);
    preference.value = 'off';
    expect(link.constrained.value).toBe(false);
    expect(link.autoReason.value).toBe('cellular');
    preference.value = 'on';
    const fast = setup({ effectiveType: '4g', downlink: 10 }, 'on');
    expect(fast.link.constrained.value).toBe(true);
  });
});

describe('link constraint: the call bandwidth', () => {
  // A 4-person call at 128 kbps on a 250 kbps uplink: three senders need 3 x 153 kbps.
  const low = { estimate: 250_000, need: 459_000 };
  const fine = { estimate: 900_000, need: 459_000 };

  /** Feed one sample every 2 s (the stats poll) from `start`; returns the time after the last. */
  const feed = (link: ReturnType<typeof setup>['link'], sample: typeof low | null, count: number, start: number) => {
    let now = start;
    for (let i = 0; i < count; i += 1) {
      link.reportCallBandwidth(sample, now);
      now += 2000;
    }
    return now;
  };

  it('trips once the estimate stays below the need for 5 s, not before', () => {
    const { link } = setup();
    link.reportCallBandwidth(low, 0);
    link.reportCallBandwidth(low, 2000);
    link.reportCallBandwidth(low, 4000);
    expect(link.constrained.value).toBe(false);
    link.reportCallBandwidth(low, CALL_BANDWIDTH_HOLD_MS);
    expect(link.constrained.value).toBe(true);
    expect(link.autoReason.value).toBe('call-bandwidth');
  });

  it('needs the 5 s without a break', () => {
    const { link } = setup();
    link.reportCallBandwidth(low, 0);
    link.reportCallBandwidth(low, 4000);
    link.reportCallBandwidth(fine, 4500);
    link.reportCallBandwidth(low, 6000);
    link.reportCallBandwidth(low, 10_000);
    expect(link.constrained.value).toBe(false);
    link.reportCallBandwidth(low, 11_000);
    expect(link.constrained.value).toBe(true);
  });

  it('never trips on a healthy audio-only call, whose estimate sits near 300 kbps', () => {
    // Measured in Chrome over loopback: 286-442 kbps while sending 128 kbps to one peer.
    const { link } = setup();
    feed(link, { estimate: 300_000, need: 153_000 }, 40, 0);
    expect(link.constrained.value).toBe(false);
  });

  it('lifts the cap for a re-test after 60 s, backs off when it trips again, and resets after a calm period', () => {
    const { link } = setup();
    let now = feed(link, low, 4, 0); // trips at 6 s
    expect(link.constrained.value).toBe(true);
    const trippedAt = now - 2000;

    // Capped: the estimate follows the cap and says nothing, until the re-test.
    link.reportCallBandwidth({ estimate: 90_000, need: 147_000 }, trippedAt + CALL_BANDWIDTH_RETEST_MS - 1);
    expect(link.constrained.value).toBe(true);
    link.reportCallBandwidth({ estimate: 90_000, need: 147_000 }, trippedAt + CALL_BANDWIDTH_RETEST_MS);
    expect(link.constrained.value).toBe(false);

    // Still too slow: it trips again 5 s later, and now waits twice as long.
    now = trippedAt + CALL_BANDWIDTH_RETEST_MS + 2000;
    now = feed(link, low, 4, now);
    expect(link.constrained.value).toBe(true);
    const second = now - 2000;
    link.reportCallBandwidth(low, second + CALL_BANDWIDTH_RETEST_MS);
    expect(link.constrained.value).toBe(true);
    link.reportCallBandwidth(low, second + 2 * CALL_BANDWIDTH_RETEST_MS);
    expect(link.constrained.value).toBe(false);

    // The link got better: 30 s of calm, then a later trip starts again from 60 s.
    now = feed(link, fine, 20, second + 2 * CALL_BANDWIDTH_RETEST_MS + 2000);
    expect(link.constrained.value).toBe(false);
    now = feed(link, low, 4, now);
    expect(link.constrained.value).toBe(true);
    const third = now - 2000;
    link.reportCallBandwidth(low, third + CALL_BANDWIDTH_RETEST_MS);
    expect(link.constrained.value).toBe(false);
  });

  it('caps the back-off at 8 minutes', () => {
    const { link } = setup();
    let now = 0;
    let wait = CALL_BANDWIDTH_RETEST_MS;
    for (let round = 0; round < 6; round += 1) {
      now = feed(link, low, 4, now);
      const tripped = now - 2000;
      expect(link.constrained.value).toBe(true);
      link.reportCallBandwidth(low, tripped + wait - 1);
      expect(link.constrained.value).toBe(true);
      link.reportCallBandwidth(low, tripped + wait);
      expect(link.constrained.value).toBe(false);
      now = tripped + wait + 2000;
      wait = Math.min(wait * 2, CALL_BANDWIDTH_RETEST_MAX_MS);
    }
    expect(wait).toBe(CALL_BANDWIDTH_RETEST_MAX_MS);
  });

  it('ignores the stats while the network or the preference already caps voice, and resets at the end of a call', () => {
    const { fake, preference, link } = setup({ type: 'cellular' });
    feed(link, low, 10, 0);
    expect(link.autoReason.value).toBe('cellular');
    // Back on Wi-Fi: the cap goes at once, the stats start over.
    fake!.set({ type: 'wifi', effectiveType: '4g', downlink: 10 });
    expect(link.constrained.value).toBe(false);

    preference.value = 'off';
    feed(link, low, 10, 100_000);
    expect(link.autoReason.value).toBe(null);
    preference.value = 'auto';

    feed(link, low, 4, 200_000);
    expect(link.constrained.value).toBe(true);
    link.reportCallBandwidth(null, 210_000);
    expect(link.constrained.value).toBe(false);
  });

  it('does not trip on a call without voice senders', () => {
    const { link } = setup();
    feed(link, { estimate: 0, need: 0 }, 10, 0);
    expect(link.constrained.value).toBe(false);
  });
});
