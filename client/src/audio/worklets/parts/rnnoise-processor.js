// ---- RNNoise processor: hand-written glue for the emscripten build (no JS glue file needed) ----

const RNNOISE_FRAME_WINDOW = 100;
const PCM16_SCALE = 32768;

/** Instantiates the RNNoise wasm (xiph/rnnoise built with emscripten) and wraps its C API. */
const createRnnoise = (wasmModule) => {
  let memory = null;
  const imports = {
    env: {
      __assert_fail: () => { throw new Error('rnnoise assertion failed'); },
      emscripten_resize_heap: (size) => {
        const pages = Math.ceil((size - memory.buffer.byteLength) / 65536);
        if (pages > 0) { try { memory.grow(pages); } catch { return 0; } }
        return 1;
      },
      emscripten_memcpy_big: (dest, src, n) => { new Uint8Array(memory.buffer).copyWithin(dest, src, src + n); return dest; },
      emscripten_memcpy_js: (dest, src, n) => { new Uint8Array(memory.buffer).copyWithin(dest, src, src + n); return dest; },
    },
    wasi_snapshot_preview1: {
      fd_write: (fd, iov, iovcnt, pnum) => { new Uint32Array(memory.buffer)[pnum >> 2] = 0; return 0; },
      fd_close: () => 0,
      fd_seek: () => 0,
      proc_exit: () => { throw new Error('rnnoise exited'); },
    },
  };
  const instance = new WebAssembly.Instance(wasmModule, imports);
  const ex = instance.exports;
  memory = ex.memory;
  if (typeof ex.__wasm_call_ctors === 'function') ex.__wasm_call_ctors();
  const frameSize = ex.rnnoise_get_frame_size();
  const state = ex.rnnoise_create(0);
  if (!state) throw new Error('rnnoise_create failed');
  const inPtr = ex.malloc(frameSize * 4);
  const outPtr = ex.malloc(frameSize * 4);
  return {
    frameSize,
    /** Denoises `frame` (floats in -1..1) in place and returns the voice probability. */
    process(frame) {
      const inView = new Float32Array(memory.buffer, inPtr, frameSize);
      for (let i = 0; i < frameSize; i++) inView[i] = frame[i] * PCM16_SCALE;
      const vad = ex.rnnoise_process_frame(state, outPtr, inPtr);
      const outView = new Float32Array(memory.buffer, outPtr, frameSize);
      for (let i = 0; i < frameSize; i++) frame[i] = outView[i] / PCM16_SCALE;
      return vad;
    },
    destroy() {
      ex.rnnoise_destroy(state);
      ex.free(inPtr);
      ex.free(outPtr);
    },
  };
};

/**
 * Runs RNNoise on the mono input, limits its attenuation by mixing the input back in, and gates
 * pauses from its voice probability.
 *
 * processorOptions: { wasmModule, attenLimDb, gate: ActivityGate options | null, bypassUntilReady, report }
 * Messages as for DeepFilterProcessor ('configure' takes attenLimDb, gate, enabled).
 */
class RnnoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.enabled = o.enabled !== false;
    this.bypassUntilReady = o.bypassUntilReady !== false;
    this.report = Boolean(o.report);
    this.engine = null;
    this.gate = o.gate ? new ActivityGate(o.gate) : null;
    this.setAttenLim(typeof o.attenLimDb === 'number' ? o.attenLimDb : 100);
    this.disposed = false;
    this.port.onmessage = (event) => this.onMessage(event.data || {});
    try {
      if (sampleRate !== 48000) throw new Error('RNNoise needs a 48 kHz AudioContext, got ' + sampleRate);
      this.engine = createRnnoise(o.wasmModule);
      this.frameSamples = this.engine.frameSize;
      this.frame = new Float32Array(this.frameSamples);
      this.inputFifo = new SampleFifo(this.frameSamples * 4 + 512);
      this.outputFifo = new SampleFifo(this.frameSamples * 4 + 512);
      this.loadMeter = new LoadMeter(RNNOISE_FRAME_WINDOW, (this.frameSamples / sampleRate) * 1000);
      this.port.postMessage({ type: 'ready', frameSamples: this.frameSamples, lookaheadFrames: 0, gateFrames: this.gate ? this.gate.delayFrames : 0, highRes: hasHighResClock });
    } catch (error) {
      this.fail(error);
    }
  }

  setAttenLim(db) {
    this.mixBack = db >= 100 ? 0 : Math.pow(10, -Math.abs(db) / 20);
  }

  onMessage(data) {
    if (data.type === 'dispose') {
      this.disposed = true;
      if (this.engine) { try { this.engine.destroy(); } catch { /* ignore */ } }
      this.engine = null;
      return;
    }
    if (data.type !== 'configure') return;
    if (typeof data.attenLimDb === 'number') this.setAttenLim(data.attenLimDb);
    if (typeof data.enabled === 'boolean') this.enabled = data.enabled;
    if (data.gate && this.gate) this.gate.configure(data.gate);
  }

  fail(error) {
    this.engine = null;
    this.port.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }

  process(inputs, outputs) {
    if (this.disposed) return false;
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    if (!input) { output.fill(0); return true; }
    if (!this.engine || !this.enabled) {
      if (this.bypassUntilReady) output.set(input.subarray(0, output.length));
      else output.fill(0);
      return true;
    }
    try {
      this.inputFifo.push(input);
      while (this.inputFifo.length >= this.frameSamples) {
        this.inputFifo.pull(this.frame);
        const started = nowMs();
        const inputLevelDb = frameLevelDb(this.frame);
        const raw = this.mixBack > 0 ? this.frame.slice() : null;
        const vad = this.engine.process(this.frame);
        if (raw) for (let i = 0; i < this.frameSamples; i++) this.frame[i] = this.frame[i] * (1 - this.mixBack) + raw[i] * this.mixBack;
        const out = this.gate ? this.gate.process(this.frame, inputLevelDb, vad) : this.frame;
        this.outputFifo.push(out);
        const elapsed = nowMs() - started;
        const load = this.loadMeter.record(elapsed);
        if (load) this.port.postMessage({ type: 'load', ...load, highRes: hasHighResClock });
        if (this.report) this.port.postMessage({ type: 'frame', vad, activity: vad, open: this.gate ? this.gate.open : true, inputLevelDb });
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

registerProcessor('rnnoise-processor', RnnoiseProcessor);
