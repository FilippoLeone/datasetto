/**
 * Parses the three map files into screen definitions (bellwick.md §3.4). Runs once per server process
 * and once per client chunk load (`content()` memoizes). Malformed content throws; the content test
 * runs this on every change.
 *
 * Format, one screen:
 *   @screen <id> <key> <gx>,<gy>|- <area> <music>
 *   9 rows of 12 legend characters
 *   directives, one per line:
 *     @enemy <kind> x,y [d|u|l|r]            @chest x,y <item> [n=<n>] flag=<f> [under=block] [appear=clear]
 *     @warp x,y <screen> x,y                 @exit <n|s|w|e> <screen> x,y
 *     @sign x,y <text>                       @npc x,y <who> <text> [gift=<item>] [n=<n>] [flag=<f>]
 *     @shop x,y <item> <price> [flag=<f>]    @talk <text>        @lantern x,y <name>
 *     @stash x,y <item> <n> flag=<f>         @lock x,y flag=<f>  @shutter flag=<f>
 *     @crystal x,y flag=<f>                  @start x,y          @boss x,y
 */
import bellhouse from './bellhouse.txt.js';
import interiors from './interiors.txt.js';
import overworld from './overworld.txt.js';
import { flagId } from './flags.js';
import { LEGEND, T } from './legend.js';
import { Item, Kind, Lantern, SCREEN_H, SCREEN_W, TILES } from '../types.js';

export const AREA = { village: 0, fields: 1, wood: 2, dungeon: 3, home: 4, cave: 5 } as const;
export type Area = (typeof AREA)[keyof typeof AREA];

export interface EnemyDef { kind: number; tile: number; dir: number }
export interface ChestDef { tile: number; item: number; n: number; flag: number; under: boolean; onClear: boolean }
export interface WarpDef { tile: number; to: number; tile2: number }
export interface ExitDef { to: number; tile2: number }
export interface NpcDef { tile: number; who: number; text: string; gift: number; n: number; flag: number }
export interface ShopDef { tile: number; item: number; price: number; flag: number }
export interface StashDef { tile: number; item: number; n: number; flag: number }
export interface LockDef { tile: number; flag: number; boss: boolean }

export interface ScreenDef {
  id: number;
  key: string;
  /** Grid position in its area (overworld or Bellhouse), −1 for interiors. */
  gx: number;
  gy: number;
  area: Area;
  music: string;
  dungeon: boolean;
  /** 108 initial tile codes. */
  tiles: Uint8Array;
  enemies: EnemyDef[];
  chests: ChestDef[];
  warps: WarpDef[];
  /** Per edge (down/south, up/north, left/west, right/east): an override, else null. */
  exits: (ExitDef | null)[];
  /** Per edge: the neighbouring room id on the grid, or −1. */
  near: number[];
  signs: { tile: number; text: string }[];
  npcs: NpcDef[];
  shop: ShopDef[];
  talk: string | null;
  lantern: { tile: number; id: number } | null;
  stash: StashDef[];
  locks: LockDef[];
  shutterFlag: number;
  crystal: { tile: number; flag: number } | null;
  start: number;
  boss: number;
}

export interface Content {
  /** Indexed by room id (0–44); null where no room exists. */
  screens: (ScreenDef | null)[];
  byKey: Readonly<Record<string, ScreenDef>>;
  /** The start room and tile (Kettlebrook Square). */
  startRoom: number;
  startTile: number;
  /** Lantern id → room and tile. */
  lanterns: { room: number; tile: number }[];
}

export const NPC_WHO: Readonly<Record<string, number>> = { hesper: 0, pell: 1, fennick: 2 };

const ITEMS: Readonly<Record<string, number>> = {
  sword: Item.Sword,
  buckler: Item.Buckler,
  hook: Item.Hook,
  map: Item.Map,
  compass: Item.Compass,
  key: Item.Key,
  bosskey: Item.BossKey,
  shard: Item.Shard,
  vessel: Item.Vessel,
  brew: Item.Brew,
  glints: Item.Glints,
  spark: Item.Glints,
};

const KINDS: Readonly<Record<string, number>> = {
  burrlet: Kind.Burrlet,
  snapjaw: Kind.Snapjaw,
  slingkin: Kind.Slingkin,
  shellback: Kind.Shellback,
  wisp: Kind.Wisp,
  rootling: Kind.Rootling,
  bat: Kind.Bat,
  sentinel: Kind.Sentinel,
};

const DIRS: Readonly<Record<string, number>> = { d: 0, u: 1, l: 2, r: 3 };
const EDGES: Readonly<Record<string, number>> = { s: 0, n: 1, w: 2, e: 3 };
const LANTERNS: Readonly<Record<string, number>> = Lantern;

export const tileIndex = (x: number, y: number): number => y * SCREEN_W + x;

interface Pending {
  def: ScreenDef;
  warps: { tile: number; to: string; tile2: number }[];
  exits: { edge: number; to: string; tile2: number }[];
}

const fail = (key: string, why: string): never => {
  throw new Error('bellwick content: ' + key + ': ' + why);
};

