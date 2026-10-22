/**
 * Fuseyard's sounds (fuseyard.md §9): effect recipes synthesized by the platform's audio module
 * (pre-rendered once, 22,050 Hz mono), at most 4 explosion voices per 100 ms, and an optional music
 * loop per arena generated from a chord progression (original, stored as note arrays).
 */
import type { GameAudio, MusicSeq, SoundRecipe } from '@/arcade/runtime/audio';

export const RECIPES: Readonly<Record<string, SoundRecipe>> = {
  // Sine 180 → 90 Hz over 80 ms, plus a click.
  place: {
    layers: [
      { wave: 'sine', freq: 180, freqEnd: 90, decay: 0.08, gain: 0.9 },
      { wave: 'noise', freq: 5000, filter: 'highpass', decay: 0.012, gain: 0.35 },
    ],
  },
  // Noise with a low-pass swept 2,000 → 200 Hz over 400 ms, plus a 60 Hz thump.
  explode: {
    gain: 0.9,
    layers: [
      { wave: 'noise', freq: 2000, freqEnd: 200, filter: 'lowpass', decay: 0.4, gain: 1 },
      { wave: 'sine', freq: 60, freqEnd: 40, decay: 0.3, gain: 0.9 },
    ],
  },
  // Band-pass noise at 900 Hz, 120 ms.
  crumble: { layers: [{ wave: 'noise', freq: 900, filter: 'bandpass', q: 3, decay: 0.12, gain: 0.7 }] },
  // A square-wave major triad, 3 × 40 ms.
  pickup: {
    gain: 0.45,
    layers: [
      { wave: 'square', freq: 1046.5, decay: 0.04 },
      { wave: 'square', freq: 1318.5, decay: 0.04, delay: 0.04 },
      { wave: 'square', freq: 1568, decay: 0.06, delay: 0.08 },
    ],
  },
  // A noise sweep 400 → 1,600 Hz, 90 ms.
  kick: { layers: [{ wave: 'noise', freq: 400, freqEnd: 1600, filter: 'bandpass', q: 2, decay: 0.09, gain: 0.8 }] },
  // An FM bell at 660 Hz.
  teleport: { gain: 0.6, layers: [{ wave: 'sine', freq: 660, fm: { ratio: 3.5, depth: 1.6 }, decay: 0.5 }] },
  // A square glide 600 → 100 Hz, 300 ms.
  death: { gain: 0.5, layers: [{ wave: 'square', freq: 600, freqEnd: 100, decay: 0.3 }] },
  // Closing Time: an 880/660 Hz alarm.
  closing: {
    gain: 0.35,
    layers: [
      { wave: 'square', freq: 880, decay: 0.14 },
      { wave: 'square', freq: 660, decay: 0.14, delay: 0.18 },
      { wave: 'square', freq: 880, decay: 0.14, delay: 0.36 },
      { wave: 'square', freq: 660, decay: 0.14, delay: 0.54 },
    ],
  },
  tick: { gain: 0.35, layers: [{ wave: 'sine', freq: 520, decay: 0.08 }] },
  go: { gain: 0.45, layers: [{ wave: 'sine', freq: 780, decay: 0.12 }, { wave: 'sine', freq: 1170, decay: 0.12, delay: 0.02, gain: 0.5 }] },
  win: {
    gain: 0.4,
    layers: [
      { wave: 'triangle', freq: 523.3, decay: 0.12 },
      { wave: 'triangle', freq: 659.3, decay: 0.12, delay: 0.1 },
      { wave: 'triangle', freq: 784, decay: 0.12, delay: 0.2 },
      { wave: 'triangle', freq: 1046.5, decay: 0.3, delay: 0.3 },
    ],
  },
  shield: { gain: 0.3, layers: [{ wave: 'triangle', freq: 440, freqEnd: 880, decay: 0.15 }] },
};

export interface Sfx {
  play(id: keyof typeof RECIPES, o?: { gain?: number; detune?: number }): void;
  explode(seed: number): void;
}

