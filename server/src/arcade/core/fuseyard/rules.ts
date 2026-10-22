/**
 * Fuseyard's rules: constants, kinds, the match configuration, item tables and the state types
 * (docs/arcade/fuseyard.md §1, §2.2). Pure and shared: the server and the device import the same
 * numbers. Kinds are `as const` objects with union types (no enums, platform.md §3.1).
 */

export const TICK_HZ = 30;
/** Sub-units per cell; a cell's centre is at `cell * 64 + 32`. */
export const TILE = 64;
export const HALF = 32;
/** Half of the 48 × 48 hitbox. */
export const HIT_HALF = 24;
export const W = 15;
export const H = 13;
export const CELLS = 195;

export const FUSE = 75;
export const FLAME = 15;
export const REMOTE = 0xffff;
/** A Clicker bomb's fuse once its holder dies or turns ghost. */
export const ORPHAN_FUSE = 45;
export const SHIELD = 45;
export const GHOST_LOCK_MAX = 45;
/** A ghost request waits for bombs whose fuse is at most this. */
export const GHOST_LOCK_FUSE = 30;
export const HOLD_WIN = 150;
export const RESUME_COUNT = 30;
export const COUNTDOWN = 90;
export const RESULT_CARD = 120;
export const ROUND_TICKS = 4500;
export const QUICK_TICKS = 2700;
export const CLOSE_AT = 2700;
export const QUICK_CLOSE_AT = 900;
export const CLOSE_EVERY = 6;
export const WARN_TICKS = 30;
/** Interior non-pillar cells on the Closing Time spiral (the 3 × 3 around the centre is spared). */
export const SPIRAL_CELLS = 106;
export const PAD_COOLDOWN = 20;
export const KICK_SPEED = 16;
export const BELT_PUSH = 4;
export const BELT_SPEED = 4;
export const MAX_BOMBS = 32;
/** Death scatter drops at most this many items. */
export const SCATTER_MAX = 6;
/** Units per tick at speed levels 0–5. */
export const SPEEDS: readonly number[] = [8, 9, 10, 11, 12, 13];

export const Dir = { None: 0, N: 1, E: 2, S: 3, W: 4 } as const;
export type Dir = (typeof Dir)[keyof typeof Dir];
/** Step per direction, indexed by Dir. */
export const DX: readonly number[] = [0, 0, 1, 0, -1];
export const DY: readonly number[] = [0, -1, 0, 1, 0];
export const OPPOSITE: readonly number[] = [0, 3, 4, 1, 2];

export const Cell = { Floor: 0, Wall: 1, Pillar: 2, Block: 3, Steel: 4 } as const;
export type Cell = (typeof Cell)[keyof typeof Cell];

export const Special = { None: 0, BeltN: 1, BeltE: 2, BeltS: 3, BeltW: 4, Ice: 5, PadA: 6, Pada: 7, PadB: 8, Padb: 9 } as const;
export type Special = (typeof Special)[keyof typeof Special];

export const Item = { None: 0, SpareFuse: 1, WideSpark: 2, QuickBoots: 3, ShoveGlove: 4, Clicker: 5 } as const;
export type Item = (typeof Item)[keyof typeof Item];
/** Items per round for 4 fighters, indexed by Item. */
export const ITEM_COUNTS: readonly number[] = [0, 7, 7, 4, 2, 1];
/** Death scatter order. */
export const SCATTER_ORDER: readonly number[] = [Item.Clicker, Item.ShoveGlove, Item.QuickBoots, Item.WideSpark, Item.SpareFuse];
export const BOMBS_CAP = 8;
export const RANGE_CAP = 8;
export const SPEED_CAP = 5;

export const Control = { Human: 0, Ghost: 1, Bot: 2 } as const;
export type Control = (typeof Control)[keyof typeof Control];

/** Wire seat state (platform SeatState): 0 live, 1 ghost, 2 bot, 3 left (a bot in a leaver's seat). */
export const Seat = { Live: 0, Ghost: 1, Bot: 2, Left: 3 } as const;
export type Seat = (typeof Seat)[keyof typeof Seat];

export const BotLevel = { Sprout: 0, Scrapper: 1, Menace: 2 } as const;
export type BotLevel = (typeof BotLevel)[keyof typeof BotLevel];

export const SeatCmd = { None: 0xff, Return: 0, Ghost: 1, BotTakeover: 2, Left: 3, Reclaim: 4 } as const;
export type SeatCmd = (typeof SeatCmd)[keyof typeof SeatCmd];

