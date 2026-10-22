/**
 * Glimmerhall on the table lane (glimmerhall.md §10): JSON events on the main socket. Stops travel
 * as base64url strings, one character per reel stop (every strip has fewer than 64 stops), so a
 * 200-spin free-spin run fits in 1,000 characters. Machines are wire indices 0–2.
 *
 * Types here are shared by the server hall, the offline local hall and the client.
 */
import type { MachineDef, MachineIdx } from './machines.js';

export const STOP_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** One character per stop. Stops must be in [0, 64). */
export const encodeStops = (s: readonly number[]): string => {
  let out = '';
  for (let i = 0; i < s.length; i += 1) out += STOP_ALPHABET.charAt(s[i] as number);
  return out;
};

/**
 * Stops from a wire string, range-checked per reel (`fs`: against the free-spin strips). The
 * length must be a positive multiple of the reel count. Null for anything out of range.
 */
export const decodeStops = (t: unknown, def: MachineDef, fs: boolean): number[] | null => {
  if (typeof t !== 'string' || t.length === 0 || t.length % def.reels !== 0 || t.length > def.reels * 200) return null;
  const strips = fs ? def.fsStrips : def.strips;
  const out: number[] = [];
  for (let i = 0; i < t.length; i += 1) {
    const v = STOP_ALPHABET.indexOf(t.charAt(i));
    if (v < 0 || v >= (strips[i % def.reels] as Uint8Array).length) return null;
    out.push(v);
  }
  return out;
};

/** Spin and pick ids: 12 base64url characters (72 random bits). */
export const ID_CHARS = 12;
export const isSpinId = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length !== ID_CHARS) return false;
  for (let i = 0; i < v.length; i += 1) if (STOP_ALPHABET.indexOf(v.charAt(i)) < 0) return false;
  return true;
};

// --------------------------------------------------------------------------- thresholds

/** A spin returning at least this × bet makes a feed entry. */
export const NOTABLE_X = 5;
/** Brag banner: a win or feature total of at least this × bet (and every pot win). */
export const BRAG_X = 25;
/** Auto-spin stops on a win of at least this × bet (default on). */
export const AUTO_STOP_X = 50;

/** Pixel emotes for reactions, by wire index. */
export const EMOTES = ['sparkle', 'clap', 'grin', 'wow', 'flame', 'heart'] as const;
export type EmoteIdx = 0 | 1 | 2 | 3 | 4 | 5;

// --------------------------------------------------------------------------- Glimmer Pot

/** Each online base spin adds bet × POT_E4 e4-units (0.75 % of the bet). */
export const POT_E4 = 75;
/** The pot draw: randomInt(POT_ODDS) < bet. */
export const POT_ODDS = 1_000_000;
/** Chips the house puts back into the pot after a win. */
export const POT_SEED = 7_500;

// --------------------------------------------------------------------------- hall

export const HALL_MEMBERS = 16;
/** Hall pushes at most once a second per hall. */
export const FEED_GAP_MS = 1_000;
/** The pot value in pushes at most once every 2 s per hall. */
export const POT_GAP_MS = 2_000;
/** One reaction per 3 s per account. */
export const REACT_GAP_MS = 3_000;
/** A disconnected seat is dropped after this long. */
export const SEAT_DROP_MS = 120_000;
/** Away changes shown at most once per member per 5 s. */
export const AWAY_GAP_MS = 5_000;
/** The Glimmerhall push sub-bucket per recipient (wire bytes). */
export const PUSH_BUCKET = { rateBps: 200, depth: 800 } as const;
/** Feed entries kept per push when merging (the biggest wins stay). */
export const FEED_KEEP = 6;
/** Client floor between spins. */
export const SPIN_FLOOR_MS = 700;

// --------------------------------------------------------------------------- Glimmer Dash

export const DASH_LENGTHS = [3, 5, 10] as const;
export const DASH_BUYINS = [0, 100, 500, 1000] as const;
export const DASH_LOBBY_MS = 60_000;
export const DASH_MIN = 2;
export const DASH_MAX = 8;
export const DASH_SERVER_LIMIT = 4;

/** Dash state on the wire. */
export const DASH_ST = { lobby: 0, running: 1, done: 2, void: 3 } as const;

/**
 * A Dash as members see it (about 145 B with 8 entrants). `t`: lobby or play seconds left, stamped
 * at send time. `s`: [slot, score, spins left] per entrant, flattened. `pay`: [slot, chips] per
 * paid entrant, flattened, once done. `host`: the host's hall slot.
 */
export interface DashView {
  id: string;
  st: 0 | 1 | 2 | 3;
  m: MachineIdx;
  len: number;
  buy: number;
  host: number;
  t: number;
  s: number[];
  pay?: number[];
}

/** Entrant rows of a DashView: [slot, score, left]. */
export const dashRows = (v: DashView): [number, number, number][] => {
  const out: [number, number, number][] = [];
  for (let i = 0; i + 2 < v.s.length; i += 3) out.push([v.s[i] as number, v.s[i + 1] as number, v.s[i + 2] as number]);
  return out;
};

// --------------------------------------------------------------------------- messages

/** Harvest Wheel `g` segment; Tide Turn `r` free-spin stops; Forge Spins after door `d`. Wins `w` in chips. */
export type WireFeature = { k: 'h'; g: number; w: number } | { k: 't'; r: string; w: number } | { k: 'v'; d: number; r: string; w: number };

export type RefuseCode =
  | 'busy'
  | 'pending'
  | 'funds'
  | 'moved'
  | 'disabled'
  | 'update'
  | 'hidden'
  | 'bet'
  | 'invalid'
  | 'voice'
  | 'full'
  | 'nohall'
  | 'gone'
  | 'state'
  | 'limit'
  | 'auth';

