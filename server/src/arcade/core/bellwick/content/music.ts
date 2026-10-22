/**
 * Bellwick's music (bellwick.md §11): four loops and four jingles for a 4-channel tracker (two squares,
 * a triangle, soft noise), all original. The client's audio runtime renders them.
 *
 * The motif is a bell's "ding ding dong": one note struck twice, then a lower answer. Kettlebrook sings
 * it as a falling fourth, Gloamwood and the Bellhouse darken it, Old Clapper drives it in 3+3+2, the
 * item jingle turns it upside down, and the victory peal rings it out.
 */
export type BwWave = 'square' | 'triangle' | 'sawtooth' | 'sine' | 'noise';
export interface BwTrack { readonly wave: BwWave; readonly gain: number; readonly decay?: number; readonly notes: readonly (number | null)[] }
export interface BwMusic { readonly bpm: number; readonly stepsPerBeat: number; readonly loop: boolean; readonly tracks: readonly BwTrack[] }

type Notes = (number | null)[];

const PITCH: Readonly<Record<string, number>> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const DRUM: Readonly<Record<string, number>> = { x: 108, o: 96, k: 64 };

/** Parses a note string: whitespace-separated tokens; '.' rest; 'c4' 'c#4' 'bb3' … 'b7' → MIDI (c4 = 60);
 *  for noise tracks 'x' = 108, 'o' = 96, 'k' = 64 (the note sets the noise low-pass cutoff).
 *  '|' is a bar line and takes no step. An unreadable token throws, so a typo fails every test. */
