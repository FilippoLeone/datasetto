import { describe, expect, it, vi } from 'vitest';
import { createAppVisibility, type AppVisibilitySources } from './appVisibility';

/** Stand-ins for every source, each flipped by the test. */
const fakeSources = (options: { bridge?: boolean; windowVisible?: boolean | null; appActive?: boolean } = {}) => {
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  const win = new EventTarget();
  const appListeners = new Set<(active: boolean) => void>();
  const windowListeners = new Set<(visible: boolean) => void>();
  let lastWindow: boolean | null = options.windowVisible ?? null;
  let active = options.appActive ?? true;

  const sources: AppVisibilitySources = {
    doc,
    win,
    appActive: () => active,
    onAppStateChange: (cb) => {
      appListeners.add(cb);
      return () => appListeners.delete(cb);
    },
    // Like desktop/preload.js: the last state is replayed to a new subscriber.
    onWindowVisibility:
      options.bridge === false
        ? undefined
        : (cb) => {
            windowListeners.add(cb);
            if (lastWindow !== null) cb(lastWindow);
            return () => windowListeners.delete(cb);
          },
  };

  return {
    sources,
    setDocument(state: DocumentVisibilityState) {
      doc.visibilityState = state;
      doc.dispatchEvent(new Event('visibilitychange'));
    },
    pageHide: () => win.dispatchEvent(new Event('pagehide')),
    pageShow: () => win.dispatchEvent(new Event('pageshow')),
    setApp(next: boolean) {
      active = next;
      appListeners.forEach((cb) => cb(next));
    },
    setWindow(visible: boolean) {
      lastWindow = visible;
      windowListeners.forEach((cb) => cb(visible));
    },
    get listenerCounts() {
      return { app: appListeners.size, window: windowListeners.size };
    },
  };
};

const record = (fake: ReturnType<typeof fakeSources>) => {
  const visibility = createAppVisibility(() => fake.sources);
  const seen: boolean[] = [];
  visibility.subscribe((visible) => seen.push(visible));
  return { visibility, seen };
};

describe('app visibility', () => {
  it('follows the document', () => {
    const fake = fakeSources();
    const { visibility, seen } = record(fake);
    expect(visibility.visible).toBe(true);
    fake.setDocument('hidden');
    fake.setDocument('visible');
    expect(seen).toEqual([false, true]);
    expect(visibility.visible).toBe(true);
  });

  it('follows pagehide and pageshow', () => {
    const fake = fakeSources();
    const { visibility, seen } = record(fake);
    fake.pageHide();
    expect(visibility.visible).toBe(false);
    fake.pageShow();
    expect(seen).toEqual([false, true]);
  });

  it('follows the Capacitor app state, where the WebView keeps saying visible', () => {
    const fake = fakeSources();
    const { visibility, seen } = record(fake);
    fake.setApp(false);
    expect(visibility.visible).toBe(false);
    fake.setApp(true);
    expect(seen).toEqual([false, true]);
  });

  it('follows the desktop window: minimize, restore, hide to the tray, show', () => {
    const fake = fakeSources({ windowVisible: true });
    const { visibility, seen } = record(fake);
    fake.setWindow(false); // minimize
    fake.setWindow(true); // restore
    fake.setWindow(false); // hide
    fake.setWindow(true); // show
    expect(seen).toEqual([false, true, false, true]);
    expect(visibility.visible).toBe(true);
  });

  it('starts hidden when the desktop window was already minimized (replayed state)', () => {
    const fake = fakeSources({ windowVisible: false });
    const visibility = createAppVisibility(() => fake.sources);
    expect(visibility.visible).toBe(false);
  });

  it('starts hidden when the native app is already in the background', () => {
    const fake = fakeSources({ appActive: false });
    const visibility = createAppVisibility(() => fake.sources);
    expect(visibility.visible).toBe(false);
  });

  it('is visible only while no source says hidden, and reports changes of the merged value only', () => {
    const fake = fakeSources({ windowVisible: true });
    const { visibility, seen } = record(fake);
    fake.setWindow(false); // minimized: hidden
    fake.setDocument('hidden'); // still hidden, no report
    fake.setApp(false); // still hidden
    fake.setWindow(true); // document and app still say hidden
    fake.setDocument('visible'); // the app still says hidden
    expect(seen).toEqual([false]);
    fake.setApp(true);
    expect(seen).toEqual([false, true]);
    fake.setWindow(true); // no change
    fake.setApp(true);
    expect(seen).toEqual([false, true]);
    expect(visibility.visible).toBe(true);
  });

  it('falls back to the document in desktop shells without the bridge', () => {
    const fake = fakeSources({ bridge: false });
    const { visibility, seen } = record(fake);
    expect(visibility.visible).toBe(true);
    fake.setDocument('hidden');
    expect(seen).toEqual([false]);
  });

  it('reads the sources on first use, installs them once and lets listeners go', () => {
    const fake = fakeSources({ windowVisible: true });
    const getSources = vi.fn(() => fake.sources);
    const visibility = createAppVisibility(getSources);
    expect(getSources).not.toHaveBeenCalled();
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = visibility.subscribe(first);
    visibility.subscribe(second);
    void visibility.visible;
    expect(getSources).toHaveBeenCalledTimes(1);
    expect(fake.listenerCounts).toEqual({ app: 1, window: 1 });

    stopFirst();
    fake.setWindow(false);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(false);
  });

  it('merges the real document and the desktop bridge by default', async () => {
    vi.resetModules();
    const handlers = new Set<(visible: boolean) => void>();
    window.desktopAPI = {
      onWindowVisibility: (cb: (visible: boolean) => void) => {
        handlers.add(cb);
        return () => handlers.delete(cb);
      },
    } as unknown as NonNullable<Window['desktopAPI']>;
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    try {
      const { appVisibility } = await import('./appVisibility');
      const seen: boolean[] = [];
      appVisibility.subscribe((visible) => seen.push(visible));
      handlers.forEach((cb) => cb(false));
      handlers.forEach((cb) => cb(true));
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(seen).toEqual([false, true, false]);
      expect(appVisibility.visible).toBe(false);
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
      if (original) Object.defineProperty(Document.prototype, 'visibilityState', original);
      delete window.desktopAPI;
    }
  });
});
