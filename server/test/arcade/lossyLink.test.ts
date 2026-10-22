/**
 * The virtual-clock lossy-link simulator (platform.md §15.2, plan.md §3.2 "Link simulator"): the real
 * sender and pacer with a probe runtime shaped like a Fuseyard player (22 B snapshot, about 7 B of
 * events per frame, 4 players), the 147 kbit/s voice flow each way and the chat prober, over one
 * client's bottleneck link. Each scenario runs at most 60 virtual seconds in under 1 s of wall time,
 * all of them in under 5 s.
 *
 * Collapse. The plan's collapse cuts the link left over by voice to 120 kbit/s, as the shaped bench
 * does (its shaper carries only the non-voice share). The lane needs about 18 kbit/s, so that is no
 * squeeze at all: it is checked as such. "Collapse, squeezed" leaves 12 kbit/s after voice (159 kbit/s
 * in all), below what the lane needs at 15 Hz: that is the case that moves the ladder and can overflow.
 * (A link of 120 kbit/s in all cannot carry the 147 kbit/s of voice, and chat then waits seconds behind
 * voice whatever the game does.)
 */
import { afterAll, describe, expect, it } from 'vitest';
import { BUDGETS, LANE_CEILING } from '../../src/arcade/core/net/budget.js';
import { KEY_REASON, TICK_MS, VIS } from '../../src/arcade/core/net/lane.js';
import { PACE } from '../../src/arcade/core/net/pacer.js';
import { mean, percentile, runScenario, windows, withWallCap, type LinkProfile, type Scenario, type ScenarioResult } from './harness/sim.js';

const FUSEYARD = BUDGETS.fuseyard;
const G3: LinkProfile = { downBps: 750_000, upBps: 250_000, rttMs: 300, jitterMs: 50 };
const VOICE = 147_000;
const walls: Record<string, number> = {};

/** Certain failures stop a run at once: a frame gap, an undecodable message, a world mismatch. */
const broken = (r: ScenarioResult): 'fail' | null => (r.gaps + r.decodeErrors + r.worldMismatches > 0 ? 'fail' : null);

const run = (s: Scenario): ScenarioResult => {
  const r = withWallCap(1000, (progress) => runScenario({ ...s, settle: (res, t) => (progress(t), s.settle?.(res, t) ?? broken(res)) }));
  walls[s.name] = r.wallMs;
  expect(r.verdict).not.toBe('fail');
  expect(r.gaps).toBe(0);
  expect(r.decodeErrors).toBe(0);
  expect(r.worldMismatches).toBe(0);
  expect(r.worldChecks).toBeGreaterThan(50);
  return r;
};

const chatMs = (r: ScenarioResult, fromMs = 0, toMs = Infinity): number[] => r.chat.filter((c) => c.t >= fromMs && c.t < toMs).map((c) => c.ms);
const divisorAt = (r: ScenarioResult, t: number): number => [...r.ladder].reverse().find((l) => l.t <= t)?.divisor ?? 2;

/**
 * How the ladder answered queueing after `fromMs`: the first RTT sample over 150 ms, the first step
 * down, and the start of the unbroken run of high samples that step ended (what the pacer reacts to).
 */
const reaction = (r: ScenarioResult, fromMs: number): { firstHigh: number; step: number; runFrom: number } | null => {
  const firstHigh = r.queueing.find((q) => q.t > fromMs && q.q > PACE.queueHighMs);
  if (!firstHigh) return null;
  const step = r.ladder.find((l, i) => i > 0 && l.t >= firstHigh.t && l.divisor > (r.ladder[i - 1]?.divisor ?? 2));
  if (!step) return { firstHigh: firstHigh.t, step: Infinity, runFrom: firstHigh.t };
  let runFrom = step.t;
  for (const q of r.queueing.filter((x) => x.t <= step.t).reverse()) {
    if (q.q <= PACE.queueHighMs) break;
    runFrom = q.t;
  }
  return { firstHigh: firstHigh.t, step: step.t, runFrom };
};

