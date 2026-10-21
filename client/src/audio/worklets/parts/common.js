// ---- shared by the neural suppressor processors (inlined by build-worklets.mjs) ----

/** Float32 FIFO used to reframe 128-sample render quanta into model frames. */
export class SampleFifo {
  constructor(capacity) {
    this.buffer = new Float32Array(capacity);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.length = 0;
  }

  push(samples) {
    if (samples.length > this.buffer.length - this.length) throw new Error('fifo overflow');
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.writeIndex] = samples[i];
      this.writeIndex = (this.writeIndex + 1) % this.buffer.length;
    }
    this.length += samples.length;
  }

  /** Copies `target.length` samples out; returns false (and copies nothing) when too few are queued. */
  pull(target) {
    if (target.length > this.length) return false;
    for (let i = 0; i < target.length; i++) {
      target[i] = this.buffer[this.readIndex];
      this.readIndex = (this.readIndex + 1) % this.buffer.length;
    }
    this.length -= target.length;
    return true;
  }

  clear() {
    this.readIndex = 0;
    this.writeIndex = 0;
    this.length = 0;
  }
}

export const frameLevelDb = (frame) => {
  let energy = 0;
  for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
  return 10 * Math.log10(energy / frame.length + 1e-12);
};

/**
 * Speech gate driven by the model's activity estimate, applied after the model.
 *
 * `activity` is 0..1 (RNNoise's voice probability, or DeepFilterNet's local SNR mapped through a
 * logistic curve). The gate opens once `openFrames` consecutive frames are above `openThreshold`
 * and the model kept the frame (its output is within `keptWithinDb` of the input, so a keystroke
 * the model removed does not count), stays open while activity is above `closeThreshold`, and
 * holds for `holdFrames` frames after. Output is delayed by `lookaheadFrames` so the gain ramp
 * finishes before the first speech frame comes out. When closed the gain is `closedGain`.
 */
export class ActivityGate {
  constructor(options) {
    this.options = { ...options };
    this.queue = [];
    this.gain = options.closedGain;
    this.targetGain = options.closedGain;
    this.open = false;
    this.run = 0;
    this.hold = 0;
    this.currentActivity = 0;
  }

  configure(options) {
    Object.assign(this.options, options);
    if (!this.open) this.targetGain = this.options.closedGain;
  }

  /** Delay in frames the gate adds. */
  get delayFrames() {
    return this.options.lookaheadFrames;
  }

  /**
   * @param frame denoised model frame (not modified)
   * @param inputLevelDb level of the raw input frame
   * @param activity model speech activity 0..1
   * @returns the gated frame from `lookaheadFrames` earlier (silence at the start)
   */
  process(frame, inputLevelDb, activity) {
    const o = this.options;
    const outLevelDb = frameLevelDb(frame);
    const kept = outLevelDb > inputLevelDb - o.keptWithinDb;
    this.currentActivity = activity;
    if (activity >= o.openThreshold && kept) this.run += 1;
    else if (activity < o.closeThreshold) this.run = 0;
    if (this.run >= o.openFrames) {
      this.open = true;
      this.hold = o.holdFrames;
    } else if (this.open) {
      if (activity >= o.closeThreshold && kept) this.hold = o.holdFrames;
      else if (this.hold > 0) this.hold -= 1;
      else this.open = false;
    }
    this.targetGain = this.open ? 1 : o.closedGain;

    this.queue.push(frame.slice());
    if (this.queue.length <= o.lookaheadFrames) return new Float32Array(frame.length);
    const out = this.queue.shift();
    // Ramp linearly towards the target: opening takes the lookahead frames, closing releaseFrames.
    const span = 1 - o.closedGain;
    const rate = this.open ? span / Math.max(1, o.lookaheadFrames) : span / Math.max(1, o.releaseFrames);
    const from = this.gain;
    let to = from + Math.sign(this.targetGain - from) * rate;
    if ((this.targetGain - from) * (this.targetGain - to) <= 0) to = this.targetGain;
    for (let i = 0; i < out.length; i++) out[i] *= from + ((to - from) * i) / out.length;
    this.gain = to;
    return out;
  }
}

/** Sums processing time over windows of frames and reports the share of real time used. */
export class LoadMeter {
  constructor(windowFrames, frameMs) {
    this.windowFrames = windowFrames;
    this.frameMs = frameMs;
    this.frames = 0;
    this.busyMs = 0;
    this.maxMs = 0;
  }

  /** Returns the window's load (0..1) and max frame time when the window is complete, else null. */
  record(elapsedMs) {
    this.busyMs += elapsedMs;
    this.frames += 1;
    if (elapsedMs > this.maxMs) this.maxMs = elapsedMs;
    if (this.frames < this.windowFrames) return null;
    const report = { load: this.busyMs / (this.windowFrames * this.frameMs), maxFrameMs: this.maxMs, frames: this.frames };
    this.frames = 0;
    this.busyMs = 0;
    this.maxMs = 0;
    return report;
  }
}

export const nowMs = typeof performance !== 'undefined' && typeof performance.now === 'function' ? () => performance.now() : () => Date.now();
export const hasHighResClock = typeof performance !== 'undefined' && typeof performance.now === 'function';
