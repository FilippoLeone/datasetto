/**
 * Bellwick's sound effects (bellwick.md §11): parameter records the game audio runtime pre-renders
 * once at mount. All original. Each stays under 0.6 s, except `downed` (1 s) and `bells` (2.5 s).
 * Levels are relative: the runtime plays effects at 70 % of the Arcade master, itself below voice.
 */
import type { SoundRecipe, ToneLayer } from '@/arcade/runtime/audio';

export type SoundId =
  | 'swish'
  | 'spin'
  | 'hit'
  | 'clink'
  | 'kill'
  | 'hurt'
  | 'cut'
  | 'chip'
  | 'heart'
  | 'chest'
  | 'item'
  | 'key'
  | 'unlock'
  | 'push'
  | 'switch'
  | 'shutter'
  | 'crystal'
  | 'bridge'
  | 'hookThrow'
  | 'hookLatch'
  | 'pull'
  | 'bounce'
  | 'pebble'
  | 'note'
  | 'slam'
  | 'shock'
  | 'bossHurt'
  | 'bossPhase'
  | 'bat'
  | 'rootPop'
  | 'fall'
  | 'splash'
  | 'lantern'
  | 'warp'
  | 'menuMove'
  | 'menuSelect'
  | 'menuBack'
  | 'blip'
  | 'buy'
  | 'refuse'
  | 'brew'
  | 'downed'
  | 'revive'
  | 'bells';

/** An FM bell: a sine whose modulator sits at an inharmonic ratio (1.4 by default). */
const bell = (
  freq: number,
  decay: number,
  gain: number,
  delay = 0,
  ratio = 1.4,
  depth = ratio
): ToneLayer => ({
  wave: 'sine',
  freq,
  fm: { ratio, depth },
  delay,
  decay,
  gain,
});

/** A plain tone. */
const tone = (
  wave: ToneLayer['wave'],
  freq: number,
  decay: number,
  gain: number,
  delay = 0,
  freqEnd?: number
): ToneLayer => ({
  wave,
  freq,
  freqEnd,
  delay,
  decay,
  gain,
});

/** Noise through a filter whose cutoff starts at `freq` (low-pass unless `filter` says otherwise). */
const hiss = (freq: number, decay: number, gain: number, more?: Partial<ToneLayer>): ToneLayer => ({
  wave: 'noise',
  freq,
  decay,
  gain,
  ...more,
});

