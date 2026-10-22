/**
 * Glimmerhall's sounds (glimmerhall.md §16): recipes the runtime renders once into small buffers.
 * Each machine colours its win sounds: Orchard a marimba (sine plus its 4th harmonic), Tidepool
 * bubble chirps (rising sines), Ember Vault metallic FM. Nothing here plays on its own.
 */
import type { MachineIdx } from '@arcade/core/glimmer/machines';
import type { SoundRecipe, ToneLayer } from '@/arcade/runtime/audio';

/** A4 = 69. */
const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

const note = (m: MachineIdx, midi: number, delay: number, decay: number, gain = 0.5): ToneLayer[] => {
  const f = hz(midi);
  if (m === 0) return [{ wave: 'sine', freq: f, delay, decay, gain }, { wave: 'sine', freq: f * 4, delay, decay: decay * 0.35, gain: gain * 0.22 }];
  if (m === 1) return [{ wave: 'sine', freq: f * 0.8, freqEnd: f * 1.15, delay, decay, gain }];
  return [{ wave: 'sine', freq: f, delay, decay: decay * 1.4, gain, fm: { ratio: 3.5, depth: 1.6 } }];
};

const seq = (m: MachineIdx, notes: readonly number[], gap: number, decay: number, gain?: number): ToneLayer[] => notes.flatMap((n, i) => note(m, n, i * gap, decay, gain));

const PENTA = [0, 2, 4, 7, 9, 12, 14, 16];

/** Sounds every machine shares. */
export type SharedSound = 'whirr' | 'stop' | 'tick' | 'soft' | 'win3' | 'win4' | 'scatter' | 'wheel' | 'door' | 'reveal' | 'pot' | 'tap';
/** Sounds in each machine's own timbre (the small and medium wins, heard most). */
export type MachineSound = 'win1' | 'win2';
export type SoundId = SharedSound | MachineSound;

export const MACHINE_SOUNDS: readonly MachineSound[] = ['win1', 'win2'];

/** The machine's own win sounds. */
export const machineRecipes = (m: MachineIdx): Record<MachineSound, SoundRecipe> => {
  const root = [60, 62, 57][m] as number;
  return {
    win1: { layers: [{ wave: 'square', freq: hz(root + 12), decay: 0.08, gain: 0.18 }, { wave: 'square', freq: hz(root + 16), delay: 0.09, decay: 0.1, gain: 0.18 }, ...note(m, root + 19, 0.09, 0.2, 0.25)] },
    win2: { layers: seq(m, PENTA.slice(0, 4).map((p) => root + 12 + p), 0.09, 0.28, 0.42) },
  };
};

/** The shared set, rendered once. About 0.9 MB with every machine's own wins added. */
export const sharedRecipes = (): Record<SharedSound, SoundRecipe> => {
  const root = 60;
  const ticks: ToneLayer[] = [];
  for (let i = 0; i < 9; i += 1) ticks.push({ wave: 'square', freq: 1400, delay: i / 12, decay: 0.012, gain: 0.08 });
  const tri = (notes: readonly number[], delay: number, decay: number, gain: number): ToneLayer[] => notes.map((p) => ({ wave: 'triangle', freq: hz(root + p), delay, decay, gain }));
  return {
    whirr: { layers: [{ wave: 'noise', freq: 900, filter: 'bandpass', q: 2.5, attack: 0.05, decay: 0.65, gain: 0.22 }, ...ticks], gain: 0.7 },
    stop: { layers: [{ wave: 'sine', freq: 180, freqEnd: 90, decay: 0.06, gain: 0.7 }, { wave: 'noise', freq: 3200, filter: 'highpass', decay: 0.012, gain: 0.3 }] },
    tick: { layers: [{ wave: 'noise', freq: 4200, filter: 'highpass', decay: 0.008, gain: 0.35 }, { wave: 'square', freq: 2200, decay: 0.006, gain: 0.08 }] },
    soft: { layers: [{ wave: 'sine', freq: 880, decay: 0.05, gain: 0.25 }] },
    win3: { layers: [...tri([0, 4, 7], 0, 0.6, 0.3), ...tri([5, 9, 12], 0.45, 0.6, 0.3), ...tri([7, 12, 16], 0.85, 0.5, 0.32), { wave: 'noise', freq: 6000, filter: 'highpass', attack: 0.2, decay: 1.1, gain: 0.08 }], gain: 0.8 },
    win4: {
      layers: [
        ...PENTA.map((p, i): ToneLayer => ({ wave: 'triangle', freq: hz(root + 12 + p), delay: i * 0.07, decay: 0.25, gain: 0.3 })),
        ...tri([12, 16, 19, 24], 0.6, 1.0, 0.26),
        { wave: 'noise', freq: 7000, filter: 'highpass', attack: 0.3, decay: 1.3, gain: 0.08 },
      ],
      gain: 0.8,
    },
    scatter: { layers: [{ wave: 'sine', freq: hz(root + 19), decay: 0.5, gain: 0.45, fm: { ratio: 3.5, depth: 1.2 } }] },
    wheel: { layers: [{ wave: 'noise', freq: 2600, filter: 'bandpass', q: 3, decay: 0.02, gain: 0.5 }] },
    door: { layers: [{ wave: 'noise', freq: 320, freqEnd: 1300, filter: 'bandpass', q: 9, attack: 0.04, decay: 0.45, gain: 0.55 }] },
    reveal: { layers: [2400, 3100, 2700, 3600, 4200].map((f, i): ToneLayer => ({ wave: 'sine', freq: f, delay: i * 0.05, decay: 0.12, gain: 0.16 })) },
    pot: {
      layers: [
        ...[0, 4, 7, 12, 7, 12, 16, 19].map((p, i): ToneLayer => ({ wave: 'triangle', freq: hz(root + p), delay: i * 0.15, decay: 0.3, gain: 0.34 })),
        ...tri([12, 16, 19, 24], 1.25, 1.1, 0.28),
        { wave: 'noise', freq: 6500, filter: 'highpass', attack: 0.4, decay: 1.8, gain: 0.07 },
      ],
      gain: 0.8,
    },
    tap: { layers: [{ wave: 'sine', freq: 660, freqEnd: 520, decay: 0.03, gain: 0.2 }] },
  };
};
