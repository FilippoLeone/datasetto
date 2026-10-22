/**
 * Decisions behind the camera's background blur, kept free of WebGL, workers and media
 * tracks so they can be unit tested: the levels, where the blur can run on this device,
 * how the system's own camera effects are detected, and when a device that cannot keep
 * up steps down (segment less often, then Light, then Off).
 *
 * The blur itself runs in services/voice/blurPipeline.ts (person segmentation with
 * MediaPipe's selfie segmenter, compositing in WebGL 2) inside blur.worker.ts, wired to the
 * camera by cameraEffects.ts.
 */

export type CameraBlurLevel = 'off' | 'light' | 'strong';
export const CAMERA_BLUR_LEVELS: readonly CameraBlurLevel[] = ['off', 'light', 'strong'];

/** Stored values this build does not know become Off (the default). */
export const normalizeBlurLevel = (value: unknown): CameraBlurLevel =>
  CAMERA_BLUR_LEVELS.includes(value as CameraBlurLevel) ? (value as CameraBlurLevel) : 'off';

/**
 * How frames reach the blur:
 * - `insertable`: MediaStreamTrackProcessor and MediaStreamTrackGenerator (Chromium, Electron,
 *   Android WebView); the frames go to the worker and back as a track without touching the page.
 * - `canvas`: the page draws the camera into bitmaps, the worker blurs them and a canvas
 *   capture stream sends the result (Firefox and other browsers without the processor).
 * - `none`: no blur here (no worker canvas, no WebGL 2 or no WebAssembly).
 */
export type BlurPath = 'insertable' | 'canvas' | 'none';

export interface BlurEnvironment {
  worker: boolean;
  wasm: boolean;
  /** OffscreenCanvas with a WebGL 2 context (the worker draws on one). */
  offscreenWebgl2: boolean;
  trackProcessor: boolean;
  trackGenerator: boolean;
  canvasCapture: boolean;
  imageBitmap: boolean;
}

export interface BlurSupport {
  path: BlurPath;
  /** Why blur is unavailable, in plain words; null when it is available. */
  reason: string | null;
}

export const chooseBlurPath = (env: BlurEnvironment): BlurSupport => {
  if (!env.worker || !env.wasm) return { path: 'none', reason: 'Background blur needs Web Workers and WebAssembly, which this browser does not offer.' };
  if (!env.offscreenWebgl2) return { path: 'none', reason: 'Background blur needs WebGL 2 in a worker (OffscreenCanvas), which this browser or graphics driver does not offer.' };
  if (env.trackProcessor && env.trackGenerator) return { path: 'insertable', reason: null };
  if (env.canvasCapture && env.imageBitmap) return { path: 'canvas', reason: null };
  return { path: 'none', reason: 'Background blur needs either insertable video streams or canvas capture, and this browser has neither.' };
};

/**
 * The system's own camera effects as Chrome exposes them (`backgroundBlur` in the track's
 * capabilities, Chrome 114+): `controllable` when the page may switch them (Windows with
 * camera effects such as Windows Studio Effects), `forced-on` when the operating system has
 * them on and the page can only observe that (macOS Control Center, ChromeOS), `none` otherwise.
 */
export type PlatformBlur = 'controllable' | 'forced-on' | 'none';

export const platformBlurMode = (capabilities: { backgroundBlur?: unknown } | null | undefined): PlatformBlur => {
  const values = capabilities?.backgroundBlur;
  if (!Array.isArray(values)) return 'none';
  const set = new Set(values.filter((value): value is boolean => typeof value === 'boolean'));
  if (set.has(true) && set.has(false)) return 'controllable';
  if (set.has(true)) return 'forced-on';
  return 'none';
};

/** What the on-device pipeline runs: the blur strength and how often the person is segmented. */
export interface BlurTier {
  level: Exclude<CameraBlurLevel, 'off'>;
  /** Segment every Nth frame and reuse the smoothed mask in between. */
  segmentEvery: 1 | 2 | 3;
}

/** Phones and tablets start at half the segmentation rate to save battery. */
export const initialTier = (level: Exclude<CameraBlurLevel, 'off'>, phone: boolean): BlurTier => ({ level, segmentEvery: phone ? 2 : 1 });

/**
 * One rung down when the device cannot keep up: first the person is segmented less often,
 * then Strong becomes Light (the cheaper blur at the lower rate), then blur turns off (null).
 */
