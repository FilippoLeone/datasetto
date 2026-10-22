/**
 * Screen Wake Lock while an action game is live and visible, or a table game is mid-hand or
 * auto-playing (platform.md §10.6). Supported from WebView 84; elsewhere nothing happens. The
 * browser releases the lock when the page is hidden, so it is taken again when it comes back,
 * and the visibility listener exists only while the lock is wanted.
 */

interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener?(type: 'release', cb: () => void): void;
}

export interface WakeLockHelper {
  set(on: boolean): void;
  dispose(): void;
}

export const createWakeLock = (): WakeLockHelper => {
  let wanted = false;
  let sentinel: WakeLockSentinelLike | null = null;
  let pending = false;
  const api = typeof navigator !== 'undefined' ? (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }).wakeLock : undefined;

  const acquire = (): void => {
    if (!api || sentinel || pending || !wanted || document.visibilityState !== 'visible') return;
    pending = true;
    api
      .request('screen')
      .then((lock) => {
        pending = false;
        if (!wanted) {
          void lock.release().catch(() => undefined);
          return;
        }
        sentinel = lock;
        lock.addEventListener?.('release', () => {
          if (sentinel === lock) sentinel = null;
        });
      })
      .catch(() => {
        pending = false;
      });
  };

  const onVisibility = () => acquire();

  const set = (on: boolean): void => {
    if (on === wanted) return;
    wanted = on;
    if (on) {
      document.addEventListener('visibilitychange', onVisibility);
      acquire();
    } else {
      document.removeEventListener('visibilitychange', onVisibility);
      const lock = sentinel;
      sentinel = null;
      if (lock) void lock.release().catch(() => undefined);
    }
  };

  return { set, dispose: () => set(false) };
};
