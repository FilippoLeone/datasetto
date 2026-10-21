// Types for common.js, the parts shared by the neural suppression worklets (plain JS so it can be inlined).

export class SampleFifo {
  constructor(capacity: number);
  readonly length: number;
  push(samples: Float32Array): void;
  pull(target: Float32Array): boolean;
  clear(): void;
}

export function frameLevelDb(frame: Float32Array): number;

export interface ActivityGateOptions {
  /** Activity (0..1) at or above which a frame counts as speech for opening. */
  openThreshold: number;
  /** Activity below which the gate starts closing (hysteresis). */
  closeThreshold: number;
  /** Consecutive speech frames needed before opening. */
  openFrames: number;
  /** Frames the gate stays open after the last speech frame. */
  holdFrames: number;
  /** Frames of output delay; the gate ramps open over them so word attacks are kept. */
  lookaheadFrames: number;
  /** Frames the closing ramp takes. */
  releaseFrames: number;
  /** Linear gain while closed. */
  closedGain: number;
  /** A frame only counts as speech when the model kept it within this many dB of the input. */
  keptWithinDb: number;
}

export class ActivityGate {
  constructor(options: ActivityGateOptions);
  readonly open: boolean;
  readonly delayFrames: number;
  configure(options: Partial<ActivityGateOptions>): void;
  process(frame: Float32Array, inputLevelDb: number, activity: number): Float32Array;
}

export class LoadMeter {
  constructor(windowFrames: number, frameMs: number);
  record(elapsedMs: number): { load: number; maxFrameMs: number; frames: number } | null;
}

export const nowMs: () => number;
export const hasHighResClock: boolean;