export const stepDownTier = (tier: BlurTier): BlurTier | null => {
  if (tier.segmentEvery === 1) return { level: tier.level, segmentEvery: 2 };
  if (tier.level === 'strong') return { level: 'light', segmentEvery: tier.segmentEvery };
  if (tier.segmentEvery === 2) return { level: 'light', segmentEvery: 3 };
  return null;
};

/** One second of the pipeline, as the worker reports it. */
export interface BlurWindow {
  /** Frames the camera delivered (including the ones dropped because the pipeline was busy). */
  inputFrames: number;
  /** Frames the pipeline sent on. */
  outputFrames: number;
  /** Wall-clock length of the window. */
  durationMs: number;
  /** Mean and 95th percentile time from a frame reaching the pipeline to its blurred copy leaving it. */
  meanLatencyMs: number;
  p95LatencyMs: number;
  /** Mean time spent on a frame (segmentation when it ran, plus compositing). */
  meanCostMs: number;
}

export interface GovernorOptions {
  /** The frame rate the blur must hold (or the camera's own rate when that is lower). */
  minFps: number;
  /** Share of the camera's frames that may be dropped in a window. */
  maxDropRatio: number;
  /** Added delay the blur may cause (95th percentile). */
  maxLatencyMs: number;
  /** Consecutive bad windows before stepping down; one bad second is a hiccup. */
  windows: number;
  /** Windows ignored after a start or a step-down (model warm-up). */
  warmupWindows: number;
}

export const DEFAULT_GOVERNOR: GovernorOptions = { minFps: 24, maxDropRatio: 0.15, maxLatencyMs: 40, windows: 3, warmupWindows: 2 };

export type WindowVerdict = 'warmup' | 'ok' | 'slow';

/** Whether one window kept the budget: the frame rate, the dropped frames and the added delay. */
export const judgeWindow = (window: BlurWindow, options: GovernorOptions = DEFAULT_GOVERNOR): 'ok' | 'slow' => {
  if (window.durationMs <= 0 || window.inputFrames <= 0) return 'ok';
  const seconds = window.durationMs / 1000;
  const inputFps = window.inputFrames / seconds;
  const outputFps = window.outputFrames / seconds;
  // A camera that itself delivers fewer frames (a dark room) is not the blur's fault: then the
  // blur only has to keep (almost) all of them.
  const floor = Math.min(options.minFps, inputFps * (1 - options.maxDropRatio));
  if (outputFps < floor) return 'slow';
  if (window.p95LatencyMs > options.maxLatencyMs) return 'slow';
  return 'ok';
};

/**
 * Watches the pipeline's one-second windows and says when to step down: after `windows`
 * bad windows in a row, not counting the warm-up windows after each (re)start.
 */
export class BlurGovernor {
  private consecutive = 0;
  private warmup: number;

  constructor(private readonly options: GovernorOptions = DEFAULT_GOVERNOR) {
    this.warmup = options.warmupWindows;
  }

  /** Records a window; true when the tier should step down now. */
  record(window: BlurWindow): boolean {
    if (this.warmup > 0) {
      this.warmup -= 1;
      return false;
    }
    if (judgeWindow(window, this.options) === 'slow') this.consecutive += 1;
    else this.consecutive = 0;
    if (this.consecutive >= this.options.windows) {
      this.restart();
      return true;
    }
    return false;
  }

  /** After a start, a step-down or a new camera: warm up again. */
  restart(): void {
    this.consecutive = 0;
    this.warmup = this.options.warmupWindows;
  }
}

export interface FrameSample {
  /** The frame's media timestamp in microseconds (VideoFrame.timestamp), or null when unknown. */
  timestampUs: number | null;
  /** When the pipeline took the frame and when its blurred copy left, in performance.now() ms. */
  startedMs: number;
  doneMs: number;
  /** Time spent working on it (segmentation when it ran, plus compositing). */
  costMs: number;
}

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};

/**
 * Turns the frames that went through the pipeline into one-second windows for the governor.
 *
 * The insertable path only sees the frames it read: when it is busy the browser drops the
 * camera's frames in between, which shows as gaps in the media timestamps (a gap of three
 * camera intervals is two dropped frames). A frame that waited in the queue shows as a larger
 * gap between its media timestamp and the moment it was read than the smallest one seen;
 * that wait counts as added delay too.
 */
export class WindowMeter {
  private start: number | null = null;
  private inputFrames = 0;
  private outputFrames = 0;
  private latencies: number[] = [];
  private costs: number[] = [];
  private gaps: number[] = [];
  private lastTimestampUs: number | null = null;
  private minLagMs: number | null = null;
  private extraInput = 0;