const xy = (key: string, s: string | undefined): number => {
  const m = /^(\d+),(\d+)$/.exec(s ?? '');
  if (!m) return fail(key, 'bad coordinates "' + s + '"');
  const x = Number(m[1]);
  const y = Number(m[2]);
  if (x >= SCREEN_W || y >= SCREEN_H) fail(key, 'coordinates out of range: ' + s);
  return tileIndex(x, y);
};

const opts = (words: readonly string[]): Record<string, string> => {
  const o: Record<string, string> = {};
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] as string;
    const eq = w.indexOf('=');
    if (eq > 0) o[w.slice(0, eq)] = w.slice(eq + 1);
  }
  return o;
};

const flagOf = (key: string, name: string | undefined): number => {
  if (name === undefined) return -1;
  const id = flagId(name);
  if (id < 0) fail(key, 'unknown flag ' + name);
  return id;
};

const itemOf = (key: string, name: string | undefined): number => {
  const item = ITEMS[name ?? ''];
  if (item === undefined) return fail(key, 'unknown item ' + name);
  return item;
};

const parseFile = (text: string, out: Pending[]): void => {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  let current: Pending | null = null;
  let row = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] as string).trimEnd();
    if (line === '') continue;
    if (line.startsWith('@screen ')) {
      const w = line.split(/\s+/);
      const id = Number(w[1]);
      const key = w[2] ?? '';
      const at = w[3] ?? '-';
      const area = AREA[(w[4] ?? '') as keyof typeof AREA];
      if (!Number.isInteger(id) || id < 0 || id > 63) fail(key, 'bad id');
      if (area === undefined) fail(key, 'bad area ' + w[4]);
      const m = /^(\d+),(\d+)$/.exec(at);
      const def: ScreenDef = {
        id,
        key,
        gx: m ? Number(m[1]) : -1,
        gy: m ? Number(m[2]) : -1,
        area,
        music: w[5] ?? 'village',
        dungeon: area === AREA.dungeon,
        tiles: new Uint8Array(TILES),
        enemies: [],
        chests: [],
        warps: [],
        exits: [null, null, null, null],
        near: [-1, -1, -1, -1],
        signs: [],
        npcs: [],
        shop: [],
        talk: null,
        lantern: null,
        stash: [],
        locks: [],
        shutterFlag: -1,
        crystal: null,
        start: -1,
        boss: -1,
      };
      current = { def, warps: [], exits: [] };
      out.push(current);
      row = 0;
      continue;
    }
    if (!current) return fail('?', 'text before the first @screen');
    const def: ScreenDef = current.def;
    const key = def.key;
    if (!line.startsWith('@')) {
      if (row >= SCREEN_H) fail(key, 'more than 9 rows');
      if (line.length !== SCREEN_W) fail(key, 'row ' + row + ' is ' + line.length + ' wide');
      for (let x = 0; x < SCREEN_W; x += 1) {
        const code = LEGEND[line[x] as string];
        if (code === undefined) fail(key, 'unknown character "' + line[x] + '" at ' + x + ',' + row);
        def.tiles[tileIndex(x, row)] = code as number;
      }
      row += 1;
      continue;
    }
    if (row !== SCREEN_H) fail(key, 'directive before all 9 rows');
    const w = line.split(/\s+/);
    const o = opts(w);
    switch (w[0]) {
      case '@enemy': {
        const kind = KINDS[w[1] ?? ''];
        if (kind === undefined) fail(key, 'unknown enemy ' + w[1]);
        def.enemies.push({ kind: kind as number, tile: xy(key, w[2]), dir: DIRS[w[3] ?? 'd'] ?? 0 });
        break;
      }
      case '@chest': {
        const tile = xy(key, w[1]);
        const item = itemOf(key, w[2]);
        const n = o.n !== undefined ? Number(o.n) : item === Item.Glints ? Number(w[3]) : 1;
        if (!Number.isInteger(n) || n < 1) fail(key, 'bad amount');
        def.chests.push({ tile, item, n, flag: flagOf(key, o.flag), under: o.under === 'block', onClear: o.appear === 'clear' });
        break;
      }
      case '@warp':
        current.warps.push({ tile: xy(key, w[1]), to: w[2] ?? '', tile2: xy(key, w[3]) });
        break;
      case '@exit': {
        const edge = EDGES[w[1] ?? ''];
        if (edge === undefined) fail(key, 'bad edge ' + w[1]);
        current.exits.push({ edge: edge as number, to: w[2] ?? '', tile2: xy(key, w[3]) });
        break;
      }
      case '@sign':
        def.signs.push({ tile: xy(key, w[1]), text: w[2] ?? '' });
        break;
      case '@npc': {
        const who = NPC_WHO[w[2] ?? ''];
        if (who === undefined) fail(key, 'unknown npc ' + w[2]);
        def.npcs.push({
          tile: xy(key, w[1]),
          who: who as number,
          text: w[3] ?? '',
          gift: o.gift ? itemOf(key, o.gift) : Item.None,
          n: o.n !== undefined ? Number(o.n) : 1,
          flag: flagOf(key, o.flag),
        });
        break;
      }
      case '@shop':
        def.shop.push({ tile: xy(key, w[1]), item: itemOf(key, w[2]), price: Number(w[3]), flag: flagOf(key, o.flag) });
        break;
      case '@talk':
        def.talk = w[1] ?? null;
        break;
      case '@lantern': {
        const id = LANTERNS[w[2] ?? ''];
        if (id === undefined) fail(key, 'unknown lantern ' + w[2]);
        def.lantern = { tile: xy(key, w[1]), id: id as number };
        break;
      }
      case '@stash':
        def.stash.push({ tile: xy(key, w[1]), item: itemOf(key, w[2]), n: Number(w[3]), flag: flagOf(key, o.flag) });
        break;
      case '@lock': {
        const tile = xy(key, w[1]);
        def.locks.push({ tile, flag: flagOf(key, o.flag), boss: def.tiles[tile] === T.BOSSDOOR });
        break;
      }
      case '@shutter':
        def.shutterFlag = flagOf(key, o.flag);
        break;
      case '@crystal':
        def.crystal = { tile: xy(key, w[1]), flag: flagOf(key, o.flag) };
        break;
      case '@start':
        def.start = xy(key, w[1]);
        break;
      case '@boss':
        def.boss = xy(key, w[1]);
        break;
      default:
        fail(key, 'unknown directive ' + w[0]);
    }
  }
};

