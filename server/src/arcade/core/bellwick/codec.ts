/**
 * Bellwick's wire formats on the action lane (bellwick.md §4): the UP payload (HeroState, 10 B), the EVT
 * payloads, the FRAME snapshot (≤ 91 B), room and party events, the KEYFRAME body (≤ 384 B), WELCOME's cfg
 * and the SaveV1 record. Little-endian, through the shared ByteWriter/ByteReader. Readers never throw:
 * a short or malformed buffer gives `false`/`null`.
 */
import { ByteReader, ByteWriter } from '../bytes.js';

/** Up: EVT kinds (the first payload byte). */
export const EVT = {
  HitClaim: 0x01,
  DamageTaken: 0x02,
  Blocked: 0x03,
  Interact: 0x04,
  Push: 0x05,
  EnterRoom: 0x06,
  Buy: 0x07,
  UseBrew: 0x08,
  Respawn: 0x09,
  GoToAlly: 0x0a,
  Emote: 0x0b,
} as const;

/** Down: room events (to the heroes in that room) and party events (to everyone). */
export const EV = {
  Spawn: 0x01,
  Projectile: 0x02,
  Despawn: 0x03,
  Damage: 0x04,
  Drop: 0x05,
  Tile: 0x06,
  BlockSlide: 0x07,
  Correct: 0x08,
  Hp: 0x09,
  Downed: 0x0a,
  Revived: 0x0b,
  BossPhase: 0x0c,
  Shock: 0x0d,
  Refused: 0x0e,
  Party: 0x20,
  Flag: 0x21,
  Got: 0x22,
  Roster: 0x23,
  Saved: 0x24,
  Victory: 0x25,
  Emote: 0x26,
} as const;

export const DESPAWN = { killed: 0, expired: 1, blocked: 2, collected: 3, removed: 4 } as const;
export const REFUSE = { locked: 1, glints: 2, haveBrew: 3, soldOut: 4, exit: 5, claim: 6, far: 7, busy: 8 } as const;
export const CORRECT = { move: 0, wall: 1, resync: 2 } as const;
/** Party event fields. */
export const PF = { purse: 0, keys: 1, items: 2, shards: 3, vessels: 4, lantern: 5, maxHp: 6, cleared: 7 } as const;
/** KEYFRAME entry reasons. */
export const ENTRY = { edge: 0, warp: 1, respawn: 2, join: 3, resume: 4, resync: 5 } as const;

export const UP_BYTES = 10;
export const SNAPSHOT_MAX = 91;
export const KEYFRAME_MAX = 384;
export const ENT_MAX = 14;

// ------------------------------------------------------------------ HeroState (UP)

export interface HeroState {
  room: number;
  x: number;
  y: number;
  facing: number;
  act: number;
  moving: boolean;
  charged: boolean;
  actT: number;
  hp: number;
  heroTick: number;
}

export const newHeroState = (): HeroState => ({ room: 0, x: 0, y: 0, facing: 0, act: 0, moving: false, charged: false, actT: 0, hp: 0, heroTick: 0 });

export const writeUp = (w: ByteWriter, s: HeroState): ByteWriter =>
  w
    .u8(s.room)
    .u16(Math.max(0, Math.min(0xffff, s.x)))
    .u16(Math.max(0, Math.min(0xffff, s.y)))
    .u8((s.facing & 3) | ((s.act & 15) << 2) | (s.moving ? 64 : 0) | (s.charged ? 128 : 0))
    .u8(Math.min(255, s.actT))
    .u8(Math.max(0, Math.min(255, s.hp)))
    .u16(s.heroTick & 0xffff);

/** Fills `out`; false on a short or malformed payload. */
export const readUp = (p: Uint8Array, out: HeroState): boolean => {
  if (p.length !== UP_BYTES) return false;
  const r = new ByteReader(p);
  out.room = r.u8();
  out.x = r.u16();
  out.y = r.u16();
  const packed = r.u8();
  out.facing = packed & 3;
  out.act = (packed >> 2) & 15;
  out.moving = (packed & 64) !== 0;
  out.charged = (packed & 128) !== 0;
  out.actT = r.u8();
  out.hp = r.u8();
  out.heroTick = r.u16();
  return r.ok;
};

// ------------------------------------------------------------------ EVT payloads

