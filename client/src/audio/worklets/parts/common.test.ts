import { describe, expect, it } from 'vitest';
import { ActivityGate, LoadMeter, SampleFifo, frameLevelDb } from './common.js';

const ramp = (n: number, from = 0) => Float32Array.from({ length: n }, (_, i) => from + i);

describe('SampleFifo (128-sample quanta into 480-sample frames)', () => {
  it('hands out whole frames in order and keeps the remainder', () => {
    const fifo = new SampleFifo(480 * 4 + 512);
    const frame = new Float32Array(480);
    let next = 0;
    const frames: number[][] = [];
    for (let q = 0; q < 15; q++) {
      fifo.push(ramp(128, next));
      next += 128;
      while (fifo.length >= 480) {
        expect(fifo.pull(frame)).toBe(true);
        frames.push([frame[0], frame[479]]);
      }
    }
    // 15 quanta = 1920 samples = 4 frames, 0 left over
    expect(frames).toEqual([
      [0, 479],
      [480, 959],
      [960, 1439],
      [1440, 1919],
    ]);
    expect(fifo.length).toBe(0);
    expect(fifo.pull(frame)).toBe(false);
  });

  it('wraps around its storage without corrupting samples', () => {
    const fifo = new SampleFifo(1000);
    const out = new Float32Array(480);
    let next = 0;
    for (let round = 0; round < 50; round++) {
      fifo.push(ramp(128, next));
      next += 128;
      if (fifo.length >= 480) {
        fifo.pull(out);
        for (let i = 1; i < out.length; i++) expect(out[i] - out[i - 1]).toBe(1);
      }
    }
  });

  it('refuses to overflow', () => {
    const fifo = new SampleFifo(200);
    fifo.push(new Float32Array(128));
    expect(() => fifo.push(new Float32Array(128))).toThrow();
    fifo.clear();
    expect(fifo.length).toBe(0);
  });
});

describe('frameLevelDb', () => {
  it('measures RMS in dB', () => {
    expect(frameLevelDb(new Float32Array(480).fill(1))).toBeCloseTo(0, 5);
    expect(frameLevelDb(new Float32Array(480).fill(0.1))).toBeCloseTo(-20, 5);
    expect(frameLevelDb(new Float32Array(480))).toBeLessThan(-100);
  });
});

const GATE = { openThreshold: 0.6, closeThreshold: 0.35, openFrames: 1, holdFrames: 20, lookaheadFrames: 2, releaseFrames: 5, closedGain: 0.03, keptWithinDb: 15 };
const loud = new Float32Array(480).fill(0.1); // -20 dB
const run = (gate: ActivityGate, steps: Array<[activity: number, inputDb: number]>) =>
  steps.map(([activity, inputDb]) => {
    const out = gate.process(loud, inputDb, activity);
    return Number((out[out.length - 1] / 0.1).toFixed(3)); // gain at the end of the delayed frame
  });

describe('ActivityGate', () => {
  it('starts closed, delays by the lookahead and is open when the first speech frame comes out', () => {
    const gate = new ActivityGate(GATE);
    const gains = run(gate, [
      [0, -20],
      [0, -20],
      [0.9, -20], // speech starts here: it comes out two frames later
      [0.9, -20],
      [0.9, -20],
      [0.9, -20],
    ]);
    expect(gains.slice(0, 2)).toEqual([0, 0]); // nothing out yet (lookahead)
    // The two frames before speech carry the ramp (0.03 -> 0.515 -> 1), so the first speech frame is fully open.
    expect(gains[2]).toBeCloseTo(0.515, 2);
    expect(gains[3]).toBeCloseTo(1, 2);
    expect(gains[4]).toBe(1);
    expect(gains[5]).toBe(1);
  });

  it('holds after speech stops, then closes over releaseFrames', () => {
    const gate = new ActivityGate({ ...GATE, holdFrames: 3, releaseFrames: 2 });
    const steps: Array<[number, number]> = [[0.9, -20], [0.9, -20], [0.9, -20]];
    for (let i = 0; i < 12; i++) steps.push([0, -20]);
    const gains = run(gate, steps);
    // Outputs (delayed by 2): ramp up over the two frames before speech, open through the speech
    // (ending at output index 4), held while the 3 hold frames run down, then a 2-frame release.
    const expected = [0, 0, 0.515, 1, 1, 1, 0.515, 0.03, 0.03, 0.03];
    expected.forEach((value, index) => expect(gains[index]).toBeCloseTo(value, 2));
  });

  it('does not open for frames the model removed, such as keystrokes', () => {
    const gate = new ActivityGate(GATE);
    // Model output is at -20 dB while the input was -2 dB: the model took 18 dB out, more than keptWithinDb.
    const gains = run(gate, [[0.95, -2], [0.95, -2], [0.95, -2], [0.95, -2], [0.95, -2]]);
    expect(Math.max(...gains)).toBeCloseTo(0.03, 2);
    expect(gate.open).toBe(false);
  });

  it('needs openFrames consecutive speech frames and uses hysteresis to stay open', () => {
    const gate = new ActivityGate({ ...GATE, openFrames: 2, holdFrames: 0 });
    gate.process(loud, -20, 0.9); // one frame is not enough
    expect(gate.open).toBe(false);
    gate.process(loud, -20, 0.9);
    expect(gate.open).toBe(true);
    gate.process(loud, -20, 0.5); // between close and open thresholds: stays open
    expect(gate.open).toBe(true);
    gate.process(loud, -20, 0.2);
    expect(gate.open).toBe(false);
  });

  it('can be reconfigured on the fly', () => {
    const gate = new ActivityGate(GATE);
    gate.configure({ closedGain: 0.5 });
    const gains = run(gate, Array.from({ length: 12 }, () => [0, -20] as [number, number]));
    expect(gains[11]).toBeCloseTo(0.5, 2); // the closed gain moved to the new value over releaseFrames
  });
});

describe('LoadMeter', () => {
  it('reports the share of real time once per window', () => {
    const meter = new LoadMeter(4, 10);
    expect(meter.record(1)).toBeNull();
    expect(meter.record(2)).toBeNull();
    expect(meter.record(1)).toBeNull();
    expect(meter.record(4)).toEqual({ load: 0.2, maxFrameMs: 4, frames: 4 });
    expect(meter.record(0)).toBeNull();
  });
});
