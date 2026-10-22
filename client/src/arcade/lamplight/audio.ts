/**
 * Lamplight's sounds (lamplight.md §15), synthesized for this project with the Arcade's audio
 * runtime and played 12 dB under the game volume, below voice.
 */
import type { SoundRecipe } from '../runtime/audio';

const E5 = 659.25;
const B5 = 987.77;
const C5 = 523.25;

export const SOUNDS: Readonly<Record<string, SoundRecipe>> = {
  deal: { layers: [{ wave: 'noise', freq: 3200, filter: 'bandpass', q: 1.4, decay: 0.03, gain: 0.55 }] },
  chip: {
    layers: [
      { wave: 'sine', freq: 2200, decay: 0.06, gain: 0.35 },
      { wave: 'sine', freq: 3100, decay: 0.06, gain: 0.25 },
      { wave: 'noise', freq: 6000, filter: 'highpass', decay: 0.012, gain: 0.3 },
    ],
  },
  check: {
    layers: [
      { wave: 'sine', freq: 180, freqEnd: 110, decay: 0.07, gain: 0.9 },
      { wave: 'noise', freq: 900, decay: 0.02, gain: 0.25 },
    ],
  },
  fold: { layers: [{ wave: 'triangle', freq: 620, freqEnd: 190, decay: 0.12, gain: 0.3 }] },
  turn: {
    layers: [
      { wave: 'sine', freq: E5, decay: 0.22, gain: 0.5, fm: { ratio: 2, depth: 0.4 } },
      { wave: 'sine', freq: B5, delay: 0.11, decay: 0.25, gain: 0.45, fm: { ratio: 2, depth: 0.3 } },
    ],
  },
  tick: { layers: [{ wave: 'square', freq: 1300, filter: 'lowpass', decay: 0.015, gain: 0.12 }] },
  win: {
    layers: [C5, E5, 783.99, 1046.5].map((freq, i) => ({ wave: 'triangle' as const, freq, delay: i * 0.08, decay: 0.32, gain: 0.35 })),
  },
  flyTick: { layers: [{ wave: 'sine', freq: 1500, freqEnd: 1800, decay: 0.03, gain: 0.25 }] },
  chord2: { layers: [C5, 783.99].map((freq) => ({ wave: 'triangle' as const, freq, decay: 0.7, gain: 0.3 })) },
  chord3: { layers: [C5, E5, 783.99].map((freq) => ({ wave: 'triangle' as const, freq, decay: 0.9, gain: 0.28 })) },
  chord5: { layers: [261.63, C5, E5, 783.99, 1046.5].map((freq) => ({ wave: 'triangle' as const, freq, decay: 1.4, gain: 0.24, fm: { ratio: 3, depth: 0.15 } })) },
};

/** The chord for a Firefly multiplier: more voices for bigger ones. */
export const chordFor = (mult: number): string => (mult >= 25 ? 'chord5' : mult >= 5 ? 'chord3' : 'chord2');

/** 12 dB under the game volume. */
export const LAMPLIGHT_GAIN = 0.25;
