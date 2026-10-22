/**
 * Bellwick's per-client budget (bellwick.md §4.8 and §15, plan.md §2.6.8), owned by the Bellwick package.
 * Player: 19 kbit/s exploring, 22 in a fight, 28 at peak, 32 in the worst window; 16.4 up.
 */
import type { GameBudget } from '../net/budget.js';

export const BUDGET: GameBudget = {
  downAvg: 2750,
  downPeak1s: 4000,
  upAvg: 2050,
  keyframeMax: 384,
  snapshotMax: 91,
  frameTypMax: 256,
  upMax: 16,
  overflowEvents: 1024,
};