export interface EvtView {
  kind: number;
  /** HitClaim. */
  seenTick: number;
  attack: number;
  dir: number;
  n: number;
  targets: Uint8Array;
  /** DamageTaken: source, amount. Blocked: projectile id (in `a`). Interact/Push: tile (a), dir (b). EnterRoom: edge (a), pos (b). Buy: item (a). GoToAlly: slot (a). Emote: emote (a). */
  a: number;
  b: number;
}

export const newEvtView = (): EvtView => ({ kind: 0, seenTick: 0, attack: 0, dir: 0, n: 0, targets: new Uint8Array(8), a: 0, b: 0 });

export const writeHitClaim = (w: ByteWriter, seenTick: number, attack: number, dir: number, targets: Uint8Array, n: number): ByteWriter => {
  w.u8(EVT.HitClaim).u16(seenTick & 0xffff).u8(attack).u8(dir).u8(Math.min(8, n));
  for (let i = 0; i < n && i < 8; i += 1) w.u8(targets[i] as number);
  return w;
};
export const writeDamageTaken = (w: ByteWriter, source: number, amount: number, seenTick: number): ByteWriter =>
  w.u8(EVT.DamageTaken).u8(source).u8(amount).u16(seenTick & 0xffff);
export const writeBlocked = (w: ByteWriter, projectileId: number, seenTick: number): ByteWriter => w.u8(EVT.Blocked).u8(projectileId).u16(seenTick & 0xffff);
export const writeInteract = (w: ByteWriter, tile: number): ByteWriter => w.u8(EVT.Interact).u8(tile);
export const writePush = (w: ByteWriter, tile: number, dir: number): ByteWriter => w.u8(EVT.Push).u8(tile).u8(dir);
export const writeEnterRoom = (w: ByteWriter, edge: number, pos: number): ByteWriter => w.u8(EVT.EnterRoom).u8(edge).u8(pos);
export const writeBuy = (w: ByteWriter, item: number): ByteWriter => w.u8(EVT.Buy).u8(item);
export const writeUseBrew = (w: ByteWriter): ByteWriter => w.u8(EVT.UseBrew);
export const writeRespawn = (w: ByteWriter): ByteWriter => w.u8(EVT.Respawn);
export const writeGoToAlly = (w: ByteWriter, slot: number): ByteWriter => w.u8(EVT.GoToAlly).u8(slot);
export const writeEmote = (w: ByteWriter, emote: number): ByteWriter => w.u8(EVT.Emote).u8(emote);

/** Decodes one EVT payload into `out`; false on anything malformed (wrong length, bad values). */
export const readEvt = (p: Uint8Array, out: EvtView): boolean => {
  if (p.length < 1) return false;
  const r = new ByteReader(p);
  const kind = r.u8();
  out.kind = kind;
  switch (kind) {
    case EVT.HitClaim: {
      if (p.length < 7) return false;
      out.seenTick = r.u16();
      out.attack = r.u8();
      out.dir = r.u8();
      const n = r.u8();
      if (n < 1 || n > 8 || p.length !== 6 + n) return false;
      if (out.attack > 3 || out.dir > 3) return false;
      out.n = n;
      for (let i = 0; i < n; i += 1) out.targets[i] = r.u8();
      return r.ok;
    }
    case EVT.DamageTaken:
      if (p.length !== 5) return false;
      out.a = r.u8();
      out.b = r.u8();
      out.seenTick = r.u16();
      return r.ok && out.b <= 12;
    case EVT.Blocked:
      if (p.length !== 4) return false;
      out.a = r.u8();
      out.seenTick = r.u16();
      return r.ok;
    case EVT.Interact:
      if (p.length !== 2) return false;
      out.a = r.u8();
      return r.ok && out.a < 108;
    case EVT.Push:
      if (p.length !== 3) return false;
      out.a = r.u8();
      out.b = r.u8();
      return r.ok && out.a < 108 && out.b < 4;
    case EVT.EnterRoom:
      if (p.length !== 3) return false;
      out.a = r.u8();
      out.b = r.u8();
      return r.ok && out.a <= 4 && out.b < 108;
    case EVT.Buy:
    case EVT.GoToAlly:
    case EVT.Emote:
      if (p.length !== 2) return false;
      out.a = r.u8();
      return r.ok;
    case EVT.UseBrew:
    case EVT.Respawn:
      return p.length === 1;
    default:
      return false;
  }
};

