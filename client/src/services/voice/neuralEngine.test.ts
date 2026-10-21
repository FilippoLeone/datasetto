import { describe, expect, it } from 'vitest';
import { chooseInitialEngine, clampStrength, OverloadMonitor, stepDown } from './neuralEngine';

describe('chooseInitialEngine', () => {
  it('uses DeepFilterNet3 on desktops', () => {
    expect(chooseInitialEngine({ phone: false, simd: true })).toBe('deepfilternet3');
    expect(chooseInitialEngine({ phone: false, simd: false })).toBe('deepfilternet3');
  });

  it('starts phones on RNNoise until a benchmark shows headroom', () => {
    expect(chooseInitialEngine({ phone: true, simd: true })).toBe('rnnoise');
    expect(chooseInitialEngine({ phone: true, simd: true, benchmark: null })).toBe('rnnoise');
    expect(chooseInitialEngine({ phone: true, simd: true, benchmark: { engine: 'deepfilternet3', meanMs: 3, p95Ms: 4 } })).toBe('rnnoise');
    expect(chooseInitialEngine({ phone: true, simd: true, benchmark: { engine: 'deepfilternet3', meanMs: 1.2, p95Ms: 6 } })).toBe('rnnoise');
    expect(chooseInitialEngine({ phone: true, simd: true, benchmark: { engine: 'deepfilternet3', meanMs: 1.2, p95Ms: 2.5 } })).toBe('deepfilternet3');
  });

  it('ignores a benchmark of the other engine', () => {
    expect(chooseInitialEngine({ phone: true, simd: true, benchmark: { engine: 'rnnoise', meanMs: 0.5, p95Ms: 0.8 } })).toBe('rnnoise');
  });
});

describe('stepDown', () => {
  it('goes DeepFilterNet3 -> RNNoise -> standard and stays there', () => {
    expect(stepDown('deepfilternet3')).toBe('rnnoise');
    expect(stepDown('rnnoise')).toBe('standard');
    expect(stepDown('standard')).toBe('standard');
  });
});

describe('OverloadMonitor', () => {
  it('trips only after consecutive windows above the limit', () => {
    const monitor = new OverloadMonitor({ maxLoad: 0.7, windows: 3 });
    expect(monitor.record(0.9)).toBe(false);
    expect(monitor.record(0.95)).toBe(false);
    expect(monitor.record(0.3)).toBe(false); // a quiet window resets the count
    expect(monitor.record(0.9)).toBe(false);
    expect(monitor.record(0.9)).toBe(false);
    expect(monitor.record(0.71)).toBe(true);
  });

  it('reports once until reset', () => {
    const monitor = new OverloadMonitor({ maxLoad: 0.5, windows: 1 });
    expect(monitor.record(0.6)).toBe(true);
    expect(monitor.record(0.6)).toBe(false);
    monitor.reset();
    expect(monitor.record(0.6)).toBe(true);
  });

  it('ignores loads that are not numbers', () => {
    const monitor = new OverloadMonitor({ maxLoad: 0.5, windows: 1 });
    expect(monitor.record(Number.NaN)).toBe(false);
    expect(monitor.record(0.4)).toBe(false);
  });
});

describe('clampStrength', () => {
  it('keeps the strength inside the slider range and rounds it', () => {
    expect(clampStrength(25.4)).toBe(25);
    expect(clampStrength(2)).toBe(6);
    expect(clampStrength(99)).toBe(40);
    expect(clampStrength(undefined)).toBe(25);
    expect(clampStrength('12')).toBe(25);
  });
});