export interface Refused {
  ok: false;
  code: RefuseCode | string;
}

/** `glimmer:spin` ack. `v: 1` = Three Vaults pending (pick next); `pt` = Glimmer Pot won (chips). */
export interface SpinOk {
  ok: true;
  id: string;
  st: string;
  w: number;
  bal: number;
  pot?: number;
  f?: WireFeature;
  v?: 1;
  pt?: number;
}

/** `glimmer:pick` ack: the prize behind each door, the Forge run. */
export interface PickOk {
  ok: true;
  id: string;
  dr: number[];
  f: Extract<WireFeature, { k: 'v' }>;
  bal: number;
}

export type ResumeOk = SpinOk | PickOk | { ok: true; settled: true; bal: number } | { ok: true; found: false; bal: number };

/** [slot, account id (null for a bot offline … or hidden), machine, away 0/1, last notable win, its × 100]. */
export type MemberRow = [number, string | null, MachineIdx, 0 | 1, number, number];

export interface EnterOk {
  ok: true;
  bal: number;
  /** The Glimmer Pot (0 offline). */
  pot: number;
  /** My hall slot, or -1 outside a hall. */
  me: number;
  maxBet: number;
  mem: MemberRow[];
  /** A pending vault: open the doors screen. */
  pend?: { m: MachineIdx; bet: number };
  dash?: DashView;
}

/** [slot, machine, bet, win, kind]: 0 win ≥ 5×, 1 feature total, 2 pot win, 3 machine change. */
export type FeedEntry = [number, MachineIdx, number, number, 0 | 1 | 2 | 3];
/** [from slot, to slot, emote]. */
export type Reaction = [number, number, number];
/** [slot, account id or null (left), machine, away 0/1]. */
export type MemberDelta = [number, string | null, MachineIdx, 0 | 1];

export interface FeedView {
  e?: FeedEntry[];
  p?: number;
  r?: Reaction[];
  h?: MemberDelta[];
  d?: DashView;
}

export const FEED_KIND = { win: 0, feature: 1, pot: 2, machine: 3 } as const;

/** What a hall has collected for its next push. */
export interface FeedPending {
  e: FeedEntry[];
  r: Reaction[];
  h: MemberDelta[];
  d?: DashView;
  p?: number;
}

export const emptyPending = (): FeedPending => ({ e: [], r: [], h: [] });

export const pendingEmpty = (p: FeedPending): boolean => p.e.length === 0 && p.r.length === 0 && p.h.length === 0 && p.d === undefined && p.p === undefined;

/**
 * One push of at most `cap` JSON bytes, merged newest-wins: the latest Dash view and pot, the
 * biggest feed entries (at most FEED_KEEP, the rest dropped), then membership changes and
 * reactions in order. Membership changes and reactions that do not fit stay in `p` for the next
 * push. Returns null when there is nothing to send.
 */
export const packFeed = (p: FeedPending, cap: number = SIZE.feed): FeedView | null => {
  if (pendingEmpty(p)) return null;
  const view: FeedView = {};
  let size = 2;
  const add = (key: number, text: number): boolean => {
    const extra = key + text;
    if (size + extra > cap) return false;
    size += extra;
    return true;
  };
  if (p.d !== undefined && add(6, JSON.stringify(p.d).length)) view.d = p.d;
  p.d = undefined;
  if (p.p !== undefined && add(6, String(p.p).length)) view.p = p.p;
  p.p = undefined;
  if (p.e.length > 0) {
    const ranked = p.e.slice().sort((a, b) => b[3] / Math.max(1, b[2]) - a[3] / Math.max(1, a[2]) || b[4] - a[4]);
    const keep: FeedEntry[] = [];
    let used = 6;
    for (let i = 0; i < ranked.length && keep.length < FEED_KEEP; i += 1) {
      const text = JSON.stringify(ranked[i]).length + 1;
      if (size + used + text > cap) break;
      used += text;
      keep.push(ranked[i] as FeedEntry);
    }
    if (keep.length > 0) {
      size += used;
      view.e = keep;
    }
    p.e = [];
  }
  const take = <T>(list: T[]): T[] => {
    const out: T[] = [];
    let used = 6;
    let i = 0;
    for (; i < list.length; i += 1) {
      const text = JSON.stringify(list[i]).length + 1;
      if (size + used + text > cap) break;
      used += text;
      out.push(list[i] as T);
    }
    if (out.length > 0) size += used;
    list.splice(0, i);
    return out;
  };
  const h = take(p.h);
  if (h.length > 0) view.h = h;
  const r = take(p.r);
  if (r.length > 0) view.r = r;
  return view.d || view.p !== undefined || view.e || view.h || view.r ? view : null;
};

export interface DashSpinOk {
  ok: true;
  id: string;
  st: string;
  w: number;
  f?: WireFeature;
  /** Score so far. */
  sc: number;
  left: number;
}

// --------------------------------------------------------------------------- sizes

/** Byte limits checked by the wire tests (JSON payload, framing excluded). */
export const SIZE = {
  baseAck: 80,
  tideAck10: 160,
  featureAck: 1200,
  enterAck: 1024,
  feed: 400,
  dashView: 150,
} as const;

/** The wire form of a feature result (`r`: free-spin stops). */
export const wireFeature = (kind: 'wheel' | 'tide' | 'vault', o: { segment?: number; stops: readonly number[]; win: number; picked?: number }): WireFeature => {
  if (kind === 'wheel') return { k: 'h', g: o.segment ?? 0, w: o.win };
  if (kind === 'tide') return { k: 't', r: encodeStops(o.stops), w: o.win };
  return { k: 'v', d: o.picked ?? 0, r: encodeStops(o.stops), w: o.win };
};