// ------------------------------------------------------------------ room and party events (writers)

export const evSpawn = (w: ByteWriter, id: number, kind: number, xPx: number, yPx: number, state: number, hp: number): void => {
  w.u8(EV.Spawn).u8(id).u8(kind).u8(xPx).u8(yPx).u8(state).u8(hp);
};
export const evProjectile = (w: ByteWriter, id: number, kind: number, dir: number, xPx: number, yPx: number, t0: number): void => {
  w.u8(EV.Projectile).u8(id).u8((kind & 15) | ((dir & 15) << 4)).u8(xPx).u8(yPx).u16(t0 & 0xffff);
};
export const evDespawn = (w: ByteWriter, id: number, reason: number): void => {
  w.u8(EV.Despawn).u8(id).u8(reason);
};
export const evDamage = (w: ByteWriter, target: number, amount: number, hpAfter: number, bySlot: number): void => {
  w.u8(EV.Damage).u8(target).u8(amount).u8(Math.max(0, hpAfter)).u8(bySlot);
};
export const evDrop = (w: ByteWriter, id: number, kind: number, ttl: number, xPx: number, yPx: number): void => {
  w.u8(EV.Drop).u8(id).u8((kind & 15) | (ttlCode(ttl) << 4)).u8(xPx).u8(yPx);
};
export const evTile = (w: ByteWriter, tile: number, code: number): void => {
  w.u8(EV.Tile).u8(tile).u8(code);
};
export const evBlockSlide = (w: ByteWriter, tile: number, dir: number): void => {
  w.u8(EV.BlockSlide).u8(tile).u8(dir);
};
export const evCorrect = (w: ByteWriter, room: number, x: number, y: number, reason: number): void => {
  w.u8(EV.Correct).u8(room).u16(x).u16(y).u8(reason);
};
export const evHp = (w: ByteWriter, slot: number, hp: number): void => {
  w.u8(EV.Hp).u8(slot).u8(Math.max(0, hp));
};
export const evDowned = (w: ByteWriter, slot: number): void => {
  w.u8(EV.Downed).u8(slot);
};
export const evRevived = (w: ByteWriter, slot: number, bySlot: number): void => {
  w.u8(EV.Revived).u8(slot).u8(bySlot);
};
export const evBossPhase = (w: ByteWriter, phase: number, hp: number, tick: number): void => {
  w.u8(EV.BossPhase).u8(phase).u8(hp).u16(tick & 0xffff);
};
export const evShock = (w: ByteWriter, xPx: number, yPx: number, t0: number): void => {
  w.u8(EV.Shock).u8(xPx).u8(yPx).u16(t0 & 0xffff);
};
/** Refused (self only): the EVT kind and its first argument, so the client can match it, and a code. */
export const evRefused = (w: ByteWriter, evtKind: number, arg: number, code: number): void => {
  w.u8(EV.Refused).u8(evtKind).u8(arg).u8(code);
};
export const evParty = (w: ByteWriter, field: number, value: number): void => {
  w.u8(EV.Party).u8(field).u16(value & 0xffff);
};
export const evFlag = (w: ByteWriter, flag: number, value: number): void => {
  w.u8(EV.Flag).u8(flag).u8(value);
};
export const evGot = (w: ByteWriter, slot: number, item: number): void => {
  w.u8(EV.Got).u8(slot).u8(item);
};
export const evSaved = (w: ByteWriter, lantern: number): void => {
  w.u8(EV.Saved).u8(lantern);
};
export const evVictory = (w: ByteWriter, playSec: number): void => {
  w.u8(EV.Victory).u32(playSec >>> 0);
};
export const evEmote = (w: ByteWriter, slot: number, emote: number): void => {
  w.u8(EV.Emote).u8(slot).u8(emote);
};

/** One roster row: slot:2|status:2|tunic:2|host:1|lag:1, room, tx:4|ty:4, hp, joinOrder. */
export interface RosterRow { slot: number; status: number; tunic: number; host: boolean; lag: boolean; room: number; tx: number; ty: number; hp: number; joinOrder: number }
export const evRoster = (w: ByteWriter, rows: readonly RosterRow[], n: number): void => {
  w.u8(EV.Roster).u8(n);
  for (let i = 0; i < n; i += 1) {
    const r = rows[i] as RosterRow;
    w.u8((r.slot & 3) | ((r.status & 3) << 2) | ((r.tunic & 3) << 4) | (r.host ? 64 : 0) | (r.lag ? 128 : 0))
      .u8(r.room)
      .u8((r.tx & 15) | ((r.ty & 15) << 4))
      .u8(Math.max(0, r.hp))
      .u8(r.joinOrder);
  }
};

