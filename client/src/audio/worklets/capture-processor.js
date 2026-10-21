// Captures mono input and posts it to the main thread in 4800-sample chunks (the mic test recording).
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(4800);
    this.fill = 0;
    this.stopped = false;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'stop') {
        this.port.postMessage({ type: 'chunk', samples: this.chunk.slice(0, this.fill) });
        this.port.postMessage({ type: 'done' });
        this.stopped = true;
      }
    };
  }
  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      this.chunk[this.fill++] = input[i];
      if (this.fill === this.chunk.length) {
        this.port.postMessage({ type: 'chunk', samples: this.chunk.slice() });
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
