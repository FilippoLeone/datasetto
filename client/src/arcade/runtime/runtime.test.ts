import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fitCanvas } from './canvas';
import { createLoop } from './loop';
import { frames } from './p0';
import { createPracticeWallet, PRACTICE_REFILL } from './practiceWallet';
import { readLocal, writeLocal } from './store';
import { installFakeFrames, type FakeFrames } from './testing';

let fake: FakeFrames;
beforeEach(() => {
  fake = installFakeFrames();
});
afterEach(() => {
  fake.restore();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('frames (phase 0 shim)', () => {
  it('requests nothing with no subscriber and caps the rate', () => {
    expect(frames.active).toBe(0);
    expect(fake.pending).toBe(0);
    let calls = 0;
    const off = frames.add(() => (calls += 1), { maxFps: 60 });
    fake.advance(1000, 240);
    expect(calls).toBeLessThanOrEqual(61);
    expect(calls).toBeGreaterThanOrEqual(55);
    off();
    expect(frames.active).toBe(0);
    expect(fake.pending).toBe(0);
  });

  const countRequests = (): { readonly n: number } => {
    const inner = window.requestAnimationFrame;
    const counter = { n: 0 };
    window.requestAnimationFrame = (cb) => {
      counter.n += 1;
      return inner(cb);
    };
    return counter;
  };

  it('paces a 60 fps cap on a 240 Hz display with a timer and one frame request per call', () => {
    const requests = countRequests();
    let calls = 0;
    const off = frames.add(() => (calls += 1), { maxFps: 60 });
    fake.advance(1000, 240);
    expect(calls).toBeGreaterThanOrEqual(55);
    expect(calls).toBeLessThanOrEqual(61);
    // A request on every refresh would be about 240; pacing needs about one per call (plus a few
    // back-to-back frames to measure the display, and an occasional early wake-up).
    expect(requests.n).toBeLessThan(100);
    off();
    expect(fake.pending).toBe(0);
  });

  it('keeps one request per refresh when the cap is the display rate, or a subscriber is uncapped', () => {
    const requests = countRequests();
    let capped = 0;
    const off = frames.add(() => (capped += 1), { maxFps: 60 });
    fake.advance(1000, 60);
    expect(capped).toBeGreaterThanOrEqual(58);
    expect(requests.n).toBeGreaterThanOrEqual(58);
    off();
    // On a 240 Hz display a capped game is paced until an uncapped subscriber joins.
    let paced = 0;
    let full = 0;
    const offPaced = frames.add(() => (paced += 1), { maxFps: 60 });
    fake.advance(500, 240);
    const offFull = frames.add(() => (full += 1));
    fake.advance(500, 240);
    expect(full).toBeGreaterThanOrEqual(115);
    expect(paced).toBeGreaterThanOrEqual(55);
    expect(paced).toBeLessThanOrEqual(61);
    offPaced();
    offFull();
    expect(frames.active).toBe(0);
    expect(fake.pending).toBe(0);
  });
});

describe('createLoop', () => {
  it('draws once when dirty, then schedules nothing', () => {
    const draw = vi.fn();
    const loop = createLoop({ draw });
    fake.advance(17);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(loop.running).toBe(false);
    fake.advance(500);
    expect(draw).toHaveBeenCalledTimes(1);
    loop.markDirty();
    fake.advance(34);
    expect(draw).toHaveBeenCalledTimes(2);
    loop.dispose();
    expect(frames.active).toBe(0);
  });

  it('runs while animating and stops while hidden', () => {
    const draw = vi.fn();
    const loop = createLoop({ draw });
    loop.animate(true);
    fake.advance(1000);
    const drawn = draw.mock.calls.length;
    expect(drawn).toBeGreaterThan(50);
    loop.setVisible(false);
    expect(loop.running).toBe(false);
    fake.advance(1000);
    expect(draw.mock.calls.length).toBe(drawn);
    loop.setVisible(true);
    fake.advance(100);
    expect(draw.mock.calls.length).toBeGreaterThan(drawn);
    loop.dispose();
    expect(frames.active).toBe(0);
  });

  it('steps a sim at 30 Hz with at most 4 steps per frame', () => {
    let steps = 0;
    const alphas: number[] = [];
    const loop = createLoop({ draw: (_now, alpha) => alphas.push(alpha), step: { fn: () => (steps += 1) } });
    fake.advance(1000);
    expect(steps).toBeGreaterThanOrEqual(28);
    expect(steps).toBeLessThanOrEqual(31);
    expect(alphas.every((a) => a >= 0 && a < 1)).toBe(true);
    const before = steps;
    fake.advance(1000, 1);
    expect(steps - before).toBeLessThanOrEqual(4);
    loop.dispose();
    expect(frames.active).toBe(0);
  });
});

describe('fitCanvas', () => {
  it('prefers whole device pixels when they fill 85 % of the space', () => {
    const fit = fitCanvas(500, 500, 1, { logicalW: 240, logicalH: 224, mode: 'pixelated' });
    expect(fit.metrics.integer).toBe(true);
    expect(fit.metrics.cssW).toBe(480);
    expect(fit.backingW).toBe(240);
    const fractional = fitCanvas(400, 400, 1, { logicalW: 240, logicalH: 224, mode: 'pixelated' });
    expect(fractional.metrics.integer).toBe(false);
    expect(fractional.metrics.cssW).toBeCloseTo(400, 0);
  });

  it('caps the DPR for blit and scales the backing store', () => {
    const fit = fitCanvas(480, 448, 4, { logicalW: 240, logicalH: 224, mode: 'blit', dprCap: 3 });
    expect(fit.metrics.dpr).toBe(3);
    expect(fit.transform).toBe(6);
    expect(fit.backingW).toBe(1440);
    const hd = fitCanvas(400, 300, 2, { logicalW: 400, logicalH: 300, mode: 'hd' });
    expect(hd.metrics.integer).toBe(false);
    expect(hd.backingW).toBe(800);
  });
});

describe('store and practice wallet', () => {
  it('falls back to memory when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(writeLocal('datasetto.arcade.test.v1', { a: 1 })).toBe(false);
    expect(readLocal('datasetto.arcade.test.v1', (v) => v as { a: number })).toEqual({ a: 1 });
    const wallet = createPracticeWallet('datasetto.arcade.practice.test');
    expect(wallet.balance()).toBe(PRACTICE_REFILL);
    expect(wallet.debit(400, 'x')).toBe(true);
    expect(wallet.balance()).toBe(PRACTICE_REFILL - 400);
  });

  it('debits, credits, refills below the minimum bet and notifies', () => {
    const wallet = createPracticeWallet('datasetto.arcade.practice.a');
    const seen: number[] = [];
    const off = wallet.onChange((bal) => seen.push(bal));
    expect(wallet.debit(20_000, 'x')).toBe(false);
    expect(wallet.debit(9_900, 'x')).toBe(true);
    wallet.credit(50, 'y');
    expect(wallet.balance()).toBe(150);
    expect(wallet.refill(400)).toBe(true);
    expect(wallet.balance()).toBe(PRACTICE_REFILL);
    expect(wallet.refill(400)).toBe(false);
    off();
    expect(seen).toEqual([100, 150, PRACTICE_REFILL]);
  });

  it('restores open escrow on the next start', () => {
    const key = 'datasetto.arcade.practice.b';
    const first = createPracticeWallet(key);
    first.escrow('lamplight:local:1', 2_000);
    expect(first.balance()).toBe(8_000);
    // The page closes mid-hand; the next start returns the stack to the balance.
    const second = createPracticeWallet(key);
    expect(second.balance()).toBe(PRACTICE_REFILL);
    second.escrow('t', 500);
    expect(second.release('t')).toBe(500);
    expect(second.release('t')).toBe(0);
  });
});
