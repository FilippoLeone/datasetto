// @vitest-environment node
/// <reference types="node" />
/**
 * The desktop shell's screen-share picker never offers Datasetto's own helper windows
 * (desktop/picker/own-windows.js), loaded as it ships: plain CommonJS with no Electron in it.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type * as OwnWindows from '../../../desktop/picker/own-windows';

const load = createRequire(import.meta.url);
const ownWindows = load('../../../desktop/picker/own-windows.js') as typeof OwnWindows;

/** A little-endian native handle buffer like BrowserWindow.getNativeWindowHandle() returns on 64-bit Windows. */
const handleBuffer = (value: number): Buffer => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
};

/**
 * What desktopCapturer.getSources() returned on Windows 11 with the installed Datasetto in a
 * voice channel (overlay on) next to a test build of the app: the other copy's overlay comes
 * first because it is always on top. Ids and Datasetto titles as recorded, other windows renamed.
 */
const RECORDED_SOURCES = [
  { id: 'screen:0:0', name: 'Screen 1' },
  { id: 'screen:1:0', name: 'Screen 2' },
  { id: 'window:919182:0', name: 'Datasetto voice overlay' },
  { id: 'window:133670:1', name: 'Datasetto' },
  { id: 'window:198888:0', name: 'A game' },
  { id: 'window:1443262:0', name: 'A web page — Mozilla Firefox' },
  { id: 'window:786886:0', name: 'Datasetto – app' },
];

describe('window handles in capture source ids', () => {
  it('reads the handle of a window source and nothing else', () => {
    expect(ownWindows.windowHandleOf('window:919182:0')).toBe('919182');
    expect(ownWindows.windowHandleOf('window:1050030:2')).toBe('1050030');
    expect(ownWindows.windowHandleOf('screen:0:0')).toBeNull();
    expect(ownWindows.windowHandleOf('window:0:0')).toBeNull();
    expect(ownWindows.windowHandleOf('window::0')).toBeNull();
    expect(ownWindows.windowHandleOf(undefined)).toBeNull();
  });

  it('turns a native handle buffer into the same number', () => {
    expect(ownWindows.nativeHandleToString(handleBuffer(1050030))).toBe('1050030');
    const small = Buffer.alloc(4);
    small.writeUInt32LE(919182);
    expect(ownWindows.nativeHandleToString(small)).toBe('919182');
    expect(ownWindows.nativeHandleToString(Buffer.alloc(8))).toBeNull();
    expect(ownWindows.nativeHandleToString(null)).toBeNull();
  });
});

describe('the picker leaves out the picker and the voice overlay', () => {
  it("drops another running copy's overlay, which used to be the first window", () => {
    const names = ownWindows.withoutHelperWindows(RECORDED_SOURCES, []).map((source) => source.name);
    expect(names).not.toContain('Datasetto voice overlay');
    expect(names.filter((name) => !name.startsWith('Screen'))[0]).toBe('Datasetto');
    // The app's main windows (this copy's and the other one's) can still be shared.
    expect(names).toEqual(['Screen 1', 'Screen 2', 'Datasetto', 'A game', 'A web page — Mozilla Firefox', 'Datasetto – app']);
  });

  it("drops this app's own windows by handle even when the trailing number differs", () => {
    const sources = [
      { id: 'window:1050030:0', name: 'Overlay under another title' },
      { id: 'window:1902596:0', name: 'Picker under another title' },
      { id: 'window:198888:0', name: 'A game' },
    ];
    const own = [
      { mediaSourceId: 'window:1050030:2', nativeHandle: null },
      { mediaSourceId: null, nativeHandle: handleBuffer(1902596) },
    ];
    expect(ownWindows.withoutHelperWindows(sources, own).map((source) => source.id)).toEqual(['window:198888:0']);
  });

  it('matches titles exactly, on windows only', () => {
    const sources = [
      { id: 'window:5:0', name: 'Share your screen' },
      { id: 'window:6:0', name: '  Datasetto voice overlay ' },
      { id: 'window:7:0', name: 'Datasetto voice overlay — Mozilla Firefox' },
      { id: 'window:8:0', name: 'How to share your screen' },
      { id: 'screen:2:0', name: 'Datasetto voice overlay' },
    ];
    expect(ownWindows.withoutHelperWindows(sources, []).map((source) => source.id)).toEqual(['window:7:0', 'window:8:0', 'screen:2:0']);
  });

  it('ignores closed or unreadable windows instead of dropping everything', () => {
    const sources = [
      { id: 'window:0:0', name: 'Odd window' },
      { id: 'window:42:0', name: 'Notes' },
    ];
    const own = [null, undefined, { mediaSourceId: '', nativeHandle: Buffer.alloc(8) }, { mediaSourceId: 'window:0:0' }];
    // The exact id still matches; a zero handle never does.
    expect(ownWindows.withoutHelperWindows(sources, own).map((source) => source.id)).toEqual(['window:42:0']);
    expect(ownWindows.withoutHelperWindows(sources, [null]).map((source) => source.id)).toEqual(['window:0:0', 'window:42:0']);
  });

  it('uses the titles the helper pages really have', () => {
    const titleOf = (page: string) => /<title>([^<]*)<\/title>/.exec(readFileSync(new URL(page, import.meta.url), 'utf8'))?.[1];
    expect(titleOf('../../../desktop/overlay/index.html')).toBe(ownWindows.OVERLAY_TITLE);
    expect(titleOf('../../../desktop/picker/index.html')).toBe(ownWindows.PICKER_TITLE);
    expect(ownWindows.HELPER_WINDOW_TITLES).toEqual([ownWindows.OVERLAY_TITLE, ownWindows.PICKER_TITLE]);
  });
});
