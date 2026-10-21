// ---- DeepFilterNet3 processor (expects initSync + DeepFilter from the wasm-bindgen glue above) ----

const DF_FRAME_WINDOW = 100; // frames per load report (1 s)

/**
 * Runs DeepFilterNet3 on the mono input and gates the pauses from the model's local SNR estimate.
 *
 * processorOptions: { wasmModule, modelBytes, attenLimDb, thresholds: [min, maxErb, maxDf],
 *   postFilterBeta, gate: ActivityGate options | null, lsnrMidDb, lsnrSlopeDb, bypassUntilReady, report: bool }
 * Messages in: { type: 'configure', attenLimDb?, postFilterBeta?, gate?, enabled?, thresholds? }, { type: 'dispose' }
 * Messages out: { type: 'ready', frameSamples, lookaheadFrames, delaySamples }, { type: 'error', message },
 *   { type: 'load', load, maxFrameMs, frames, highRes }, { type: 'frame', lsnr, activity, open } (when report)
 */
class DeepFilterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.enabled = o.enabled !== false;
    this.bypassUntilReady = o.bypassUntilReady !== false;
    this.report = Boolean(o.report);
    this.lsnrMidDb = typeof o.lsnrMidDb === 'number' ? o.lsnrMidDb : 8;
    this.lsnrSlopeDb = typeof o.lsnrSlopeDb === 'number' ? o.lsnrSlopeDb : 4;
    this.model = null;
    this.inputFifo = null;
    this.outputFifo = null;
    this.frame = null;
    this.gate = o.gate ? new ActivityGate(o.gate) : null;
    this.loadMeter = null;
    this.disposed = false;
    this.port.onmessage = (event) => this.onMessage(event.data || {});
    try {
      if (sampleRate !== 48000) throw new Error('DeepFilterNet3 needs a 48 kHz AudioContext, got ' + sampleRate);
      initSync({ module: o.wasmModule });
      const thresholds = Array.isArray(o.thresholds) && o.thresholds.length === 3 ? o.thresholds : [-Infinity, Infinity, Infinity];
      this.model = new DeepFilter(new Uint8Array(o.modelBytes), typeof o.attenLimDb === 'number' ? o.attenLimDb : 100, thresholds[0], thresholds[1], thresholds[2]);
      if (typeof o.postFilterBeta === 'number') this.model.set_post_filter_beta(o.postFilterBeta);
      this.frameSamples = this.model.frame_length();
      this.frame = new Float32Array(this.frameSamples);
      this.inputFifo = new SampleFifo(this.frameSamples * 4 + 512);
      this.outputFifo = new SampleFifo(this.frameSamples * 4 + 512);
      this.loadMeter = new LoadMeter(DF_FRAME_WINDOW, (this.frameSamples / sampleRate) * 1000);
      const lookaheadFrames = this.model.lookahead();
      this.port.postMessage({
        type: 'ready',
        frameSamples: this.frameSamples,
        lookaheadFrames,
        gateFrames: this.gate ? this.gate.delayFrames : 0,
        highRes: hasHighResClock,
      });
    } catch (error) {
      this.fail(error);
    }
  }

  onMessage(data) {
    if (data.type === 'dispose') {
      this.disposed = true;
      if (this.model) { try { this.model.free(); } catch { /* already freed */ } }
      this.model = null;
      return;
    }
    if (data.type !== 'configure' || !this.model) return;
    if (typeof data.attenLimDb === 'number') this.model.set_atten_lim(data.attenLimDb);
    if (typeof data.postFilterBeta === 'number') this.model.set_post_filter_beta(data.postFilterBeta);
    if (Array.isArray(data.thresholds) && data.thresholds.length === 3) this.model.set_thresholds(data.thresholds[0], data.thresholds[1], data.thresholds[2]);
    if (typeof data.enabled === 'boolean') this.enabled = data.enabled;
    if (data.gate && this.gate) this.gate.configure(data.gate);
    if (typeof data.lsnrMidDb === 'number') this.lsnrMidDb = data.lsnrMidDb;
    if (typeof data.lsnrSlopeDb === 'number') this.lsnrSlopeDb = data.lsnrSlopeDb;
  }

  fail(error) {
    this.model = null;
    this.port.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }

  activityFromLsnr(lsnr) {
    return 1 / (1 + Math.exp(-(lsnr - this.lsnrMidDb) / this.lsnrSlopeDb));
  }

  process(inputs, outputs) {
    if (this.disposed) return false;
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    if (!input) { output.fill(0); return true; }
    if (!this.model || !this.enabled) {
      if (this.bypassUntilReady || !this.model === false) output.set(input.subarray(0, output.length));
      else output.fill(0);
      return true;
    }
    try {
      this.inputFifo.push(input);
      const memory = wasm.memory.buffer;
      while (this.inputFifo.length >= this.frameSamples) {
        this.inputFifo.pull(this.frame);
        const started = nowMs();
        const inputLevelDb = frameLevelDb(this.frame);
        const inView = new Float32Array(wasm.memory.buffer, this.model.input_ptr(), this.frameSamples);
        inView.set(this.frame);
        const lsnr = this.model.process();
        const outView = new Float32Array(wasm.memory.buffer, this.model.output_ptr(), this.frameSamples);
        const activity = this.activityFromLsnr(lsnr);
        let out;
        if (this.gate) out = this.gate.process(outView, inputLevelDb, activity);
        else out = outView;
        this.outputFifo.push(out);
        const elapsed = nowMs() - started;
        const load = this.loadMeter.record(elapsed);
        if (load) this.port.postMessage({ type: 'load', ...load, highRes: hasHighResClock });
        if (this.report) this.port.postMessage({ type: 'frame', lsnr, activity, open: this.gate ? this.gate.open : true, inputLevelDb });
      }
      if (!this.outputFifo.pull(output)) output.fill(0);
    } catch (error) {
      this.fail(error);
      if (this.bypassUntilReady) output.set(input.subarray(0, output.length));
      else output.fill(0);
    }
    return true;
  }
}

registerProcessor('deepfilter-processor', DeepFilterProcessor);
