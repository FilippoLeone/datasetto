import { computed, signal } from '@preact/signals';
import { Storage } from '@/lib/storage';
import { isNewerVersion } from '@/lib/version';

/**
 * What the update banner shows.
 *
 * - `ready`: the desktop app downloaded a new version; a restart installs it.
 * - `available`: a newer release exists but this shell cannot install it itself
 *   (web, Android, macOS, the portable build): the banner links to the download.
 */
export type UpdateNotice =
  | { kind: 'ready'; version: string }
  | { kind: 'available'; version: string; url: string | null; reload: boolean };

const DISMISSED_KEY = 'datasetto.updates.dismissed.v1';
const CHECK_KEY = 'datasetto.updates.checkedAt.v1';
const LATEST_KEY = 'datasetto.updates.latest.v1';
/** Web and Android ask the server for the latest release this often. */
export const RELEASE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const updateNotice = signal<UpdateNotice | null>(null);
/** The Electron shell's updater state, for the settings dialog; null outside the desktop app. */
export const desktopUpdate = signal<DesktopUpdateState | null>(null);
/** The version whose notice the user closed; the banner stays hidden until a newer one appears. */
export const dismissedUpdateVersion = signal<string | null>(Storage.get<string | null>(DISMISSED_KEY, null));

export const visibleUpdateNotice = computed<UpdateNotice | null>(() => {
  const notice = updateNotice.value;
  if (!notice) return null;
  const dismissed = dismissedUpdateVersion.value;
  if (dismissed && !isNewerVersion(notice.version, dismissed)) return null;
  return notice;
});

/** The banner for a desktop updater state, or null when there is nothing to tell. */
export const noticeFromDesktopState = (state: DesktopUpdateState | null | undefined): UpdateNotice | null => {
  if (!state || !state.version) return null;
  if (state.status === 'ready') return { kind: 'ready', version: state.version };
  if (state.status === 'available') return { kind: 'available', version: state.version, url: state.url ?? null, reload: false };
  return null;
};

export const applyDesktopUpdateState = (state: DesktopUpdateState | null | undefined): void => {
  desktopUpdate.value = state ?? null;
  updateNotice.value = noticeFromDesktopState(state);
};

export interface ReleaseCheckResult {
  /** The latest published release. */
  latest: string | null | undefined;
  /** The version this build runs. */
  current: string | null | undefined;
  /** Where to get the release (the downloads page, or the APK on Android). */
  url: string | null;
  /** Web only: a reload is enough to pick up the new bundle. */
  reload: boolean;
}

/** Web and Android: show the notice only when the server reports a strictly newer release. */
export const applyReleaseCheck = (result: ReleaseCheckResult): UpdateNotice | null => {
  const next: UpdateNotice | null =
    result.latest && isNewerVersion(result.latest, result.current) ? { kind: 'available', version: result.latest, url: result.url, reload: result.reload } : null;
  updateNotice.value = next;
  return next;
};

export const dismissUpdateNotice = (): void => {
  const version = updateNotice.value?.version ?? null;
  dismissedUpdateVersion.value = version;
  if (version) Storage.set(DISMISSED_KEY, version);
  else Storage.remove(DISMISSED_KEY);
};

export const lastReleaseCheckAt = (): number | null => {
  const value = Storage.get<unknown>(CHECK_KEY, null);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

export const rememberReleaseCheck = (at: number = Date.now()): void => {
  Storage.set(CHECK_KEY, at);
};

export interface KnownRelease {
  version: string;
  url: string | null;
}

/** The latest release the last check found, so the card is back right after a reload. */
export const lastKnownRelease = (): KnownRelease | null => {
  const value = Storage.get<Partial<KnownRelease> | null>(LATEST_KEY, null);
  if (!value || typeof value.version !== 'string' || !value.version) return null;
  return { version: value.version, url: typeof value.url === 'string' ? value.url : null };
};

export const rememberLatestRelease = (release: KnownRelease | null): void => {
  if (release) Storage.set(LATEST_KEY, release);
  else Storage.remove(LATEST_KEY);
};

/** Whether a daily check is due: never checked, a day has passed, or the clock went backwards. */
export const isReleaseCheckDue = (checkedAt: number | null, now: number = Date.now(), interval: number = RELEASE_CHECK_INTERVAL_MS): boolean => {
  if (checkedAt === null) return true;
  if (checkedAt > now) return true;
  return now - checkedAt >= interval;
};
