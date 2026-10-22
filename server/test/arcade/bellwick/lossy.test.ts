/**
 * Lossy link (bellwick.md §13 test 13). Two halves:
 *
 * 1. Bellwick's own traffic in the boss room: four bot heroes fight Old Clapper through 167 ms each way
 *    (a 3G round trip). For the measured hero, every FRAME at the default divisor (one per 2 ticks) is
 *    sized as the lane sends it, and must stay inside the game's budget (§4.8); at least 98 % of all
 *    claims must stand; no hero is ever corrected.
 * 2. The platform's `lossyLink` scenarios (the real sender and pacer, voice and the chat prober) with a
 *    probe shaped like that measured traffic: 3G and 3G + 1 % loss must meet the platform's criteria.
 *    (The scenario runner drives the probe runtime only, so the shape, not the game, crosses the link.)
 */
import { describe, expect, it } from 'vitest';
import { createHeroBot } from '../../../src/arcade/core/bellwick/bots/hero.js';
import { BUDGET } from '../../../src/arcade/core/bellwick/budget.js';
import { fromBase64, KEYFRAME_MAX, SNAPSHOT_MAX } from '../../../src/arcade/core/bellwick/codec.js';
import { flagId } from '../../../src/arcade/core/bellwick/content/flags.js';
import { hasFlag } from '../../../src/arcade/core/bellwick/sim/state.js';
import { BUDGETS, LANE_CEILING, OVERHEAD } from '../../../src/arcade/core/net/budget.js';
import { mean, percentile, runScenario, windows, withWallCap, type LinkProfile, type ScenarioResult } from '../harness/sim.js';
import { botRun, dungeonSave, dungeonScript } from './helpers.js';
import { createPartyRun } from './party.js';

const G3: LinkProfile = { downBps: 750_000, upBps: 250_000, rttMs: 300, jitterMs: 50 };

/** A tale standing in the Belfry's antechamber with the boss door open: the dungeon bot's save there. */
const bossSave = () => {
  const r = botRun(77, { save: dungeonSave(77), script: dungeonScript() });
  const script = dungeonScript();
  const at = script.indexOf('item buckler');
  for (let t = 0; t < 30_000 && r.bot.step < at; t += 1) r.play(1);
  expect(r.bot.step).toBe(at);
  return r.run.core.save();
};

interface Traffic {
  snapP95: number;
  eventsPerTick: number;
  downPerSecond: number[];
  claims: number;
  refused: number;
  corrects: number;
  keyframeMax: number;
  snapMax: number;
  won: boolean;
}

const bossFight = (): Traffic => {
  const save = bossSave();
  const run = createPartyRun({ seed: 77, heroes: 4, save: { data: save, flags: fromBase64(save.flags, 32)! }, delay: 5 });
  // Four bots that start apart (a bot is deterministic: four from one spot would move as one).
  const bots = ['go ante 3,3', 'go ante 8,3', 'go ante 3,6', 'go ante 8,6'].map((first) => createHeroBot([first, 'go ante 5,1', 'item buckler', 'boss']));
  const acts = [0, 1, 2, 3].map((s) => run.actions(s));
  const snaps: number[] = [];
  const perSecond: number[] = [];
  let events = 0;
  let ticks = 0;
  let snapMax = 0;
  let keyframeMax = 0;
  let frameBytes = 0;
  let pendingEvents = 0;
  const core = run.core;
  let inBoss = false;
  for (let t = 0; t < 9000 && !hasFlag(core.world.party, flagId('boss_down')); t += 1) {
    run.step(bots.map((b, s) => (t < s * 45 ? 0 : b.tick(run.clients[s]!, acts[s]!))));
    const r = { slot: 0, view: 0 };
    const roomOf = core.world.rooms[core.world.heroes[0]!.room];
    if (!inBoss) {
      inBoss = roomOf?.boss != null;
      continue;
    }
    // What the lane would send slot 0: a FRAME every 2 ticks with the newest snapshot and both ticks' events.
    const ev = core.takeEvents(r);
    if (ev) pendingEvents += ev.bytes.length;
    events += ev ? ev.bytes.length : 0;
    ticks += 1;
    keyframeMax = Math.max(keyframeMax, core.keyframeFor(r).length);
    if (ticks % 2 === 0) {
      const snap = core.snapshotFor(r);
      const s = snap ? snap.length : 0;
      snaps.push(s);
      snapMax = Math.max(snapMax, s);
      frameBytes += 8 + (snap ? 1 + s : 0) + (pendingEvents > 0 ? 1 + pendingEvents : 0) + OVERHEAD.down;
      pendingEvents = 0;
    }
    if (ticks % 30 === 0) {
      perSecond.push(frameBytes);
      frameBytes = 0;
    }
  }
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
  return {
    snapP95: percentile(snaps, 95),
    eventsPerTick: events / Math.max(1, ticks),
    downPerSecond: perSecond,
    claims: sum(run.stats.claims),
    refused: sum(run.stats.refusedClaims),
    corrects: sum(run.stats.corrects),
    keyframeMax,
    snapMax,
    won: hasFlag(core.world.party, flagId('boss_down')),
  };
};