/** Pickup lifetime on the wire: 4 bits of 20 ticks (0 = never expires). */
export const ttlCode = (ttl: number): number => (ttl < 0 ? 0 : Math.max(1, Math.min(15, Math.ceil(ttl / 20))));
export const ttlFromCode = (code: number): number => (code === 0 ? -1 : code * 20);

/** Payload sizes after the kind byte (−1: variable). */
const EV_SIZE: readonly number[] = ((): number[] => {
  const s: number[] = [];
  for (let i = 0; i < 0x30; i += 1) s.push(-2);
  s[EV.Spawn] = 6;
  s[EV.Projectile] = 6;
  s[EV.Despawn] = 2;
  s[EV.Damage] = 4;
  s[EV.Drop] = 4;
  s[EV.Tile] = 2;
  s[EV.BlockSlide] = 2;
  s[EV.Correct] = 6;
  s[EV.Hp] = 2;
  s[EV.Downed] = 1;
  s[EV.Revived] = 2;
  s[EV.BossPhase] = 4;
  s[EV.Shock] = 4;
  s[EV.Refused] = 3;
  s[EV.Party] = 3;
  s[EV.Flag] = 2;
  s[EV.Got] = 2;
  s[EV.Roster] = -1;
  s[EV.Saved] = 1;
  s[EV.Victory] = 4;
  s[EV.Emote] = 2;
  return s;
})();

/** Decoded event, reused: fields a–f in wire order (u16 fields whole). */
export interface EvView {
  kind: number;
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  /** Roster rows (when kind is Roster). */
  rows: RosterRow[];
  n: number;
}

export const newEvView = (): EvView => {
  const rows: RosterRow[] = [];
  for (let i = 0; i < 4; i += 1) rows.push({ slot: 0, status: 0, tunic: 0, host: false, lag: false, room: 0, tx: 0, ty: 0, hp: 0, joinOrder: 0 });
  return { kind: 0, a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, rows, n: 0 };
};

/**
 * Reads one game event of `kind` (the kind byte already read) from `r` into `out`. False for an unknown
 * kind or a short buffer (the platform walk then stops and the client resyncs).
 */
export const readEv = (kind: number, r: ByteReader, out: EvView): boolean => {
  const size = EV_SIZE[kind];
  if (size === undefined || size === -2) return false;
  out.kind = kind;
  switch (kind) {
    case EV.Projectile: {
      out.a = r.u8();
      const kd = r.u8();
      out.b = kd & 15;
      out.c = kd >> 4;
      out.d = r.u8();
      out.e = r.u8();
      out.f = r.u16();
      break;
    }
    case EV.Drop: {
      out.a = r.u8();
      const kt = r.u8();
      out.b = kt & 15;
      out.c = ttlFromCode(kt >> 4);
      out.d = r.u8();
      out.e = r.u8();
      break;
    }
    case EV.Correct:
      out.a = r.u8();
      out.b = r.u16();
      out.c = r.u16();
      out.d = r.u8();
      break;
    case EV.BossPhase:
      out.a = r.u8();
      out.b = r.u8();
      out.c = r.u16();
      break;
    case EV.Shock:
      out.a = r.u8();
      out.b = r.u8();
      out.c = r.u16();
      break;
    case EV.Party:
      out.a = r.u8();
      out.b = r.u16();
      break;
    case EV.Victory:
      out.a = r.u32();
      break;
    case EV.Roster: {
      const n = r.u8();
      if (n > 4) return false;
      out.n = n;
      for (let i = 0; i < n; i += 1) {
        const row = out.rows[i] as RosterRow;
        const p = r.u8();
        row.slot = p & 3;
        row.status = (p >> 2) & 3;
        row.tunic = (p >> 4) & 3;
        row.host = (p & 64) !== 0;
        row.lag = (p & 128) !== 0;
        row.room = r.u8();
        const t = r.u8();
        row.tx = t & 15;
        row.ty = t >> 4;
        row.hp = r.u8();
        row.joinOrder = r.u8();
      }
      break;
    }
    default: {
      // Plain u8 fields.
      out.a = size > 0 ? r.u8() : 0;
      out.b = size > 1 ? r.u8() : 0;
      out.c = size > 2 ? r.u8() : 0;
      out.d = size > 3 ? r.u8() : 0;
      out.e = size > 4 ? r.u8() : 0;
      out.f = size > 5 ? r.u8() : 0;
    }
  }
  return r.ok;
};

