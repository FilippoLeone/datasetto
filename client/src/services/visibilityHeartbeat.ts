/**
 * Tells the server whether this page is visible (`presence:visibility`), so push
 * notifications only go out when none of the user's windows shows the app.
 *
 * Reports at once on start, on every visibility change and, while visible, every
 * `intervalMs`; the server treats a visible page that stops reporting for 90 s as
 * hidden (a frozen background tab, a laptop that went to sleep). Hidden pages do not
 * repeat themselves: hidden is the default assumption once the heartbeat stops.
 */
export interface VisibilityHeartbeatOptions {
  /** Delivers one report; gate it on the socket being connected and signed in. */
  send: (visible: boolean) => void;
  intervalMs?: number;
  /** The document to observe (tests pass a stand-in). */
  doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
}

export interface VisibilityHeartbeat {
  start(): void;
  stop(): void;
  /** Report the current state now (after a sign-in or reconnect). */
  pulse(): void;
  readonly running: boolean;
}

export const HEARTBEAT_INTERVAL_MS = 30_000;

export const createVisibilityHeartbeat = ({ send, intervalMs = HEARTBEAT_INTERVAL_MS, doc = document }: VisibilityHeartbeatOptions): VisibilityHeartbeat => {
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const isVisible = () => doc.visibilityState !== 'hidden';

  const clear = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const schedule = () => {
    clear();
    if (isVisible()) timer = setInterval(() => send(true), intervalMs);
  };

  const onChange = () => {
    if (!running) return;
    send(isVisible());
    schedule();
  };

  return {
    get running() {
      return running;
    },
    start() {
      if (running) return;
      running = true;
      doc.addEventListener('visibilitychange', onChange);
      send(isVisible());
      schedule();
    },
    stop() {
      if (!running) return;
      running = false;
      doc.removeEventListener('visibilitychange', onChange);
      clear();
    },
    pulse() {
      if (running) send(isVisible());
    },
  };
};