describe('lossy link', () => {
  afterAll(() => {
    const total = Object.values(walls).reduce((a, b) => a + b, 0);
    expect(total, JSON.stringify(walls)).toBeLessThanOrEqual(5000);
  });

  it('Wi-Fi (20 Mbit/s, 30 ms): 15 Hz, chat untouched, typical play inside the Fuseyard budget', () => {
    const r = run({ name: 'wifi', link: { downBps: 20_000_000, upBps: 20_000_000, rttMs: 30, jitterMs: 4 } });
    const fps = windows(r.framesPerSecond, 2, 60);
    expect(mean(fps)).toBeGreaterThanOrEqual(14.8);
    expect(Math.min(...fps)).toBeGreaterThanOrEqual(14);
    expect(r.ladder).toHaveLength(1);
    expect(r.parks).toEqual([]);
    expect(percentile(chatMs(r), 95)).toBeLessThan(40);
    expect(mean(windows(r.downPerSecond, 2, 60))).toBeLessThanOrEqual(FUSEYARD.downAvg);
    expect(Math.max(...r.downPerSecond)).toBeLessThanOrEqual(FUSEYARD.downPeak1s);
    expect(mean(windows(r.upPerSecond, 2, 60))).toBeLessThanOrEqual(FUSEYARD.upAvg);
  });

  it('3G (750 / 250 kbit/s, 300 ± 50 ms), moving all the time: chat p95 < 300 ms, ≥ 13 frames/s, bytes inside the ceilings, game queue ≤ 8 KB', () => {
    const r = run({
      name: '3g',
      link: G3,
      moving: 'always',
      settle: (res) => broken(res) ?? (chatMs(res).filter((ms) => ms >= 300).length > 0.05 * 59 ? 'fail' : null),
    });
    expect(percentile(chatMs(r), 95)).toBeLessThan(300);
    expect(mean(windows(r.framesPerSecond, 2, 60))).toBeGreaterThanOrEqual(13);
    expect(mean(windows(r.downPerSecond, 2, 60))).toBeLessThanOrEqual(LANE_CEILING.downAvgBps);
    expect(Math.max(...r.downPerSecond)).toBeLessThanOrEqual(Math.min(LANE_CEILING.downPeak1s, FUSEYARD.downPeak1s));
    expect(mean(windows(r.upPerSecond, 2, 60))).toBeLessThanOrEqual(Math.min(LANE_CEILING.upAvgBps, FUSEYARD.upAvg));
    expect(Math.max(...r.queuePerSecond)).toBeLessThanOrEqual(8192);
    expect(r.parks).toEqual([]);
    expect(r.voiceDroppedBytes).toEqual({ down: 0, up: 0 });
  });

  it('3G + 1 % head-of-line loss: chat p95 < 450 ms, ≥ 10 frames/s', () => {
    const r = run({ name: '3g-loss', link: { ...G3, loss: 0.01 }, moving: 'always' });
    expect(r.lostSegments).toBeGreaterThan(5);
    expect(percentile(chatMs(r), 95)).toBeLessThan(450);
    expect(mean(windows(r.framesPerSecond, 2, 60))).toBeGreaterThanOrEqual(10);
    expect(Math.max(...r.acks.map((a) => a.ms))).toBeLessThan(2000);
    expect(r.parks).toEqual([]);
  });

  it('collapse to 120 kbit/s for 20 s (the share left by voice, as the bench shapes it): no squeeze, so no step is needed; 15 Hz on; no chat ack over 2 s', () => {
    const r = run({ name: 'collapse', link: G3, changes: [{ atMs: 20_000, link: { downBps: 120_000 + VOICE } }, { atMs: 40_000, link: { downBps: G3.downBps } }] });
    const during = windows(r.framesPerSecond, 21, 40);
    expect(Math.min(...during)).toBeGreaterThanOrEqual(13);
    // The lane never queued 150 ms, so the ladder had nothing to answer.
    expect(reaction(r, 20_000)).toBeNull();
    expect(r.ladder).toHaveLength(1);
    expect(Math.max(...r.acks.map((a) => a.ms))).toBeLessThan(2000);
  });

  it('collapse, squeezed (12 kbit/s left after voice for 20 s): ladder down within 1 s, ≥ 5 frames/s, back to 15 Hz within 5 s, no chat ack over 2 s', () => {
    const R = 40_000;
    const r = run({
      name: 'collapse-squeezed',
      link: G3,
      changes: [{ atMs: 20_000, link: { downBps: 12_000 + VOICE } }, { atMs: R, link: { downBps: G3.downBps } }],
      settle: (res, t) => broken(res) ?? (res.acks.some((a) => a.ms > 2000) ? 'fail' : t >= R + 8000 && divisorAt(res, R + 5000) === 2 ? 'pass' : null),
    });
    const re = reaction(r, 20_000);
    expect(re).not.toBeNull();
    if (!re) return;
    expect(re.step - re.runFrom).toBeLessThanOrEqual(PACE.queueHighForMs + TICK_MS + 1e-6);
    expect(re.step - re.firstHigh).toBeLessThanOrEqual(2000);
    expect(Math.max(...r.ladder.filter((l) => l.t > 20_000 && l.t < R).map((l) => l.divisor))).toBe(6);
    // At least 5 frames/s through the squeeze (d = 6 at worst), or clean overflow parks: each one
    // answered by an unpark keyframe, with no gap and the worlds equal (checked by run()).
    const during = windows(r.framesPerSecond, 21, 40);
    const overflowParks = r.parks.filter((p) => p.park === 'overflow' && p.t > 20_000 && p.t < R + 1000);
    if (overflowParks.length === 0) expect(mean(during)).toBeGreaterThanOrEqual(5);
    for (const p of overflowParks) expect(r.keyframes.some((k) => k.t > p.t && k.reason === KEY_REASON.unpark)).toBe(true);
    // Back at d = 2 within 5 s of the link recovering, and frames at 15 Hz after that.
    const back = r.ladder.filter((l) => l.t > R && l.divisor === 2)[0];
    expect(back).toBeDefined();
    expect((back?.t ?? Infinity) - R).toBeLessThanOrEqual(5000);
    expect(divisorAt(r, R + 5000)).toBe(2);
    expect(Math.min(...windows(r.framesPerSecond, Math.ceil((back?.t ?? R) / 1000) + 1, Math.floor(r.ranMs / 1000)))).toBeGreaterThanOrEqual(14);
    expect(Math.max(...r.acks.map((a) => a.ms))).toBeLessThanOrEqual(2000);
    expect(r.voiceDroppedBytes.down).toBe(0);
  });

  it('10 s tunnel: stalled 2.5 s after the last ACK; the resume costs one keyframe ≤ 512 B; the worlds agree after it', () => {
    const OUT = 20_000;
    const BACK = 30_000;
    const r = run({
      name: 'tunnel',
      link: G3,
      changes: [{ atMs: OUT, link: { downBps: 0, upBps: 0 } }, { atMs: BACK, link: { downBps: G3.downBps, upBps: G3.upBps } }],
      settle: (res, t) => broken(res) ?? (t >= 50_000 && windows(res.framesPerSecond, 47, 50).every((n) => n >= 14) ? 'pass' : null),
    });
    expect(r.stalls).toHaveLength(1);
    const stall = r.stalls[0] as { t: number; quietMs: number };
    expect(stall.quietMs).toBeGreaterThan(2500);
    expect(stall.quietMs).toBeLessThanOrEqual(2500 + TICK_MS + 1e-6);
    expect(stall.t - OUT).toBeLessThanOrEqual(2500 + 300);
    // Nothing reaches the client from the stall to the resume, and no keyframe is spent before it.
    expect(windows(r.framesPerSecond, Math.ceil(stall.t / 1000), BACK / 1000).every((n) => n === 0)).toBe(true);
    expect(r.keyframes.filter((k) => k.t > OUT && k.t < BACK)).toEqual([]);
    const resume = r.keyframes.filter((k) => k.t >= BACK);
    expect(resume.length).toBeGreaterThanOrEqual(1);
    expect(resume[0]?.body).toBeLessThanOrEqual(FUSEYARD.keyframeMax);
    expect(resume[0]?.wire).toBeLessThanOrEqual(FUSEYARD.keyframeMax + 10 + 76);
    // The outage also timed out a chat request (8 s), so "chat first" yields once the link is back
    // and resumes after two good probes: at most one more keyframe, and 15 Hz by 50 s.
    expect(resume.length).toBeLessThanOrEqual(2);
    expect(windows(r.framesPerSecond, 47, 50).every((n) => n >= 14)).toBe(true);
  });

  it('3 s app-socket backlog: yield within 2.5 s, no frames while yielding, resume after 2 probes', () => {
    const AT = 20_000;
    let resumedAt: number | null = null;
    const r = run({
      name: 'backlog',
      link: G3,
      mainBacklog: [{ atMs: AT, ms: 3000 }],
      settle: (res, t) => {
        if (broken(res)) return 'fail';
        resumedAt ??= res.parks.find((p) => p.t > AT && p.park === null)?.t ?? null;
        return resumedAt !== null && t >= resumedAt + 4000 ? 'pass' : null;
      },
    });
    const y = r.parks.find((p) => p.t > AT && p.park === 'yield');
    expect(y).toBeDefined();
    expect((y?.t ?? Infinity) - AT).toBeLessThanOrEqual(2500);
    const resume = r.parks.find((p) => p.t > (y?.t ?? 0) && p.park === null);
    expect(resume).toBeDefined();
    if (!y || !resume) return;
    expect(windows(r.framesPerSecond, Math.ceil(y.t / 1000), Math.floor(resume.t / 1000)).every((n) => n === 0)).toBe(true);
    // The client yielded on the slow ack, and resumed after two probes under 600 ms.
    const yieldVis = r.vis.find((v) => v.state === VIS.yield);
    const liveVis = r.vis.find((v) => v.state === VIS.live && v.t > (yieldVis?.t ?? Infinity));
    expect(yieldVis).toBeDefined();
    expect(liveVis).toBeDefined();
    const before = r.probes.filter((p) => p.t > (yieldVis?.t ?? 0) && p.t < (liveVis?.t ?? 0));
    expect(before.length).toBeGreaterThanOrEqual(2);
    expect(before.slice(-2).every((p) => p.ms !== null && p.ms < 600)).toBe(true);
    expect(resume.t).toBeGreaterThanOrEqual(liveVis?.t ?? Infinity);
    expect(resume.t - (liveVis?.t ?? 0)).toBeLessThanOrEqual(1000);
    expect(r.keyframes.filter((k) => k.t >= resume.t)[0]?.reason).toBe(KEY_REASON.unpark);
    expect(windows(r.framesPerSecond, Math.ceil(resume.t / 1000) + 1, Math.floor(r.ranMs / 1000)).every((n) => n >= 14)).toBe(true);
  });
});