/** Round phases; the same codes travel in the Round event and the KEYFRAME header. */
export const Phase = { Countdown: 0, Playing: 1, Frozen: 2, Resuming: 3, RoundEnd: 4, MatchEnd: 5 } as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

export const Mode = { Brawl: 0, Quickfire: 1 } as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

/** Input byte: bits 0–2 primary direction, 3–5 secondary, 6 bomb press, 7 detonate press. */
export const IN_BOMB = 0x40;
export const IN_DETONATE = 0x80;
export const inputByte = (d1: number, d2: number, bomb: boolean, detonate: boolean): number =>
  (d1 & 7) | ((d2 & 7) << 3) | (bomb ? IN_BOMB : 0) | (detonate ? IN_DETONATE : 0);
/** A direction value above 4 reads as 0. */
export const inDir1 = (input: number): number => {
  const d = input & 7;
  return d > 4 ? 0 : d;
};
export const inDir2 = (input: number): number => {
  const d = (input >> 3) & 7;
  return d > 4 ? 0 : d;
};

/** Event kinds inside FRAME (fuseyard.md §3.3); sizes include the kind byte. */
export const EV = {
  BombPlaced: 0x01,
  BombKicked: 0x02,
  BombStopped: 0x03,
  Explode: 0x04,
  BlockBroken: 0x05,
  ItemTaken: 0x06,
  ItemBurned: 0x07,
  SteelWarn: 0x08,
  SteelDrop: 0x09,
  ItemDropped: 0x0a,
  Died: 0x0b,
  Stats: 0x0c,
  Teleport: 0x0d,
  Round: 0x0e,
} as const;
export const EV_SIZE: readonly number[] = [0, 7, 4, 4, 8, 3, 4, 2, 2, 2, 3, 4, 4, 5, 8];
/** Explode arm length flag: the arm ended on a block. */
export const ARM_BLOCK = 0x80;
/** BombKicked direction flag: pushed by a belt. */
export const KICK_BELT = 0x80;
export const DEATH_FLAME = 0;
export const DEATH_STEEL = 1;
export const TELE_FIGHTER = 0;
export const TELE_BOMB = 1;
export const TELE_GHOST = 2;
export const NO_SLOT = 0xff;

export type ArenaId = 'yard' | 'mill' | 'pond' | 'garden' | 'depot';
export const ARENA_IDS: readonly ArenaId[] = ['yard', 'mill', 'pond', 'garden', 'depot'];
/** The wire's arena byte for rotation. */
export const ROTATION = 0xff;

export interface MatchConfig {
  mode: 'brawl' | 'quickfire';
  arena: ArenaId | 'rotation';
  fighters: 2 | 3 | 4;
  winsNeeded: 2 | 3 | 5;
  botLevel: BotLevel;
  /** u32, drawn by the server (crypto) or the device (getRandomValues), never in core. */
  seed: number;
}

export const DEFAULT_CONFIG: MatchConfig = { mode: 'brawl', arena: 'rotation', fighters: 4, winsNeeded: 3, botLevel: BotLevel.Scrapper, seed: 1 };

export interface Fighter {
  slot: number;
  /** Seated in this match (slot < fighters). */
  seated: boolean;
  control: Control;
  /** A bot in a leaver's seat: it is never reclaimed. */
  left: boolean;
  botLevel: BotLevel;
  x: number;
  y: number;
  facing: Dir;
  moving: boolean;
  alive: boolean;
  diedAt: number;
  bombsMax: number;
  bombsOut: number;
  range: number;
  speedLvl: number;
  glove: boolean;
  clicker: boolean;
  /** Collected items this round, indexed by Item. */
  collected: Uint8Array;
  padCooldown: number;
  dodgeGrace: number;
  doomedTicks: number;
  /** Ticks of invulnerability left. */
  shield: number;
  /** 0xff: no ghost request pending; else ticks waited. */
  ghostLock: number;
  /** The seat goes back to its human at the next round setup. */
  reclaim: boolean;
  lastInput: number;
  kills: number;
  blocksBroken: number;
  deaths: number;
}

export interface Bomb {
  id: number;
  owner: number;
  x: number;
  y: number;
  fuse: number;
  range: number;
  slideDir: Dir;
  slideSpeed: number;
  /** Slot bitmask of fighters that may still walk off this bomb. */
  passers: number;
}

