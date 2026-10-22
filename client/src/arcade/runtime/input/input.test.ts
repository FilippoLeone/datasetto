import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyBinding } from '../types';
import { ACT, createInput, DEFAULT_KEYS, DEFAULT_TOUCH, isReservedKey, type Input, type InputSample, type TouchLayout } from './index';
import { isTyping } from './keyboard';

const PTT: KeyBinding = { code: 'KeyV', ctrl: false, shift: false, alt: false, meta: false };
/** The defaults plus every reserved key's base key, so a binding would show up as bits. */
const KEYS = { ...DEFAULT_KEYS, KeyV: ACT.a, KeyM: ACT.a, Comma: ACT.a, KeyC: ACT.a, KeyI: ACT.a, F12: ACT.a };

let target: HTMLElement;
let outside: HTMLElement;
let input: Input | null = null;

const make = (o: { touch?: TouchLayout | null; gamepad?: boolean } = {}): Input =>
  (input = createInput(target, { keys: KEYS, ptt: PTT, touch: o.touch ?? null, gamepad: o.gamepad ?? false }));

const key = (el: EventTarget, type: 'keydown' | 'keyup', code: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const e = new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
};

const ptr = (el: Element, type: string, pointerId: number, clientX = 0, clientY = 0): void => {
  el.dispatchEvent(new PointerEvent(type, { pointerId, clientX, clientY, bubbles: true, cancelable: true }));
};

const bits = (s: InputSample) => [s.held, s.pressed];

beforeEach(() => {
  target = document.createElement('div');
  outside = document.createElement('div');
  document.body.append(target, outside);
});

