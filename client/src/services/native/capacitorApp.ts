import { closeTopPanel } from '@/lib/backStack';
import { isCapacitor } from '@/lib/device';
import { closeDrawers, closeModal, membersOpen, modal, sidebarOpen } from '@/state/ui';
import { searchOpen } from '@/state/search';
import { closeSearch } from '@/features/search/searchActions';
import { startAppStateTracking } from './appState';

/**
 * Capacitor App plugin hooks. A no-op on the web and in Electron.
 *
 * Foreground and background: the one shared `appStateChange` listener (appState.ts)
 * starts here, so the state is known before anything subscribes to it.
 *
 * Android back (button or gesture): close whatever is open first (newest
 * first: a sheet, a picker, a dialog, the search page, a drawer), then put the
 * app in the background instead of killing it, so a voice call keeps running.
 */
export const installCapacitorAppHandlers = async (): Promise<void> => {
  if (!isCapacitor()) return;
  startAppStateTracking();
  try {
    const { App } = await import('@capacitor/app');
    await App.addListener('backButton', () => {
      if (closeTopPanel()) return;
      // Belt and braces for anything that did not register with the back stack.
      if (modal.value) {
        closeModal();
        return;
      }
      if (searchOpen.value) {
        closeSearch();
        return;
      }
      if (sidebarOpen.value || membersOpen.value) {
        closeDrawers();
        return;
      }
      void App.minimizeApp();
    });
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('[capacitorApp] App plugin unavailable:', error);
    }
  }
};
