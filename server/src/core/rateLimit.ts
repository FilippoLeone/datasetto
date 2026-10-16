/**
 * Fixed-window rate limiter. Small and allocation-light; good enough for a
 * server with tens of users. Keys are pruned lazily and on a timer.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    autoPrune = true,
  ) {
    if (autoPrune) {
      this.timer = setInterval(() => this.prune(), Math.max(windowMs, 10_000));
      this.timer.unref?.();
    }
  }

  hit(key: string, now = Date.now()): RateLimitResult {
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    const allowed = window.count <= this.max;
    return {
      allowed,
      remaining: Math.max(0, this.max - window.count),
      retryAfterMs: allowed ? 0 : window.resetAt - now,
    };
  }

  reset(key: string): void {
    this.windows.delete(key);
  }

  prune(now = Date.now()): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.windows.clear();
  }
}