const build = (): Content => {
  const pending: Pending[] = [];
  parseFile(overworld, pending);
  parseFile(interiors, pending);
  parseFile(bellhouse, pending);
  const screens: (ScreenDef | null)[] = [];
  for (let i = 0; i < 45; i += 1) screens.push(null);
  const byKey: Record<string, ScreenDef> = {};
  for (const p of pending) {
    const d = p.def;
    if (d.id >= screens.length || screens[d.id]) fail(d.key, 'duplicate or out-of-range id ' + d.id);
    if (byKey[d.key]) fail(d.key, 'duplicate key');
    screens[d.id] = d;
    byKey[d.key] = d;
  }
  // Grid neighbours: the overworld is 5 × 4 with id = gy × 5 + gx; the Bellhouse is looked up by position.
  const DX = [0, 0, -1, 1];
  const DY = [1, -1, 0, 0];
  for (const p of pending) {
    const d = p.def;
    if (d.gx < 0) continue;
    for (let e = 0; e < 4; e += 1) {
      const nx = d.gx + (DX[e] as number);
      const ny = d.gy + (DY[e] as number);
      for (const q of pending) {
        const o = q.def;
        if (o.gx === nx && o.gy === ny && o.dungeon === d.dungeon && (o.id < 20) === (d.id < 20)) d.near[e] = o.id;
      }
    }
    if (!d.dungeon && d.id !== d.gy * 5 + d.gx) fail(d.key, 'overworld id must be gy × 5 + gx');
  }
  for (const p of pending) {
    for (const w of p.warps) {
      const to = byKey[w.to];
      if (!to) fail(p.def.key, 'warp to unknown screen ' + w.to);
      p.def.warps.push({ tile: w.tile, to: (to as ScreenDef).id, tile2: w.tile2 });
    }
    for (const x of p.exits) {
      const to = byKey[x.to];
      if (!to) fail(p.def.key, 'exit to unknown screen ' + x.to);
      p.def.exits[x.edge] = { to: (to as ScreenDef).id, tile2: x.tile2 };
    }
  }
  let startRoom = -1;
  let startTile = -1;
  const lanterns: { room: number; tile: number }[] = [];
  for (const d of screens) {
    if (!d) continue;
    if (d.start >= 0) {
      startRoom = d.id;
      startTile = d.start;
    }
    if (d.lantern) lanterns[d.lantern.id] = { room: d.id, tile: d.lantern.tile };
  }
  if (startRoom < 0) fail('content', 'no @start');
  return { screens, byKey, startRoom, startTile, lanterns };
};

let cached: Content | null = null;

/** The parsed content, built on first use. */
export const content = (): Content => {
  if (!cached) cached = build();
  return cached;
};

/** The screen of a room id (throws for an unknown id: content is static). */
export const screen = (id: number): ScreenDef => {
  const d = content().screens[id];
  if (!d) throw new Error('bellwick: no room ' + id);
  return d;
};

/**
 * A tile of a room that is not in memory, as the party's flags leave it: opened locks and boss doors,
 * opened shutters, an extended bridge. `flagOn` reads the party's flags.
 */
export const flaggedTile = (def: ScreenDef, tile: number, flagOn: (id: number) => boolean): number => {
  const code = def.tiles[tile] as number;
  if (code === T.LOCK || code === T.BOSSDOOR) {
    for (const l of def.locks) if (l.tile === tile && flagOn(l.flag)) return l.boss ? T.BOSSDOOR_OPEN : T.LOCK_OPEN;
    return code;
  }
  if (code === T.SHUTTER) return def.shutterFlag >= 0 && flagOn(def.shutterFlag) ? T.SHUTTER_OPEN : code;
  if (code === T.BRIDGE_OFF) return def.crystal && flagOn(def.crystal.flag) ? T.BRIDGE_ON : code;
  return code;
};
