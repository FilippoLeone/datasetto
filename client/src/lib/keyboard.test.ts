import { describe, expect, it } from 'vitest';
import { isTextEntry, KEYBOARD_MIN_PX, keyboardIsOpen, visualViewportPin } from './keyboard';

describe('keyboardIsOpen', () => {
  it('needs a touch screen, a focused text field and a shrunken viewport', () => {
    expect(keyboardIsOpen(true, true, true)).toBe(true);
    expect(keyboardIsOpen(false, true, true)).toBe(false);
    expect(keyboardIsOpen(true, false, true)).toBe(false);
    expect(keyboardIsOpen(true, true, false)).toBe(false);
  });

  it('knows which elements bring the keyboard up', () => {
    const textarea = document.createElement('textarea');
    const text = document.createElement('input');
    const range = document.createElement('input');
    range.type = 'range';
    const button = document.createElement('button');
    const editable = document.createElement('div');
    expect(isTextEntry(textarea)).toBe(true);
    expect(isTextEntry(text)).toBe(true);
    expect(isTextEntry(range)).toBe(false);
    expect(isTextEntry(button)).toBe(false);
    expect(isTextEntry(editable)).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

describe('visualViewportPin (iOS keyboard)', () => {
  const portrait = { focusedTextField: true, layoutHeight: 844, visualHeight: 844, visualOffsetTop: 0 };

  it('leaves the root alone while no text field has the focus', () => {
    expect(visualViewportPin({ ...portrait, focusedTextField: false, visualHeight: 500, visualOffsetTop: 300 })).toBeNull();
  });

  it('leaves the root alone when the visual viewport is (nearly) the layout viewport', () => {
    expect(visualViewportPin(portrait)).toBeNull();
    expect(visualViewportPin({ ...portrait, visualHeight: 844 - KEYBOARD_MIN_PX + 1 })).toBeNull();
  });

  it('fits the root to the visual viewport once the keyboard is up', () => {
    // iPhone 12 in Safari: 336 px keyboard, the page scrolled by the same amount.
    expect(visualViewportPin({ ...portrait, visualHeight: 508, visualOffsetTop: 336 })).toEqual({ height: 508, offsetTop: 336 });
    // Home-screen app: no scroll offset, only the height changes.
    expect(visualViewportPin({ ...portrait, visualHeight: 508.4, visualOffsetTop: 0 })).toEqual({ height: 508, offsetTop: 0 });
    // Landscape iPhone with the keyboard covering most of the screen.
    expect(visualViewportPin({ focusedTextField: true, layoutHeight: 390, visualHeight: 180, visualOffsetTop: 210 })).toEqual({ height: 180, offsetTop: 210 });
  });

  it('never produces a negative offset or a pin without a height', () => {
    expect(visualViewportPin({ ...portrait, visualHeight: 500, visualOffsetTop: -4 })).toEqual({ height: 500, offsetTop: 0 });
    expect(visualViewportPin({ ...portrait, visualHeight: 0 })).toBeNull();
    expect(visualViewportPin({ ...portrait, visualHeight: Number.NaN })).toBeNull();
  });
});