  constructor(private readonly windowMs = 1000) {}

  /** A new camera: the timestamps start over. */
  resetSource(): void {
    this.lastTimestampUs = null;
    this.minLagMs = null;
    this.gaps = [];
  }

  /** Frames the camera delivered that never reached the pipeline (counted by the page on the canvas path). */
  skipped(count: number): void {
    this.extraInput += count;
  }

  /** Records a frame; returns the finished window when a second has passed. */
  frame(sample: FrameSample): BlurWindow | null {
    if (this.start === null) this.start = sample.startedMs;
    let represented = 1;
    let queueMs = 0;
    const ts = sample.timestampUs;
    if (ts !== null && Number.isFinite(ts)) {
      if (this.lastTimestampUs !== null && ts > this.lastTimestampUs) {
        const gap = (ts - this.lastTimestampUs) / 1000;
        const interval = this.gaps.length >= 5 ? percentile(this.gaps, 0.25) : gap;
        if (interval > 0) represented = Math.max(1, Math.round(gap / interval));
        this.gaps.push(gap);
        if (this.gaps.length > 60) this.gaps.shift();
      }
      this.lastTimestampUs = ts;
      const lag = sample.startedMs - ts / 1000;
      if (this.minLagMs === null || lag < this.minLagMs) this.minLagMs = lag;
      queueMs = Math.max(0, lag - this.minLagMs);
    }
    this.inputFrames += represented;
    this.outputFrames += 1;
    this.latencies.push(queueMs + (sample.doneMs - sample.startedMs));
    this.costs.push(sample.costMs);
    const elapsed = sample.doneMs - this.start;
    if (elapsed < this.windowMs) return null;
    const window: BlurWindow = {
      inputFrames: this.inputFrames + this.extraInput,
      outputFrames: this.outputFrames,
      durationMs: elapsed,
      meanLatencyMs: this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length,
      p95LatencyMs: percentile(this.latencies, 0.95),
      meanCostMs: this.costs.reduce((a, b) => a + b, 0) / this.costs.length,
    };
    this.start = sample.doneMs;
    this.inputFrames = 0;
    this.outputFrames = 0;
    this.extraInput = 0;
    this.latencies = [];
    this.costs = [];
    return window;
  }
}

/**
 * How strong each level blurs, as a share of the picture height (so it looks the same at
 * 360p and 1080p): the Gaussian's sigma, the passes it takes at quarter resolution, and the
 * width of the soft edge around the person.
 */
export const BLUR_LOOK: Record<BlurTier['level'], { sigma: number; passes: 1 | 2; feather: number }> = {
  light: { sigma: 0.012, passes: 1, feather: 0.16 },
  strong: { sigma: 0.026, passes: 2, feather: 0.2 },
};

/** Model input of the two selfie segmenters; the landscape one fits 16:9 webcams. */
export const chooseSegmenterModel = (width: number, height: number): 'landscape' | 'square' => (height > 0 && width / height >= 1.5 ? 'landscape' : 'square');

/** A short line for the settings dialog: what runs and what it costs. */
export interface BlurRunStats {
  fps: number;
  inputFps: number;
  latencyMs: number;
  costMs: number;
  segmentEvery: number;
  /** Mean time of one segmentation and of one composite, for measurements. */
  segmentMs?: number;
  composeMs?: number;
}

export const describeBlurStats = (stats: BlurRunStats): string => {
  const parts = [Math.round(stats.fps) + ' fps', Math.max(1, Math.round(stats.latencyMs)) + ' ms added'];
  if (stats.segmentEvery > 1) parts.push('person found every ' + (stats.segmentEvery === 2 ? '2nd' : '3rd') + ' frame');
  return parts.join(' · ');
};

export interface CameraBlurStatus {
  /** What the user picked. */
  level: CameraBlurLevel;
  state: 'off' | 'starting' | 'running' | 'failed';
  /** Where the blur happens: the system's camera effects or this device's segmentation. */
  engine: 'system' | 'device' | null;
  /** On-device only: the strength and segmentation rate running now (after any step-down). */
  tier: BlurTier | null;
  /** On-device only: false while the model is still loading (the picture is blurred everywhere then). */
  modelReady: boolean;
  stats: BlurRunStats | null;
  /** One line about a step-down, a failure or the system's effects. */
  notice: string | null;
}

export const OFF_STATUS: CameraBlurStatus = { level: 'off', state: 'off', engine: null, tier: null, modelReady: false, stats: null, notice: null };
