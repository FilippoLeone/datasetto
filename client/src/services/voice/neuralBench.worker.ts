/**
 * Times DeepFilterNet3 frame by frame in a worker, so a phone can decide whether it has headroom
 * for the better model without ever running it on the audio thread.
 * Message in: { wasmModule: WebAssembly.Module, modelBytes: ArrayBuffer, frames: number }
 * Message out: { engine: 'deepfilternet3', meanMs, p95Ms } or { error }
 */
import init, { DeepFilter } from '@/audio/neural/deepfilternet3-glue.js';

interface Request {
  wasmModule: WebAssembly.Module;
  modelBytes: ArrayBuffer;
  frames: number;
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const { wasmModule, modelBytes, frames } = event.data;
  try {
    const wasm = await init(wasmModule);
    const model = new DeepFilter(new Uint8Array(modelBytes), 100, -1e9, 1e9, 1e9);
    const n = model.frame_length();
    const times: number[] = [];
    let seed = 1;
    for (let f = 0; f < frames; f++) {
      const view = new Float32Array(wasm.memory.buffer, model.input_ptr(), n);
      for (let i = 0; i < n; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        view[i] = ((seed / 4294967296) * 2 - 1) * 0.03;
      }
      const started = performance.now();
      model.process();
      times.push(performance.now() - started);
    }
    model.free();
    const measured = times.slice(Math.min(20, times.length - 1)).sort((a, b) => a - b); // skip the warm-up
    const meanMs = measured.reduce((a, b) => a + b, 0) / Math.max(1, measured.length);
    const p95Ms = measured[Math.min(measured.length - 1, Math.floor(0.95 * measured.length))] ?? meanMs;
    self.postMessage({ engine: 'deepfilternet3', meanMs, p95Ms });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
