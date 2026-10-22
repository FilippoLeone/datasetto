/**
 * Glimmerhall's three machines (docs/arcade/glimmerhall.md §1–§3): strips, lines, paytables, bet
 * ladders and features, exactly as designed. Pure data plus a few lookups; shared by the server
 * (online authority) and the device (offline play, line details, "How it works").
 *
 * Symbols are small integers per machine (their index in `symbols`). A strip is a circular list of
 * symbol indices; stop `i` shows `strip[i]`, `strip[i+1]` and `strip[i+2]` (mod length) as the top,
 * middle and bottom rows. What is drawn is what is shown: no virtual reels, no weighting.
 *
 * Changing any strip, paytable, line or feature rule needs a `VERSION.defs` bump (version.ts).
 */

export const MACHINES = ['orchard', 'tidepool', 'embervault'] as const;
export type MachineCode = (typeof MACHINES)[number];
/** The wire index of a machine. */
export type MachineIdx = 0 | 1 | 2;

/** Rows in every window. */
export const ROWS = 3;
/** Hard cap on free spins played in one feature (§2). */
export const FS_CAP = 200;
/** Glimmer Dash: spins per entrant and the fixed bet, in sprint points. */
export const DASH_SPINS = 100;
export const DASH_BET = 20;

export type FeatureDef =
  /** Harvest Wheel: equally likely segments, each paying `× bet`. */
  | { readonly kind: 'wheel'; readonly segments: readonly number[] }
  /** Tide Turn: free spins on the same strips, every win × mult; three scatters add `retrigger` spins. */
  | { readonly kind: 'tide'; readonly scatterPay: number; readonly spins: number; readonly mult: number; readonly retrigger: number }
  /** Three Vaults: three prizes behind three doors, then Forge Spins on the Forge strips. */
  | {
      readonly kind: 'vault';
      readonly scatterPay: number;
      readonly prizes: readonly { readonly spins: number; readonly mult: number }[];
      readonly retrigger: number;
    };

export interface MachineDef {
  readonly idx: MachineIdx;
  readonly code: MachineCode;
  readonly name: string;
  readonly feature: FeatureDef;
  /** Feature name as shown. */
  readonly featureName: string;
  readonly reels: number;
  /** Symbol codes, one char each, in index order. */
  readonly symbols: string;
  readonly symbolNames: readonly string[];
  readonly wild: number;
  /** Orchard's Sunseed pays on its own; the others' wilds do not. */
  readonly wildPays: boolean;
  /** The scatter or bonus symbol. */
  readonly scatter: number;
  /** Reels the scatter sits on; one in each of these windows triggers the feature. */
  readonly scatterReels: readonly number[];
  readonly eval: 'lines' | 'ways';
  /** Lines: the row (0 = top) on each reel. Empty for ways. */
  readonly lines: readonly (readonly number[])[];
  /** Per symbol, indexed by the run length (0..reels): units per line (lines) or per way (ways). */
  readonly pays: readonly (readonly number[])[];
  /** One unit = bet / unitDiv chips (a line bet for Orchard, a coin for the others). */
  readonly unitDiv: number;
  readonly bets: readonly number[];
  /** Base strips, one per reel (symbol indices). */
  readonly strips: readonly Uint8Array[];
  /** Free-spin strips (Ember Vault's Forge strips); the base strips elsewhere. */
  readonly fsStrips: readonly Uint8Array[];
  /** The strips as written in the design, for tests and the paytable. */
  readonly stripText: readonly string[];
  /** Lines flattened for the engine: cell index (reel × 3 + row) per line and reel. */
  readonly lineCells: Uint8Array;
  /** Pays flattened for the engine: `payFlat[sym × (reels + 1) + count]`. */
  readonly payFlat: Uint16Array;
  readonly fsStripText: readonly string[];
}

const toStrip = (symbols: string, text: string): Uint8Array => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const at = symbols.indexOf(text.charAt(i));
    // A typo in a strip is a build-time bug; the strip tests catch it (255 never appears in a valid strip).
    out[i] = at < 0 ? 255 : at;
  }
  return out;
};

/** Pays by symbol code → [count, pay] pairs, laid out as arrays indexed by count. */
const payTable = (symbols: string, reels: number, rows: Readonly<Record<string, readonly (readonly [number, number])[]>>): number[][] => {
  const out: number[][] = [];
  for (let s = 0; s < symbols.length; s += 1) {
    const row: number[] = [];
    for (let k = 0; k <= reels; k += 1) row.push(0);
    const entries = rows[symbols.charAt(s)] ?? [];
    for (let i = 0; i < entries.length; i += 1) {
      const pair = entries[i] as readonly [number, number];
      row[pair[0]] = pair[1];
    }
    out.push(row);
  }
  return out;
};

