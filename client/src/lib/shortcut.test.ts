import { describe, expect, it } from 'vitest';
import {
  describeKey,
  formatShortcut,
  isBareTypingKey,
  parseShortcut,
  serializeShortcut,
  shortcutFromEvent,
  shortcutMatchesEvent,
  toElectronAccelerator,
  type Shortcut,
} from './shortcut';

const key = (code: string, mods: Partial<Omit<Shortcut, 'code'>> = {}): Shortcut => ({ code, ctrl: false, shift: false, alt: false, meta: false, ...mods });
const event = (code: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe('shortcut parsing and serialising', () => {
  it('reads the old bare KeyboardEvent.code and round-trips', () => {
    expect(parseShortcut('KeyV')).toEqual(key('KeyV'));
    expect(parseShortcut('Space')).toEqual(key('Space'));
    expect(serializeShortcut(key('F13'))).toBe('F13');
  });

  it('parses and serialises modifiers in a fixed order', () => {
    expect(parseShortcut('Shift+Ctrl+KeyV')).toEqual(key('KeyV', { ctrl: true, shift: true }));
    expect(serializeShortcut(key('KeyV', { ctrl: true, shift: true, alt: true, meta: true }))).toBe('Ctrl+Alt+Shift+Meta+KeyV');
    expect(parseShortcut(serializeShortcut(key('Digit1', { alt: true, meta: true })))).toEqual(key('Digit1', { alt: true, meta: true }));
  });

  it('treats empty and modifier-less garbage as no shortcut', () => {
    expect(parseShortcut('')).toBeNull();
    expect(parseShortcut(null)).toBeNull();
    expect(parseShortcut('Ctrl+Shift')).toBeNull();
    expect(parseShortcut('+')).toBeNull();
  });

  it('keeps a modifier-only shortcut free of its own flag', () => {
    expect(parseShortcut('Ctrl+ControlRight')).toEqual(key('ControlRight'));
    expect(serializeShortcut({ code: 'ShiftLeft', ctrl: false, shift: true, alt: false, meta: false })).toBe('ShiftLeft');
  });
});

describe('shortcut labels', () => {
  it('names keys the way a keyboard does', () => {
    expect(describeKey('KeyV', false)).toBe('V');
    expect(describeKey('Digit7', false)).toBe('7');
    expect(describeKey('Numpad4', false)).toBe('Num 4');
    expect(describeKey('NumpadAdd', false)).toBe('Num +');
    expect(describeKey('F13', false)).toBe('F13');
    expect(describeKey('ArrowUp', false)).toBe('Up');
    expect(describeKey('ControlRight', false)).toBe('Right Ctrl');
    expect(describeKey('MetaLeft', false)).toBe('Left Win');
    expect(describeKey('MetaLeft', true)).toBe('Left Cmd');
    expect(describeKey('AltLeft', true)).toBe('Left Option');
    expect(describeKey('BrowserBack', false)).toBe('Browser Back');
  });

  it('formats whole shortcuts', () => {
    expect(formatShortcut(key('KeyV', { ctrl: true, shift: true }), false)).toBe('Ctrl + Shift + V');
    expect(formatShortcut(key('Space'), false)).toBe('Space');
    expect(formatShortcut(key('ControlRight'), false)).toBe('Right Ctrl');
    expect(formatShortcut(key('KeyK', { meta: true, alt: true }), true)).toBe('Option + Cmd + K');
    expect(formatShortcut(null)).toBe('');
  });
});

describe('matching key events', () => {
  it('builds the shortcut from a key press with its modifiers', () => {
    expect(shortcutFromEvent(event('KeyV', { ctrlKey: true, shiftKey: true }))).toEqual(key('KeyV', { ctrl: true, shift: true }));
    // Pressing Ctrl itself: ctrlKey is true on that event but is not a separate modifier.
    expect(shortcutFromEvent(event('ControlLeft', { ctrlKey: true }))).toEqual(key('ControlLeft'));
  });

  it('requires the exact modifiers on press', () => {
    const plain = key('KeyV');
    expect(shortcutMatchesEvent(plain, event('KeyV'), 'down')).toBe(true);
    expect(shortcutMatchesEvent(plain, event('KeyV', { ctrlKey: true }), 'down')).toBe(false);
    expect(shortcutMatchesEvent(plain, event('KeyB'), 'down')).toBe(false);
    const combo = key('KeyV', { ctrl: true, shift: true });
    expect(shortcutMatchesEvent(combo, event('KeyV', { ctrlKey: true, shiftKey: true }), 'down')).toBe(true);
    expect(shortcutMatchesEvent(combo, event('KeyV', { ctrlKey: true }), 'down')).toBe(false);
  });

  it('matches the release on the key alone, whatever the modifiers do', () => {
    const combo = key('KeyV', { ctrl: true, shift: true });
    expect(shortcutMatchesEvent(combo, event('KeyV'), 'up')).toBe(true);
    expect(shortcutMatchesEvent(combo, event('ShiftLeft'), 'up')).toBe(false);
  });

  it('matches a modifier-only shortcut on both edges', () => {
    const ctrl = key('ControlRight');
    expect(shortcutMatchesEvent(ctrl, event('ControlRight', { ctrlKey: true }), 'down')).toBe(true);
    expect(shortcutMatchesEvent(ctrl, event('ControlRight', { ctrlKey: false }), 'up')).toBe(true);
    expect(shortcutMatchesEvent(ctrl, event('ControlLeft', { ctrlKey: true }), 'down')).toBe(false);
  });
});

describe('Electron accelerators', () => {
  it('maps letters, digits, function and named keys', () => {
    expect(toElectronAccelerator(key('KeyV', { ctrl: true, shift: true }))).toBe('Control+Shift+V');
    expect(toElectronAccelerator(key('Digit3', { alt: true }))).toBe('Alt+3');
    expect(toElectronAccelerator(key('F13'))).toBe('F13');
    expect(toElectronAccelerator(key('Space'))).toBe('Space');
    expect(toElectronAccelerator(key('Numpad0', { meta: true }))).toBe('Super+num0');
    expect(toElectronAccelerator(key('NumpadAdd'))).toBe('numadd');
    expect(toElectronAccelerator(key('ArrowLeft', { ctrl: true, alt: true, shift: true, meta: true }))).toBe('Control+Alt+Shift+Super+Left');
    expect(toElectronAccelerator(key('Backquote'))).toBe('`');
  });

  it('has none for modifier-only shortcuts and unknown keys', () => {
    expect(toElectronAccelerator(key('ControlRight'))).toBeNull();
    expect(toElectronAccelerator(key('ShiftLeft', { ctrl: true }))).toBeNull();
    expect(toElectronAccelerator(key('Pause'))).toBeNull();
    expect(toElectronAccelerator(key('F25'))).toBeNull();
    expect(toElectronAccelerator(null)).toBeNull();
  });
});

describe('bare typing keys', () => {
  it('flags keys other apps need for typing', () => {
    expect(isBareTypingKey(key('KeyV'))).toBe(true);
    expect(isBareTypingKey(key('Space'))).toBe(true);
    expect(isBareTypingKey(key('Digit1'))).toBe(true);
    expect(isBareTypingKey(key('KeyV', { shift: true }))).toBe(true);
    expect(isBareTypingKey(key('KeyV', { ctrl: true }))).toBe(false);
    expect(isBareTypingKey(key('F13'))).toBe(false);
    expect(isBareTypingKey(key('Numpad0'))).toBe(false);
    expect(isBareTypingKey(key('ControlRight'))).toBe(false);
    expect(isBareTypingKey(null)).toBe(false);
  });
});
