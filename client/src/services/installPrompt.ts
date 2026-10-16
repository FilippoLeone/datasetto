import { signal } from '@preact/signals';
import { isAndroid, isIOS, isNativeApp, isTouchPrimary } from '@/lib/device';
import { installHintFor, type InstallHint } from '@/lib/installPrompt';
import { Storage } from '@/lib/storage';

const DISMISSED_KEY = 'datasetto.installHint.dismissedAt';

/** Chrome's deferred install prompt (not in lib.dom). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let dismissedAt: number | null = Storage.get<number | null>(DISMISSED_KEY, null);

/** What the sidebar's install card should show right now. */
export const installHint = signal<InstallHint>('none');

/** Running from the home screen already. */
export const isStandaloneDisplay = (): boolean => {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) return true;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
};

const recompute = (): void => {
  installHint.value = installHintFor({
    standalone: isStandaloneDisplay(),
    nativeApp: isNativeApp(),
    touch: isTouchPrimary(),
    platform: isIOS() ? 'ios' : isAndroid() ? 'android' : 'other',
    canPrompt: deferredPrompt !== null,
    dismissedAt,
    now: Date.now(),
  });
};

/**
 * Catch Chrome's `beforeinstallprompt` (Android) so the app can offer the
 * install at a calmer moment, and follow installs and display-mode changes.
 */
export const installInstallPrompt = (): void => {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    recompute();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    recompute();
  });
  if (typeof window.matchMedia === 'function') window.matchMedia('(display-mode: standalone)').addEventListener('change', recompute);
  recompute();
};

/** Show the browser's install dialog; true when the user accepted. */
export const promptInstall = async (): Promise<boolean> => {
  const event = deferredPrompt;
  if (!event) return false;
  deferredPrompt = null;
  try {
    await event.prompt();
    const choice = await event.userChoice;
    if (choice.outcome !== 'accepted') dismissInstallHint();
    recompute();
    return choice.outcome === 'accepted';
  } catch {
    recompute();
    return false;
  }
};

/** "Not now": hide the card for two weeks. */
export const dismissInstallHint = (): void => {
  dismissedAt = Date.now();
  Storage.set(DISMISSED_KEY, dismissedAt);
  recompute();
};
