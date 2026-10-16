import { isCapacitor, isElectron } from './device';

/**
 * The release version this build was made from (`VITE_APP_VERSION`, set by the
 * release and image workflows from the tag), or null for an unversioned local build.
 */
export const buildVersion = (): string | null => {
  const value = import.meta.env.VITE_APP_VERSION;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

let resolved: Promise<string | null> | null = null;

/**
 * The version of the app the user is running: the Electron package version, the
 * Android app's versionName, or the version baked into the web bundle. Null when
 * none is known (a local development build), in which case no update notice is shown.
 */
export const currentAppVersion = (): Promise<string | null> => {
  if (!resolved) resolved = detect();
  return resolved;
};

const detect = async (): Promise<string | null> => {
  if (isElectron()) {
    try {
      const info = await window.desktopAPI?.getInfo();
      if (info?.version) return info.version;
    } catch {
      /* fall through to the bundle version */
    }
  }
  if (isCapacitor()) {
    try {
      const { App } = await import('@capacitor/app');
      const info = await App.getInfo();
      if (info.version) return info.version;
    } catch {
      /* plugin unavailable: fall through */
    }
  }
  return buildVersion();
};
