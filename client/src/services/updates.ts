/**
 * Update notices.
 *
 * In the desktop app the Electron shell checks GitHub Releases itself
 * (desktop/updater.js) and pushes its state over the bridge; the client only
 * renders it. In a browser and on Android the client asks the server for the
 * latest release (`GET /api/releases`, cached there) once a day and compares it
 * with the version this build was made from.
 */
import { currentAppVersion } from '@/lib/appVersion';
import { isCapacitor, isElectron } from '@/lib/device';
import { runtimeUrls } from '@/lib/runtimeConfig';
import {
  applyDesktopUpdateState,
  applyReleaseCheck,
  isReleaseCheckDue,
  lastKnownRelease,
  lastReleaseCheckAt,
  rememberLatestRelease,
  rememberReleaseCheck,
} from '@/state/updates';

/** The fields of the server's release payload we read. */
interface ReleaseInfo {
  version?: string | null;
  releaseUrl?: string;
  builds?: Array<{ platform?: string; downloadUrl?: string }>;
}

const FIRST_CHECK_DELAY_MS = 10_000;
const DUE_POLL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

let checking: Promise<void> | null = null;

/** The site's downloads page, next to the API (same origin on the web). */
export const downloadsPageUrl = (): string => `${runtimeUrls.apiBaseUrl}/downloads.html`;

export const checkLatestRelease = async (): Promise<void> => {
  if (checking) return checking;
  checking = (async () => {
    const current = await currentAppVersion();
    if (!current) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${runtimeUrls.apiBaseUrl}/api/releases`, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!response.ok) return;
      const release = (await response.json()) as ReleaseInfo;
      rememberReleaseCheck();
      const android = isCapacitor();
      const apk = android ? release.builds?.find((build) => build.platform === 'android')?.downloadUrl : undefined;
      const url = android ? (apk ?? release.releaseUrl ?? null) : downloadsPageUrl();
      rememberLatestRelease(release.version ? { version: release.version, url } : null);
      applyReleaseCheck({ latest: release.version ?? null, current, url, reload: !android });
    } catch {
      /* offline or no release information: try again next time */
    } finally {
      clearTimeout(timer);
    }
  })().finally(() => {
    checking = null;
  });
  return checking;
};

const checkIfDue = (): void => {
  if (isReleaseCheckDue(lastReleaseCheckAt())) void checkLatestRelease();
};

/** Between daily checks the card comes from the last answer, so a reload does not hide it. */
const restoreLastRelease = async (): Promise<void> => {
  const known = lastKnownRelease();
  if (!known) return;
  const current = await currentAppVersion();
  if (!current) return;
  applyReleaseCheck({ latest: known.version, current, url: known.url, reload: !isCapacitor() });
};

/** Call once at boot. */
export const installUpdateNotices = (): void => {
  if (isElectron()) {
    const bridge = window.desktopAPI;
    if (!bridge?.getUpdateState || !bridge.onUpdateState) return;
    bridge.onUpdateState((state) => applyDesktopUpdateState(state));
    void bridge.getUpdateState().then((state) => applyDesktopUpdateState(state));
    return;
  }
  void restoreLastRelease();
  window.setTimeout(checkIfDue, FIRST_CHECK_DELAY_MS);
  window.setInterval(checkIfDue, DUE_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkIfDue();
  });
};