afterEach(() => {
  input?.dispose();
  input = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('keyboard', () => {
  it.each([
    ['the push-to-talk key', 'KeyV', {}],
    ['Ctrl+K', 'KeyK', { ctrlKey: true }],
    ['Ctrl+Shift+M', 'KeyM', { ctrlKey: true, shiftKey: true }],
    ['Ctrl+Shift+D', 'KeyD', { ctrlKey: true, shiftKey: true }],
    ['Ctrl+Shift+Comma', 'Comma', { ctrlKey: true, shiftKey: true }],
    ['Alt+C', 'KeyC', { altKey: true }],
    ['Ctrl+Shift+I', 'KeyI', { ctrlKey: true, shiftKey: true }],
    ['Cmd+K', 'KeyK', { metaKey: true }],
    ['F12', 'F12', {}],
  ])('never binds %s', (_, code, init) => {
    const s = make();
    const e = key(target, 'keydown', code, init);
    expect(isReservedKey(e, PTT)).toBe(true);
    expect(e.defaultPrevented).toBe(false);
    key(target, 'keyup', code, init);
    expect(bits(s.sample())).toEqual([0, 0]);
  });

  it('leaves Escape outside the game element to the app, and makes it the menu key inside', () => {
    const s = make();
    const out = key(outside, 'keydown', 'Escape');
    expect(isReservedKey(out, PTT)).toBe(true);
    expect(out.defaultPrevented).toBe(false);
    expect(bits(s.sample())).toEqual([0, 0]);

    const child = document.createElement('canvas');
    target.append(child);
    const inside = key(child, 'keydown', 'Escape');
    expect(isReservedKey(inside, PTT)).toBe(false);
    expect(inside.defaultPrevented).toBe(true);
    expect(bits(s.sample())).toEqual([ACT.menu, ACT.menu]);

    s.dispose();
    expect(isReservedKey(inside, PTT)).toBe(true);
  });

  it('a push-to-talk shortcut with modifiers leaves the bare key bound', () => {
    const ptt: KeyBinding = { code: 'Space', ctrl: false, shift: true, alt: false, meta: false };
    expect(isReservedKey(new KeyboardEvent('keydown', { code: 'Space', shiftKey: true }), ptt)).toBe(true);
    expect(isReservedKey(new KeyboardEvent('keydown', { code: 'Space' }), ptt)).toBe(false);
    expect(isReservedKey(new KeyboardEvent('keydown', { code: 'Space' }), null)).toBe(false);
  });

  it('ignores keys typed into a text field inside the game element', () => {
    const s = make();
    const field = document.createElement('input');
    const area = document.createElement('textarea');
    const box = document.createElement('input');
    box.type = 'checkbox';
    target.append(field, area, box);
    for (const el of [field, area]) {
      const e = key(el, 'keydown', 'KeyW');
      expect(e.defaultPrevented).toBe(false);
      key(el, 'keyup', 'KeyW');
    }
    expect(bits(s.sample())).toEqual([0, 0]);
    expect(isTyping(box)).toBe(false);
    expect(isTyping(target)).toBe(false);
    expect(isTyping(null)).toBe(false);
  });

  it('binds the defaults with preventDefault, and listens on the game element only', () => {
    const s = make();
    const e = key(target, 'keydown', 'ArrowDown');
    expect(e.defaultPrevented).toBe(true);
    key(target, 'keydown', 'KeyL');
    key(target, 'keydown', 'ShiftLeft', { shiftKey: true });
    key(target, 'keydown', 'KeyJ', { shiftKey: true });
    expect(s.sample().held).toBe(ACT.down | ACT.swap | ACT.b | ACT.a);
    // Not bound: passes untouched.
    expect(key(target, 'keydown', 'KeyQ').defaultPrevented).toBe(false);
    // Outside the element nothing is seen.
    key(outside, 'keydown', 'KeyW');
    expect(s.sample().held & ACT.up).toBe(0);
  });

  it('latches a tap between two samples: pressed once, never held', () => {
    const s = make();
    key(target, 'keydown', 'Space');
    key(target, 'keyup', 'Space');
    expect(bits(s.sample())).toEqual([0, ACT.a]);
    expect(bits(s.sample())).toEqual([0, 0]);
  });

  it('does not re-press on key repeat, and keeps a bit held while another key holds it', () => {
    const s = make();
    key(target, 'keydown', 'KeyW');
    expect(bits(s.sample())).toEqual([ACT.up, ACT.up]);
    expect(key(target, 'keydown', 'KeyW', { repeat: true }).defaultPrevented).toBe(true);
    expect(bits(s.sample())).toEqual([ACT.up, 0]);
    key(target, 'keydown', 'ArrowUp');
    key(target, 'keyup', 'KeyW');
    expect(bits(s.sample())).toEqual([ACT.up, 0]);
    key(target, 'keyup', 'ArrowUp', { ctrlKey: true });
    expect(bits(s.sample())).toEqual([0, 0]);
  });

  it('releases every key on window blur and when the focus leaves the element', () => {
    const s = make();
    key(target, 'keydown', 'KeyD');
    window.dispatchEvent(new FocusEvent('blur'));
    expect(bits(s.sample())).toEqual([0, ACT.right]);

    const child = document.createElement('button');
    target.append(child);
    key(target, 'keydown', 'KeyA');
    child.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: target }));
    expect(s.sample().held).toBe(ACT.left);
    target.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outside }));
    expect(s.sample().held).toBe(0);
  });

  it('makes the element focusable and restores it on dispose', () => {
    make().dispose();
    expect(target.hasAttribute('tabindex')).toBe(false);
    make();
    expect(target.tabIndex).toBe(0);
    input!.dispose();
    expect(target.hasAttribute('tabindex')).toBe(false);
    target.tabIndex = -1;
    make().dispose();
    expect(target.getAttribute('tabindex')).toBe('-1');
  });
});