// ------------------------------------------------------------------ snapshot and keyframe pieces

/** A hero as others see it (snapshot and keyframe, 6 B). */
export const writeHeroView = (
  w: ByteWriter,
  slot: number,
  status: number,
  facing: number,
  hurt: boolean,
  moving: boolean,
  xPx: number,
  yPx: number,
  act: number,
  charged: boolean,
  actT: number,
  hp: number,
): void => {
  w.u8((slot & 3) | ((status & 3) << 2) | ((facing & 3) << 4) | (hurt ? 64 : 0) | (moving ? 128 : 0))
    .u8(clampPx(xPx, 191))
    .u8(clampPx(yPx, 143))
    .u8((act & 15) | (charged ? 16 : 0))
    .u8(Math.min(255, actT))
    .u8(Math.max(0, hp));
};

export interface HeroView { slot: number; status: number; facing: number; hurt: boolean; moving: boolean; x: number; y: number; act: number; charged: boolean; actT: number; hp: number }
export const newHeroView = (): HeroView => ({ slot: 0, status: 0, facing: 0, hurt: false, moving: false, x: 0, y: 0, act: 0, charged: false, actT: 0, hp: 0 });

export const readHeroView = (r: ByteReader, out: HeroView): void => {
  const a = r.u8();
  out.slot = a & 3;
  out.status = (a >> 2) & 3;
  out.facing = (a >> 4) & 3;
  out.hurt = (a & 64) !== 0;
  out.moving = (a & 128) !== 0;
  out.x = r.u8();
  out.y = r.u8();
  const b = r.u8();
  out.act = b & 15;
  out.charged = (b & 16) !== 0;
  out.actT = r.u8();
  out.hp = r.u8();
};

/** Entity state byte: pose:4 | facing:2 | hurt:1 | stunned:1. */
export const entState = (pose: number, facing: number, hurt: boolean, stunned: boolean): number =>
  (pose & 15) | ((facing & 3) << 4) | (hurt ? 64 : 0) | (stunned ? 128 : 0);

export const clampPx = (v: number, max: number): number => (v < 0 ? 0 : v > max ? max : v | 0);

/** 108 six-bit tile codes packed into 81 bytes. */
export const writeTiles = (w: ByteWriter, tiles: Uint8Array): void => {
  for (let i = 0; i < 108; i += 4) {
    const a = (tiles[i] as number) & 63;
    const b = (tiles[i + 1] as number) & 63;
    const c = (tiles[i + 2] as number) & 63;
    const d = (tiles[i + 3] as number) & 63;
    const v = a | (b << 6) | (c << 12) | (d << 18);
    w.u8(v & 255).u8((v >> 8) & 255).u8((v >> 16) & 255);
  }
};

export const readTiles = (r: ByteReader, out: Uint8Array): void => {
  for (let i = 0; i < 108; i += 4) {
    const v = r.u8() | (r.u8() << 8) | (r.u8() << 16);
    out[i] = v & 63;
    out[i + 1] = (v >> 6) & 63;
    out[i + 2] = (v >> 12) & 63;
    out[i + 3] = (v >> 18) & 63;
  }
};

// ------------------------------------------------------------------ WELCOME cfg

export interface WelcomeCfg { taleSlot: number; contentHash: number; seats: { slot: number; tunic: number; joinOrder: number }[] }

export const writeWelcomeCfg = (taleSlot: number, contentHash: number, seats: readonly { slot: number; tunic: number; joinOrder: number }[]): Uint8Array => {
  const w = new ByteWriter(6 + 3 * 4);
  w.u8(taleSlot).u32(contentHash >>> 0).u8(Math.min(4, seats.length));
  for (let i = 0; i < seats.length && i < 4; i += 1) {
    const s = seats[i] as { slot: number; tunic: number; joinOrder: number };
    w.u8(s.slot).u8(s.tunic).u8(s.joinOrder);
  }
  return w.copy();
};

