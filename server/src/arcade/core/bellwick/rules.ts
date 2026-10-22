/**
 * Bellwick's rules (bellwick.md §1, §3.6). Integers only: distances in sub (1/16 px), times in ticks
 * (30 per second), chances in percent.
 *
 * `HERO_RULES` and `TILE_FLAGS` belong to the codec contract, not the sim: the client is authoritative
 * for its own hero against the server's walls, so both sides must agree on them exactly. `rulesHash()`
 * covers both; a test fails when it changes without a bump of `CODEC.bellwick` (core/bellwick/version.ts).
 */
import { fnvMix, FNV_OFFSET } from '../hash.js';
import { T, TILE_CODES } from './content/legend.js';
import { Kind } from './types.js';

export const HERO_RULES = {
  /** Walk, sub per tick: 2 px; 22 per axis on diagonals. */
  speed: 32,
  diag: 22,
  /** While charging a spin or holding the Buckler. */
  slowSpeed: 16,
  slowDiag: 11,
  /** Feet box half sizes (10 × 8 px); positions are the feet-box centre. */
  feetHW: 80,
  feetHH: 64,
  /** Hurt box: 10 px wide, from 10 px above to 4 px below the feet centre. */
  hurtHW: 80,
  hurtUp: 160,
  hurtDown: 64,
  /** Slash: 10 ticks; a 14 × 10 px box in front is live on ticks 2–5; movement locked for 8. */
  slashTicks: 10,
  slashFrom: 2,
  slashTo: 5,
  slashLock: 8,
  slashDamage: 2,
  slashLong: 224,
  slashShort: 160,
  /** Slash box centre offsets per facing (down, up, side). */
  slashDownY: 144,
  slashUpY: -240,
  slashSideX: 176,
  slashSideY: -48,
  /** Spin: charge 18 ticks while holding A, release for 12 ticks of radius 22 px, damage 4. */
  chargeTicks: 18,
  spinTicks: 12,
  spinRadius: 352,
  spinDamage: 4,
  /** Interact reach in front of the feet box (7 px, so standing a pixel off a tile's centre still reaches). */
  interactReach: 112,
  /** Hurt: knockback 48 sub/tick for 5 ticks, then 45 ticks of invincibility. */
  hurtSpeed: 48,
  hurtTicks: 5,
  iframes: 45,
  /** A Sentinel's repel shot: no damage, knockback 64 sub/tick for 12 ticks, ignores invincibility. */
  repelSpeed: 64,
  repelTicks: 12,
  /** Pushing a block for 15 ticks slides it 16 px over 16 ticks. */
  pushTicks: 15,
  slideTicks: 16,
  /** Vinehook: 96 sub/tick out to 64 px, back at the same speed, 10 ticks of cooldown. */
  hookSpeed: 96,
  hookRange: 1024,
  hookCooldown: 10,
  pullSpeed: 96,
  /** Ledge hop: 16 ticks at 32 sub/tick (2 tiles south). */
  ledgeTicks: 16,
  ledgeSpeed: 32,
  /** Falling into a pit: 20 ticks, then back at the room entry, 1 half heart. */
  fallTicks: 20,
  pitDamage: 1,
  /** Corner nudge: an overlap of 5 px or less slides 1 px per tick around the corner. */
  nudge: 80,
  nudgeSpeed: 16,
  /** Screen slide 600 ms horizontally, 500 ms vertically; warps fade 250 ms each way. */
  transitH: 18,
  transitV: 15,
  transitWarp: 15,
  transitStep: 16,
  /** Revival: an ally within 16 px for 60 ticks; back with 4 half hearts and 45 ticks of invincibility. */
  reviveRange: 256,
  reviveTicks: 60,
  reviveHp: 4,
  downedTicks: 600,
  /** The "found an item" pose. */
  gotTicks: 40,
} as const;

