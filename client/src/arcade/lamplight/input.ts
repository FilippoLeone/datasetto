/**
 * Keyboard and gamepad (lamplight.md §14.5). Keys work only while the stage has focus, never while a
 * text field has it, and never bind the push-to-talk key or the app shortcuts: when push-to-talk is
 * one of these keys its binding is dropped and the hint shows the other key. The gamepad is read only
 * on your turn, by the 10 Hz turn-ring timer, and only after a `gamepadconnected` event.
 */
import { isReservedKey, isTyping } from '../runtime/input/keyboard';
import type { KeyBinding } from '../runtime/types';

export type Command = 'fold' | 'call' | 'raise' | 'up' | 'down' | 'upPot' | 'downPot' | 'confirm' | 'allin' | 'history' | 'close';

const KEYS: Readonly<Record<string, Command>> = {
  KeyF: 'fold',
  KeyC: 'call',
  Space: 'call',
  KeyR: 'raise',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Enter: 'confirm',
  NumpadEnter: 'confirm',
  KeyA: 'allin',
  KeyH: 'history',
  Escape: 'close',
};

export interface Keys {
  /** Hint labels with any key push-to-talk took away left out. */
  hints(): { call: string; fold: string; raise: string };
  dispose(): void;
}

export const createKeys = (el: HTMLElement, o: { ptt: KeyBinding | null; reserved: readonly KeyBinding[]; on(cmd: Command): void }): Keys => {
  // Bindings that push-to-talk (or another app shortcut) takes away: the same key with no Ctrl, Alt or Meta.
  const taken = new Set<string>();
  for (const k of [o.ptt, ...o.reserved]) if (k && !k.ctrl && !k.alt && !k.meta && KEYS[k.code]) taken.add(k.code);
  const onKey = (e: KeyboardEvent): void => {
    if (e.repeat && e.code !== 'ArrowUp' && e.code !== 'ArrowDown') return;
    if (isTyping(e.target) && e.code !== 'Escape' && e.code !== 'Enter') return;
    if (taken.has(e.code)) return;
    // Escape on the stage is ours (it closes a sheet); everything else goes through the app's reserved-key rule.
    if (e.code === 'Escape' ? e.ctrlKey || e.altKey || e.metaKey : isReservedKey(e, o.ptt, o.reserved)) return;
    let cmd = KEYS[e.code];
    if (!cmd) return;
    if (e.shiftKey && cmd === 'up') cmd = 'upPot';
    if (e.shiftKey && cmd === 'down') cmd = 'downPot';
    e.preventDefault();
    o.on(cmd);
  };
  el.addEventListener('keydown', onKey);
  return {
    hints() {
      const pick = (codes: string[], labels: string[]): string => labels.filter((_, i) => !taken.has(codes[i])).join(' / ') || 'button';
      return { call: pick(['KeyC', 'Space'], ['C', 'Space']), fold: pick(['KeyF'], ['F']), raise: pick(['KeyR'], ['R']) };
    },
    dispose() {
      el.removeEventListener('keydown', onKey);
    },
  };
};

export interface Pad {
  /** Read the pad (called by the 10 Hz ring timer on your turn). */
  poll(now: number): void;
  readonly connected: boolean;
  dispose(): void;
}

const DEAD = 0.3;

/** Standard mapping: A check/call, B fold, X raise sheet, LB/RB amount, Y held 1 s all-in. */
export const createPad = (o: { on(cmd: Command): void }): Pad => {
  let connected = false;
  let prev = 0;
  let yDownAt = 0;
  const onConnect = (): void => {
    connected = true;
  };
  window.addEventListener('gamepadconnected', onConnect);
  return {
    get connected() {
      return connected;
    },
    poll(now) {
      if (!connected || typeof navigator.getGamepads !== 'function') return;
      const pad = Array.from(navigator.getGamepads()).find((p) => p && p.mapping === 'standard');
      if (!pad) return;
      let bits = 0;
      pad.buttons.forEach((b, i) => {
        if (b.pressed || b.value > DEAD) bits |= 1 << i;
      });
      const pressed = bits & ~prev;
      prev = bits;
      if (pressed & 1) o.on('call');
      if (pressed & 2) o.on('fold');
      if (pressed & 4) o.on('raise');
      if (pressed & 16) o.on('down');
      if (pressed & 32) o.on('up');
      if (bits & 8) {
        if (!yDownAt) yDownAt = now;
        else if (now - yDownAt >= 1000) {
          yDownAt = 0;
          prev |= 8;
          o.on('allin');
          o.on('allin');
        }
      } else yDownAt = 0;
    },
    dispose() {
      window.removeEventListener('gamepadconnected', onConnect);
    },
  };
};
