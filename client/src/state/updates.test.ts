import { beforeEach, describe, expect, it } from 'vitest';
import {
  RELEASE_CHECK_INTERVAL_MS,
  applyDesktopUpdateState,
  applyReleaseCheck,
  desktopUpdate,
  dismissUpdateNotice,
  dismissedUpdateVersion,
  isReleaseCheckDue,
  lastKnownRelease,
  lastReleaseCheckAt,
  noticeFromDesktopState,
  rememberLatestRelease,
  rememberReleaseCheck,
  updateNotice,
  visibleUpdateNotice,
} from './updates';

const desktopState = (patch: Partial<DesktopUpdateState>): DesktopUpdateState => ({
  autoUpdate: true,
  mode: 'self',
  status: 'idle',
  currentVersion: '0.1.8',
  version: null,
  percent: null,
  url: null,
  error: null,
  checkedAt: null,
  ...patch,
});

describe('update notices', () => {
  beforeEach(() => {
    localStorage.clear();
    updateNotice.value = null;
    desktopUpdate.value = null;
    dismissedUpdateVersion.value = null;
  });

  it('maps the desktop updater state to a banner', () => {
    expect(noticeFromDesktopState(null)).toBeNull();
    expect(noticeFromDesktopState(desktopState({ status: 'checking' }))).toBeNull();
    expect(noticeFromDesktopState(desktopState({ status: 'downloading', version: '0.1.9', percent: 40 }))).toBeNull();
    expect(noticeFromDesktopState(desktopState({ status: 'none', checkedAt: 1 }))).toBeNull();
    expect(noticeFromDesktopState(desktopState({ status: 'error', error: 'offline' }))).toBeNull();
    expect(noticeFromDesktopState(desktopState({ status: 'ready', version: '0.1.9' }))).toEqual({ kind: 'ready', version: '0.1.9' });
    expect(noticeFromDesktopState(desktopState({ mode: 'notice', status: 'available', version: '0.1.9', url: 'https://example.test/latest' }))).toEqual({
      kind: 'available',
      version: '0.1.9',
      url: 'https://example.test/latest',
      reload: false,
    });
    // A state without a version has nothing to announce.
    expect(noticeFromDesktopState(desktopState({ status: 'ready' }))).toBeNull();
  });

  it('keeps the desktop state for the settings dialog and derives the banner', () => {
    const state = desktopState({ status: 'ready', version: '0.1.9' });
    applyDesktopUpdateState(state);
    expect(desktopUpdate.value).toBe(state);
    expect(visibleUpdateNotice.value).toEqual({ kind: 'ready', version: '0.1.9' });
    applyDesktopUpdateState(desktopState({ status: 'none' }));
    expect(visibleUpdateNotice.value).toBeNull();
  });

  it('shows a release notice only for a strictly newer version', () => {
    expect(applyReleaseCheck({ latest: '0.1.12', current: '0.1.11', url: '/downloads.html', reload: true })).toEqual({
      kind: 'available',
      version: '0.1.12',
      url: '/downloads.html',
      reload: true,
    });
    expect(visibleUpdateNotice.value?.version).toBe('0.1.12');
    expect(applyReleaseCheck({ latest: '0.1.11', current: '0.1.11', url: null, reload: true })).toBeNull();
    expect(applyReleaseCheck({ latest: '0.1.10', current: '0.1.11', url: null, reload: true })).toBeNull();
    expect(applyReleaseCheck({ latest: null, current: '0.1.11', url: null, reload: true })).toBeNull();
    expect(applyReleaseCheck({ latest: '0.1.12', current: null, url: null, reload: true })).toBeNull();
    expect(visibleUpdateNotice.value).toBeNull();
  });

  it('hides a dismissed version until a newer one appears, across reloads', () => {
    applyReleaseCheck({ latest: '0.1.12', current: '0.1.11', url: null, reload: true });
    dismissUpdateNotice();
    expect(visibleUpdateNotice.value).toBeNull();
    expect(updateNotice.value?.version).toBe('0.1.12');
    expect(JSON.parse(localStorage.getItem('datasetto.updates.dismissed.v1') ?? 'null')).toBe('0.1.12');

    // The same version again (next daily check) stays hidden.
    applyReleaseCheck({ latest: '0.1.12', current: '0.1.11', url: null, reload: true });
    expect(visibleUpdateNotice.value).toBeNull();

    // A newer release is announced again.
    applyReleaseCheck({ latest: '0.1.13', current: '0.1.11', url: null, reload: true });
    expect(visibleUpdateNotice.value?.version).toBe('0.1.13');

    // A desktop update that is ready to install is subject to the same dismissal.
    applyDesktopUpdateState(desktopState({ status: 'ready', version: '0.1.12' }));
    expect(visibleUpdateNotice.value).toBeNull();
    applyDesktopUpdateState(desktopState({ status: 'ready', version: '0.1.13' }));
    expect(visibleUpdateNotice.value?.kind).toBe('ready');
  });

  it('dismissing with nothing shown clears the stored version', () => {
    localStorage.setItem('datasetto.updates.dismissed.v1', JSON.stringify('0.1.12'));
    dismissedUpdateVersion.value = '0.1.12';
    dismissUpdateNotice();
    expect(dismissedUpdateVersion.value).toBeNull();
    expect(localStorage.getItem('datasetto.updates.dismissed.v1')).toBeNull();
  });

  it('schedules the web and Android check once a day', () => {
    const now = 1_800_000_000_000;
    expect(isReleaseCheckDue(null, now)).toBe(true);
    expect(isReleaseCheckDue(now - 1000, now)).toBe(false);
    expect(isReleaseCheckDue(now - RELEASE_CHECK_INTERVAL_MS + 1, now)).toBe(false);
    expect(isReleaseCheckDue(now - RELEASE_CHECK_INTERVAL_MS, now)).toBe(true);
    expect(isReleaseCheckDue(now + 60_000, now)).toBe(true);
    expect(isReleaseCheckDue(now - 5000, now, 1000)).toBe(true);
  });

  it('remembers when the last check ran', () => {
    expect(lastReleaseCheckAt()).toBeNull();
    rememberReleaseCheck(1234);
    expect(lastReleaseCheckAt()).toBe(1234);
    localStorage.setItem('datasetto.updates.checkedAt.v1', JSON.stringify('garbage'));
    expect(lastReleaseCheckAt()).toBeNull();
  });

  it('remembers the last release it found, for the next page load', () => {
    expect(lastKnownRelease()).toBeNull();
    rememberLatestRelease({ version: '0.1.12', url: '/downloads.html' });
    expect(lastKnownRelease()).toEqual({ version: '0.1.12', url: '/downloads.html' });
    rememberLatestRelease({ version: '0.1.13', url: null });
    expect(lastKnownRelease()).toEqual({ version: '0.1.13', url: null });
    localStorage.setItem('datasetto.updates.latest.v1', JSON.stringify({ url: 'x' }));
    expect(lastKnownRelease()).toBeNull();
    rememberLatestRelease(null);
    expect(localStorage.getItem('datasetto.updates.latest.v1')).toBeNull();
  });
});
