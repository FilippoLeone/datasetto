/**
 * The Arcade test harness (plan.md §2.6.5), one import for the platform's and the games' tests.
 *
 * - Virtual time (sim.ts): `lossyLink`, `runScenario`, `deltaFuzz`, `probeRuntime`, `withWallCap`.
 * - Live server (server.ts): `startArcadeServer` boots the real HTTP app, Socket.IO and the action
 *   lane on a free port with a fake clock; `account()`, `socket()`, `joinVoice()` and `lane()` drive it.
 * - `createFakeClock` (clock.ts) and the probe match game (probeGame.ts) for lane and hub tests.
 *
 * Every test file keeps to the 60 s wall cap; scenario runs report their own wall time.
 */
export * from './sim.js';
export { startArcadeServer, type ArcadeTestServer, type TestAccount, type TestLane, type TestSocket } from './server.js';
export { createFakeClock, type FakeClock } from './clock.js';
export { EV_INPUT, probeControl, probeGame, probeLog, resetProbe, type ProbeControl, type ProbeLog } from './probeGame.js';
