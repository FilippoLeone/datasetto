/**
 * The pure (virtual time) half of the Arcade test harness (plan.md §2.6.5). `harness/index.ts`
 * re-exports it next to the live-server half.
 *
 * - `lossyLink`: one client's bottleneck link (link.ts).
 * - `runScenario`: the real sender and the probe runtime over that link against a modelled client,
 *   ≤ 60 virtual seconds in well under 1 s of wall time (scenario.ts).
 * - `deltaFuzz`: seeded schedules through the real sender, checking the delta-base rule (fuzz.ts).
 * - `probeRuntime`: a pure match runtime shaped like an action game (probe.ts).
 * - `withWallCap`: a wall-clock cap that reports progress (wall.ts).
 */
export { deltaFuzz, type DeltaFuzzOptions, type DeltaFuzzStats } from './fuzz.js';
export { lossyLink, type Dir, type LinkProfile, type LinkSim, type Stream } from './link.js';
export { PROBE_EV, probeApply, probeDecode, probeDiff, probeEqual, probeKeyframe, probeRuntime, type ProbeOptions, type ProbeRuntime, type ProbeWorld } from './probe.js';
export { FUSEYARD_PROBE, mean, percentile, runScenario, windows, type Scenario, type ScenarioResult } from './scenario.js';
export { withWallCap } from './wall.js';
