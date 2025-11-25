const DEFAULT_THRESHOLD = 0.025;
const MIN_THRESHOLD = 0.008;
const MAX_THRESHOLD = 0.08;
const MIN_REDUCTION = 0.05;
const MAX_REDUCTION = 0.5;
const DEFAULT_SMOOTHING = 0.0015;
const ATTACK_COEFFICIENT = 0.02;  // Fast attack for speech onset
const RELEASE_COEFFICIENT = 0.0008; // Slow release for natural tail

class NoiseGateProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    const initialConfig = options.processorOptions ?? {};
    this.threshold = this._clamp(initialConfig.threshold ?? DEFAULT_THRESHOLD, MIN_THRESHOLD, MAX_THRESHOLD);
    this.reduction = this._clamp(initialConfig.reduction ?? 0.2, MIN_REDUCTION, MAX_REDUCTION);
    this.smoothing = initialConfig.smoothing ?? DEFAULT_SMOOTHING;
    this.channelGains = [];
    this.envelopeFollowers = [];
    this.holdCounters = [];
    this.holdSamples = 2400; // ~50ms at 48kHz - prevents cutting off consonants

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'configure') {
        if (typeof data.threshold === 'number') {
          this.threshold = this._clamp(data.threshold, MIN_THRESHOLD, MAX_THRESHOLD);
        }
        if (typeof data.reduction === 'number') {
          this.reduction = this._clamp(data.reduction, MIN_REDUCTION, MAX_REDUCTION);
        }
        if (typeof data.smoothing === 'number') {
          this.smoothing = Math.max(1e-5, data.smoothing);
        }
      }
    };
  }

  _clamp(value, min, max) {
    if (!Number.isFinite(value)) {
      return min;
    }
    return Math.min(max, Math.max(min, value));
  }

  _ensureChannels(count) {
    while (this.channelGains.length < count) {
      this.channelGains.push(1);
      this.envelopeFollowers.push(0);
      this.holdCounters.push(0);
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output) {
      return true;
    }

    this._ensureChannels(Math.min(input.length, output.length));

    for (let channel = 0; channel < input.length; channel++) {
      const inChannel = input[channel];
      const outChannel = output[channel];
      if (!inChannel || !outChannel) {
        continue;
      }

      let gain = this.channelGains[channel] ?? 1;
      let envelope = this.envelopeFollowers[channel] ?? 0;
      let holdCounter = this.holdCounters[channel] ?? 0;

      for (let i = 0; i < inChannel.length; i++) {
        const sample = inChannel[i];
        const magnitude = Math.abs(sample);
        
        // Envelope follower with fast attack, slow release
        if (magnitude > envelope) {
          envelope += (magnitude - envelope) * ATTACK_COEFFICIENT;
        } else {
          envelope += (magnitude - envelope) * RELEASE_COEFFICIENT;
        }
        
        // Gate logic with hold time
        let targetGain;
        if (envelope > this.threshold) {
          targetGain = 1;
          holdCounter = this.holdSamples;
        } else if (holdCounter > 0) {
          targetGain = 1;
          holdCounter--;
        } else {
          targetGain = this.reduction;
        }
        
        // Smooth gain transitions
        gain += (targetGain - gain) * this.smoothing;
        outChannel[i] = sample * gain;
      }

      this.channelGains[channel] = gain;
      this.envelopeFollowers[channel] = envelope;
      this.holdCounters[channel] = holdCounter;
    }

    return true;
  }
}

registerProcessor('noise-gate-processor', NoiseGateProcessor);
