/**
 * Wall-clock caps for test runs (plan.md §3.0: no run exceeds its cap; one that hits it fails and says
 * how far it got, and never keeps running).
 */

/**
 * Runs `fn` and fails if it takes longer than `ms` of wall time. `fn` reports its progress (schedules
 * done, virtual ms simulated, …) through the callback; each report checks the clock, so a run over the
 * cap stops at its next report with `over the N ms wall cap after <progress> …`. A run that never
 * reports is checked once at the end.
 */
export const withWallCap = <T>(ms: number, fn: (progress: (n: number) => void) => T): T => {
  const t0 = performance.now();
  let done = 0;
  const over = (): Error => new Error(`over the ${ms} ms wall cap after ${done} (${Math.round(performance.now() - t0)} ms)`);
  const result = fn((n) => {
    done = n;
    if (performance.now() - t0 > ms) throw over();
  });
  if (performance.now() - t0 > ms) throw over();
  return result;
};