let traffic: Traffic | null = null;
const measured = (): Traffic => (traffic ??= bossFight());

/** Certain failures stop a run at once. */
const broken = (r: ScenarioResult): 'fail' | null => (r.gaps + r.decodeErrors + r.worldMismatches > 0 ? 'fail' : null);
const chatMs = (r: ScenarioResult): number[] => r.chat.map((c) => c.ms);

describe('Bellwick lossy link', () => {
  it('four heroes in the boss room at 3G stay inside the budget; ≥ 98 % of claims stand; nobody is corrected', () => {
    const m = measured();
    expect(m.won).toBe(true);
    expect(m.corrects).toBe(0);
    expect(m.claims).toBeGreaterThan(30);
    expect(m.refused / m.claims).toBeLessThanOrEqual(0.02);
    expect(m.snapMax).toBeLessThanOrEqual(SNAPSHOT_MAX);
    expect(m.keyframeMax).toBeLessThanOrEqual(KEYFRAME_MAX);
    // §4.8: 22 kbit/s in a fight, ≤ 32 in any second, inside the game's budget and the lane's ceilings.
    expect(mean(m.downPerSecond)).toBeLessThanOrEqual(BUDGET.downAvg);
    expect(Math.max(...m.downPerSecond)).toBeLessThanOrEqual(Math.min(BUDGET.downPeak1s, LANE_CEILING.downPeak1s));
    expect(BUDGET).toEqual(BUDGETS.bellwick);
  });

  const scenario = (name: string, link: LinkProfile): ScenarioResult => {
    const m = measured();
    const r = withWallCap(1000, (progress) =>
      runScenario({
        name,
        link,
        moving: 'always',
        budget: BUDGET,
        skipUnchanged: false,
        probe: { snapshotBytes: Math.max(1, Math.round(m.snapP95)), eventBytesPerTick: m.eventsPerTick, players: 4 },
        settle: (res, t) => (progress(t), broken(res)),
      }),
    );
    expect(r.verdict).not.toBe('fail');
    expect(r.gaps + r.decodeErrors + r.worldMismatches).toBe(0);
    return r;
  };

  it('3G with that traffic: chat p95 < 300 ms, ≥ 13 frames/s, bytes inside the budget and ceilings, no parks', () => {
    const r = scenario('bellwick-3g', G3);
    expect(percentile(chatMs(r), 95)).toBeLessThan(300);
    expect(mean(windows(r.framesPerSecond, 2, 60))).toBeGreaterThanOrEqual(13);
    expect(mean(windows(r.downPerSecond, 2, 60))).toBeLessThanOrEqual(Math.min(LANE_CEILING.downAvgBps, BUDGET.downAvg + 26 * 15));
    expect(Math.max(...r.downPerSecond)).toBeLessThanOrEqual(LANE_CEILING.downPeak1s);
    expect(mean(windows(r.upPerSecond, 2, 60))).toBeLessThanOrEqual(Math.min(LANE_CEILING.upAvgBps, BUDGET.upAvg));
    expect(Math.max(...r.queuePerSecond)).toBeLessThanOrEqual(8192);
    expect(r.parks).toEqual([]);
  });

  it('3G + 1 % loss with that traffic: chat p95 < 450 ms, ≥ 10 frames/s', () => {
    const r = scenario('bellwick-3g-loss', { ...G3, loss: 0.01 });
    expect(r.lostSegments).toBeGreaterThan(5);
    expect(percentile(chatMs(r), 95)).toBeLessThan(450);
    expect(mean(windows(r.framesPerSecond, 2, 60))).toBeGreaterThanOrEqual(10);
    expect(r.parks).toEqual([]);
  });
});