describe('touch', () => {
  const stickOf = () => target.querySelector('[data-stick]')!;
  const button = (id: string) => target.querySelector<HTMLElement>(`[data-btn="${id}"]`)!;

  it('floating stick: dead zone 12 px, magnitude 1 at 48 px, clamped beyond, direction bits', () => {
    const s = make({ touch: DEFAULT_TOUCH });
    const stick = stickOf();
    ptr(stick, 'pointerdown', 1, 100, 100);
    ptr(stick, 'pointermove', 1, 111, 100);
    let v = s.sample();
    expect([v.stickX, v.stickY, v.held, v.pressed]).toEqual([0, 0, 0, 0]);

    ptr(stick, 'pointermove', 1, 148, 100);
    v = s.sample();
    expect(v.stickX).toBeCloseTo(1);
    expect(v.stickY).toBe(0);
    expect(bits(v)).toEqual([ACT.right, ACT.right]);

    ptr(stick, 'pointermove', 1, 100 + 34, 100 - 34);
    v = s.sample();
    expect(Math.hypot(v.stickX, v.stickY)).toBeCloseTo(1, 5);
    expect(v.held).toBe(ACT.up | ACT.right);

    // Past the radius: clamped, and the origin follows the finger (now at 100, 48).
    ptr(stick, 'pointerup', 1);
    ptr(stick, 'pointerdown', 1, 100, 100);
    ptr(stick, 'pointermove', 1, 100, 0);
    v = s.sample();
    expect([v.stickX, v.stickY]).toEqual([0, -1]);
    expect(v.held).toBe(ACT.up);
    ptr(stick, 'pointermove', 1, 100, 48 + 30);
    v = s.sample();
    expect(v.stickY).toBeCloseTo((30 - 12) / 36);
    expect(v.held).toBe(ACT.down);

    // A small minor axis sets no bit for it (x ≈ 0.27 < 0.35 after the dead zone).
    ptr(stick, 'pointermove', 1, 100 + 15, 48 + 30);
    expect(s.sample().held).toBe(ACT.down);
  });

  it('releases the stick on pointercancel and on a lost capture, and ignores other pointers', () => {
    const s = make({ touch: DEFAULT_TOUCH });
    const stick = stickOf();
    ptr(stick, 'pointerdown', 1, 50, 50);
    ptr(stick, 'pointermove', 1, 0, 50);
    ptr(stick, 'pointerdown', 2, 50, 50);
    ptr(stick, 'pointermove', 2, 99, 50);
    ptr(stick, 'pointerup', 2);
    expect(s.sample().held).toBe(ACT.left);
    ptr(stick, 'pointercancel', 1);
    let v = s.sample();
    expect([v.held, v.stickX, v.stickY]).toEqual([0, 0, 0]);

    ptr(stick, 'pointerdown', 3, 50, 50);
    ptr(stick, 'pointermove', 3, 50, 100);
    expect(s.sample().held).toBe(ACT.down);
    ptr(stick, 'lostpointercapture', 3);
    v = s.sample();
    expect([v.held, v.stickY]).toEqual([0, 0]);
  });

  it('buttons set A and B while held, also together with the stick, and release on up and blur', () => {
    const s = make({ touch: DEFAULT_TOUCH });
    const stick = stickOf();
    ptr(stick, 'pointerdown', 1, 50, 50);
    ptr(stick, 'pointermove', 1, 50, 0);
    ptr(button('a'), 'pointerdown', 2);
    expect(bits(s.sample())).toEqual([ACT.up | ACT.a, ACT.up | ACT.a]);
    ptr(button('b'), 'pointerdown', 3);
    ptr(button('a'), 'pointerup', 2);
    expect(bits(s.sample())).toEqual([ACT.up | ACT.b, ACT.b]);
    // A quick tap between samples is latched.
    ptr(button('a'), 'pointerdown', 4);
    ptr(button('a'), 'pointerup', 4);
    expect(bits(s.sample())).toEqual([ACT.up | ACT.b, ACT.a]);
    window.dispatchEvent(new FocusEvent('blur'));
    const v = s.sample();
    expect([v.held, v.stickX, v.stickY]).toEqual([0, 0, 0]);
  });

  it('sizes, vibration and setButtonVisible', () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
    const layout: TouchLayout = { ...DEFAULT_TOUCH, buttons: [...DEFAULT_TOUCH.buttons, { id: 'swap', label: 'L', px: 40 }], vibrateMs: 10 };
    const s = make({ touch: layout });
    expect(button('a').style.width).toBe('76px');
    expect(button('swap').style.width).toBe('44px');
    expect(button('swap').textContent).toBe('L');
    ptr(button('swap'), 'pointerdown', 1);
    expect(vibrate).toHaveBeenCalledWith(10);
    expect(s.sample().held).toBe(ACT.swap);
    s.setButtonVisible('swap', false);
    expect(button('swap').style.display).toBe('none');
    expect(s.sample().held).toBe(0);
    s.setButtonVisible('swap', true);
    expect(button('swap').style.display).toBe('flex');
    s.setButtonVisible('nope', false);
    delete (navigator as { vibrate?: unknown }).vibrate;
  });

  it('no vibration by default, and the overlay is built once', () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
    const s = make({ touch: DEFAULT_TOUCH });
    const root = target.querySelector('[data-arcade-touch]')!;
    expect(root.getAttribute('data-arcade-touch')).toBe('deck');
    const mutations: MutationRecord[] = [];
    const mo = new MutationObserver((m) => mutations.push(...m));
    mo.observe(root, { childList: true, subtree: true });
    const stick = stickOf();
    ptr(stick, 'pointerdown', 1, 50, 50);
    for (let i = 0; i < 50; i++) ptr(stick, 'pointermove', 1, 50 + i, 50);
    ptr(stick, 'pointerup', 1);
    ptr(button('a'), 'pointerdown', 2);
    ptr(button('a'), 'pointerup', 2);
    s.sample();
    mutations.push(...mo.takeRecords());
    mo.disconnect();
    expect(mutations).toHaveLength(0);
    expect(vibrate).not.toHaveBeenCalled();
    delete (navigator as { vibrate?: unknown }).vibrate;
  });

  it('D-pad: fixed cross, 8 sectors, bits only', () => {
    const s = make({ touch: { ...DEFAULT_TOUCH, stick: 'dpad', region: 'overlay' } });
    // jsdom has no layout: the cross's centre is at (0, 0).
    const pad = stickOf();
    ptr(pad, 'pointerdown', 1, 0, -40);
    let v = s.sample();
    expect([v.held, v.stickX, v.stickY]).toEqual([ACT.up, 0, 0]);
    ptr(pad, 'pointermove', 1, 40, 5);
    expect(s.sample().held).toBe(ACT.right);
    ptr(pad, 'pointermove', 1, 30, 30);
    expect(s.sample().held).toBe(ACT.right | ACT.down);
    ptr(pad, 'pointermove', 1, 5, 5);
    expect(s.sample().held).toBe(0);
    ptr(pad, 'pointermove', 1, -40, 0);
    ptr(pad, 'pointercancel', 1);
    v = s.sample();
    expect(bits(v)).toEqual([0, ACT.left]);
    expect(target.querySelector('[data-arcade-touch]')!.getAttribute('data-arcade-touch')).toBe('overlay');
  });
});