const parseLines = (text: string): number[][] => {
  const out: number[][] = [];
  const words = text.split(' ');
  for (let w = 0; w < words.length; w += 1) {
    const word = words[w] as string;
    const line: number[] = [];
    for (let i = 0; i < word.length; i += 1) line.push(word.charCodeAt(i) - 48);
    out.push(line);
  }
  return out;
};

const machine = (o: {
  idx: MachineIdx;
  code: MachineCode;
  name: string;
  featureName: string;
  feature: FeatureDef;
  symbols: string;
  symbolNames: readonly string[];
  wildPays: boolean;
  scatterReels: readonly number[];
  eval: 'lines' | 'ways';
  lines: string;
  pays: Readonly<Record<string, readonly (readonly [number, number])[]>>;
  unitDiv: number;
  bets: readonly number[];
  strips: readonly string[];
  fsStrips?: readonly string[];
}): MachineDef => {
  const reels = o.strips.length;
  const fsText = o.fsStrips ?? o.strips;
  const lines = o.lines === '' ? [] : parseLines(o.lines);
  const pays = payTable(o.symbols, reels, o.pays);
  const lineCells = new Uint8Array(lines.length * reels);
  for (let l = 0; l < lines.length; l += 1) for (let r = 0; r < reels; r += 1) lineCells[l * reels + r] = r * ROWS + ((lines[l] as number[])[r] as number);
  const payFlat = new Uint16Array(pays.length * (reels + 1));
  for (let s = 0; s < pays.length; s += 1) for (let k = 0; k <= reels; k += 1) payFlat[s * (reels + 1) + k] = (pays[s] as number[])[k] as number;
  return {
    idx: o.idx,
    code: o.code,
    name: o.name,
    feature: o.feature,
    featureName: o.featureName,
    reels,
    symbols: o.symbols,
    symbolNames: o.symbolNames,
    wild: o.symbols.indexOf('W'),
    wildPays: o.wildPays,
    scatter: o.symbols.length - 1,
    scatterReels: o.scatterReels,
    eval: o.eval,
    lines,
    pays,
    lineCells,
    payFlat,
    unitDiv: o.unitDiv,
    bets: o.bets,
    strips: o.strips.map((t) => toStrip(o.symbols, t)),
    fsStrips: fsText.map((t) => toStrip(o.symbols, t)),
    stripText: o.strips,
    fsStripText: fsText,
  };
};

const ORCHARD_STRIP = 'BAPRHAFPRAPWHARPAFHRPA';

/** Pocket Orchard: 3 × 3, 5 lines, the Harvest Wheel (§3.1). */
export const ORCHARD: MachineDef = machine({
  idx: 0,
  code: 'orchard',
  name: 'Pocket Orchard',
  featureName: 'Harvest Wheel',
  feature: { kind: 'wheel', segments: [5, 5, 8, 8, 10, 10, 12, 15, 20, 25, 40, 75] },
  // The bonus symbol is last, so `scatter` is always the last index.
  symbols: 'APRHFWB',
  symbolNames: ['Acorn', 'Plum', 'Pear', 'Honeycomb', 'Fig', 'Sunseed', 'Basket'],
  wildPays: true,
  scatterReels: [0, 1, 2],
  eval: 'lines',
  lines: '111 000 222 012 210',
  pays: {
    A: [[2, 1], [3, 5]],
    P: [[3, 9]],
    R: [[3, 14]],
    H: [[3, 28]],
    F: [[3, 60]],
    W: [[3, 150]],
  },
  unitDiv: 5,
  bets: [5, 10, 25, 50, 100],
  strips: [ORCHARD_STRIP, ORCHARD_STRIP, ORCHARD_STRIP],
});

const TIDE_OUTER = 'XSCKUHLTSCKUOSHCXKULSCKTSUHCKSLUXCKHSOUCKSTLHUCKS';
const TIDE_INNER = 'WSCKUHLTSCKUOSHCKULSCKTSWUHCKSLUCKHSOUCKSTLHUCKS';
const TIDE_MID = 'XSCKUHLTWSCKUOSHCXKULSCKTSUHCKSLUWXCKHSOUCKSTLHUCKS';

