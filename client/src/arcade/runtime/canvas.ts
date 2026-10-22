/**
 * A stage canvas sized to its container (platform.md §10.2, fuseyard.md §13 item 10). Games draw in
 * logical units; the canvas maps them to the screen:
 *
 * - `pixelated`: the backing store stays at the logical size and CSS upscales it with
 *   `image-rendering: pixelated`, at a whole number of device pixels per logical pixel whenever that
 *   fills at least `minIntegerFill` (85 %) of the space, else at the largest fractional size.
 * - `blit`: the backing store is at device resolution (DPR capped at `dprCap`, default 2) and the
 *   context transform scales logical units, again preferring whole device-pixel multiples. Image
 *   smoothing is off. The fallback where pixelated CSS scaling is not wanted.
 * - `hd`: smooth graphics (cards, reels) at device resolution, transform = CSS scale × DPR.
 *
 * `dispose()` disconnects the observer, shrinks the backing store to 0 × 0 and removes the canvas.
 */

export interface CanvasMetrics {
  /** CSS size of the canvas. */
  cssW: number;
  cssH: number;
  /** CSS px per logical unit. */
  scale: number;
  /** Whole device pixels per logical pixel. */
  integer: boolean;
  /** The device pixel ratio used (capped). */
  dpr: number;
}

export interface StageCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly metrics: CanvasMetrics;
  onResize(cb: (m: CanvasMetrics) => void): () => void;
  dispose(): void;
}

export interface StageCanvasOptions {
  logicalW: number;
  logicalH: number;
  mode: 'pixelated' | 'blit' | 'hd';
  dprCap?: 2 | 3;
  minIntegerFill?: number;
}

/** The layout for a given space (pure; exported for tests). */
export const fitCanvas = (
  availW: number,
  availH: number,
  dprRaw: number,
  o: StageCanvasOptions,
): { metrics: CanvasMetrics; backingW: number; backingH: number; transform: number } => {
  const dpr = o.mode === 'pixelated' ? Math.max(1, dprRaw) : Math.max(1, Math.min(dprRaw, o.dprCap ?? 2));
  const fill = o.minIntegerFill ?? 0.85;
  const fit = Math.max(0, Math.min(availW / o.logicalW, availH / o.logicalH));
  const device = fit * dpr;
  const whole = Math.floor(device);
  const integer = o.mode !== 'hd' && whole >= 1 && whole / device >= fill;
  const deviceScale = integer ? whole : device;
  const cssScale = deviceScale / dpr;
  const cssW = Math.round(o.logicalW * cssScale * 100) / 100;
  const cssH = Math.round(o.logicalH * cssScale * 100) / 100;
  if (o.mode === 'pixelated') {
    return { metrics: { cssW, cssH, scale: cssScale, integer, dpr }, backingW: o.logicalW, backingH: o.logicalH, transform: 1 };
  }
  return {
    metrics: { cssW, cssH, scale: cssScale, integer, dpr },
    backingW: Math.max(1, Math.round(o.logicalW * deviceScale)),
    backingH: Math.max(1, Math.round(o.logicalH * deviceScale)),
    transform: deviceScale,
  };
};

export const createStageCanvas = (container: HTMLElement, o: StageCanvasOptions): StageCanvas => {
  const canvas = document.createElement('canvas');
  canvas.className = 'arcade-canvas';
  canvas.style.display = 'block';
  canvas.style.margin = 'auto';
  canvas.style.touchAction = 'none';
  if (o.mode !== 'hd') {
    canvas.style.imageRendering = 'pixelated';
  }
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D;

  const listeners = new Set<(m: CanvasMetrics) => void>();
  let metrics: CanvasMetrics = { cssW: 0, cssH: 0, scale: 0, integer: false, dpr: 1 };

  const apply = (width: number, height: number): void => {
    const layout = fitCanvas(width, height, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, o);
    if (canvas.width !== layout.backingW) canvas.width = layout.backingW;
    if (canvas.height !== layout.backingH) canvas.height = layout.backingH;
    canvas.style.width = layout.metrics.cssW + 'px';
    canvas.style.height = layout.metrics.cssH + 'px';
    if (ctx) {
      ctx.setTransform(layout.transform, 0, 0, layout.transform, 0, 0);
      ctx.imageSmoothingEnabled = o.mode === 'hd';
    }
    const changed = layout.metrics.cssW !== metrics.cssW || layout.metrics.cssH !== metrics.cssH || layout.metrics.dpr !== metrics.dpr;
    metrics = layout.metrics;
    if (changed) for (const cb of Array.from(listeners)) cb(metrics);
  };

  const measure = (): void => apply(container.clientWidth, container.clientHeight);

  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (box) apply(box.width, box.height);
    });
    observer.observe(container);
  }
  measure();

  return {
    canvas,
    ctx,
    get metrics() {
      return metrics;
    },
    onResize(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      observer?.disconnect();
      observer = null;
      listeners.clear();
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
    },
  };
};