describe('gamepad', () => {
  const pads: (Gamepad | null)[] = [null, null];
  const getGamepads = vi.fn(() => pads);
  const pad = (axes: number[], pressed: number[] = []): Gamepad =>
    ({
      index: 0,
      connected: true,
      mapping: 'standard',
      axes,
      buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), touched: false, value: pressed.includes(i) ? 1 : 0 })),
    }) as unknown as Gamepad;
  const connect = (type: string) => window.dispatchEvent(Object.assign(new Event(type), { gamepad: { index: 0 } }));

  beforeEach(() => {
    pads[0] = pads[1] = null;
    getGamepads.mockClear();
    Object.defineProperty(navigator, 'getGamepads', { value: getGamepads, configurable: true });
  });
  afterEach(() => {
    delete (navigator as { getGamepads?: unknown }).getGamepads;
  });

  it('polls only inside sample() and only while a pad is connected', () => {
    const s = make({ gamepad: true });
    expect(getGamepads).toHaveBeenCalledTimes(1);
    s.sample();
    s.sample();
    expect(getGamepads).toHaveBeenCalledTimes(1);
    pads[0] = pad([0, 0], [0]);
    connect('gamepadconnected');
    expect(getGamepads).toHaveBeenCalledTimes(1);
    expect(bits(s.sample())).toEqual([ACT.a, ACT.a]);
    expect(getGamepads).toHaveBeenCalledTimes(2);
    pads[0] = null;
    connect('gamepaddisconnected');
    expect(s.sample().held).toBe(0);
    expect(getGamepads).toHaveBeenCalledTimes(2);
  });

  it('finds a pad already connected at creation; maps the standard buttons', () => {
    pads[0] = pad([0, 0], [2, 3, 9, 12]);
    const s = make({ gamepad: true });
    expect(bits(s.sample())).toEqual([ACT.b | ACT.swap | ACT.menu | ACT.up, ACT.b | ACT.swap | ACT.menu | ACT.up]);
    expect(s.sample().pressed).toBe(0);
    pads[0] = pad([0, 0], [1, 13, 14, 15]);
    expect(s.sample().held).toBe(ACT.b | ACT.down | ACT.left | ACT.right);
  });

  it('left stick: dead zone 0.3, rescaled, direction bits past 0.35', () => {
    pads[0] = pad([0.29, 0]);
    const s = make({ gamepad: true });
    let v = s.sample();
    expect([v.held, v.stickX, v.stickY]).toEqual([0, 0, 0]);
    pads[0] = pad([0, -0.2, 0.9]);
    v = s.sample();
    expect([v.held, v.stickX, v.stickY]).toEqual([0, 0, 0]);
    pads[0] = pad([0.65, 0]);
    v = s.sample();
    expect(v.stickX).toBeCloseTo(0.5);
    expect(v.held).toBe(ACT.right);
    pads[0] = pad([0.5, 0]);
    v = s.sample();
    expect(v.stickX).toBeCloseTo(0.2 / 0.7);
    expect(v.held).toBe(0);
    pads[0] = pad([-1, 1]);
    v = s.sample();
    expect(Math.hypot(v.stickX, v.stickY)).toBeCloseTo(1);
    expect(v.held).toBe(ACT.left | ACT.down);
  });

  it('is off unless asked for', () => {
    pads[0] = pad([1, 0], [0]);
    const s = make();
    expect(bits(s.sample())).toEqual([0, 0]);
    expect(getGamepads).not.toHaveBeenCalled();
  });
});

