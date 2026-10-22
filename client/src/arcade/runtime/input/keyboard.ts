/**
 * Keyboard source. Listeners sit on the game element only, so keys are captured only while it (or
 * something inside it) has the focus. Reserved keys and keys typed into a text field pass through
 * untouched; bound keys get preventDefault so the page does not scroll.
 */
import { shortcutMatchesEvent } from '@/lib/shortcut';
import type { KeyBinding, KeyMap } from '../types';
import { on, type Off } from './map';

/** Targets of live inputs: inside one, Escape is the menu key; anywhere else it is the app's. */
const targets: Node[] = [];

const NON_TEXT = /^(checkbox|radio|range|file|button|submit|reset|color|image)$/;

/**
 * The `isTyping` guard: a text field has the key. Same rule as lib/keyboard.ts `isTextEntry` (copied,
 * because that module imports app state), plus `select`.
 */
export const isTyping = (t: EventTarget | null): boolean => {
  const el = t as HTMLInputElement | null;
  const tag = el?.tagName;
  return tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !NON_TEXT.test(el!.type)) || el?.isContentEditable === true;
};

/**
 * Never bound: the push-to-talk shortcut, any other app shortcut in `reserved` (the clip key, which
 * Settings can make a bare key), any key with Ctrl, Alt or Meta held (Ctrl+K, Ctrl+Shift+M/D/comma,
 * Alt+C, Ctrl+Shift+I…), F12, and Escape outside every live game element.
 */
export function isReservedKey(e: KeyboardEvent, ptt: KeyBinding | null, reserved: readonly KeyBinding[] = []): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey || e.code === 'F12') return true;
  const phase = e.type === 'keyup' ? 'up' : 'down';
  if (ptt && shortcutMatchesEvent(ptt, e, phase)) return true;
  if (reserved.some((key) => shortcutMatchesEvent(key, e, phase))) return true;
  if (e.code !== 'Escape') return false;
  const n = e.target;
  return !(n instanceof Node && targets.some((t) => t.contains(n)));
}

/** Wires the keyboard to `set` (the bits held now); returns `release`, which lets go of every key. */
export const createKeyboard = (target: HTMLElement, keys: KeyMap, ptt: KeyBinding | null, reserved: readonly KeyBinding[], set: (bits: number) => void, offs: Off[]): Off => {
  const down = new Map<string, number>();
  const update = () => {
    let bits = 0;
    for (const v of down.values()) bits |= v;
    set(bits);
  };
  const release = () => {
    down.clear();
    set(0);
  };
  const focusable = target.hasAttribute('tabindex');
  if (!focusable) target.tabIndex = 0;
  targets.push(target);

  on<KeyboardEvent>(
    target,
    'keydown',
    (e) => {
      const bits = keys[e.code];
      if (!bits || e.isComposing || isTyping(e.target) || isReservedKey(e, ptt, reserved)) return;
      e.preventDefault();
      // Held already: a repeat (or a second keydown) is not a new press.
      if (down.has(e.code)) return;
      down.set(e.code, bits);
      update();
    },
    offs,
  );
  // A release always counts, whatever the modifiers or the focused field.
  on<KeyboardEvent>(target, 'keyup', (e) => down.delete(e.code) && update(), offs);
  // The focus left the game element (not just moved inside it).
  on<FocusEvent>(target, 'focusout', (e) => !target.contains(e.relatedTarget as Node | null) && release(), offs);
  offs.push(() => {
    targets.splice(targets.indexOf(target), 1);
    if (!focusable) target.removeAttribute('tabindex');
  });
  return release;
};
