// @vitest-environment node
/// <reference types="node" />
/**
 * The desktop shell tells the installed app apart from test builds (desktop/app-identity.js),
 * loaded as it ships: plain CommonJS with no Electron in it. Only the installed copy may use
 * the app's taskbar ID and Electron's notifications, which rewrite the Start Menu shortcut.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type * as Identity from '../../../desktop/app-identity';

const load = createRequire(import.meta.url);
const { APP_USER_MODEL_ID, resolveAppIdentity, samePath } = load('../../../desktop/app-identity.js') as typeof Identity;

const INSTALLED = 'C:\\Users\\someone\\AppData\\Local\\Programs\\datasetto-desktop\\Datasetto.exe';
const UNINSTALLER = 'C:\\Users\\someone\\AppData\\Local\\Programs\\datasetto-desktop\\Uninstall Datasetto.exe';
const SCRATCH = 'C:\\Users\\someone\\AppData\\Local\\Temp\\scratch\\desktop-out\\win-unpacked\\Datasetto.exe';
const PORTABLE = 'C:\\Users\\someone\\AppData\\Local\\Temp\\2Kq8Tz\\Datasetto.exe';
const DEV = 'C:\\src\\datasetto\\desktop\\node_modules\\electron\\dist\\electron.exe';

/** A file system that only has the installed app's uninstaller. */
const installedPc = (file: string): boolean => file === UNINSTALLER;

describe('desktop app identity', () => {
  it('gives the installed app the ID its Start Menu shortcut and pin carry, and notifications', () => {
    const identity = resolveAppIdentity({ platform: 'win32', isPackaged: true, execPath: INSTALLED, env: {}, fileExists: installedPc });
    expect(identity).toEqual({ kind: 'installed', appUserModelId: 'com.datasetto.desktop', titleSuffix: '', nativeNotifications: true });
    expect(APP_USER_MODEL_ID).toBe('com.datasetto.desktop');
  });

  it('keeps an unpacked test build off the installed app: own ID, no notifications, labelled title', () => {
    const asked: string[] = [];
    const identity = resolveAppIdentity({
      platform: 'win32',
      isPackaged: true,
      execPath: SCRATCH,
      env: {},
      fileExists: (file) => {
        asked.push(file);
        return installedPc(file);
      },
    });
    expect(identity).toEqual({ kind: 'unpacked', appUserModelId: 'com.datasetto.desktop.dev', titleSuffix: ' (test build)', nativeNotifications: false });
    expect(asked).toEqual(['C:\\Users\\someone\\AppData\\Local\\Temp\\scratch\\desktop-out\\win-unpacked\\Uninstall Datasetto.exe']);
  });

  it('treats electron . as a dev run on every platform, with notifications only outside Windows', () => {
    const windows = resolveAppIdentity({ platform: 'win32', isPackaged: false, execPath: DEV, env: {}, fileExists: () => true });
    expect(windows).toEqual({ kind: 'dev', appUserModelId: 'com.datasetto.desktop.dev', titleSuffix: ' (dev)', nativeNotifications: false });
    const mac = resolveAppIdentity({ platform: 'darwin', isPackaged: false, execPath: '/src/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', fileExists: () => false });
    expect(mac.kind).toBe('dev');
    expect(mac.nativeNotifications).toBe(true);
  });

  it('counts packaged builds outside Windows as installed', () => {
    const linux = resolveAppIdentity({ platform: 'linux', isPackaged: true, execPath: '/opt/Datasetto/datasetto', fileExists: () => false });
    expect(linux).toMatchObject({ kind: 'installed', titleSuffix: '', nativeNotifications: true });
  });

  describe('portable exe', () => {
    const portable = (startMenuTarget: () => string | null) =>
      resolveAppIdentity({
        platform: 'win32',
        isPackaged: true,
        execPath: PORTABLE,
        env: { PORTABLE_EXECUTABLE_DIR: 'C:\\Users\\someone\\Downloads' },
        fileExists: () => true,
        startMenuTarget,
      });

    it('has its own ID and no title label', () => {
      expect(portable(() => null)).toMatchObject({ kind: 'portable', appUserModelId: 'com.datasetto.desktop.portable', titleSuffix: '' });
    });

    it('keeps notifications on a PC without another copy, or when the shortcut is already its own', () => {
      expect(portable(() => null).nativeNotifications).toBe(true);
      expect(portable(() => PORTABLE.toLowerCase()).nativeNotifications).toBe(true);
    });

    it("never takes over the installed app's shortcut, or one it cannot read", () => {
      expect(portable(() => INSTALLED).nativeNotifications).toBe(false);
      expect(portable(() => SCRATCH).nativeNotifications).toBe(false);
      expect(portable(() => '').nativeNotifications).toBe(false);
      expect(
        portable(() => {
          throw new Error('Failed to read shortcut link');
        }).nativeNotifications,
      ).toBe(false);
    });
  });

  it('compares Windows paths without case', () => {
    expect(samePath('C:\\A\\Datasetto.exe', 'c:\\a\\datasetto.EXE')).toBe(true);
    expect(samePath('C:\\A\\Datasetto.exe', 'C:\\B\\Datasetto.exe')).toBe(false);
    expect(samePath('', '')).toBe(false);
    expect(samePath(null, 'C:\\A\\Datasetto.exe')).toBe(false);
  });
});
