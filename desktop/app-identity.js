'use strict';

/**
 * Which copy of the desktop app is running, and what it may claim on Windows.
 *
 * Every Windows build is a Datasetto.exe with the product name Datasetto, so Windows and
 * Electron cannot tell the installed app from a test build on their own:
 * - Windows groups the windows of every process with the same AppUserModelID under one
 *   taskbar button, the installed app's pin included.
 * - The first time a process touches notifications (Notification.isSupported() is enough),
 *   Electron points "Start Menu\Programs\<product name>.lnk" at the running exe and registers
 *   that exe as the handler for notification clicks (EnsureShortcut and EnsureCLSIDRegistry in
 *   Electron's shell/browser/notifications/win/windows_toast_activator.cc). A test build that
 *   ran for three seconds took over the installed app's Start Menu shortcut that way.
 *
 * So only the copy the installer put in place uses the app's ID and native notifications.
 * Unpacked test builds and dev runs get their own ID, no native notifications on Windows and
 * a title that says what they are. The portable exe gets its own ID too; it keeps
 * notifications unless another copy owns the Start Menu shortcut.
 *
 * No Electron in here: main.js passes in what it needs, and the client's unit tests load this
 * file as it is.
 */

const path = require('node:path');

/** The installed app's AppUserModelID, the same in every version (the installer's shortcut carries it too). */
const APP_USER_MODEL_ID = 'com.datasetto.desktop';

/**
 * 'installed': the installer's copy (or any packaged build outside Windows);
 * 'portable': the single-file portable exe; 'unpacked': an electron-builder output folder
 * such as win-unpacked, run in place; 'dev': `electron .` from the source tree.
 */
function detectBuildKind({ platform, isPackaged, execPath, env = {}, fileExists }) {
  if (!isPackaged) {
    return 'dev';
  }
  if (platform !== 'win32') {
    return 'installed';
  }
  if (env.PORTABLE_EXECUTABLE_DIR) {
    return 'portable';
  }
  // The installer leaves "Uninstall Datasetto.exe" next to the app; a build output folder has none.
  const uninstaller = path.win32.join(path.win32.dirname(execPath), `Uninstall ${path.win32.basename(execPath)}`);
  return fileExists(uninstaller) ? 'installed' : 'unpacked';
}

/** The same file, as Windows compares paths (no case). */
function samePath(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a !== '' && b !== ''
    && path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase();
}

/**
 * @param {object} options
 * @param {string} options.platform process.platform
 * @param {boolean} options.isPackaged app.isPackaged
 * @param {string} options.execPath process.execPath
 * @param {Record<string, string | undefined>} [options.env] process.env
 * @param {(file: string) => boolean} options.fileExists
 * @param {() => string | null} [options.startMenuTarget] what the Start Menu shortcut named after
 *   the exe points at, or null when there is none; only asked for the portable build
 */
function resolveAppIdentity(options) {
  const kind = detectBuildKind(options);
  if (kind === 'installed') {
    return { kind, appUserModelId: APP_USER_MODEL_ID, titleSuffix: '', nativeNotifications: true };
  }
  if (kind === 'portable') {
    // Toasts need a Start Menu shortcut, and Electron makes one for the portable exe on a PC
    // without the installed app. Where another copy owns that shortcut, leave it alone.
    let target = null;
    try {
      target = options.startMenuTarget ? options.startMenuTarget() : null;
    } catch {
      target = '';
    }
    return {
      kind,
      appUserModelId: `${APP_USER_MODEL_ID}.portable`,
      titleSuffix: '',
      nativeNotifications: target === null || samePath(target, options.execPath),
    };
  }
  return {
    kind,
    appUserModelId: `${APP_USER_MODEL_ID}.dev`,
    titleSuffix: kind === 'dev' ? ' (dev)' : ' (test build)',
    // Outside Windows Electron writes no shortcut, so dev runs there keep their notifications.
    nativeNotifications: options.platform !== 'win32',
  };
}

module.exports = { APP_USER_MODEL_ID, detectBuildKind, resolveAppIdentity, samePath };
