import { pushStatus } from '@/state/notifications';

/**
 * Electron bridge helpers. Every call is a no-op in the browser and on mobile.
 */
export const isDesktopApp = (): boolean => typeof window !== 'undefined' && Boolean(window.desktopAPI);

export const notifyDesktop = async (title: string, body: string): Promise<void> => {
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  const bridge = window.desktopAPI;
  if (bridge?.showNotification) {
    try {
      await bridge.showNotification({ title, body, type: 'message' });
    } catch {
      /* ignore */
    }
    return;
  }
  if (typeof Notification === 'undefined') return;
  // A hidden page with Web Push on is served by the service worker instead (the server
  // pushes when every page is hidden); a visible but unfocused window still notifies here.
  if (document.visibilityState === 'hidden' && pushStatus.value.enabled) return;
  if (Notification.permission === 'granted') {
    new Notification(title, { body, silent: true });
  } else if (Notification.permission === 'default') {
    void Notification.requestPermission();
  }
};

export const updateDesktopVoiceActivity = (state: { connected: boolean; speaking: boolean; muted: boolean }): void => {
  try {
    window.desktopAPI?.updateVoiceActivity(state);
  } catch {
    /* ignore */
  }
};

export const openExternal = (url: string): void => {
  if (window.desktopAPI?.openExternal) {
    void window.desktopAPI.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
};
