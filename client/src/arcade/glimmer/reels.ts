/**
 * The reels on canvas (glimmerhall.md §12.3, §12.6). One pixel-art canvas per machine at its logical
 * size (5 reels: 144 × 80; Orchard: 88 × 80), scaled by the runtime's stage canvas. The cabinet
 * frame is drawn once per machine; each frame clears only the inner area and draws at most about
 * 25 images. The loop runs only while reels move or an effect plays, then unsubscribes.
 *
 * Reels scroll their true strips. On the answer each reel lands on its drawn stop: stops at 500,
 * 625, 750, 875 and 1,000 ms after the tap, never sooner than 250 ms after the answer (turbo halves
 * it); a second tap stops every reel within 150 ms. The fast part of the spin uses the blurred
 * variant, and the last stretch before rest shows the real neighbours on the strip. With reduced
 * motion the reels rest within 300 ms and never blur. No anticipation slowdowns.
 */
import { ROWS, type MachineDef } from '@arcade/core/glimmer/machines';
import { createStageCanvas, type StageCanvas } from '@/arcade/runtime/canvas';
import { drawText } from '@/arcade/runtime/font';
import { createLoop, type Loop } from '@/arcade/runtime/loop';
import { CABINETS, SYM, cssColor, type MachineArt } from './art';

const PAD = 4;
const PITCH = SYM + 4;
/** Symbols per millisecond at full speed. */
const VMAX = 0.024;

export const logicalSize = (def: MachineDef): { w: number; h: number } => ({ w: PAD * 2 + def.reels * PITCH - 4, h: PAD * 2 + ROWS * SYM });

/** Something drawn over the reels for a while (the wheel, the doors, particles, a big number). */
export interface Effect {
  /** Draws a frame; false when finished. */
  draw(ctx: CanvasRenderingContext2D, now: number): boolean;
}

interface Reel {
  len: number;
  /** Strip index of the top row (float while moving). */
  pos: number;
  mode: 'rest' | 'spin' | 'stop';
  startAt: number;
  stopAt: number;
  target: number;
  from: number;
  stopBegan: number;
  dur: number;
  bounceAt: number;
}

export interface Reels {
  readonly def: MachineDef;
  readonly canvas: HTMLCanvasElement;
  readonly spinning: boolean;
  readonly size: { w: number; h: number };
  /** Rest on these stops at once (no animation). */
  rest(stops: readonly number[], fs?: boolean): void;
  /** Start spinning now (the tap). */
  start(o: { turbo: boolean; fs?: boolean }): void;
  /** The result: land on `stops`; resolves once every reel rests. */
  land(stops: readonly number[]): Promise<void>;
  /** Second tap: every reel rests within 150 ms (as soon as the result is known). */
  slam(): void;
  /** Light cells (bit per reel × 3 + row) and draw a line through `line` rows. */
  light(cells: number, line: readonly number[] | null): void;
  /** Play an effect over the reels. */
  play(fx: Effect): void;
  clearEffects(): void;
  setVisible(v: boolean): void;
  dispose(): void;
}

