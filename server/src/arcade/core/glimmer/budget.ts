/**
 * Glimmerhall's table-lane budget per hall member (glimmerhall.md §11, plan.md §2.6.8), owned by the
 * Glimmerhall package. Worst sustained 3.9 kbit/s down, 2.4 up; ≤ 2.1 KB in any second.
 */
import type { TableBudget } from '../net/budget.js';

export const BUDGET: TableBudget = {
  downAvg: 485,
  downPeak1s: 2100,
  upAvg: 301,
};
