import { appVisibility, type AppVisibility } from '@/services/native/appVisibility';

/**
 * Tells the server whether this page is visible (`presence:visibility`), so push
 * notifications only go out when none of the user's windows shows the app.
 *
 * Visibility is the merged app visibility (services/native/appVisibility.ts), so a
 * minimized or tray-hidden desktop window and a backgrounded Android app count as hidden
 * too, not only a background browser tab.
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
  /** Where visibility comes from (tests pass a stand-in). */
  source?: AppVisibility;
}

export interface VisibilityHeartbeat {
  start(): void;
  stop(): void;
  /** Report the current state now (after a sign-in or reconnect). */
  pulse(): void;
  readonly running: boolean;
}

export const HEARTBEAT_INTERVAL_MS = 30_000;

export const createVisibilityHeartbeat = ({ send, intervalMs = HEARTBEAT_INTERVAL_MS, source = appVisibility }: VisibilityHeartbeatOptions): VisibilityHeartbeat => {
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const clear = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const schedule = () => {
    clear();
    if (source.visible) timer = setInterval(() => send(true), intervalMs);
  };

  const onChange = () => {
    if (!running) return;
    send(source.visible);
    schedule();
  };

  return {
    get running() {
      return running;
    },
    start() {
      if (running) return;
      running = true;
      unsubscribe = source.subscribe(onChange);
      send(source.visible);
      schedule();
    },
    stop() {
      if (!running) return;
      running = false;
      unsubscribe?.();
      unsubscribe = null;
      clear();
    },
    pulse() {
      if (running) send(source.visible);
    },
  };
};
