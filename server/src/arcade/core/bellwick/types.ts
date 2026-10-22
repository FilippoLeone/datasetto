/**
 * Bellwick's shared types (docs/arcade/bellwick.md §3.3). `as const` objects with union types, no enums.
 * Positions are integers in 1/16 px ("sub"), local to the room; a screen is 3072 × 2304 sub.
 */

export const Act = {
  Idle: 0,
  Walk: 1,
  Slash: 2,
  Charge: 3,
  Spin: 4,
  Shield: 5,
  Hook: 6,
  Push: 7,
  Hurt: 8,
  Pulled: 9,
  Ledge: 10,
  Downed: 11,
  Resting: 12,
  Transit: 13,
  Fall: 14,
  Got: 15,
} as const;
export type Act = (typeof Act)[keyof typeof Act];

/** Down, up, left, right. */
export type Dir = 0 | 1 | 2 | 3;
export const DIR = { down: 0, up: 1, left: 2, right: 3 } as const;
/** Projectile directions: down, up, left, right, down-left, down-right, up-left, up-right. */
export type Dir8 = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Unit vectors per Dir8 (×16 for a pixel; diagonals are 11/16 per axis). */
export const DX8: readonly number[] = [0, 0, -16, 16, -11, 11, -11, 11];
export const DY8: readonly number[] = [16, -16, 0, 0, 11, 11, -11, -11];
export const DX4: readonly number[] = [0, 0, -1, 1];
export const DY4: readonly number[] = [1, -1, 0, 0];

export const Status = { Active: 0, Downed: 1, Resting: 2, Transit: 3 } as const;
export type Status = (typeof Status)[keyof typeof Status];

/** u8 button bits (the same bits as the platform's ACT up to menu). */
export const Btn = { up: 1, down: 2, left: 4, right: 8, a: 16, b: 32, swap: 64, menu: 128 } as const;
export type Buttons = number;

/** Room ids: 0–19 overworld (gy × 5 + gx), 20–22 interiors, 32–44 dungeon (room n = 31 + n). */
export type RoomId = number;

export const Kind = {
  None: 0,
  Burrlet: 1,
  Snapjaw: 2,
  Slingkin: 3,
  Shellback: 4,
  Wisp: 5,
  Rootling: 6,
  Bat: 7,
  Sentinel: 8,
  Boss: 9,
  Block: 10,
} as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

/** Projectile kinds (4 bits). Bounce is a pebble the Buckler sent back, which hurts enemies. */
export const Proj = { Pebble: 0, Note: 1, Repel: 2, Bounce: 3 } as const;
export type Proj = (typeof Proj)[keyof typeof Proj];

/** Pickup kinds (4 bits). */
export const Pick = { Chip: 0, Spark: 1, Star: 2, Heart: 3, Vessel: 4 } as const;
export type Pick = (typeof Pick)[keyof typeof Pick];

/** Items, as chests, shops and gifts name them (and the Got event carries them). */
export const Item = {
  None: 0,
  Sword: 1,
  Buckler: 2,
  Hook: 3,
  Map: 4,
  Compass: 5,
  Key: 6,
  BossKey: 7,
  Shard: 8,
  Vessel: 9,
  Brew: 10,
  Glints: 11,
} as const;
export type Item = (typeof Item)[keyof typeof Item];

/** Bits of the party's `items` byte. */
export const ItemBit = { sword: 1, buckler: 2, hook: 4, map: 8, compass: 16, bossKey: 32 } as const;

/** Attack kinds in hit claims. */
export const Attack = { Slash: 0, Spin: 1, Hook: 2, Bounce: 3 } as const;

/** Ids of the four lanterns (party.lantern). */
export const Lantern = { village: 0, mossy: 1, entry: 2, ante: 3 } as const;

export const SCREEN_W = 12;
export const SCREEN_H = 9;
export const TILES = SCREEN_W * SCREEN_H;
/** Sub per pixel and per tile. */
export const SUB = 16;
export const TILE_SUB = 256;
export const ROOM_W_SUB = SCREEN_W * TILE_SUB;
export const ROOM_H_SUB = SCREEN_H * TILE_SUB;

/** Per-room pool capacities (bellwick.md §3.1). */
export const CAP = { enemies: 12, projectiles: 12, pickups: 12, blocks: 6, shocks: 2 } as const;