describe('dispose', () => {
  it('removes every listener it added and the overlay, restores the element, and uses no timers', () => {
    Object.defineProperty(navigator, 'getGamepads', { value: () => [], configurable: true });
    const spy = (t: EventTarget) => ({ add: vi.spyOn(t, 'addEventListener'), remove: vi.spyOn(t, 'removeEventListener') });
    const spies = [spy(target), spy(window), spy(document)];
    const timers = [vi.spyOn(globalThis, 'setTimeout'), vi.spyOn(globalThis, 'setInterval'), vi.spyOn(globalThis, 'requestAnimationFrame')];

    const s = make({ touch: DEFAULT_TOUCH, gamepad: true });
    expect(spies[0].add.mock.calls.length).toBeGreaterThan(0);
    expect(spies[1].add.mock.calls.length).toBeGreaterThan(0);
    expect(target.style.position).toBe('relative');
    expect(target.childElementCount).toBe(1);
    key(target, 'keydown', 'KeyW');
    ptr(target.querySelector('[data-btn="a"]')!, 'pointerdown', 1);
    s.sample();
    s.dispose();

    for (const { add, remove } of spies) {
      expect(remove.mock.calls.length).toBe(add.mock.calls.length);
      for (const call of add.mock.calls) expect(remove.mock.calls).toContainEqual(call);
    }
    for (const t of timers) expect(t).not.toHaveBeenCalled();
    expect(target.childElementCount).toBe(0);
    expect(target.style.position).toBe('');
    expect(target.hasAttribute('tabindex')).toBe(false);
    expect(bits(s.sample())).toEqual([0, 0]);
    delete (navigator as { getGamepads?: unknown }).getGamepads;
  });

  it('keeps a position the element already had', () => {
    target.style.position = 'absolute';
    make({ touch: DEFAULT_TOUCH }).dispose();
    expect(target.style.position).toBe('absolute');
  });
});
