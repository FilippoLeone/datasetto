/**
 * The turn ring (lamplight.md §14.3) over the seat whose clock is running. It is a CSS countdown made
 * only of transform and opacity animations, which the compositor runs without any main-thread work,
 * so a table waiting on someone's clock costs nothing per frame. (The module's 10 Hz timer runs only
 * on your own turn, for the last-5-seconds tick and the gamepad.)
 *
 * The classic pie timer: a full disc in the clock colour, a half-disc "spinner" in the track colour
 * turning 360° around the centre, a "filler" that covers the right half from the midpoint, and a
 * "mask" hiding the spinner's left half until the midpoint; a radial mask cuts the middle out so the
 * avatar shows through. Red takes over for the last 5 s.
 */
export const RING = 56;

export interface Ring {
  /** Place it over the avatar centred at (x, y), or hide it (null). */
  place(at: { x: number; y: number } | null): void;
  /** Start (or restart) the countdown: `total` ms in all, `remaining` ms left. */
  start(o: { total: number; remaining: number; bank: boolean }): void;
  dispose(): void;
}

const STYLE_ID = 'll-ring-style';
const CSS = `
.ll-ring{position:absolute;width:${RING}px;height:${RING}px;pointer-events:none;display:none;border-radius:50%;
  -webkit-mask:radial-gradient(circle,transparent 22px,#000 23px);mask:radial-gradient(circle,transparent 22px,#000 23px);}
.ll-ring>div{position:absolute;top:0;height:${RING}px;}
.ll-ring .b{left:0;width:${RING}px;border-radius:50%;}
.ll-ring .s,.ll-ring .m{left:0;width:${RING / 2}px;border-radius:${RING / 2}px 0 0 ${RING / 2}px;}
.ll-ring .s{transform-origin:100% 50%;animation-name:ll-spin;animation-timing-function:linear;}
.ll-ring .f{left:${RING / 2}px;width:${RING / 2}px;border-radius:0 ${RING / 2}px ${RING / 2}px 0;opacity:0;animation-name:ll-on;animation-timing-function:steps(1,end);}
.ll-ring .m{animation-name:ll-off;animation-timing-function:steps(1,end);}
.ll-ring .r{left:0;width:${RING}px;border-radius:50%;background:#e5484d;opacity:0;animation-name:ll-red;animation-timing-function:steps(1,end);}
.ll-ring .s,.ll-ring .f,.ll-ring .m,.ll-ring .r{animation-fill-mode:forwards;}
@keyframes ll-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@keyframes ll-on{0%{opacity:0}50%{opacity:1}100%{opacity:1}}
@keyframes ll-off{0%{opacity:1}50%{opacity:0}100%{opacity:0}}
@keyframes ll-red{0%{opacity:0}100%{opacity:1}}
`;

let users = 0;

export const createRing = (parent: HTMLElement): Ring => {
  if (users++ === 0 && !document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const root = document.createElement('div');
  root.className = 'll-ring';
  parent.appendChild(root);
  let shownAt = '';
  let disposed = false;
  return {
    place(at) {
      const key = at ? Math.round(at.x - RING / 2) + ',' + Math.round(at.y - RING / 2) : '';
      if (key === shownAt) return;
      shownAt = key;
      if (!at) {
        root.style.display = 'none';
        return;
      }
      const [x, y] = key.split(',');
      root.style.display = 'block';
      root.style.left = x + 'px';
      root.style.top = y + 'px';
    },
    start({ total, remaining, bank }) {
      const t = Math.max(1, total);
      const left = Math.max(0, Math.min(t, remaining));
      const delay = -(t - left) + 'ms';
      const colour = bank ? '#4ea1ff' : '#f2b84b';
      const track = '#25312f';
      // New nodes restart every animation from the right point; this happens once per turn.
      root.textContent = '';
      const part = (cls: string, bg: string | null, duration: number, d: string): void => {
        const el = document.createElement('div');
        el.className = cls;
        if (bg) el.style.background = bg;
        el.style.animationDuration = duration + 'ms';
        el.style.animationDelay = d;
        root.appendChild(el);
      };
      part('b', colour, t, delay);
      // Red for the last 5 s (under the elapsed part): a step at (left − 5 s) from now.
      const red = left - 5000;
      part('r', null, 1, red > 0 ? red + 'ms' : '0ms');
      part('s', track, t, delay);
      part('f', track, t, delay);
      part('m', colour, t, delay);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.remove();
      if (--users === 0) document.getElementById(STYLE_ID)?.remove();
    },
  };
};
