/**
 * Effects drawn over the reels (glimmerhall.md §12.3, §15): the Harvest Wheel, the three vault doors,
 * celebrations (at most 64 particles, at most 4 s, none with reduced motion) and a centred plate
 * for big numbers. Each is an `Effect` the reels' loop draws until it reports it is done, so the
 * frame subscription ends with it.
 */
import { ORCHARD, type MachineDef } from '@arcade/core/glimmer/machines';
import { CABINETS, cssColor, type MachineArt } from './art';
import { centerText, type Effect } from './reels';

const ease = (u: number): number => 1 - (1 - u) * (1 - u) * (1 - u);

/** A dark plate with 1–2 lines of text, centred. */
export const plate = (art: MachineArt, w: number, h: number, lines: readonly string[], ms: number, color: number): Effect => {
  let t0 = -1;
  return {
    draw(ctx, now) {
      if (t0 < 0) t0 = now;
      const width = Math.max(...lines.map((l) => l.length * 6 - 1)) + 10;
      const height = lines.length * 9 + 6;
      const x = Math.round((w - width) / 2);
      const y = Math.round((h - height) / 2);
      ctx.fillStyle = 'rgba(10,8,12,0.82)';
      ctx.fillRect(x, y, width, height);
      lines.forEach((line, i) => centerText(ctx, art, line, w / 2, y + 4 + i * 9, color));
      return now - t0 < ms;
    },
  };
};

/** Coins and sparks from the centre; `level` 1–4 scales count and length. */
export const celebrate = (def: MachineDef, w: number, h: number, level: 1 | 2 | 3 | 4, seed: number): Effect => {
  const count = [0, 12, 28, 48, 64][level] as number;
  const ms = [0, 700, 1500, 2600, 4000][level] as number;
  const colours = [CABINETS[def.idx]?.line ?? 0xffd050, 0xffe08a, 0xffffff, 0xffa030].map(cssColor);
  let s = seed | 1;
  const rand = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return ((s >>> 8) & 0xffff) / 0x10000;
  };
  const parts: { x: number; y: number; vx: number; vy: number; c: string; born: number; size: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    const ang = rand() * Math.PI * 2;
    const sp = 0.03 + rand() * 0.07;
    parts.push({ x: w / 2, y: h / 2, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 0.05, c: colours[i % colours.length] as string, born: (i / count) * ms * 0.5, size: 1 + (i % 3 === 0 ? 1 : 0) });
  }
  let t0 = -1;
  return {
    draw(ctx, now) {
      if (t0 < 0) t0 = now;
      const t = now - t0;
      for (const p of parts) {
        const a = t - p.born;
        if (a < 0 || a > ms * 0.6) continue;
        const x = p.x + p.vx * a;
        const y = p.y + p.vy * a + 0.00012 * a * a;
        if (x < 4 || y < 4 || x > w - 6 || y > h - 6) continue;
        ctx.fillStyle = p.c;
        ctx.fillRect(Math.round(x), Math.round(y), p.size, p.size);
      }
      return t < ms;
    },
  };
};

/**
 * The Harvest Wheel: twelve equal segments; it turns three times and lands on `segment` under the
 * pointer. `onTick` fires as segments pass, at most 15 a second.
 */
