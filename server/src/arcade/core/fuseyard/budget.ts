/**
 * Fuseyard's per-client budget (fuseyard.md §3.8, plan.md §2.6.8), owned by the Fuseyard package.
 * Player at d = 2: 17.2 kbit/s down typical, 25.1 worst 1 s, 14.2 up moving.
 */
import type { GameBudget } from '../net/budget.js';

export const BUDGET: GameBudget = {
  downAvg: 2200,
  downPeak1s: 3200,
  upAvg: 1800,
  keyframeMax: 512,
  /** 4 fighters, no sliding bombs; +6 B per sliding bomb. */
  snapshotMax: 22,
  frameTypMax: 256,
  upMax: 9,
  overflowEvents: 1024,
};
