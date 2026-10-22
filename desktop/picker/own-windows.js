'use strict';

/**
 * Datasetto's own helper windows must never be offered in the screen-share picker: the
 * picker itself (it closes the moment you pick) and the voice overlay (it is excluded
 * from capture, so a share of it is an empty frame). desktopCapturer lists them like
 * any other window, and the always-on-top overlay even comes first, so it would be the
 * preselected window.
 *
 * Two ways a helper window is recognised:
 * - Windows of this app, by the native handle in the source id ("window:<handle>:<n>").
 *   The trailing number differs between listings (Chromium adds an internal id for its
 *   own windows), so only the handle is compared. main.js passes the current windows on
 *   every refresh, because the overlay is created the first time it is shown, which can
 *   happen while the picker is open.
 * - Helper windows of another running copy of Datasetto (the installed app next to a
 *   test build or the dev shell): their handles are unknown here, so they are matched
 *   by their exact window title. Only windows are matched this way, never screens.
 *
 * No Electron in here, so the client's unit tests load this file as it is.
 */

/** Window titles of the helper windows; the pages' <title> tags must say the same. */
const OVERLAY_TITLE = 'Datasetto voice overlay';
const PICKER_TITLE = 'Share your screen';
const HELPER_WINDOW_TITLES = Object.freeze([OVERLAY_TITLE, PICKER_TITLE]);

/** The native handle in a window source id ("window:<handle>:<n>"), or null. */
function windowHandleOf(sourceId) {
  if (typeof sourceId !== 'string') {
    return null;
  }
  const match = /^window:(\d+):/.exec(sourceId);
  return match && match[1] !== '0' ? match[1] : null;
}

/** BrowserWindow.getNativeWindowHandle() (a little-endian buffer) as a decimal string, or null. */
function nativeHandleToString(buffer) {
  if (!buffer || typeof buffer.length !== 'number') {
    return null;
  }
  try {
    let value = null;
    if (buffer.length >= 8 && typeof buffer.readBigUInt64LE === 'function') {
      value = buffer.readBigUInt64LE(0);
    } else if (buffer.length >= 4 && typeof buffer.readUInt32LE === 'function') {
      value = BigInt(buffer.readUInt32LE(0));
    }
    return value && value > 0n ? value.toString() : null;
  } catch {
    return null;
  }
}

/**
 * A test for "is this source one of our helper windows?".
 * @param {Array<{ mediaSourceId?: string | null, nativeHandle?: Buffer | Uint8Array | null } | null | undefined>} windows
 *   this app's helper windows right now
 * @param {readonly string[]} [titles] window titles that mark a helper window of any copy of the app
 */
function helperWindowMatcher(windows, titles = HELPER_WINDOW_TITLES) {
  const ids = new Set();
  const handles = new Set();
  for (const window of Array.isArray(windows) ? windows : []) {
    if (!window) {
      continue;
    }
    if (typeof window.mediaSourceId === 'string' && window.mediaSourceId) {
      ids.add(window.mediaSourceId);
      const handle = windowHandleOf(window.mediaSourceId);
      if (handle) {
        handles.add(handle);
      }
    }
    const native = nativeHandleToString(window.nativeHandle);
    if (native) {
      handles.add(native);
    }
  }
  const names = new Set(titles);
  return (source) => {
    const id = source && typeof source.id === 'string' ? source.id : null;
    if (!id) {
      return false;
    }
    if (ids.has(id)) {
      return true;
    }
    const handle = windowHandleOf(id);
    if (handle && handles.has(handle)) {
      return true;
    }
    return id.startsWith('window:') && typeof source.name === 'string' && names.has(source.name.trim());
  };
}

/** `sources` without Datasetto's helper windows (see helperWindowMatcher). */
function withoutHelperWindows(sources, windows, titles) {
  if (!Array.isArray(sources)) {
    return [];
  }
  const isHelper = helperWindowMatcher(windows, titles);
  return sources.filter((source) => !isHelper(source));
}

module.exports = {
  OVERLAY_TITLE,
  PICKER_TITLE,
  HELPER_WINDOW_TITLES,
  windowHandleOf,
  nativeHandleToString,
  helperWindowMatcher,
  withoutHelperWindows,
};
