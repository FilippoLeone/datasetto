import { isCapacitor } from '@/lib/device';

/**
 * Whether the native app is in the foreground, from one shared Capacitor `appStateChange`
 * listener (the App plugin). The Android WebView keeps reporting the page as visible
 * while the app is in the background, so this is the signal to go by there.
 * On the web and in Electron nothing is installed and the app counts as active.
 */
type AppStateListener = (active: boolean) => void;

const listeners = new Set<AppStateListener>();
let active = true;
let changed = false;
let installed = false;

const emit = (isActive: boolean): void => {
  active = isActive;
  for (const listener of [...listeners]) {
    try {
      listener(isActive);
    } catch (error) {
      if (import.meta.env.DEV) console.warn('[appState] listener failed:', error);
    }
  }
};

const install = (): void => {
  if (installed || !isCapacitor()) return;
  installed = true;
  void (async () => {
    try {
      // Never resolve a promise with the plugin object itself: Capacitor plugin proxies
      // answer `then`, and the await would never settle.
      const { App } = await import('@capacitor/app');
      await App.addListener('appStateChange', ({ isActive }) => {
        changed = true;
        emit(isActive);
      });
      // The app can start in the background (a notification, the foreground service).
      const { isActive } = await App.getState();
      if (!changed && isActive !== active) emit(isActive);
    } catch (error) {
      if (import.meta.env.DEV) console.warn('[appState] App plugin unavailable:', error);
    }
  })();
};

/** Start listening at app start, so the state is known before the first subscriber. */
export const startAppStateTracking = (): void => install();

/** The last state Capacitor reported; `true` on the web, in Electron and until the first report. */
export const isAppActive = (): boolean => active;

/**
 * Calls `cb(active)` on every move to the foreground (`true`) or the background (`false`),
 * all through one shared plugin listener. Returns the unsubscribe function.
 */
export function onAppStateChange(cb: (active: boolean) => void): () => void {
  listeners.add(cb);
  install();
  return () => {
    listeners.delete(cb);
  };
}
