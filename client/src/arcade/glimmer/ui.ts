/**
 * Tiny DOM helpers for the framework-free hall chrome (glimmerhall.md §12.2, §12.5): elements are
 * built once; buttons act on `pointerup` inside the button (a `pointercancel` cancels) and on
 * keyboard activation.
 */

export type Off = () => void;

export const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

export const listen = <E extends Event>(t: EventTarget, type: string, fn: (e: E) => void, offs: Off[], opts?: AddEventListenerOptions): void => {
  const l = fn as EventListener;
  t.addEventListener(type, l, opts);
  offs.push(() => t.removeEventListener(type, l, opts));
};

/**
 * Calls `fn` when a press starts and ends inside `btn` (touch, pen, mouse), or on keyboard
 * activation (a click with no pointer). A `pointercancel` or leaving the button cancels.
 */
export const onTap = (btn: HTMLElement, fn: () => void, offs: Off[]): void => {
  let armed = -1;
  listen<PointerEvent>(btn, 'pointerdown', (e) => {
    if (e.button !== 0) return;
    armed = e.pointerId;
  }, offs);
  listen<PointerEvent>(btn, 'pointerup', (e) => {
    if (armed !== e.pointerId) return;
    armed = -1;
    const r = btn.getBoundingClientRect();
    const inside = r.width === 0 || (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom);
    if (inside && !(btn as HTMLButtonElement).disabled) fn();
  }, offs);
  listen(btn, 'pointercancel', () => (armed = -1), offs);
  listen(btn, 'pointerleave', () => (armed = -1), offs);
  // Keyboard activation (Enter or Space on a focused button) arrives as a click without a pointer.
  listen<MouseEvent>(btn, 'click', (e) => {
    if (e.detail === 0 && !(btn as HTMLButtonElement).disabled) fn();
  }, offs);
};

export const button = (cls: string, text: string, label?: string): HTMLButtonElement => {
  const b = h('button', cls, text);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  return b;
};

/** 15240 → "15,240". */
export const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

/** "×62" for a win of 62 × the bet, one decimal under 10. */
export const times = (win: number, bet: number): string => {
  const x = win / Math.max(1, bet);
  return '×' + (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10);
};

export const signed = (n: number): string => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n));

/** A stable colour for an avatar initial. */
export const hueOf = (key: string): string => {
  let x = 7;
  for (let i = 0; i < key.length; i += 1) x = (x * 31 + key.charCodeAt(i)) >>> 0;
  return 'hsl(' + (x % 360) + ' 60% 62%)';
};

export const setText = (el: HTMLElement, text: string): void => {
  if (el.textContent !== text) el.textContent = text;
};
