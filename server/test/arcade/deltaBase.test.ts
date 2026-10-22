/**
 * The delta-base rule (platform.md §6.2, plan.md §3.2 "Delta base"): 2,000 seeded schedules of skipped
 * slots, all four park reasons, unparks, reconnects and rekeys through the real sender
 * (server/src/arcade/sender.ts) and the probe runtime. After every keyframe plus the events after it the
 * client world equals the server's public view; frameSeq is consecutive; the first message after an
 * unpark is always a KEYFRAME. The harness (test/arcade/harness/fuzz.ts) throws on the first violation.
 */
import { describe, expect, it } from 'vitest';
import { deltaFuzz, probeDecode, probeEqual, probeRuntime, withWallCap, type DeltaFuzzStats } from './harness/sim.js';

const SCHEDULES = 2000;

describe('delta base', () => {
  it(`holds over ${SCHEDULES} seeded schedules in under 2 s of wall time`, () => {
    let made = 0;
    let stats: DeltaFuzzStats | null = null;
    withWallCap(2000, (progress) =>
      deltaFuzz({
        // Vary the shape per schedule: Fuseyard-sized events most of the time, sometimes heavy ones
        // (so the 1 KB overflow rule trips, not only the 1.5 s age rule), with host rekeys, phases and
        // seat changes at seeded random ticks.
        create: () => {
          made += 1;
          const heavy = made % 5 === 0;
          return probeRuntime({
            snapshotBytes: 22,
            eventBytesPerTick: heavy ? 40 : 2 + (made % 4),
            players: 1 + (made % 4),
            seed: made * 7919,
            rekeyEvery: 90,
            phaseEvery: 70,
            seatEvery: 60,
          });
        },
        schedules: SCHEDULES,
        seed: 0xde17a,
        decode: probeDecode,
        equal: probeEqual,
        progress,
        onStats: (s) => (stats = s),
      }),
    );
    const s = stats as DeltaFuzzStats | null;
    expect(s).not.toBeNull();
    if (!s) return;
    expect(s.schedules).toBe(SCHEDULES);
    // The schedules exercised what they are meant to (about half of what this seed gives).
    expect(s.parks.away).toBeGreaterThan(300);
    expect(s.parks.yield).toBeGreaterThan(300);
    expect(s.parks.stalled).toBeGreaterThan(25);
    expect(s.parks.overflow).toBeGreaterThan(100);
    expect(s.unparks).toBeGreaterThan(500);
    expect(s.reconnects).toBeGreaterThan(300);
    expect(s.rekeys).toBeGreaterThan(800);
    expect(s.phases).toBeGreaterThan(1000);
    expect(s.skippedSlots).toBeGreaterThan(20_000);
    expect(s.worldChecks).toBeGreaterThan(2500);
    expect(s.keyframes).toBeGreaterThan(SCHEDULES);
  });

  it('reports the first violation with its schedule, tick and recent operations', () => {
    // A decoder that drops every event block: the worlds differ as soon as events flow.
    expect(() =>
      deltaFuzz({ create: () => probeRuntime({ snapshotBytes: 22, eventBytesPerTick: 3.5, players: 4, seed: 3 }), schedules: 5, seed: 1, decode: (k) => probeDecode(k, []), equal: probeEqual }),
    ).toThrow(/deltaFuzz: schedule 0 \(seed 1\) at tick \d+: the client world \(keyframe \+ \d+ event blocks\) differs/);
  });
});
