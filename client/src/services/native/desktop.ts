import { pushStatus } from '@/state/notifications';
import { isSharingScreenAudio } from '@/services/screenCapture';

/**
 * Electron bridge helpers. Every call is a no-op in the browser and on mobile.
 */
export const isDesktopApp = (): boolean => typeof window !== 'undefined' && Boolean(window.desktopAPI);

export const notifyDesktop = async (title: string, body: string): Promise<void> => {
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  const bridge = window.desktopAPI;
  if (bridge?.showNotification) {
    try {
      // The OS plays notification sounds itself, outside Datasetto, so a screen share's
      // system audio would carry them to everyone watching: stay silent while sharing sound.
      await bridge.showNotification({ title, body, type: 'message', silent: isSharingScreenAudio() });
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

/**
 * Click handler for an `<a target="_blank" rel="noopener noreferrer">` to a page outside the
 * app. In the desktop app the link is handed to the system browser. Everywhere else the
 * anchor's own navigation runs: that is what every browser treats as a real link (no popup
 * blocking), and what an iPhone web app opened from the Home Screen hands to Safari instead
 * of swallowing it. `window.open` from script would be blocked or opened inside the web app.
 */
export const onExternalLinkClick = (event: MouseEvent, url: string): void => {
  event.stopPropagation();
  if (!window.desktopAPI?.openExternal) return;
  event.preventDefault();
  void window.desktopAPI.openExternal(url);
};
