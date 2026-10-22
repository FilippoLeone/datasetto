/**
 * CPU-time caps for Fuseyard's heavier tests. The full suite runs dozens of test files in parallel
 * forks, so wall time there says more about the machine than about the test; this process's own CPU
 * time (user + system) is what the test costs. Vitest's per-test timeout stays the wall backstop.
 */
export const cpuMs = (): number => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

/** Runs `fn`, failing once it has used more than `ms` of CPU (checked at each `progress` call and at the end). */
export const withCpuCap = <T>(ms: number, fn: (progress: (n: number) => void) => T): T => {
  const c0 = cpuMs();
  let done = 0;
  const over = (): Error => new Error(`over the ${ms} ms CPU cap after ${done} (${Math.round(cpuMs() - c0)} ms)`);
  const result = fn((n) => {
    done = n;
    if (cpuMs() - c0 > ms) throw over();
  });
  if (cpuMs() - c0 > ms) throw over();
  return result;
};