export const createReels = (container: HTMLElement, def: MachineDef, art: MachineArt, o: { reduced: boolean; onReelStop?(reel: number): void }): Reels => {
  const size = logicalSize(def);
  const stage: StageCanvas = createStageCanvas(container, { logicalW: size.w, logicalH: size.h, mode: 'pixelated' });
  const ctx = stage.ctx;
  const cab = CABINETS[def.idx] as (typeof CABINETS)[number];
  let strips = def.strips;
  const reels: Reel[] = [];
  for (let r = 0; r < def.reels; r += 1) {
    reels.push({ len: (strips[r] as Uint8Array).length, pos: 0, mode: 'rest', startAt: 0, stopAt: Infinity, target: 0, from: 0, stopBegan: 0, dur: 220, bounceAt: -1e9 });
  }
  let turbo = false;
  let tapAt = 0;
  let slammed = false;
  let lit = 0;
  let line: readonly number[] | null = null;
  let effects: Effect[] = [];
  let landing: { resolve(): void } | null = null;
  let disposed = false;

  const drawCabinet = (): void => {
    ctx.fillStyle = cssColor(cab.frame);
    ctx.fillRect(0, 0, size.w, size.h);
    ctx.fillStyle = cssColor(cab.light);
    ctx.fillRect(0, 0, size.w, 1);
    ctx.fillRect(0, 0, 1, size.h);
    ctx.fillStyle = cssColor(cab.dark);
    ctx.fillRect(0, size.h - 1, size.w, 1);
    ctx.fillRect(size.w - 1, 0, 1, size.h);
    ctx.fillRect(PAD - 1, PAD - 1, size.w - PAD * 2 + 2, size.h - PAD * 2 + 2);
    // Corner studs.
    ctx.fillStyle = cssColor(cab.light);
    for (const [x, y] of [
      [1, 1],
      [size.w - 3, 1],
      [1, size.h - 3],
      [size.w - 3, size.h - 3],
    ] as const)
      ctx.fillRect(x, y, 2, 2);
  };

  const now = (): number => performance.now();

  let lastT = 0;
  const step = (t: number): boolean => {
    const dt = lastT > 0 ? Math.min(50, Math.max(0, t - lastT)) : 16.7;
    lastT = t;
    let moving = false;
    for (let r = 0; r < reels.length; r += 1) {
      const reel = reels[r] as Reel;
      if (reel.mode === 'spin') {
        const dur = turbo ? 140 : 220;
        if (t >= reel.stopAt - dur) {
          // From here the reel shows its real strip: a short eased run onto the drawn stop.
          reel.mode = 'stop';
          reel.dur = Math.max(80, Math.min(dur, reel.stopAt - t));
          reel.from = reel.target + (VMAX * reel.dur) / 3;
          reel.stopBegan = t;
        } else {
          const ramp = Math.min(1, (t - reel.startAt) / 120);
          reel.pos -= VMAX * ramp * dt;
          if (reel.pos < 0) reel.pos += reel.len * (1 + Math.floor(-reel.pos / reel.len));
          moving = true;
          continue;
        }
      }
      if (reel.mode === 'stop') {
        const u = Math.min(1, (t - reel.stopBegan) / reel.dur);
        const k = 1 - (1 - u) * (1 - u) * (1 - u);
        reel.pos = reel.from - (reel.from - reel.target) * k;
        if (u >= 1) {
          reel.pos = reel.target;
          reel.mode = 'rest';
          reel.bounceAt = t;
          o.onReelStop?.(r);
        } else moving = true;
      }
      if (reel.mode === 'rest' && t - reel.bounceAt < 140) moving = true;
    }
    if (landing && reels.every((x) => x.mode === 'rest')) {
      const done = landing;
      landing = null;
      done.resolve();
    }
    return moving;
  };

  const drawReels = (t: number): void => {
    ctx.fillStyle = cssColor(cab.gap);
    ctx.fillRect(PAD, PAD, size.w - PAD * 2, size.h - PAD * 2);
    ctx.fillStyle = cssColor(cab.reel);
    for (let r = 0; r < reels.length; r += 1) ctx.fillRect(PAD + r * PITCH, PAD, SYM, ROWS * SYM);
    for (let r = 0; r < reels.length; r += 1) {
      const reel = reels[r] as Reel;
      const strip = strips[r] as Uint8Array;
      const x = PAD + r * PITCH;
      const fast = !o.reduced && (reel.mode === 'spin' || (reel.mode === 'stop' && t - reel.stopBegan < reel.dur * 0.35));
      const base = Math.floor(reel.pos);
      const frac = reel.pos - base;
      const bounce = reel.mode === 'rest' && t - reel.bounceAt < 140 ? Math.round(2 * Math.sin((Math.PI * (t - reel.bounceAt)) / 140)) : 0;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, PAD, SYM, ROWS * SYM);
      ctx.clip();
      for (let k = frac > 0 ? -1 : 0; k < ROWS + (frac > 0 ? 1 : 0); k += 1) {
        const idx = (((base + k) % reel.len) + reel.len) % reel.len;
        const sym = strip[idx] as number;
        const y = PAD + Math.round((k - frac) * SYM) + bounce;
        const cell = r * ROWS + k;
        if (fast) ctx.drawImage(art.blur, sym * SYM, 0, SYM, SYM, x, y, SYM, SYM);
        else art.atlas.draw(ctx, 's', x, y, { frame: sym, palette: reel.mode === 'rest' && k >= 0 && k < ROWS && (lit >> cell) & 1 ? 1 : 0 });
      }
      ctx.restore();
    }
    if (lit !== 0 && reels.every((x) => x.mode === 'rest')) {
      ctx.fillStyle = cssColor(cab.line);
      for (let cell = 0; cell < reels.length * ROWS; cell += 1) {
        if (!((lit >> cell) & 1)) continue;
        const x = PAD + Math.floor(cell / ROWS) * PITCH;
        const y = PAD + (cell % ROWS) * SYM;
        ctx.fillRect(x, y, SYM, 1);
        ctx.fillRect(x, y + SYM - 1, SYM, 1);
        ctx.fillRect(x, y, 1, SYM);
        ctx.fillRect(x + SYM - 1, y, 1, SYM);
      }
      if (line) {
        ctx.strokeStyle = cssColor(cab.line);
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let r = 0; r < line.length; r += 1) {
          const cx = PAD + r * PITCH + SYM / 2;
          const cy = PAD + (line[r] as number) * SYM + SYM / 2 + 0.5;
          if (r === 0) ctx.moveTo(PAD - 2, cy);
          ctx.lineTo(cx, cy);
          if (r === line.length - 1) ctx.lineTo(size.w - PAD + 2, cy);
        }
        ctx.stroke();
      }
    }
  };

  let running = false;
  const loop: Loop = createLoop({
    maxFps: 60,
    draw(t) {
      if (disposed) return;
      const moving = step(t);
      drawReels(t);
      let fxOn = false;
      if (effects.length > 0) {
        const keep: Effect[] = [];
        for (const fx of effects) if (fx.draw(ctx, t)) keep.push(fx);
        effects = keep;
        fxOn = keep.length > 0;
      }
      const want = moving || fxOn;
      if (!want) lastT = 0;
      if (want !== running) {
        running = want;
        loop.animate(want);
      }
    },
  });

  const kick = (): void => {
    running = true;
    loop.animate(true);
  };

  drawCabinet();
  stage.onResize(() => {
    drawCabinet();
    loop.markDirty();
  });
  loop.markDirty();

  return {
    def,
    canvas: stage.canvas,
    size,
    get spinning() {
      return reels.some((r) => r.mode !== 'rest');
    },
    rest(stops, fs = false) {
      strips = fs ? def.fsStrips : def.strips;
      reels.forEach((reel, r) => {
        reel.len = (strips[r] as Uint8Array).length;
        reel.pos = (stops[r] ?? 0) % reel.len;
        reel.target = reel.pos;
        reel.mode = 'rest';
        reel.bounceAt = -1e9;
      });
      lit = 0;
      line = null;
      if (landing) {
        const done = landing;
        landing = null;
        done.resolve();
      }
      loop.markDirty();
    },
    start(opts) {
      const fs = opts.fs ?? false;
      const nextStrips = fs ? def.fsStrips : def.strips;
      if (nextStrips !== strips) {
        strips = nextStrips;
        reels.forEach((reel, r) => {
          reel.len = (strips[r] as Uint8Array).length;
          reel.pos %= reel.len;
        });
      }
      turbo = opts.turbo;
      slammed = false;
      lit = 0;
      line = null;
      tapAt = now();
      for (const reel of reels) {
        reel.mode = 'spin';
        reel.startAt = tapAt;
        reel.stopAt = Infinity;
      }
      kick();
    },
    land(stops) {
      const t = now();
      const base = o.reduced ? 200 : turbo ? 250 : 500;
      const gap = o.reduced ? 25 : turbo ? 63 : 125;
      const afterAck = o.reduced ? 100 : turbo ? 150 : 250;
      reels.forEach((reel, r) => {
        reel.target = (stops[r] ?? 0) % reel.len;
        reel.stopAt = slammed ? t + 120 : Math.max(tapAt + base + gap * r, t + afterAck + gap * r);
        if (reel.mode === 'rest') reel.pos = reel.target;
      });
      kick();
      return new Promise<void>((resolve) => {
        landing = { resolve };
        if (reels.every((x) => x.mode === 'rest')) {
          landing = null;
          resolve();
        }
      });
    },
    slam() {
      slammed = true;
      const t = now();
      for (const reel of reels) if (reel.mode === 'spin' && reel.stopAt !== Infinity) reel.stopAt = Math.min(reel.stopAt, t + 120);
    },
    light(cells, l) {
      lit = cells;
      line = l;
      loop.markDirty();
    },
    play(fx) {
      effects.push(fx);
      kick();
    },
    clearEffects() {
      effects = [];
      loop.markDirty();
    },
    setVisible(v) {
      loop.setVisible(v);
    },
    dispose() {
      disposed = true;
      loop.dispose();
      stage.dispose();
      if (landing) {
        const done = landing;
        landing = null;
        done.resolve();
      }
    },
  };
};

/** Draws centred 5 × 7 text on the reels canvas (for effects). */
export const centerText = (ctx: CanvasRenderingContext2D, art: MachineArt, text: string, cx: number, y: number, color: number): void => {
  drawText(ctx, art.atlas, text, Math.round(cx - (text.length * 6 - 1) / 2), y, color);
};
