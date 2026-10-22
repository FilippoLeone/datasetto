/**
 * Lamplight's table-lane budget per seated client (lamplight.md §7.5, plan.md §2.6.8), owned by the
 * Lamplight package. Worst sustained (1 human + 5 bots) 1.9 kbit/s down, 0.44 up; ≤ 3 KB in any second.
 */
import type { TableBudget } from '../net/budget.js';

export const BUDGET: TableBudget = {
  downAvg: 240,
  downPeak1s: 3000,
  upAvg: 55,
};