/** Tidepool Treasures: 5 × 3, 20 fixed lines, Tide Turn free spins (§3.2). */
export const TIDEPOOL: MachineDef = machine({
  idx: 1,
  code: 'tidepool',
  name: 'Tidepool Treasures',
  featureName: 'Tide Turn',
  feature: { kind: 'tide', scatterPay: 2, spins: 10, mult: 2, retrigger: 10 },
  symbols: 'SCKUHLTOWX',
  symbolNames: ['Spiral Shell', 'Crab', 'Kelp', 'Urchin', 'Seahorse', 'Lanternfish', 'Turtle', 'Octopus', 'Pearl', 'Starfish'],
  wildPays: false,
  scatterReels: [0, 2, 4],
  eval: 'lines',
  lines: '11111 00000 22222 01210 21012 00122 22100 10001 12221 01110 21112 10121 12101 01010 21212 11011 11211 02020 20202 02220',
  pays: {
    S: [[3, 10], [4, 35], [5, 120]],
    C: [[3, 10], [4, 35], [5, 120]],
    K: [[3, 15], [4, 45], [5, 150]],
    U: [[3, 15], [4, 45], [5, 150]],
    H: [[3, 25], [4, 100], [5, 300]],
    L: [[3, 35], [4, 140], [5, 500]],
    T: [[3, 60], [4, 250], [5, 900]],
    O: [[2, 5], [3, 120], [4, 500], [5, 2500]],
  },
  unitDiv: 20,
  bets: [20, 40, 100, 200, 500],
  strips: [TIDE_OUTER, TIDE_INNER, TIDE_MID, TIDE_INNER, TIDE_OUTER],
});

const EMBER_OUTER = 'KafmsgHAafmsgPafKmsgDafHmsAafgmsKafPgmsafHAgmsaf';
const EMBER_INNER = 'afmsgHAafmsgPafmsgDafHmWsAafgmsafPgmsafHAgmsafW';
const EMBER_MID = 'KafmsgHAWafmsgPaKfmsgDafHmsAafgmsKWafPgmsafHAgmsaf';
const FORGE_OUTER = 'KafmsgHAPafmsKgDafmsgHAafmsKgPafmsHAgafms';
const FORGE_INNER = 'WafmsgHAPaWfmsgDafmsgWHAafmsgPaWfmsHAgafms';
const FORGE_MID = 'KafmsgHWAPafmsgKDaWfmsgHAafmsWKgPafmsHAgWafms';

/** Ember Vault: 5 × 3, 243 ways, Three Vaults into Forge Spins (§3.3). */
export const EMBERVAULT: MachineDef = machine({
  idx: 2,
  code: 'embervault',
  name: 'Ember Vault',
  featureName: 'Three Vaults',
  feature: {
    kind: 'vault',
    scatterPay: 3,
    prizes: [
      { spins: 10, mult: 2 },
      { spins: 8, mult: 3 },
      { spins: 6, mult: 4 },
    ],
    retrigger: 3,
  },
  symbols: 'afmsgHAPDWK',
  symbolNames: ['Ash Rune', 'Frost Rune', 'Moss Rune', 'Storm Rune', 'Glow Rune', 'Forge Hammer', 'Anvil', 'Cinder Plume', 'Ember Drake', 'Molten Core', 'Vault Key'],
  wildPays: false,
  scatterReels: [0, 2, 4],
  eval: 'ways',
  lines: '',
  pays: {
    a: [[3, 4], [4, 10], [5, 30]],
    f: [[3, 4], [4, 10], [5, 30]],
    m: [[3, 4], [4, 12], [5, 40]],
    s: [[3, 4], [4, 12], [5, 40]],
    g: [[3, 6], [4, 20], [5, 50]],
    H: [[3, 20], [4, 50], [5, 200]],
    A: [[3, 25], [4, 75], [5, 300]],
    P: [[3, 40], [4, 150], [5, 600]],
    D: [[3, 75], [4, 400], [5, 2000]],
  },
  unitDiv: 20,
  bets: [20, 40, 100, 200, 500],
  strips: [EMBER_OUTER, EMBER_INNER, EMBER_MID, EMBER_INNER, EMBER_OUTER],
  fsStrips: [FORGE_OUTER, FORGE_INNER, FORGE_MID, FORGE_INNER, FORGE_OUTER],
});

/** By wire index. */
export const DEFS_BY_IDX: readonly MachineDef[] = [ORCHARD, TIDEPOOL, EMBERVAULT];

export const isMachineIdx = (v: unknown): v is MachineIdx => v === 0 || v === 1 || v === 2;

export const machineDef = (m: MachineIdx): MachineDef => DEFS_BY_IDX[m] as MachineDef;

/** The bet ladder trimmed to an admin maximum (steps above it are hidden and refused). */
export const betLadder = (def: MachineDef, maxBet: number): readonly number[] => {
  const out: number[] = [];
  for (let i = 0; i < def.bets.length; i += 1) {
    const bet = def.bets[i] as number;
    if (bet <= maxBet) out.push(bet);
  }
  return out;
};

/** True when `bet` is on the machine's ladder and at most `maxBet`. */
export const betAllowed = (def: MachineDef, bet: number, maxBet: number): boolean => bet <= maxBet && def.bets.indexOf(bet) >= 0;

/** Chips per unit at a bet (a line bet or a coin). */
export const unitOf = (def: MachineDef, bet: number): number => bet / def.unitDiv;

/** The symbol at a reel and row for a stop (rows 0–2 from the top). */
export const cellAt = (strip: Uint8Array, stop: number, row: number): number => strip[(stop + row) % strip.length] as number;
