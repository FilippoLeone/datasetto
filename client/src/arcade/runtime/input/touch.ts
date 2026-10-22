/**
 * Touch source: an overlay built once inside the game element and never re-rendered. While playing
 * only inline styles change (no child-list mutations).
 *
 * - Stick 'float': the base appears where the finger lands in the left 45 % of the element; past the
 *   radius it follows the finger. 'dpad': a fixed cross at the bottom left, 8 sectors, bits only.
 * - Buttons stack at the bottom right, the first one lowest; 'menu' sits at the top right. Every hit
 *   target is at least 44 px.
 * - Each control follows its own pointer (move and press at once) with pointer capture and
 *   `touch-action: none`; up, cancel and a lost capture release it, window blur releases all (index.ts).
 * - Region 'overlay': translucent (`--arcade-touch-opacity` on the element, default .45) at z-index 2,
 *   above the canvas. 'deck': opaque at z-index 0, so a canvas given z-index ≥ 1 stays on top.
 * - Hooks for games: `[data-arcade-touch]` (root), `[data-stick]`, `[data-btn="a"]`.
 */
import { ACT, deadZone, dirBits, on, type Off, type TouchLayout } from './map';

export interface Touch {
  x: number;
  y: number;
  release(): void;
  show(id: string, visible: boolean): void;
}

interface Button {
  hit: HTMLDivElement;
  face: HTMLDivElement;
  pid: number | null;
  bit: number;
}

const FACE = 'rgba(255,255,255,.16)';
const FACE_ON = 'rgba(255,255,255,.5)';
const RING = 'border:2px solid rgba(255,255,255,.45);box-sizing:border-box;border-radius:50%;';
const CENTER = 'display:flex;align-items:center;justify-content:center;';
const HIT = 'pointer-events:auto;touch-action:none;';
const NO_HIT = 'position:absolute;pointer-events:none;';
const safe = (side: string, px: number) => `calc(${px}px + env(safe-area-inset-${side}))`;

const div = (parent: HTMLElement, css: string, text = ''): HTMLDivElement => {
  const d = document.createElement('div');
  d.style.cssText = css;
  d.textContent = text;
  parent.append(d);
  return d;
};

const capture = (el: Element, id: number): void => {
  try {
    el.setPointerCapture?.(id);
  } catch {
    // A pointer that is already up, or a synthetic one.
  }
};

const onRelease = (el: Element, fn: (e: PointerEvent) => void, offs: Off[]): void => {
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) on(el, type, fn, offs);
};