/** The order `rulesHash()` reads HERO_RULES in (append new keys at the end). */
export const HERO_RULE_ORDER: readonly (keyof typeof HERO_RULES)[] = [
  'speed', 'diag', 'slowSpeed', 'slowDiag', 'feetHW', 'feetHH', 'hurtHW', 'hurtUp', 'hurtDown',
  'slashTicks', 'slashFrom', 'slashTo', 'slashLock', 'slashDamage', 'slashLong', 'slashShort',
  'slashDownY', 'slashUpY', 'slashSideX', 'slashSideY', 'chargeTicks', 'spinTicks', 'spinRadius', 'spinDamage',
  'interactReach', 'hurtSpeed', 'hurtTicks', 'iframes', 'repelSpeed', 'repelTicks', 'pushTicks', 'slideTicks',
  'hookSpeed', 'hookRange', 'hookCooldown', 'pullSpeed', 'ledgeTicks', 'ledgeSpeed', 'fallTicks', 'pitDamage',
  'nudge', 'nudgeSpeed', 'transitH', 'transitV', 'transitWarp', 'transitStep', 'reviveRange', 'reviveTicks',
  'reviveHp', 'downedTicks', 'gotTicks',
];

/** Tile flag bits. SOLID, WATER (blocks walkers only), PIT, LEDGE_S, CUT and HOOKABLE are the collision set. */
export const F = {
  SOLID: 1,
  WATER: 2,
  PIT: 4,
  LEDGE_S: 8,
  CUT: 16,
  HOOKABLE: 32,
  INTERACT: 64,
  WARP: 128,
  /** A lock, boss door or shutter: passable once opened (screen edges must line up with it). */
  OPENABLE: 256,
  /** A crystal: a slash toggles it too. */
  HITTABLE: 512,
} as const;

const S = F.SOLID;
/** Tile code → flags. */
export const TILE_FLAGS: readonly number[] = ((): number[] => {
  const f: number[] = [];
  for (let i = 0; i < TILE_CODES; i += 1) f.push(0);
  f[T.TALL] = F.CUT;
  f[T.BUSH] = S | F.CUT;
  f[T.TREE] = S;
  f[T.ROCK] = S;
  f[T.WATER] = F.WATER;
  f[T.THORNS] = S | F.CUT;
  f[T.FENCE] = S;
  f[T.WALL] = S;
  f[T.ROOF] = S;
  f[T.DOOR] = F.WARP;
  f[T.PIT] = F.PIT;
  f[T.POST] = S | F.HOOKABLE;
  f[T.BLOCK] = S;
  f[T.CRYSTAL] = S | F.HOOKABLE | F.HITTABLE;
  f[T.LEDGE] = F.LEDGE_S;
  f[T.SIGN] = S | F.INTERACT;
  f[T.LANTERN] = S | F.INTERACT;
  f[T.CHEST] = S | F.INTERACT;
  f[T.LOCK] = S | F.INTERACT | F.OPENABLE;
  f[T.BOSSDOOR] = S | F.INTERACT | F.OPENABLE;
  f[T.SHUTTER] = S | F.OPENABLE;
  f[T.POT] = S | F.CUT;
  f[T.DWALL] = S;
  f[T.CHEST_OPEN] = S;
  f[T.LANTERN_LIT] = S | F.INTERACT;
  f[T.CRYSTAL_ON] = S | F.HOOKABLE | F.HITTABLE;
  f[T.BRIDGE_OFF] = F.PIT;
  f[T.COUNTER] = S | F.INTERACT;
  f[T.NPC] = S | F.INTERACT;
  f[T.CAVE] = F.WARP;
  return f;
})();

/** What a cut tile becomes. */
export const CUT_TO = (code: number): number => (code === T.TALL || code === T.BUSH || code === T.THORNS ? T.STUBBLE : T.FLOOR);