export function notes(s: string): (number | null)[] {
  const out: Notes = [];
  for (const t of s.split(/\s+/)) {
    if (t === '' || t === '|') continue;
    if (t === '.') {
      out.push(null);
      continue;
    }
    const m = /^([a-g])([#b]?)(\d)$/.exec(t);
    const n = m ? PITCH[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12 * (Number(m[3]) + 1) : DRUM[t];
    if (typeof n !== 'number' || !(n >= 0 && n <= 127)) throw new Error('Bellwick music: bad note ' + t);
    out.push(n);
  }
  return out;
}

/** `n` copies of a phrase. */
const rep = (s: string, n: number): string => {
  let out = s;
  for (let i = 1; i < n; i++) out += ' ' + s;
  return out;
};

const tr = (wave: BwWave, gain: number, decay: number, s: string | Notes): BwTrack => ({ wave, gain, decay, notes: typeof s === 'string' ? notes(s) : s });

const song = (bpm: number, stepsPerBeat: number, loop: boolean, ...tracks: BwTrack[]): BwMusic => ({ bpm, stepsPerBeat, loop, tracks });

/** Gloamwood's harp in eighths: root, fifth, ninth, fifth, then root, fifth, third, fifth. */
const harp = (r: string, f: string, n: string, t: string): string => [r, f, n, f, r, f, t, f].join(' ');

/** The Bellhouse ostinato in eighths on a sixteenth grid: root, its fifth, then a turn through the
 *  neighbours above (`u`) and below (`d`). */
const ost = (r: string, f: string, u: string, d: string): string => [r, r, f, r, r, u, d, f].join(' . ') + ' .';

/** Old Clapper's bass: eighths pumping the octave, the last one leading into the next bar. */
const pump = (r: string, o: string, last: string): string => [r, r, o, r, r, r, o, last].join(' . ') + ' .';

/** Old Clapper's toll over two bars: high, high, low. */
const toll = (h: string, l: string): string => h + ' . . . . . . . ' + h + ' . . . . . . . ' + l + rep(' .', 15);

/** A phrase again `k` steps later, wrapping so it loops cleanly: the Bellhouse echo. */
const echo = (a: Notes, k: number): Notes => a.map((_, i) => a[(i + a.length - k) % a.length] ?? null);

/** Kettlebrook and the Windmere fields: F major in a lilting 6/8, the motif falling a fourth. */
const village = song(96, 3, true,
  tr('square', 0.13, 0.8,
    'f5 . f5 c5 . . | d5 . d5 a4 . . | bb4 . c5 d5 . f5 | e5 . d5 c5 . . | ' +
    'f5 . f5 c5 . . | d5 . d5 a4 . a4 | bb4 . a4 g4 . e4 | f4 . . . . c5 | ' +
    'd5 . f5 bb5 . a5 | a5 . g5 f5 . c5 | d5 . g5 bb5 . a5 | g5 . . e5 . c5 | ' +
    'a5 . a5 f5 . . | g5 . g5 d5 . . | e5 . f5 g5 . e5 | f5 . . c5 . .'),
  tr('square', 0.06, 0.3,
    '. a3 c4 . a3 c4 | . a3 d4 . a3 d4 | . bb3 d4 . bb3 d4 | . g3 e4 . bb3 e4 | ' +
    '. a3 c4 . a3 c4 | . a3 d4 . a3 d4 | . bb3 d4 . bb3 e4 | . a3 c4 . a3 c4 | ' +
    '. bb3 d4 . bb3 d4 | . a3 c4 . a3 c4 | . bb3 d4 . bb3 d4 | . g3 e4 . bb3 e4 | ' +
    '. a3 c4 . a3 c4 | . bb3 d4 . bb3 d4 | . g3 c4 . bb3 e4 | . a3 c4 . bb3 e4'),
  tr('triangle', 0.3, 0.8,
    'f3 . . c3 . . | d3 . . a2 . . | bb2 . . f3 . . | c3 . . e3 . g3 | ' +
    'f3 . . c3 . . | d3 . . c3 . a2 | g2 . . c3 . . | f3 . . c3 . a2 | ' +
    'bb2 . . f3 . d3 | a2 . . f3 . c3 | g2 . . d3 . g2 | c3 . . d3 . e3 | ' +
    'f3 . . c3 . a2 | g2 . . d3 . bb2 | c3 . . g2 . c3 | f3 . . c3 . e3'),
  tr('noise', 0.18, 0.05, rep('k . o x . o | k . o x . o | k . o x . o | k . o x o o', 4)));

/** Gloamwood: a slow A dorian in the mist, a far bell over a ringing harp. */
const wood = song(72, 2, true,
  tr('square', 0.11, 1.6,
    'e5 . e5 . b4 . . . | c5 . d5 . f#5 . . . | e5 . . . c5 . a4 . | b4 . . . g4 . . . | ' +
    'e5 . e5 . a5 . . . | f#5 . . e5 d5 . . . | c5 . . a4 b4 . d5 . | b4 . . . . . d5 .'),
  tr('square', 0.045, 1, [
    harp('a3', 'e4', 'b4', 'c5'), harp('d3', 'a3', 'e4', 'f#4'), harp('f3', 'c4', 'g4', 'a4'), harp('e3', 'b3', 'f#4', 'g4'),
    harp('a3', 'e4', 'b4', 'c5'), harp('d3', 'a3', 'e4', 'f#4'), 'f3 c4 g4 c4 g3 d4 b4 d4', harp('e3', 'b3', 'f#4', 'g4'),
  ].join(' ')),
  tr('triangle', 0.28, 2.4,
    'a2 . . . e3 . . . | d3 . . . a2 . . . | f3 . . . c3 . . . | e3 . . . b2 . . . | ' +
    'a2 . . . e3 . . . | d3 . . . a2 . . . | f3 . . . g3 . . . | e3 . . . b2 . . .'),
  tr('noise', 0.07, 1, rep('. . . . . . . . | . . . . o . . . | . . . . . . . . | . . . . . . o .', 2)));

const bellLead = notes(
  'd5 . . . . . d5 . a4 . . . d6 . . . | bb4 . . . a4 . . . . . . a5 . . . . | ' +
  'f5 . . . . . f5 . c5 . . . . . . . | d5 . . . c#5 . . . . . . . . . a5 . | ' +
  'a4 . . . . . d5 . f5 . . . e5 . d5 . | d5 . . . . . bb4 . g4 . . . . g5 . . | ' +
  'g4 . . . bb4 . . . eb5 . . . . . . . | c#5 . . . . . . . a5 . . . . . . .');

/** The Drowned Bellhouse: D minor over a low ostinato, drips and their echo off wet stone, a slow
 *  heartbeat that quickens on the dominant. */
const bellhouse = song(90, 4, true,
  tr('square', 0.12, 0.7, bellLead),
  tr('square', 0.045, 0.7, echo(bellLead, 3)),
  tr('triangle', 0.3, 0.3, [
    ost('d3', 'a2', 'eb3', 'c3'), ost('d3', 'a2', 'eb3', 'c3'), ost('bb2', 'f2', 'c3', 'a2'), ost('a2', 'e2', 'bb2', 'g#2'),
    ost('d3', 'a2', 'eb3', 'c3'), ost('g2', 'd3', 'a2', 'f#2'), ost('eb3', 'bb2', 'f3', 'd3'), ost('a2', 'e2', 'bb2', 'g#2'),
  ].join(' ')),
  tr('noise', 0.4, 0.08, rep(rep('k . k . . . . . . . . . . . . .', 3) + ' k . k . . . . . . . k . k . . .', 2)));

const clapperA = 'e5 . . e5 . . b4 . d5 . e5 . g5 . f#5 . | e5 . . . . . . . b4 . d5 . e5 . . . | ';

/** Old Clapper: E minor at a gallop, the motif in 3+3+2 over a bell that will not stop tolling. */
const boss = song(150, 4, true,
  tr('square', 0.12, 0.3,
    clapperA + 'g5 . . g5 . . e5 . c5 . e5 . g5 . a5 . | f#5 . . . . . d5 . a4 . . . d5 . f#5 . | ' +
    clapperA + 'g5 . . g5 . . e5 . c5 . . . e5 . g5 . | f#5 . . f#5 . . d#5 . b4 . . . d#5 . f#5 . | ' +
    'a5 . a5 . a5 . a5 . c6 . b5 . a5 . e5 . | a5 . . . . . . . . . . . e5 . a5 . | ' +
    'g5 . g5 . g5 . g5 . b5 . a5 . g5 . e5 . | e5 . . . . . . . . . . . b4 . e5 . | ' +
    'c6 . c6 . g5 . e5 . g5 . . . e5 . g5 . | a5 . a5 . f#5 . d5 . a5 . . . d6 . c6 . | ' +
    'b5 . . . . . . . f#5 . . . d#5 . . . | f#5 . . . d#5 . . . b4 . . . d#5 . . .'),
  tr('square', 0.065, 1.4, [
    toll('e5', 'b4'), toll('c5', 'a4'), toll('e5', 'b4'), toll('e5', 'b4'),
    toll('a4', 'e4'), toll('b4', 'e4'), toll('e5', 'a4'), toll('b4', 'f#4'),
  ].join(' ')),
  tr('triangle', 0.3, 0.18, [
    pump('e3', 'e4', 'e3'), pump('e3', 'e4', 'd3'), pump('c3', 'c4', 'c3'), pump('d3', 'd4', 'd#3'),
    pump('e3', 'e4', 'e3'), pump('e3', 'e4', 'd3'), pump('c3', 'c4', 'c3'), pump('b2', 'b3', 'b2'),
    pump('a2', 'a3', 'a2'), pump('a2', 'a3', 'd3'), pump('e3', 'e4', 'e3'), pump('e3', 'e4', 'd3'),
    pump('c3', 'c4', 'c3'), pump('d3', 'd4', 'c3'), pump('b2', 'b3', 'b2'), pump('b2', 'b3', 'd#3'),
  ].join(' ')),
  tr('noise', 0.2, 0.05, rep(rep('k . o . x . o . k . o . x . o .', 7) + ' k . o . x . o . k . x . x . x x', 2)));

export const MUSIC: {
  readonly village: BwMusic; readonly wood: BwMusic; readonly bellhouse: BwMusic; readonly boss: BwMusic;
  readonly item: BwMusic; readonly save: BwMusic; readonly victory: BwMusic; readonly downed: BwMusic;
} = {
  village,
  wood,
  bellhouse,
  boss,
  /** Found an item: a rising arpeggio, then the motif upside down, "dong dong DING". */
  item: song(150, 4, false,
    tr('square', 0.13, 0.7, 'c5 e5 g5 c6 . . g5 . g5 . c6 . . . . . . . . .'),
    tr('square', 0.06, 0.7, 'e4 . g4 . . . b4 . d5 . e5 . . . . . . . . .'),
    tr('triangle', 0.3, 0.7, 'c3 . . . . . g2 . . . c3 . . . . . . . . .'),
    tr('noise', 0.12, 0.7, '. . . . . . . . . . x . . . . . . . . .')),
  /** A lantern catches and the tale is saved: soft triangles settling home. */
  save: song(120, 4, false,
    tr('triangle', 0.3, 0.7, 'c5 . f5 . a5 . g5 . f5 . . .'),
    tr('square', 0.035, 0.5, 'a4 . . . c5 . bb4 . a4 . . .'),
    tr('triangle', 0.25, 0.8, 'f3 . . . . . c3 . f3 . . .')),
  /** The bells ring again: a fanfare, the motif on the big bells, then a full peal down the tower. */
  victory: song(120, 4, false,
    tr('square', 0.12, 0.6,
      'c5 . c5 c5 f5 . . . a5 . . . c6 . . . | d6 . . . c6 . bb5 . g5 . . . c6 . . . | ' +
      'a5 . . . a5 . f5 . . . . . c6 . a5 . | f5 . . . . . . .'),
    tr('square', 0.06, 1.8,
      rep('.', 16) + ' | f5 . . . f5 . . . c5 . . . . . . . | f5 . e5 . d5 . c5 . bb4 . a4 . g4 . f4 . | a4 . . . f5 . . .'),
    tr('triangle', 0.3, 0.5,
      'f3 . . . f3 . . . f3 . . . c3 . . . | bb2 . . . bb2 . . . c3 . . . c3 . e3 . | ' +
      'f3 . . . c3 . . . f3 . . . c3 . . . | f2 . . . . . . .'),
    tr('noise', 0.1, 0.9, 'x' + rep(' .', 31) + ' x' + rep(' .', 15) + ' x . . . . . . .')),
  /** You fell: a gentle fall from A to D in thirds, no harm meant. */
  downed: song(90, 4, false,
    tr('square', 0.1, 0.6, 'a4 . g4 f4 . e4 . . d4 . . .'),
    tr('square', 0.045, 0.6, 'f4 . e4 d4 . c#4 . . a3 . . .'),
    tr('triangle', 0.28, 0.9, 'd3 . . bb2 . a2 . . d3 . . .')),
};