export const createTouch = (target: HTMLElement, layout: TouchLayout, set: (bits: number) => void, offs: Off[]): Touch => {
  const R = layout.radiusPx;
  const float = layout.stick === 'float';
  const root = div(
    target,
    NO_HIT +
      'inset:0;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;color:#fff;font:600 16px/1 system-ui,sans-serif;z-index:' +
      (layout.region === 'overlay' ? '2;opacity:var(--arcade-touch-opacity,.45)' : '0'),
  );
  root.dataset.arcadeTouch = layout.region;
  root.setAttribute('aria-hidden', 'true');
  // The overlay is absolutely positioned: the element must be its containing block.
  const position = target.style.position;
  const computed = getComputedStyle(target).position;
  const contain = !computed || computed === 'static';
  if (contain) target.style.position = 'relative';
  on(root, 'contextmenu', (e) => e.preventDefault(), offs);
  offs.push(() => {
    root.remove();
    if (contain) target.style.position = position;
  });

  let stickBits = 0;
  let buttonBits = 0;
  const push = () => set(stickBits | buttonBits);
  const t: Touch = { x: 0, y: 0, release, show };

  // ------------------------------------------------------------------ stick
  const zone = div(
    root,
    HIT +
      'position:absolute;' +
      (float ? 'left:0;top:0;bottom:0;width:45%' : `left:${safe('left', 16)};bottom:${safe('bottom', 16)};width:${3 * R}px;height:${3 * R}px`),
  );
  zone.dataset.stick = layout.stick;
  const restLeft = safe('left', R + 24);
  const restTop = `calc(100% - ${R + 24}px - env(safe-area-inset-bottom))`;
  const base = div(zone, `${NO_HIT}${RING}width:${2 * R}px;height:${2 * R}px;margin:${-R}px 0 0 ${-R}px;display:${float ? 'block' : 'none'}`);
  const knob = div(base, `${NO_HIT}left:50%;top:50%;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;background:${FACE_ON}`);
  // Up, down, left, right: the order of the ACT bits.
  const arms = float
    ? []
    : [
        [1, 0],
        [1, 2],
        [0, 1],
        [2, 1],
      ].map(([c, r]) => div(zone, `${NO_HIT}left:${c * R}px;top:${r * R}px;width:${R}px;height:${R}px;border-radius:8px;background:${FACE}`));

  let sid: number | null = null;
  let ox = 0;
  let oy = 0;
  let zx = 0;
  let zy = 0;
  const rest = () => {
    sid = null;
    t.x = t.y = stickBits = 0;
    base.style.left = restLeft;
    base.style.top = restTop;
    base.style.opacity = '.5';
    knob.style.transform = '';
    for (const a of arms) a.style.background = FACE;
  };
  rest();

  const move = (e: PointerEvent) => {
    if (e.pointerId !== sid) return;
    let dx = e.clientX - ox;
    let dy = e.clientY - oy;
    let d = Math.hypot(dx, dy);
    if (float) {
      if (d > R) {
        // Dragging past the radius moves the origin.
        ox += dx * (1 - R / d);
        oy += dy * (1 - R / d);
        dx = e.clientX - ox;
        dy = e.clientY - oy;
        d = R;
      }
      const k = deadZone(d, layout.deadZonePx, R);
      t.x = dx * k;
      t.y = dy * k;
      stickBits = dirBits(t.x, t.y);
      base.style.left = ox - zx + 'px';
      base.style.top = oy - zy + 'px';
      knob.style.transform = `translate(${dx}px,${dy}px)`;
    } else {
      stickBits = d > layout.deadZonePx ? dirBits(dx / d, dy / d) : 0;
      arms.forEach((a, i) => (a.style.background = stickBits & (1 << i) ? FACE_ON : FACE));
    }
    push();
  };

  on<PointerEvent>(
    zone,
    'pointerdown',
    (e) => {
      if (sid !== null) return;
      sid = e.pointerId;
      capture(zone, sid);
      const r = zone.getBoundingClientRect();
      zx = r.left;
      zy = r.top;
      ox = float ? e.clientX : zx + r.width / 2;
      oy = float ? e.clientY : zy + r.height / 2;
      base.style.opacity = '1';
      move(e);
    },
    offs,
  );
  on(zone, 'pointermove', move, offs);
  onRelease(
    zone,
    (e) => {
      if (e.pointerId !== sid) return;
      rest();
      push();
    },
    offs,
  );

  // ------------------------------------------------------------------ buttons
  const cluster = div(root, `${NO_HIT}right:${safe('right', 16)};bottom:${safe('bottom', 16)};display:flex;flex-direction:column-reverse;align-items:flex-end;gap:8px`);
  const buttons = new Map<string, Button>();
  const lift = (b: Button) => {
    b.pid = null;
    b.face.style.background = FACE;
    buttonBits &= ~b.bit;
  };
  for (const { id, label, px } of layout.buttons) {
    const s = Math.max(px, 44);
    const menu = id === 'menu';
    const hit = div(menu ? root : cluster, `${HIT}${CENTER}width:${s}px;height:${s}px` + (menu ? `;position:absolute;top:${safe('top', 8)};right:${safe('right', 8)}` : ''));
    hit.dataset.btn = id;
    const face = div(hit, `${CENTER}${RING}width:${px}px;height:${px}px;font-size:${Math.round(px * 0.4)}px;background:${FACE}`, label);
    const b: Button = { hit, face, pid: null, bit: ACT[id] };
    buttons.set(id, b);
    on<PointerEvent>(
      hit,
      'pointerdown',
      (e) => {
        if (b.pid !== null) return;
        b.pid = e.pointerId;
        capture(hit, b.pid);
        face.style.background = FACE_ON;
        buttonBits |= b.bit;
        push();
        if (layout.vibrateMs) navigator.vibrate?.(layout.vibrateMs);
      },
      offs,
    );
    onRelease(
      hit,
      (e) => {
        if (e.pointerId !== b.pid) return;
        lift(b);
        push();
      },
      offs,
    );
  }

  function release() {
    rest();
    buttons.forEach(lift);
    push();
  }

  function show(id: string, visible: boolean) {
    const b = buttons.get(id);
    if (!b) return;
    b.hit.style.display = visible ? 'flex' : 'none';
    if (!visible && b.pid !== null) {
      lift(b);
      push();
    }
  }

  return t;
};