/** Walkers may stand here (not solid, not water, not a pit, not a ledge). */
export const walkable = (code: number): boolean => ((TILE_FLAGS[code] ?? 1) & (F.SOLID | F.WATER | F.PIT | F.LEDGE_S)) === 0;
/** Fliers (projectiles, wisps, bats, the hook) pass over this. */
export const flyable = (code: number): boolean => ((TILE_FLAGS[code] ?? 1) & F.SOLID) === 0;
/** Passable for the screen-edge rule: walkable, a ledge, or openable. */
export const edgeOpen = (code: number): boolean => walkable(code) || ((TILE_FLAGS[code] ?? 0) & (F.OPENABLE | F.LEDGE_S)) !== 0;

/** Enemy knockback, separation and timings shared by all kinds. */
export const ENEMY_RULES = {
  knockSpeed: 64,
  knockTicks: 4,
  iframes: 10,
  separate: 8,
  /** Projectile half size and speeds (sub, sub/tick). */
  projHalf: 48,
  pebbleSpeed: 48,
  noteSpeed: 40,
  repelSpeed: 48,
  bounceSpeed: 64,
  /** Projectiles die after this many ticks if nothing stops them. */
  projTtl: 120,
  /** Pickups last 300 ticks (the Heart Vessel stays). */
  pickupTtl: 300,
  pickupHalf: 64,
} as const;

export interface EnemyStats {
  readonly hp: number;
  readonly hit: number;
  /** Body half size (sub). */
  readonly half: number;
  /** Walking speed (sub/tick). */
  readonly speed: number;
  readonly flies: boolean;
}

/** Per kind; index by `Kind`. */
export const ENEMY_STATS: readonly EnemyStats[] = [
  { hp: 0, hit: 0, half: 0, speed: 0, flies: false }, // None
  { hp: 2, hit: 1, half: 96, speed: 32, flies: false }, // Burrlet
  { hp: 4, hit: 2, half: 96, speed: 12, flies: false }, // Snapjaw
  { hp: 4, hit: 1, half: 96, speed: 16, flies: false }, // Slingkin
  { hp: 6, hit: 2, half: 104, speed: 8, flies: false }, // Shellback
  { hp: 2, hit: 1, half: 80, speed: 24, flies: true }, // Wisp
  { hp: 4, hit: 2, half: 96, speed: 64, flies: false }, // Rootling
  { hp: 2, hit: 1, half: 80, speed: 40, flies: true }, // Bat
  { hp: 255, hit: 0, half: 112, speed: 0, flies: false }, // Sentinel
  { hp: 24, hit: 2, half: 192, speed: 20, flies: false }, // Boss (half width; the body is 24 × 20 px)
  { hp: 0, hit: 0, half: 128, speed: 16, flies: false }, // Block
];

/** Behaviour numbers per kind (bellwick.md §1.5). */
export const AI = {
  burrletHopMin: 30,
  burrletHopMax: 60,
  burrletHopTicks: 8,
  snapjawSight: 6,
  snapjawCharge: 64,
  snapjawStun: 30,
  slingkinNear: 3,
  slingkinFar: 5,
  slingkinFire: 75,
  shellbackClink: 128,
  shellbackFlip: 120,
  wispRetreat: 40,
  wispRadius: 512,
  rootlingRange: 768,
  rootlingShake: 15,
  rootlingLunge: 512,
  rootlingExposed: 45,
  rootlingHide: 60,
  batRange: 1280,
  batSwoop: 36,
  batRest: 45,
  sentinelFire: 20,
  hookStun: 45,
} as const;

/** Old Clapper (bellwick.md §1.7). */
export const BOSS_RULES = {
  hpBase: 24,
  hpPerHero: 12,
  contact: 2,
  halfW: 192,
  halfH: 160,
  /** Phase 1: wait, then airborne with a shadow for 20 ticks, slam, stuck 45. */
  waitTicks: 40,
  shadowTicks: 20,
  stuckTicks: 45,
  ringSpeed: 48,
  ringMax: 1536,
  ringBand: 96,
  ringDamage: 2,
  /** Phase 2: rolls along the walls; 3 notes every 60 ticks; 2 bats every 240 ticks, at most 4; dizzy 60 after 3 laps. */
  rollSpeed: 36,
  noteEvery: 60,
  batEvery: 240,
  batMax: 4,
  dizzyTicks: 60,
  laps: 3,
  /** Phase 3: chases at 20 sub/tick; hooked → the clapper is out for 90 ticks with double damage. */
  chaseSpeed: 20,
  clapperTicks: 90,
  /** Damage it takes per window before it shakes free: 6 + 3 per extra hero. */
  capBase: 6,
  capPerHero: 3,
} as const;

