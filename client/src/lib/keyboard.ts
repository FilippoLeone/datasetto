import { isIOS, isTouchPrimary } from '@/lib/device';
import { keyboardOpen } from '@/state/ui';

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'range', 'file', 'button', 'submit', 'reset', 'color', 'image']);

/** True for an element that brings up the on-screen keyboard when focused. */
export const isTextEntry = (element: Element | null): boolean => {
  if (!element) return false;
  if (element.tagName === 'TEXTAREA') return true;
  if (element.tagName === 'INPUT') return !NON_TEXT_INPUTS.has((element as HTMLInputElement).type);
  return (element as HTMLElement).isContentEditable === true;
};

/**
 * The viewport is much shorter than the screen: the keyboard is up. Android
 * Chrome (`interactive-widget=resizes-content`) and the Capacitor shell shrink
 * the layout viewport, iOS Safari only the visual one, so the smaller wins.
 */
export const viewportShrunk = (): boolean => {
  const screenHeight = typeof screen !== 'undefined' ? screen.height : 0;
  if (!screenHeight) return true;
  const visual = window.visualViewport?.height ?? Number.POSITIVE_INFINITY;
  const height = Math.min(window.innerHeight, visual);
  return height < screenHeight * 0.78;
};

/** Pure form of the decision, for tests. */
export const keyboardIsOpen = (touch: boolean, focusedTextField: boolean, shrunk: boolean): boolean => touch && focusedTextField && shrunk;

/**
 * iOS Safari does not shrink the layout viewport for the keyboard (it ignores
 * `interactive-widget`): the visual viewport gets shorter and the page is scrolled
 * so the focused field stays in view, which pushes the header off the top and
 * leaves fixed elements where the keyboard is. While a text field has the focus
 * and the visual viewport is at least this much shorter than the layout viewport,
 * the app root is given the visual viewport's height and offset instead.
 */
export const KEYBOARD_MIN_PX = 100;

export interface ViewportPin {
  /** Height the app root should take, in CSS pixels. */
  height: number;
  /** How far the visual viewport is scrolled down inside the layout viewport. */
  offsetTop: number;
}

/**
 * Pure form of the iOS keyboard fit: null leaves the root at 100 %, otherwise the
 * height and offset to apply. Only while a text field is focused, so pinch zoom
 * (which also shrinks the visual viewport) never moves the layout.
 */
export const visualViewportPin = (input: { focusedTextField: boolean; layoutHeight: number; visualHeight: number; visualOffsetTop: number }): ViewportPin | null => {
  if (!input.focusedTextField) return null;
  if (!Number.isFinite(input.visualHeight) || input.visualHeight <= 0) return null;
  if (input.layoutHeight - input.visualHeight < KEYBOARD_MIN_PX) return null;
  return { height: Math.round(input.visualHeight), offsetTop: Math.max(0, Math.round(input.visualOffsetTop)) };
};

const applyPin = (root: HTMLElement, pin: ViewportPin | null): void => {
  if (!pin) {
    if (root.dataset.keyboardPinned === undefined) return;
    delete root.dataset.keyboardPinned;
    root.style.removeProperty('height');
    root.style.removeProperty('transform');
    return;
  }
  root.dataset.keyboardPinned = 'true';
  root.style.height = pin.height + 'px';
  root.style.transform = pin.offsetTop > 0 ? 'translateY(' + pin.offsetTop + 'px)' : '';
};

/**
 * Keeps `keyboardOpen` (state/ui.ts) current on touch screens: a text field
 * has the focus and the viewport shrank. The bottom toolbar hides meanwhile
 * so the composer gets the room. On iPhone and iPad the app root also follows
 * the visual viewport (see `visualViewportPin`). Idempotent.
 */
let installed = false;
export const installKeyboardTracking = (): void => {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  let timer: number | null = null;
  const pinned = isIOS();
  const update = () => {
    timer = null;
    const focused = isTextEntry(document.activeElement);
    const next = keyboardIsOpen(isTouchPrimary(), focused, viewportShrunk());
    if (keyboardOpen.value !== next) keyboardOpen.value = next;
    const root = document.getElementById('app');
    const visual = window.visualViewport;
    if (!pinned || !root || !visual) return;
    const pin = visualViewportPin({ focusedTextField: focused, layoutHeight: window.innerHeight, visualHeight: visual.height, visualOffsetTop: visual.offsetTop });
    applyPin(root, pin);
    // Safari scrolled the page to show the field; with the root fitted to the visual viewport that scroll is only an offset.
    if (pin && (window.scrollY !== 0 || visual.offsetTop !== 0)) window.scrollTo(0, 0);
  };
  // The keyboard animates in after the focus: look again once it is up.
  const later = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(update, 120);
  };
  document.addEventListener('focusin', () => {
    update();
    later();
  });
  document.addEventListener('focusout', later);
  window.addEventListener('resize', update);
  window.visualViewport?.addEventListener('resize', update);
  window.visualViewport?.addEventListener('scroll', update);
};
