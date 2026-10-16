import { isCapacitor } from '@/lib/device';
import { closeDrawers, closeModal, membersOpen, modal, sidebarOpen } from '@/state/ui';

/**
 * Capacitor App plugin hooks. A no-op on the web and in Electron.
 *
 * Android back (button or gesture): close whatever is open first, then put the
 * app in the background instead of killing it, so a voice call keeps running.
 */
export const installCapacitorAppHandlers = async (): Promise<void> => {
  if (!isCapacitor()) return;
  try {
    const { App } = await import('@capacitor/app');
    await App.addListener('backButton', () => {
      if (modal.value) {
        closeModal();
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