/** Drop tables in percent (bellwick.md §1.3, §1.5). */
export const DROPS = {
  grassChip: 20,
  grassHeart: 8,
  grassSpark: 2,
  potHeart: 50,
  potChip: 30,
} as const;

export const ENEMY_DROPS: readonly { readonly chip: number; readonly heart: number; readonly spark: number }[] = [
  { chip: 0, heart: 0, spark: 0 },
  { chip: 30, heart: 0, spark: 0 }, // Burrlet
  { chip: 30, heart: 10, spark: 0 }, // Snapjaw
  { chip: 40, heart: 0, spark: 0 }, // Slingkin
  { chip: 0, heart: 0, spark: 50 }, // Shellback
  { chip: 0, heart: 0, spark: 0 }, // Wisp: 2–5 chips, always
  { chip: 0, heart: 20, spark: 0 }, // Rootling
  { chip: 30, heart: 0, spark: 0 }, // Bat
  { chip: 0, heart: 0, spark: 0 }, // Sentinel
  { chip: 0, heart: 0, spark: 0 }, // Boss: the Heart Vessel
  { chip: 0, heart: 0, spark: 0 }, // Block
];

/** Glint values of chips, sparks and stars; the purse holds 500. */
export const GLINTS = { chip: 1, spark: 5, star: 20, purseMax: 500 } as const;

export const SHOP = { buckler: 30, brew: 20, shard: 80 } as const;

/** Party economy and health (bellwick.md §1.3, §1.8). */
export const PARTY_RULES = {
  baseHp: 6,
  maxShards: 8,
  /** Autosave 2 s after a change to shared progress. */
  autosaveTicks: 60,
  /** A room that empties is frozen for 5 s, then freed. */
  freezeTicks: 150,
} as const;

/** Max hp in half hearts: 6 + 2·vessels + 2·floor(shards/4), capped at 6 hearts (12). */
export const maxHp = (vessels: number, shards: number): number => Math.min(12, 6 + 2 * vessels + 2 * Math.floor(shards / 4));

/** Respawn hp after a long downed spell: max(6, ceil(maxhp / 2)). */
export const respawnHp = (max: number): number => Math.max(6, Math.ceil(max / 2));

export const bossHp = (heroes: number): number => BOSS_RULES.hpBase + BOSS_RULES.hpPerHero * Math.max(0, heroes - 1);

/**
 * The codec contract's hash for `VERSION.codec` (bellwick.md §3.6). Changing HERO_RULES or TILE_FLAGS
 * changes `rulesHash()`; bump `VERSION.codec` and record the new hash here together.
 */
export const RULES_HASH = { codec: 1, hash: 0x4bef2c1c } as const;

/** FNV-1a over HERO_RULES (in HERO_RULE_ORDER) and TILE_FLAGS: the codec contract of §3.6. */
export const rulesHash = (): number => {
  let h = FNV_OFFSET;
  for (let i = 0; i < HERO_RULE_ORDER.length; i += 1) h = fnvMix(h, HERO_RULES[HERO_RULE_ORDER[i] as keyof typeof HERO_RULES]);
  h = fnvMix(h, 0x7f11e5);
  for (let i = 0; i < TILE_FLAGS.length; i += 1) h = fnvMix(h, TILE_FLAGS[i] as number);
  return h >>> 0;
};

/** Enemies that never count for "room cleared". */
export const countsForClear = (kind: number): boolean => kind !== Kind.Sentinel && kind !== Kind.Block && kind !== Kind.None;