/** Effects through `audio`, with the explosion voice limit (4 per 100 ms) and ±8 % pitch. */
export const createSfx = (audio: GameAudio, now: () => number): Sfx => {
  const recent = new Float64Array(4);
  let next = 0;
  return {
    play(id, o) {
      audio.play(id, o);
    },
    explode(seed) {
      const t = now();
      if (t - (recent[next] as number) < 100) return;
      recent[next] = t;
      next = (next + 1) % recent.length;
      // ±8 % ≈ ±133 cents, varied by the bomb so a chain does not sound like one note.
      const detune = (((seed * 2654435761) >>> 0) % 267) - 133;
      audio.play('explode', { detune });
    },
  };
};

// ------------------------------------------------------------------ music

interface Tune {
  bpm: number;
  root: number;
  minor: boolean;
  /** Scale degrees (0-based) of each bar's chord. */
  bars: readonly number[];
  seed: number;
}

/** One tune per arena: Brickyard, Rolling Mill, Frostbite Pond, Warp Garden, Night Depot. */
const TUNES: readonly Tune[] = [
  { bpm: 132, root: 57, minor: false, bars: [0, 3, 4, 0, 5, 3, 4, 4], seed: 11 },
  { bpm: 140, root: 52, minor: true, bars: [0, 0, 5, 6, 0, 3, 6, 4], seed: 23 },
  { bpm: 120, root: 62, minor: false, bars: [0, 5, 3, 4, 0, 5, 1, 4], seed: 37 },
  { bpm: 126, root: 60, minor: false, bars: [0, 2, 3, 4, 5, 3, 1, 4], seed: 41 },
  { bpm: 146, root: 50, minor: true, bars: [0, 6, 5, 6, 0, 3, 4, 4], seed: 53 },
];

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

/** An 8-bar loop (16 steps per bar): two pulse voices, a triangle bass and noise drums. */
export const musicFor = (arena: number): MusicSeq => {
  const t = TUNES[arena] ?? (TUNES[0] as Tune);
  const scale = t.minor ? MINOR : MAJOR;
  const note = (degree: number, octave: number): number => {
    const d = ((degree % 7) + 7) % 7;
    return t.root + 12 * (octave + Math.floor(degree / 7)) + (scale[d] as number);
  };
  let s = t.seed;
  const rnd = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const lead: (number | null)[] = [];
  const harmony: (number | null)[] = [];
  const bass: (number | null)[] = [];
  const drums: (number | null)[] = [];
  for (let bar = 0; bar < t.bars.length; bar += 1) {
    const chord = t.bars[bar] as number;
    let last = chord + 2;
    for (let step = 0; step < 16; step += 1) {
      // Lead: chord tones on strong steps, passing notes between, a few rests.
      if (step % 2 === 0 && rnd() < (step % 4 === 0 ? 0.85 : 0.55)) {
        const choices = [chord, chord + 2, chord + 4, last + 1, last - 1];
        last = choices[Math.floor(rnd() * (step % 4 === 0 ? 3 : 5))] as number;
        lead.push(note(last, 1));
      } else lead.push(null);
      // Harmony: an arpeggio of the chord on eighths.
      harmony.push(step % 2 === 0 ? note(chord + [0, 2, 4, 2][(step >> 1) % 4]!, 0) : null);
      // Bass: root on the beat, fifth on the off-beat.
      bass.push(step % 4 === 0 ? note(chord, -1) : step % 4 === 2 && rnd() < 0.5 ? note(chord + 4, -1) : null);
      // Drums: kick, snare, hats as noise cutoffs.
      drums.push(step % 8 === 0 ? 36 : step % 8 === 4 ? 84 : step % 2 === 1 ? 100 : null);
    }
  }
  return {
    bpm: t.bpm,
    stepsPerBeat: 4,
    loop: true,
    tracks: [
      { wave: 'square', gain: 0.07, decay: 0.12, notes: lead },
      { wave: 'square', gain: 0.035, decay: 0.08, notes: harmony },
      { wave: 'triangle', gain: 0.16, decay: 0.2, notes: bass },
      { wave: 'noise', gain: 0.06, decay: 0.05, notes: drums },
    ],
  };
};
