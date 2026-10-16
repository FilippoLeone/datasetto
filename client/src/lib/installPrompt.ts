/** Whether and how to suggest installing the app on the home screen. Pure; the service feeds it. */

export type InstallPlatform = 'android' | 'ios' | 'other';
/** 'prompt': the browser offered an install prompt (Android Chrome); 'ios-steps': explain Share > Add to Home Screen. */
export type InstallHint = 'prompt' | 'ios-steps' | 'none';

/** How long "Not now" keeps the hint away. */
export const INSTALL_HINT_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

export interface InstallContext {
  /** Already running from the home screen (display-mode standalone, or Safari's navigator.standalone). */
  standalone: boolean;
  /** Inside the Electron or Capacitor shell: nothing to install. */
  nativeApp: boolean;
  /** Phones and tablets only; desktop browsers have their own install affordance. */
  touch: boolean;
  platform: InstallPlatform;
  /** A `beforeinstallprompt` event is waiting to be shown. */
  canPrompt: boolean;
  dismissedAt: number | null;
  now: number;
}

export const installHintFor = (context: InstallContext): InstallHint => {
  if (context.standalone || context.nativeApp || !context.touch) return 'none';
  if (context.dismissedAt !== null && context.now - context.dismissedAt < INSTALL_HINT_SNOOZE_MS) return 'none';
  if (context.canPrompt) return 'prompt';
  if (context.platform === 'ios') return 'ios-steps';
  return 'none';
};
