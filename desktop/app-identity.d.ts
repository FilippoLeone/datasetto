/** Types for app-identity.js (CommonJS); the client's unit tests load the module through createRequire. */

export type BuildKind = 'installed' | 'portable' | 'unpacked' | 'dev';

export interface AppIdentity {
  kind: BuildKind;
  /** Passed to app.setAppUserModelId() on Windows. */
  appUserModelId: string;
  /** Appended to the main window's title ('' for the installed and portable builds). */
  titleSuffix: string;
  /** Whether this copy may use Electron's notifications (which rewrite the Start Menu shortcut on Windows). */
  nativeNotifications: boolean;
}

export interface IdentityOptions {
  platform: string;
  isPackaged: boolean;
  execPath: string;
  env?: Record<string, string | undefined>;
  fileExists: (file: string) => boolean;
  startMenuTarget?: () => string | null;
}

export const APP_USER_MODEL_ID: string;
export function detectBuildKind(options: IdentityOptions): BuildKind;
export function resolveAppIdentity(options: IdentityOptions): AppIdentity;
export function samePath(a: unknown, b: unknown): boolean;
