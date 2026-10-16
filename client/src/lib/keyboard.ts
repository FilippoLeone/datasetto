import { isTouchPrimary } from '@/lib/device';
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
 * Keeps `keyboardOpen` (state/ui.ts) current on touch screens: a text field
 * has the focus and the viewport shrank. The bottom toolbar hides meanwhile
 * so the composer gets the room. Idempotent.
 */
let installed = false;
export const installKeyboardTracking = (): void => {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  let timer: number | null = null;
  const update = () => {
    timer = null;
    const next = keyboardIsOpen(isTouchPrimary(), isTextEntry(document.activeElement), viewportShrunk());
    if (keyboardOpen.value !== next) keyboardOpen.value = next;
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
};
