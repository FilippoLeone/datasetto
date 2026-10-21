/**
 * Decisions behind the "Strong" noise suppression level, kept free of Web Audio so they can be
 * unit tested: which neural engine to start with, when the machine cannot keep up, and what to
 * step down to.
 *
 * DeepFilterNet3 is the better model and, measured in a worklet, the cheaper of the two (about
 * 0.6 ms per 10 ms frame on a desktop CPU against 1 ms for RNNoise 0.2), but its 15 MB module
 * and 8 MB model take longer to load and its first frames block the audio thread for about
 * 100 ms while the model initializes. Phones start with RNNoise and move to DeepFilterNet3 only
 * when a benchmark in a worker shows there is headroom.
 */

export type NeuralEngine = 'deepfilternet3' | 'rnnoise';

/** What the microphone chain runs: a neural engine, or the browser's own suppression after a step-down. */
export type SuppressionTier = NeuralEngine | 'standard';

export const ENGINE_LABELS: Record<SuppressionTier, string> = {
  deepfilternet3: 'DeepFilterNet3',
  rnnoise: 'RNNoise',
  standard: 'the browser’s suppression',
};

export interface EngineChoiceInput {
  /** Phones and tablets (the Capacitor shell or a touch-first browser). */
  phone: boolean;
  /** WebAssembly SIMD is available (Chrome 91, Firefox 89, Safari 16.4). */
  simd: boolean;
  /** Result of the worker benchmark on this device, when it has run: DeepFilterNet3 cost per 10 ms frame. */
  benchmark?: EngineBenchmark | null;
}

export interface EngineBenchmark {
  engine: NeuralEngine;
  meanMs: number;
  p95Ms: number;
}

/** Frame period of both models at 48 kHz: 480 samples. */
export const FRAME_MS = 10;
/**
 * A phone may run DeepFilterNet3 when its benchmark leaves most of the frame free: the mean cost
 * under a quarter of the period and the 95th percentile under half of it. The worklet also has to
 * fit the 2.67 ms render quantum next to everything else the audio thread does.
 */
export const PHONE_HEADROOM = { meanMs: FRAME_MS * 0.25, p95Ms: FRAME_MS * 0.5 } as const;

/** The engine to start with on this device. */
export const chooseInitialEngine = (input: EngineChoiceInput): NeuralEngine => {
  if (!input.phone) return 'deepfilternet3';
  const bench = input.benchmark;
  if (bench && bench.engine === 'deepfilternet3' && bench.meanMs < PHONE_HEADROOM.meanMs && bench.p95Ms < PHONE_HEADROOM.p95Ms) {
    return 'deepfilternet3';
  }
  return 'rnnoise';
};

/** The next tier when the current one failed or overloaded: DeepFilterNet3 -> RNNoise -> the browser's suppression. */
export const stepDown = (tier: SuppressionTier): SuppressionTier => {
  if (tier === 'deepfilternet3') return 'rnnoise';
  if (tier === 'rnnoise') return 'standard';
  return 'standard';
};

export interface OverloadMonitorOptions {
  /** Share of real time (0..1) a window may use before it counts as overloaded. */
  maxLoad: number;
  /** Consecutive overloaded windows before the monitor reports. One is a hiccup; two is a machine that cannot keep up. */
  windows: number;
}

export const DEFAULT_OVERLOAD: OverloadMonitorOptions = { maxLoad: 0.7, windows: 3 };

/**
 * Counts consecutive load windows (1 s each, reported by the worklet) above the limit and says
 * when the engine should step down. A window below the limit resets the count.
 */
export class OverloadMonitor {
  private consecutive = 0;
  private tripped = false;

  constructor(private readonly options: OverloadMonitorOptions = DEFAULT_OVERLOAD) {}

  /** Records one window's load; returns true once, when the limit has been exceeded for enough windows in a row. */
  record(load: number): boolean {
    if (this.tripped) return false;
    if (!Number.isFinite(load)) return false;
    this.consecutive = load > this.options.maxLoad ? this.consecutive + 1 : 0;
    if (this.consecutive >= this.options.windows) {
      this.tripped = true;
      return true;
    }
    return false;
  }

  reset(): void {
    this.consecutive = 0;
    this.tripped = false;
  }
}

/** User-facing strength (dB of noise removed while speaking) and the limits the slider offers. */
export const STRENGTH_RANGE = { min: 6, max: 40 } as const;
export const DEFAULT_STRENGTH_DB = 25;

export const clampStrength = (value: unknown): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_STRENGTH_DB;
  return Math.min(STRENGTH_RANGE.max, Math.max(STRENGTH_RANGE.min, Math.round(n)));
};
