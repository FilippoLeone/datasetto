import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forEachEvent } from '@arcade/core/net/events';
import type { FrameView, KeyframeView, PhaseView, Welcome } from '@arcade/core/net/lane';
import { frames } from '../p0';
import { createProbeCore, installFakeFrames, type FakeFrames } from '../testing';
import type { LocalTableServer, SeatInfo } from '../types';
import { createLocalMatchHost, createLocalTableHost } from './localHost';

const seats: SeatInfo[] = [
  { slot: 0, accountId: null, name: 'You', bot: false, joinOrder: 0, extra: 0 },
  { slot: 1, accountId: null, name: 'Bot 1', bot: true, joinOrder: 1, extra: 0 },
];

let fake: FakeFrames;
beforeEach(() => {
  fake = installFakeFrames();
});
afterEach(() => {
  fake.restore();
});

const collect = (host: ReturnType<typeof createLocalMatchHost>) => {
  const log: { welcome: Welcome[]; frames: { tick: number; snap: number; events: number[]; seats: string[]; divisor: number; local: boolean }[]; keyframes: KeyframeView['reason'][]; phases: number[]; closed: string[] } = {
    welcome: [],
    frames: [],
    keyframes: [],
    phases: [],
    closed: [],
  };
  host.onWelcome((w) => log.welcome.push(w));
  host.onFrame((f: FrameView) => {
    const events: number[] = [];
    const seatEvents: string[] = [];
    if (f.events) {
      forEachEvent(
        f.events,
        (kind, r) => {
          events.push(kind, r.u8());
          return true;
        },
        (e) => {
          if (e.k === 'seat') seatEvents.push(e.slot + ':' + e.state);
        },
      );
    }
    log.frames.push({ tick: f.tick, snap: f.snapshot?.remaining ?? -1, events, seats: seatEvents, divisor: f.divisor, local: f.local });
  });
  host.onKeyframe((k) => log.keyframes.push(k.reason));
  host.onPhase((p: PhaseView) => log.phases.push(p.phase));
  host.onClosed((code, reason) => log.closed.push(code + ' ' + reason));
  return log;
};

describe('createLocalMatchHost', () => {
  it('welcomes, sends a join keyframe, then one frame per tick with divisor 1', () => {
    const core = createProbeCore({ snapshotBytes: 5, eventsPerTick: 1 });
    const host = createLocalMatchHost(core, { selfSlot: 0, seats });
    const log = collect(host);
    fake.advance(17);
    expect(log.welcome).toHaveLength(1);
    expect(log.welcome[0]?.cfg).toEqual(new Uint8Array([1, 2, 3]));
    expect(log.keyframes).toEqual([0]);
    fake.advance(1000);
    expect(core.steps).toBeGreaterThanOrEqual(28);
    expect(core.steps).toBeLessThanOrEqual(31);
    expect(log.frames).toHaveLength(core.steps);
    expect(log.frames.every((f) => f.local && f.divisor === 1 && f.snap === 5)).toBe(true);
    expect(log.frames[0]?.events).toEqual([1, 1]);
    host.close();
    expect(frames.active).toBe(0);
  });

  it('runs at most 4 steps per frame and drops the backlog after a stall', () => {
    const core = createProbeCore();
    const host = createLocalMatchHost(core, { selfSlot: 0, seats });
    collect(host);
    fake.advance(17);
    const before = core.steps;
    // One frame 2 s late: at most 4 steps, then no catch-up.
    fake.advance(2000, 0.5);
    expect(core.steps - before).toBeLessThanOrEqual(4);
    host.close();
  });

  it('turns host events into SeatState, phases after the frame, keyframes on rekey and closes on end', () => {
    const core = createProbeCore({ eventsPerTick: 0 });
    core.script(2, [{ t: 'seat', slot: 1, state: 'bot' }, { t: 'phase', phase: 2, reason: 0, body: new Uint8Array(0) }]);
    core.script(3, [{ t: 'rekey', slot: 0, reason: 4, view: 7 }]);
    core.script(4, [{ t: 'end', reason: 'done', result: null }]);
    const host = createLocalMatchHost(core, { selfSlot: 0, seats });
    const log = collect(host);
    fake.advance(500);
    expect(log.frames[1]?.seats).toEqual(['1:2']);
    expect(log.phases).toEqual([2]);
    expect(log.keyframes).toEqual([0, 4]);
    expect(log.closed).toEqual(['1000 done']);
    expect(core.steps).toBe(4);
    expect(frames.active).toBe(0);
    host.close();
  });

  it('pauses while hidden and passes inputs through with their sequence', () => {
    const core = createProbeCore();
    const host = createLocalMatchHost(core, { selfSlot: 0, seats });
    collect(host);
    fake.advance(100);
    host.setVisible(false);
    expect(frames.active).toBe(0);
    const steps = core.steps;
    fake.advance(1000);
    expect(core.steps).toBe(steps);
    host.setVisible(true);
    fake.advance(100);
    expect(core.steps).toBeGreaterThan(steps);
    host.sendUp(new Uint8Array([9]), 41);
    host.sendUp(new Uint8Array([8]));
    host.sendEvent(new Uint8Array([5, 6]));
    expect(core.ups.map((u) => u.upSeq)).toEqual([41, 42]);
    expect(core.events[0]?.payload).toEqual(new Uint8Array([5, 6]));
    expect(host.estServerTick(0)).toBeGreaterThanOrEqual(core.tick);
    let seen: readonly SeatInfo[] = [];
    host.onSeats((s) => (seen = s));
    expect(seen).toEqual(seats);
    host.close();
    expect(frames.active).toBe(0);
  });
});

describe('createLocalTableHost', () => {
  it('wraps a LocalTableServer and disposes it on close', async () => {
    let emit: ((ev: string, data: unknown) => void) | null = null;
    const calls: string[] = [];
    const server: LocalTableServer = {
      request: async (ev, data) => ({ ok: true, ev, data }),
      attach: (fn) => {
        emit = fn;
      },
      setVisible: (v) => calls.push('visible ' + v),
      dispose: () => calls.push('dispose'),
    };
    const host = createLocalTableHost(server);
    expect(host.mode).toBe('local');
    expect(await host.request('lamplight:act', { a: 1 })).toEqual({ ok: true, ev: 'lamplight:act', data: { a: 1 } });
    const got: unknown[] = [];
    const off = host.on('lamplight:hand', (d) => got.push(d));
    emit!('lamplight:hand', 1);
    off();
    emit!('lamplight:hand', 2);
    expect(got).toEqual([1]);
    host.setVisible(false);
    host.close();
    expect(calls).toEqual(['visible false', 'dispose']);
    await expect(host.request('x', null)).rejects.toThrow();
  });
});
