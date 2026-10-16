/**
 * "Back closes what is open": drawers, dialogs, sheets and the phone search
 * page register a closer while they are open. The Android back button
 * (Capacitor) and the browser's back button on touch devices (a history
 * entry per open panel) close the newest one first; only with nothing open
 * does back leave the app.
 */
import { useEffect } from 'preact/hooks';

type Closer = () => void;

interface Entry {
  id: number;
  close: Closer;
}

const STATE_KEY = 'datasettoPanel';

const stack: Entry[] = [];
let nextId = 1;
let historyEnabled = false;
let installed = false;
/** Set while we call history.back() ourselves so the resulting popstate is not treated as the user's. */
let pendingOwnPops = 0;

const panelIdOf = (state: unknown): number | null => {
  if (!state || typeof state !== 'object') return null;
  const value = (state as Record<string, unknown>)[STATE_KEY];
  return typeof value === 'number' ? value : null;
};

/** Number of panels currently registered (tests and diagnostics). */
export const openPanelCount = (): number => stack.length;

/**
 * Close the newest open panel. Returns false when nothing is open, which is
 * when the caller may leave the app or let the browser navigate.
 */
export const closeTopPanel = (): boolean => {
  const top = stack[stack.length - 1];
  if (!top) return false;
  stack.pop();
  top.close();
  return true;
};

/**
 * Register a panel that is open right now; call the returned function when it
 * closes (for whatever reason). With history enabled each registration adds a
 * history entry so the browser's back button pops it.
 */
export const pushBackHandler = (close: Closer): (() => void) => {
  const entry: Entry = { id: nextId++, close };
  stack.push(entry);
  if (historyEnabled) {
    try {
      window.history.pushState({ ...(typeof window.history.state === 'object' ? window.history.state : {}), [STATE_KEY]: entry.id }, '');
    } catch {
      /* file:// or a sandboxed document */
    }
  }
  return () => {
    const index = stack.indexOf(entry);
    if (index === -1) return;
    stack.splice(index, 1);
    // Closed by a tap or a programmatic close: take our history entry with us when it is the current one.
    if (historyEnabled && panelIdOf(window.history.state) === entry.id) {
      pendingOwnPops += 1;
      window.history.back();
    }
  };
};

const onPopState = (): void => {
  if (pendingOwnPops > 0) {
    pendingOwnPops -= 1;
    return;
  }
  const top = stack[stack.length - 1];
  if (!top) return;
  stack.pop();
  top.close();
};

/**
 * Wire the browser's back button. `history: true` (touch devices on the web)
 * gives every open panel its own history entry; Capacitor uses its own back
 * button event and passes false.
 */
export const installBackStack = (options: { history: boolean }): void => {
  historyEnabled = options.history;
  if (installed || typeof window === 'undefined') return;
  installed = true;
  if (historyEnabled) {
    // A reload with a panel entry on top: nothing is open any more, drop the marker.
    try {
      if (panelIdOf(window.history.state) !== null) window.history.replaceState(null, '');
    } catch {
      /* ignore */
    }
    window.addEventListener('popstate', onPopState);
  }
};

/** Tests only. */
export const resetBackStack = (): void => {
  stack.length = 0;
  pendingOwnPops = 0;
  if (installed && typeof window !== 'undefined') window.removeEventListener('popstate', onPopState);
  installed = false;
  historyEnabled = false;
};

/** Registers `close` for the back button while `open` is true. */
export const useBackClose = (open: boolean, close: Closer): void => {
  useEffect(() => {
    if (!open) return;
    return pushBackHandler(close);
    // The closer is read when back fires; re-registering on every render would churn history entries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
};