export const readWelcomeCfg = (b: Uint8Array): WelcomeCfg | null => {
  const r = new ByteReader(b);
  const taleSlot = r.u8();
  const contentHash = r.u32();
  const n = r.u8();
  if (!r.ok || n > 4) return null;
  const seats: { slot: number; tunic: number; joinOrder: number }[] = [];
  for (let i = 0; i < n; i += 1) seats.push({ slot: r.u8(), tunic: r.u8(), joinOrder: r.u8() });
  return r.ok ? { taleSlot, contentHash, seats } : null;
};

// ------------------------------------------------------------------ SaveV1

export interface SaveHero { tunic: number; brew: boolean; downs: number; defeats: number }
export interface SaveV1 {
  v: 1;
  seed: number;
  /** base64 of the 32 flag bytes. */
  flags: string;
  playSec: number;
  imported?: true;
  purse: number;
  keys: number;
  bossKey: boolean;
  map: boolean;
  compass: boolean;
  sword: boolean;
  buckler: boolean;
  hook: boolean;
  shards: number;
  vessels: number;
  lantern: number;
  /** accountId, or 'solo'; at most 16 (the oldest dropped). */
  heroes: Record<string, SaveHero>;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export const toBase64 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = ((b[i] as number) << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] as string;
    s += B64[(n >> 12) & 63] as string;
    s += i + 1 < b.length ? (B64[(n >> 6) & 63] as string) : '=';
    s += i + 2 < b.length ? (B64[n & 63] as string) : '=';
  }
  return s;
};

export const fromBase64 = (s: string, len: number): Uint8Array | null => {
  const out = new Uint8Array(len);
  const clean = s.replace(/=+$/, '');
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    let n = 0;
    for (let k = 0; k < 4; k += 1) {
      const ch = clean[i + k];
      const v = ch === undefined ? 0 : B64.indexOf(ch);
      if (v < 0) return null;
      n = (n << 6) | v;
    }
    if (o < len) out[o++] = (n >> 16) & 255;
    if (o < len && i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (o < len && i + 3 < clean.length) out[o++] = n & 255;
  }
  return o === len ? out : null;
};

const int = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** Validates an untrusted SaveV1 (device storage or the database); null if anything is off. */
export const parseSave = (raw: unknown): SaveV1 | null => {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.flags !== 'string' || !fromBase64(o.flags, 32)) return null;
  const seed = int(o.seed, 0, 0xffffffff);
  const playSec = int(o.playSec, 0, 0x7fffffff);
  const purse = int(o.purse, 0, 500);
  const keys = int(o.keys, 0, 9);
  const shards = int(o.shards, 0, 8);
  const vessels = int(o.vessels, 0, 1);
  const lantern = int(o.lantern, 0, 3);
  const bits = [bool(o.bossKey), bool(o.map), bool(o.compass), bool(o.sword), bool(o.buckler), bool(o.hook)];
  if (seed === null || playSec === null || purse === null || keys === null || shards === null || vessels === null || lantern === null) return null;
  if (bits.some((b) => b === null)) return null;
  const heroesRaw = o.heroes;
  if (!heroesRaw || typeof heroesRaw !== 'object') return null;
  const heroes: Record<string, SaveHero> = {};
  let count = 0;
  for (const [key, value] of Object.entries(heroesRaw as Record<string, unknown>)) {
    if (count >= 16) break;
    if (!value || typeof value !== 'object' || key.length > 64) return null;
    const h = value as Record<string, unknown>;
    const tunic = int(h.tunic, 0, 3);
    const brew = bool(h.brew);
    const downs = int(h.downs, 0, 0x7fffffff);
    const defeats = int(h.defeats, 0, 0x7fffffff);
    if (tunic === null || brew === null || downs === null || defeats === null) return null;
    heroes[key] = { tunic, brew, downs, defeats };
    count += 1;
  }
  return {
    v: 1,
    seed,
    flags: o.flags,
    playSec,
    ...(o.imported === true ? { imported: true as const } : {}),
    purse,
    keys,
    bossKey: bits[0] as boolean,
    map: bits[1] as boolean,
    compass: bits[2] as boolean,
    sword: bits[3] as boolean,
    buckler: bits[4] as boolean,
    hook: bits[5] as boolean,
    shards,
    vessels,
    lantern,
    heroes,
  };
};