export interface Round {
  /** Playing ticks completed in this round. */
  tick: number;
  phase: Phase;
  /** Countdown, resume and result card ticks left. */
  phaseTicks: number;
  arena: number;
  cells: Uint8Array;
  special: Uint8Array;
  /** Item under each block: server only, read by sim.ts and replay.ts only. */
  hidden: Uint8Array;
  items: Uint8Array;
  pendingItem: Uint8Array;
  flame: Uint8Array;
  flameOwner: Uint8Array;
  warn: Uint8Array;
  fighters: Fighter[];
  /** A preallocated pool of 32; the first `bombCount` are live, sorted by id. */
  bombs: Bomb[];
  bombCount: number;
  nextBombId: number;
  spiralIndex: number;
  /** The round tick of the next Closing Time warning. */
  nextDropTick: number;
  rng: number;
  /** The round's winner, -1 for a draw or not decided. */
  winner: number;
  holdTicks: number;
  holdWinner: number;
}

export interface BotBrain {
  /** Current rule (BotRule), for stuck detection and tests. */
  rule: number;
  target: number;
  replanIn: number;
  /** Bomb count seen in the bot's row and column at the last plan. */
  lineBombs: number;
  pathLen: number;
  pathPos: number;
  path: Int16Array;
  /** Planned action at the target: 0 none, 1 bomb, 2 detonate. */
  action: number;
  /** The last direction it walked, to carry it across a pad's centre. */
  lastDir: number;
  lastCell: number;
  stillTicks: number;
}

export interface Match {
  config: MatchConfig;
  /** Core ticks since the match was created (u32). */
  tick: number;
  /** Round index, 0-based. */
  round: number;
  scores: Uint8Array;
  draws: number;
  current: Round;
  /** One mulberry32 state per slot. */
  botRng: Uint32Array;
  brains: BotBrain[];
  /** Arena of each round so far, for the result summary. */
  arenasPlayed: Uint8Array;
  /** This tick's events, already in wire format (§3.3). */
  events: Uint8Array;
  eventsLen: number;
  eventCount: number;
  /** Seat changes applied this tick: slot, wire Seat state; `seatOutLen` pairs. */
  seatOut: Uint8Array;
  seatOutLen: number;
  /** Set by the step that starts a new round (and at creation). */
  roundStarted: boolean;
  /** Set by the step that ends a round. */
  roundEnded: boolean;
  /** Set by the step that ends the match. */
  matchEnded: boolean;
}

export interface StepIn {
  /** 4 bytes, one input byte per slot (humans; ignored for bots and ghosts). */
  inputs: Uint8Array;
  /** 4 bytes of SeatCmd, usually all None. */
  seats: Uint8Array;
  /** 4 bytes of dodge grace, read only at round setup. */
  grace: Uint8Array;
}

/** What bots may see: no hidden items. */
export type BotView = Omit<Round, 'hidden'>;

export const newStepIn = (): StepIn => ({
  inputs: new Uint8Array(4),
  seats: new Uint8Array([SeatCmd.None, SeatCmd.None, SeatCmd.None, SeatCmd.None]),
  grace: new Uint8Array(4),
});

/** Items of one kind for `fighters` fighters: max(1, round(count × fighters / 4)). */
export const itemCount = (item: number, fighters: number): number => {
  const base = ITEM_COUNTS[item] ?? 0;
  if (base === 0) return 0;
  const n = Math.floor((base * fighters + 2) / 4);
  return n < 1 ? 1 : n;
};

export const roundLimit = (mode: 'brawl' | 'quickfire'): number => (mode === 'quickfire' ? QUICK_TICKS : ROUND_TICKS);
export const closeStart = (mode: 'brawl' | 'quickfire'): number => (mode === 'quickfire' ? QUICK_CLOSE_AT : CLOSE_AT);
/** A Brawl ends once someone has K wins or after 2K + 3 rounds. */
export const maxRounds = (c: MatchConfig): number => (c.mode === 'quickfire' ? 1 : 2 * c.winsNeeded + 3);

/** Grace ticks from a smoothed lane RTT: clamp(round(rtt / 66), 0, 4). */
export const graceFromRtt = (rttMs: number): number => {
  if (!(rttMs > 0)) return 0;
  const g = Math.floor((rttMs + 33) / 66);
  return g > 4 ? 4 : g;
};

/** Ticks a fighter needs to cross one cell at a speed level. */
export const ticksPerTile = (speedLvl: number): number => {
  const s = SPEEDS[speedLvl] ?? 8;
  return Math.floor((TILE + s - 1) / s);
};

export const cellX = (c: number): number => c % W;
export const cellY = (c: number): number => (c / W) | 0;
export const centre = (v: number): number => v * TILE + HALF;
/** The cell that contains a sub-unit position. */
export const cellAt = (x: number, y: number): number => (y >> 6) * W + (x >> 6);