export const SOUNDS: Readonly<Record<SoundId, SoundRecipe>> = {
  // Combat
  swish: {
    layers: [hiss(2000, 0.09, 0.9, { freqEnd: 600, filter: 'bandpass', q: 1.2, attack: 0.01 })],
  },
  spin: {
    layers: [
      hiss(600, 0.2, 1, { freqEnd: 2400, filter: 'bandpass', q: 2, attack: 0.06 }),
      hiss(2400, 0.18, 0.9, { freqEnd: 800, filter: 'bandpass', q: 2, delay: 0.2 }),
      { ...tone('triangle', 220, 0.32, 0.2, 0, 660), attack: 0.05 },
    ],
  },
  hit: {
    layers: [tone('square', 220, 0.08, 0.35, 0, 110), hiss(2500, 0.05, 0.6, { freqEnd: 400 })],
  },
  clink: {
    layers: [
      bell(1980, 0.2, 0.35, 0, 2.76, 0.8),
      tone('square', 3300, 0.04, 0.06),
      hiss(4000, 0.03, 0.4, { filter: 'highpass' }),
    ],
  },
  kill: {
    layers: [
      hiss(3000, 0.3, 0.8, { freqEnd: 250, attack: 0.01 }),
      tone('square', 520, 0.08, 0.12, 0, 1040),
      tone('triangle', 1040, 0.12, 0.3, 0.07, 1560),
    ],
  },
  hurt: {
    layers: [
      tone('square', 440, 0.2, 0.22, 0, 165),
      tone('square', 466, 0.2, 0.15, 0, 175),
      hiss(1800, 0.07, 0.5),
    ],
  },
  cut: {
    layers: [
      hiss(3500, 0.1, 0.8, { freqEnd: 1500, filter: 'bandpass', q: 0.9 }),
      hiss(700, 0.08, 0.7, { filter: 'bandpass', q: 2, delay: 0.025 }),
    ],
  },
  shock: {
    layers: [
      tone('square', 110, 0.35, 0.12, 0, 70),
      tone('triangle', 220, 0.35, 0.3, 0, 140),
      hiss(300, 0.3, 0.6, { freqEnd: 900, filter: 'bandpass', q: 1 }),
    ],
  },
  pebble: {
    layers: [
      tone('triangle', 900, 0.09, 0.35, 0, 400),
      hiss(2500, 0.05, 0.5, { filter: 'bandpass', q: 2 }),
    ],
  },
  bounce: {
    layers: [
      tone('triangle', 300, 0.12, 0.45, 0, 900),
      tone('square', 900, 0.1, 0.08, 0.05, 600),
      hiss(3000, 0.02, 0.25, { filter: 'highpass' }),
    ],
  },
  bat: {
    layers: [
      bell(2349, 0.15, 0.2, 0, 1.4, 0.8),
      tone('square', 1800, 0.05, 0.06, 0.06, 2600),
      hiss(1500, 0.12, 0.6, { filter: 'bandpass', q: 3, attack: 0.03 }),
    ],
  },
  rootPop: {
    layers: [tone('sine', 180, 0.07, 0.6, 0, 720), hiss(1200, 0.12, 0.7, { freqEnd: 300 })],
  },

  // Old Clapper
  note: { layers: [bell(988, 0.35, 0.3, 0, 2, 0.6), tone('square', 494, 0.15, 0.06)] },
  slam: {
    layers: [
      tone('triangle', 120, 0.5, 0.8, 0, 35),
      hiss(1200, 0.4, 1, { freqEnd: 120 }),
      bell(147, 0.55, 0.25, 0, 1.4, 1.5),
    ],
    gain: 0.75,
  },
  bossHurt: {
    layers: [
      bell(262, 0.5, 0.4, 0, 1.41, 2.4),
      tone('square', 196, 0.12, 0.2, 0, 98),
      hiss(3000, 0.06, 0.5, { filter: 'highpass' }),
    ],
    gain: 0.8,
  },
  bossPhase: {
    layers: [
      hiss(6000, 0.12, 0.9, { freqEnd: 800 }),
      bell(110, 0.58, 0.45, 0, 1.4, 2),
      bell(220, 0.5, 0.25, 0, 2.76, 0.8),
      tone('square', 55, 0.4, 0.12, 0, 40),
    ],
    gain: 0.8,
  },

  // Hero
  fall: {
    layers: [tone('triangle', 1046, 0.55, 0.4, 0, 98), tone('square', 523, 0.5, 0.06, 0, 49)],
  },
  splash: {
    layers: [
      hiss(5000, 0.4, 0.9, { freqEnd: 500, attack: 0.01 }),
      hiss(1600, 0.2, 0.8, { filter: 'bandpass', q: 3, delay: 0.03 }),
      tone('sine', 300, 0.06, 0.3, 0, 900),
    ],
    gain: 0.65,
  },
  downed: {
    layers: [
      { ...tone('triangle', 660, 0.9, 0.4, 0, 247), attack: 0.02 },
      tone('square', 330, 0.8, 0.06, 0, 123),
      bell(440, 0.9, 0.12, 0.05, 1.4, 1),
    ],
  },
  revive: {
    layers: [
      { ...tone('triangle', 392, 0.3, 0.35, 0, 784), attack: 0.04 },
      bell(1175, 0.3, 0.2, 0.12, 2, 0.4),
      bell(1568, 0.35, 0.2, 0.2, 2, 0.4),
    ],
  },
  brew: {
    layers: [
      tone('sine', 280, 0.06, 0.4, 0, 560),
      tone('sine', 340, 0.06, 0.4, 0.08, 680),
      tone('sine', 300, 0.06, 0.4, 0.16, 600),
      tone('sine', 400, 0.06, 0.4, 0.24, 800),
      tone('triangle', 523, 0.25, 0.3, 0.3),
      tone('triangle', 784, 0.25, 0.2, 0.32),
    ],
  },
  warp: {
    layers: [
      { ...tone('square', 300, 0.45, 0.06, 0, 1500), attack: 0.05 },
      tone('triangle', 600, 0.45, 0.25, 0.05, 2400),
      { ...bell(1200, 0.4, 0.15, 0, 1.5, 2), attack: 0.1 },
    ],
  },
  lantern: {
    layers: [
      hiss(250, 0.25, 0.8, { freqEnd: 1800, attack: 0.08 }),
      bell(784, 0.45, 0.3, 0.1, 2, 0.3),
      bell(1175, 0.4, 0.22, 0.16, 2, 0.3),
    ],
  },

  // Pickups and the world
  // A glint: two glassy bell strikes a third apart.
  chip: {
    layers: [bell(2093, 0.12, 0.22, 0, 2.76, 0.5), bell(2637, 0.25, 0.22, 0.045, 2.76, 0.5)],
  },
  heart: {
    layers: [
      tone('triangle', 659, 0.1, 0.45),
      tone('triangle', 880, 0.12, 0.45, 0.07),
      tone('triangle', 1319, 0.3, 0.4, 0.14),
    ],
  },
  chest: {
    layers: [
      { ...tone('square', 70, 0.18, 0.15, 0, 95), attack: 0.04 },
      hiss(600, 0.06, 0.6, { delay: 0.12 }),
      tone('triangle', 1047, 0.1, 0.3, 0.15),
      tone('triangle', 1319, 0.1, 0.3, 0.2),
      tone('triangle', 1568, 0.25, 0.3, 0.25),
    ],
  },
  item: {
    layers: [
      tone('square', 784, 0.08, 0.14),
      tone('square', 988, 0.08, 0.14, 0.05),
      tone('square', 1175, 0.08, 0.14, 0.1),
      tone('square', 1568, 0.3, 0.14, 0.15),
      bell(3136, 0.3, 0.08, 0.15, 1.5, 0.4),
    ],
  },
  key: {
    layers: [
      bell(2637, 0.12, 0.25, 0, 2.76, 0.5),
      bell(3520, 0.12, 0.22, 0.06, 2.76, 0.5),
      bell(2960, 0.25, 0.2, 0.12, 2.76, 0.5),
    ],
  },
  unlock: {
    layers: [
      tone('square', 180, 0.07, 0.25, 0, 90),
      hiss(500, 0.12, 0.6),
      hiss(2500, 0.03, 0.6, { filter: 'highpass', delay: 0.09 }),
      tone('triangle', 1320, 0.2, 0.25, 0.1),
    ],
  },
  push: {
    layers: [
      hiss(250, 0.35, 1, { freqEnd: 180, filter: 'bandpass', q: 3, attack: 0.04 }),
      hiss(900, 0.3, 0.2, { attack: 0.02 }),
      { ...tone('triangle', 55, 0.3, 0.4, 0, 48), attack: 0.04 },
    ],
  },
  switch: {
    layers: [
      tone('square', 300, 0.05, 0.2, 0, 150),
      hiss(3000, 0.02, 0.5),
      tone('triangle', 600, 0.08, 0.3, 0.06),
    ],
  },
  shutter: {
    layers: [
      hiss(400, 0.45, 0.9, { freqEnd: 150, attack: 0.05 }),
      { ...tone('square', 60, 0.4, 0.12, 0, 45), attack: 0.03 },
      tone('square', 160, 0.08, 0.2, 0.42, 80),
    ],
  },
  crystal: {
    layers: [
      bell(1760, 0.45, 0.3, 0, 3.5, 1),
      tone('sine', 2637, 0.4, 0.2, 0.04),
      tone('triangle', 3520, 0.3, 0.1, 0.08),
    ],
  },
  bridge: {
    // A 14 Hz square is a ratchet of clicks that speeds up as it slides to 28 Hz.
    layers: [
      tone('square', 14, 0.45, 0.15, 0, 28),
      { ...tone('triangle', 196, 0.4, 0.25, 0, 392), attack: 0.1 },
      bell(1568, 0.15, 0.2, 0.4, 2, 0.4),
    ],
  },
  hookThrow: {
    layers: [
      tone('square', 260, 0.13, 0.1, 0, 1040),
      hiss(1500, 0.12, 0.5, { freqEnd: 5000, filter: 'highpass' }),
    ],
  },
  hookLatch: {
    layers: [
      tone('triangle', 330, 0.06, 0.5, 0, 165),
      bell(1480, 0.12, 0.25, 0, 2.76, 0.6),
      hiss(2000, 0.02, 0.5),
    ],
  },
  pull: {
    layers: [
      hiss(400, 0.3, 0.9, { freqEnd: 1800, filter: 'bandpass', q: 1.5, attack: 0.08 }),
      { ...tone('triangle', 150, 0.3, 0.25, 0, 450), attack: 0.08 },
    ],
  },

  // Menus, dialogue and the shop
  menuMove: { layers: [tone('square', 1047, 0.03, 0.1)] },
  menuSelect: { layers: [tone('square', 784, 0.05, 0.1), tone('square', 1175, 0.1, 0.1, 0.05)] },
  menuBack: { layers: [tone('square', 784, 0.05, 0.1), tone('square', 523, 0.08, 0.1, 0.05)] },
  blip: { layers: [tone('square', 740, 0.02, 0.05)] },
  buy: {
    layers: [
      hiss(3000, 0.05, 0.5, { filter: 'highpass' }),
      hiss(5000, 0.06, 0.5, { filter: 'bandpass', q: 2, delay: 0.06 }),
      bell(1760, 0.3, 0.2, 0.08, 2.76, 0.5),
      bell(2217, 0.3, 0.16, 0.08, 2.76, 0.5),
    ],
  },
  refuse: { layers: [tone('square', 165, 0.09, 0.18), tone('square', 156, 0.12, 0.18, 0.12)] },

  // The bells ring again: a peal down the tower, treble first, over the tenor's low hum.
  bells: {
    layers: [
      bell(1397, 1.3, 0.1),
      bell(1047, 1.4, 0.12, 0.15, 3.5, 3),
      bell(880, 1.5, 0.14, 0.3),
      bell(698, 1.6, 0.16, 0.45, 3.5, 3),
      bell(523, 1.7, 0.18, 0.6),
      bell(349, 1.7, 0.25, 0.75),
      tone('sine', 175, 1.7, 0.2, 0.75),
    ],
  },
};
