/**
 * "Chat first", client side (docs/arcade/platform.md §6.4). Exists only while an action lane is open.
 *
 * - With no main-socket request for 5 s it sends a probe, at most one per 5 s (≤ 0.2/s).
 * - Any main-socket ack over 2,000 ms, or a probe without an answer after 3 s, yields: the host sends
 *   VIS 2, stops UP and slows ACK to 1 Hz, and the stage says chat and voice are catching up.
 * - While yielding it probes every 2 s (after the previous answer, so the server's 1-per-2-s probe
 *   limiter never refuses one); two answers in a row under 600 ms end the yield.
 *
 * One timer at a time: the next probe check, or the running probe's 3 s timeout.
 */
export interface ChatFirstGuard {
  dispose(): void;
  readonly yielding: boolean;
}

export const CHAT_FIRST = { idleMs: 5000, yieldProbeMs: 2000, probeTimeoutMs: 3000, slowAckMs: 2000, goodMs: 600, goodRun: 2 } as const;

export const createChatFirstGuard = (o: {
  /** Sends `arcade:probe`; resolves with its round trip in ms. */
  probe(): Promise<number>;
  onAck(cb: (rttMs: number) => void): () => void;
  lastRequestAt(): number;
  onYield(yielding: boolean): void;
  now?(): number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}): ChatFirstGuard => {
  const now = o.now ?? (() => performance.now());
  const st = o.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const ct = o.clearTimeout ?? ((h: unknown) => clearTimeout(h as number));
  let timer: unknown = null;
  let disposed = false;
  let yielding = false;
  let inflight = false;
  let good = 0;
  // No probe in the first 5 s: the lane was opened with a request (the ticket) a moment ago.
  let lastProbeAt = now();
  let lastDoneAt = lastProbeAt;

  const clear = (): void => {
    if (timer !== null) ct(timer);
    timer = null;
  };

  const setYield = (v: boolean): void => {
    good = 0;
    if (v === yielding) return;
    yielding = v;
    lastDoneAt = now();
    o.onYield(v);
  };

  const check = (): void => {
    clear();
    if (disposed || inflight) return;
    const t = now();
    const due = yielding ? lastDoneAt + CHAT_FIRST.yieldProbeMs : Math.max(o.lastRequestAt(), lastProbeAt) + CHAT_FIRST.idleMs;
    if (t < due) {
      timer = st(check, due - t);
      return;
    }
    inflight = true;
    lastProbeAt = t;
    let settled = false;
    // rtt null: no answer within 3 s; -1: refused before that (main socket down), which proves nothing.
    const done = (rtt: number | null): void => {
      if (settled || disposed) return;
      settled = true;
      clear();
      inflight = false;
      lastDoneAt = now();
      if (rtt === null || rtt > CHAT_FIRST.slowAckMs) setYield(true);
      else if (yielding && rtt >= 0 && rtt < CHAT_FIRST.goodMs) {
        good += 1;
        if (good >= CHAT_FIRST.goodRun) setYield(false);
      } else good = 0;
      check();
    };
    timer = st(() => done(null), CHAT_FIRST.probeTimeoutMs);
    o.probe().then(done, () => done(-1));
  };

  const offAck = o.onAck((rtt) => {
    if (disposed || rtt <= CHAT_FIRST.slowAckMs) return;
    setYield(true);
    check();
  });
  check();

  return {
    get yielding() {
      return yielding;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      offAck();
    },
  };
};
