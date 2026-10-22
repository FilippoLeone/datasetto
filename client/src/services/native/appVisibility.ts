import { isAppActive, onAppStateChange } from './appState';

/**
 * Is the app on screen? One boolean merged from every source that can say "no":
 *
 * - `document.visibilityState` (a background tab, a locked phone);
 * - `pagehide` / `pageshow` (the page is being left or comes back from the back-forward cache);
 * - Capacitor `appStateChange` (the Android app went to the background, where the
 *   WebView still reports the page as visible);
 * - the desktop shell's `window:visibility` (minimized or hidden in the tray; the shell
 *   keeps background throttling off, so the page itself still reports "visible").
 *
 * The app is visible only while none of them says otherwise. Listeners hear changes of the
 * merged value only. Desktop shells without the bridge fall back to the page's own state.
 */
export interface AppVisibility {
  readonly visible: boolean;
  /** Calls `cb` on every change of `visible`; returns the unsubscribe function. */
  subscribe(cb: (visible: boolean) => void): () => void;
}

type EventSource = Pick<EventTarget, 'addEventListener'>;

export interface AppVisibilitySources {
  doc: EventSource & { readonly visibilityState: DocumentVisibilityState };
  win: EventSource;
  appActive: () => boolean;
  onAppStateChange: (cb: (active: boolean) => void) => () => void;
  onWindowVisibility?: (cb: (visible: boolean) => void) => () => void;
}

const defaultSources = (): AppVisibilitySources => ({
  doc: document,
  win: window,
  appActive: isAppActive,
  onAppStateChange,
  onWindowVisibility: window.desktopAPI?.onWindowVisibility?.bind(window.desktopAPI),
});

/** Builds a merger over `sources` (tests pass stand-ins); the sources are read on first use. */
export const createAppVisibility = (getSources: () => AppVisibilitySources = defaultSources): AppVisibility => {
  const listeners = new Set<(visible: boolean) => void>();
  let installed = false;
  let docVisible = true;
  let pageShown = true;
  let appActive = true;
  let windowVisible = true;
  let current = true;

  const update = (): void => {
    const next = docVisible && pageShown && appActive && windowVisible;
    if (next === current) return;
    current = next;
    for (const listener of [...listeners]) listener(next);
  };

  const install = (): void => {
    if (installed) return;
    installed = true;
    const sources = getSources();
    const { doc, win } = sources;
    const readDocument = () => doc.visibilityState !== 'hidden';
    docVisible = readDocument();
    appActive = sources.appActive();
    current = docVisible && pageShown && appActive && windowVisible;

    doc.addEventListener('visibilitychange', () => {
      docVisible = readDocument();
      update();
    });
    win.addEventListener('pagehide', () => {
      pageShown = false;
      update();
    });
    win.addEventListener('pageshow', () => {
      pageShown = true;
      docVisible = readDocument();
      update();
    });
    sources.onAppStateChange((active) => {
      appActive = active;
      update();
    });
    // The desktop bridge replays its last state at once, so a window that is already
    // minimized starts out hidden here too.
    sources.onWindowVisibility?.((visible) => {
      windowVisible = visible;
      update();
    });
  };

  return {
    get visible() {
      install();
      return current;
    },
    subscribe(cb) {
      install();
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
};

/** The app's visibility; the listeners are installed on first use and stay for the page's lifetime. */
export const appVisibility: AppVisibility = createAppVisibility();