export const wheel = (art: MachineArt, w: number, h: number, segment: number, o: { reduced: boolean; onTick(): void; onDone(): void }): Effect => {
  const seg = ORCHARD.feature.kind === 'wheel' ? ORCHARD.feature.segments : [];
  const n = seg.length;
  const cx = w / 2;
  const cy = h / 2 + 2;
  const R = Math.min(w, h) / 2 - 4;
  const step = (Math.PI * 2) / n;
  // Segment i spans [i·step, (i+1)·step) from the pointer at the top, clockwise.
  const spinMs = o.reduced ? 350 : 2600;
  const holdMs = 1100;
  const turns = o.reduced ? 0 : 3;
  const final = -(segment + 0.5) * step;
  const start = final + turns * Math.PI * 2 + step * 0.37;
  const palette = ['#e8a23a', '#9a3a7a', '#7ab040', '#d0402a'];
  let t0 = -1;
  let lastSeg = -1;
  let lastTick = -1e9;
  let done = false;
  return {
    draw(ctx, now) {
      if (t0 < 0) t0 = now;
      const t = now - t0;
      const u = Math.min(1, t / spinMs);
      const angle = start + (final - start) * ease(u);
      ctx.fillStyle = 'rgba(20,12,8,0.88)';
      ctx.fillRect(4, 4, w - 8, h - 8);
      for (let i = 0; i < n; i += 1) {
        const a0 = -Math.PI / 2 + angle + i * step;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, R, a0, a0 + step);
        ctx.closePath();
        ctx.fillStyle = i === segment && u >= 1 ? '#ffe08a' : (palette[i % palette.length] as string);
        ctx.fill();
      }
      ctx.fillStyle = '#2a1a12';
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < n; i += 1) {
        const mid = -Math.PI / 2 + angle + (i + 0.5) * step;
        const label = String(seg[i]);
        centerText(ctx, art, label, cx + Math.cos(mid) * (R - 9), Math.round(cy + Math.sin(mid) * (R - 9) - 3), i === segment && u >= 1 ? 0 : 10);
      }
      // The pointer.
      ctx.fillStyle = '#fff4dc';
      ctx.beginPath();
      ctx.moveTo(cx - 4, cy - R - 3);
      ctx.lineTo(cx + 4, cy - R - 3);
      ctx.lineTo(cx, cy - R + 4);
      ctx.closePath();
      ctx.fill();
      const under = Math.floor(((((-angle) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / step);
      if (under !== lastSeg && u < 1) {
        lastSeg = under;
        if (now - lastTick >= 1000 / 15) {
          lastTick = now;
          o.onTick();
        }
      }
      if (u >= 1 && !done && t >= spinMs + holdMs) {
        done = true;
        o.onDone();
      }
      return !done;
    },
  };
};

export interface DoorsState {
  /** Prize labels behind each door, once known. */
  labels: (string | null)[];
  /** When each door started opening (ms), or null. */
  openedAt: (number | null)[];
  picked: number | null;
  /** The doors stay on screen until `closed` is set. */
  closed: boolean;
}

/** Three vault doors; open one with `openedAt[d] = now`. */
export const doors = (art: MachineArt, w: number, h: number, st: DoorsState): Effect => {
  const dw = Math.floor((w - 8 - 16) / 3);
  const dh = h - 16;
  const x0 = 4 + Math.floor((w - 8 - (dw * 3 + 8)) / 2);
  return {
    draw(ctx, now) {
      ctx.fillStyle = '#120c0c';
      ctx.fillRect(4, 4, w - 8, h - 8);
      for (let d = 0; d < 3; d += 1) {
        const x = x0 + d * (dw + 4);
        const y = 8;
        // Behind the door: the prize.
        ctx.fillStyle = st.picked === d ? '#5a2410' : '#2a2020';
        ctx.fillRect(x, y, dw, dh);
        const label = st.labels[d];
        if (label) {
          const parts = label.split(' ');
          parts.forEach((p, i) => centerText(ctx, art, p, x + dw / 2, y + dh / 2 - 8 + i * 10, st.picked === d ? 7 : 10));
        }
        const at = st.openedAt[d];
        const p = at === null || at === undefined ? 0 : Math.min(1, (now - at) / 600);
        const lift = Math.round(ease(p) * (dh - 2));
        if (lift < dh) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, dw, dh);
          ctx.clip();
          const dy = y - lift;
          ctx.fillStyle = '#4a4440';
          ctx.fillRect(x, dy, dw, dh);
          ctx.fillStyle = '#7a706a';
          ctx.fillRect(x, dy, dw, 1);
          ctx.fillRect(x, dy, 1, dh);
          ctx.fillStyle = '#2a2626';
          ctx.fillRect(x + dw - 1, dy, 1, dh);
          ctx.fillRect(x + 3, dy + 3, dw - 6, dh - 6);
          ctx.fillStyle = '#e0581a';
          ctx.fillRect(x + 4, dy + 4, dw - 8, 1);
          ctx.fillRect(x + 4, dy + dh - 5, dw - 8, 1);
          // Keyhole.
          ctx.fillStyle = '#ffa030';
          ctx.fillRect(x + dw / 2 - 2, dy + dh / 2 - 4, 4, 4);
          ctx.fillRect(x + dw / 2 - 1, dy + dh / 2, 2, 5);
          centerText(ctx, art, String(d + 1), x + dw / 2, dy + 8, 7);
          ctx.restore();
        }
        if (st.picked === d && p >= 1) {
          ctx.strokeStyle = '#ffe090';
          ctx.strokeRect(x - 0.5, y - 0.5, dw + 1, dh + 1);
        }
      }
      return !st.closed;
    },
  };
};

/** The level of celebration for a result (§15): ≥ 1× small, ≥ 10× medium, ≥ 25× big, ≥ 100× huge. */
export const celebrationLevel = (win: number, bet: number): 0 | 1 | 2 | 3 | 4 => {
  if (win < bet) return 0;
  const x = win / bet;
  return x >= 100 ? 4 : x >= 25 ? 3 : x >= 10 ? 2 : 1;
};
