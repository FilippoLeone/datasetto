/**
 * Action-lane envelopes (platform.md §5.2). One binary WebSocket message per envelope, little-endian,
 * `T` is the first byte. The game payloads inside UP, EVT, snapshots, events and keyframes are opaque
 * here: each game's codec owns them.
 *
 * Two details the platform doc leaves open are fixed here:
 * - FRAME's snapshot body is prefixed with its length as a varint (1 byte for bodies under 128 B), so
 *   a snapshot and an event block can share one FRAME.
 * - WELCOME flags: b0 = queued (a late joiner watching until the next round).
 *
 * `readClient` and `readServer` return null on any malformed message and never throw.
 */
import { ByteReader, ByteWriter, utf8Decode, utf8Encode } from '../bytes.js';

export const C2S = { UP: 0x01, ACK: 0x02, EVT: 0x03, PING: 0x04, VIS: 0x05, RESYNC: 0x06 } as const;
export const S2C = { WELCOME: 0x80, FRAME: 0x81, KEYFRAME: 0x82, BEAT: 0x83, PONG: 0x84, PHASE: 0x85, HANDOVER: 0x86, BYE: 0x8f } as const;
export const VIS = { live: 0, away: 1, yield: 2, leaving: 3 } as const;
export const PHASE = { lobby: 0, countdown: 1, running: 2, paused: 3, ending: 4, ended: 5 } as const;
export const KEY_REASON = { join: 0, resume: 1, unpark: 2, round: 3, room: 4, resync: 5 } as const;
/** RESYNC reasons. */
export const RESYNC = { gap: 0, decode: 1, mismatch: 2 } as const;
/** PHASE reasons the platform itself sends (games use their own values for other phases). */
export const PHASE_REASON = { none: 0, restart: 1, overload: 2, admin: 3, idle: 4 } as const;
export const CLOSE = {
  left: 1000,
  restart: 1012,
  away: 4000,
  malformed: 4400,
  ticket: 4401,
  forbidden: 4403,
  gone: 4404,
  helloTimeout: 4408,
  takenOver: 4409,
  update: 4426,
  rate: 4429,
} as const;
/**
 * Close codes after which the client does not reconnect by itself: it left (1000), the server is
 * restarting (1012, the stage offers continue offline or wait), away too long (4000), not allowed,
 * gone, taken over by another tab, update required. 4401 (bad ticket or resume token) is final only
 * after one fresh ticket was tried.
 */
export const CLOSE_FINAL: readonly number[] = [CLOSE.left, CLOSE.restart, CLOSE.away, CLOSE.forbidden, CLOSE.gone, CLOSE.takenOver, CLOSE.update];

export const DIVISORS = [2, 3, 4, 6] as const;
export type Divisor = (typeof DIVISORS)[number];
export const TICK_HZ = 30;
/** One tick in ms (33.33). */
export const TICK_MS = 1000 / TICK_HZ;
/** WELCOME's slot byte for a spectator. */
export const SPECTATOR = 0xff;
export const RESUME_TOKEN_BYTES = 32;
/** Largest message either side may send; the server closes the lane above it. */
export const MAX_MESSAGE = 4096;
/** HELLO is the first message: a text frame of at most this many bytes. */
export const MAX_HELLO = 512;

export interface Welcome {
  proto: number;
  game: number;
  codec: number;
  /** 0xff for a spectator. */
  slot: number;
  queued: boolean;
  /** u32 server tick, the anchor for extending the u16 ticks of later messages. */
  tick: number;
  tickHz: number;
  divisor: Divisor;
  /** The newest EVT the server applied for this seat; the client resends events above it. */
  lastEvSeq: number;
  resumeToken: Uint8Array;
  cfg: Uint8Array;
}

export interface EventBlock {
  count: number;
  r: ByteReader;
  tick: number;
}

export interface FrameView {
  /** True from a LocalHost (no network, interpolation delay 0). */
  local: boolean;
  frameSeq: number;
  tick: number;
  ackUp: number;
  divisor: Divisor | 1;
  lagging: boolean;
  snapshot: ByteReader | null;
  events: EventBlock | null;
}

export interface KeyframeView {
  frameSeq: number;
  tick: number;
  ackUp: number;
  reason: number;
  body: ByteReader;
}

export interface PhaseView {
  phase: number;
  reason: number;
  body: ByteReader;
}
// Views and their readers are valid only during the callback that receives them.

export type ClientMsg =
  | { t: 'up'; upSeq: number; ackFrame: number; ackDelayMs: number; payload: Uint8Array }
  | { t: 'ack'; ackFrame: number; ackDelayMs: number }
  | { t: 'evt'; evSeq: number; payload: Uint8Array }
  | { t: 'ping'; clientMs: number }
  | { t: 'vis'; state: number }
  | { t: 'resync'; reason: number };

/** Raw, as decoded: ticks are the wire's u16 except WELCOME, PONG and HANDOVER (u32). Bodies are views into the message. */
export type ServerMsg =
  | ({ t: 'welcome' } & Welcome)
  | {
      t: 'frame';
      frameSeq: number;
      tick: number;
      ackUp: number;
      divisor: Divisor;
      lagging: boolean;
      snapshot: Uint8Array | null;
      events: { count: number; bytes: Uint8Array } | null;
    }
  | { t: 'keyframe'; frameSeq: number; tick: number; ackUp: number; reason: number; body: Uint8Array }
  | { t: 'beat'; tick: number }
  | { t: 'pong'; clientMs: number; serverTick: number; phaseUs: number }
  | { t: 'phase'; phase: number; reason: number; body: Uint8Array }
  | { t: 'handover'; simVersion: number; tick: number; body: Uint8Array }
  | { t: 'bye'; code: number; reason: string };

/** HELLO, the first (text) message on a lane: JSON, ≤ 512 B. */
export type Hello =
  | { t: 'hello'; proto: number; codec: Partial<Record<'fuseyard' | 'bellwick', number>>; ticket: string }
  | { t: 'hello'; proto: number; codec: Partial<Record<'fuseyard' | 'bellwick', number>>; resume: string };

const clampDelay = (ms: number): number => Math.max(0, Math.min(255, Math.round(ms / 4)));
const divisorIndex = (d: Divisor): number => DIVISORS.indexOf(d);

// ------------------------------------------------------------------ client → server

export const writeUp = (upSeq: number, ackFrame: number, ackDelayMs: number, payload: Uint8Array): Uint8Array =>
  new ByteWriter(6 + payload.length).u8(C2S.UP).u16(upSeq).u16(ackFrame).u8(clampDelay(ackDelayMs)).bytes(payload).view();

export const writeAck = (ackFrame: number, ackDelayMs: number): Uint8Array =>
  new ByteWriter(4).u8(C2S.ACK).u16(ackFrame).u8(clampDelay(ackDelayMs)).view();

export const writeEvt = (evSeq: number, payload: Uint8Array): Uint8Array => new ByteWriter(3 + payload.length).u8(C2S.EVT).u16(evSeq).bytes(payload).view();

export const writePing = (clientMs: number): Uint8Array => new ByteWriter(5).u8(C2S.PING).u32(clientMs).view();

export const writeVis = (state: number): Uint8Array => new ByteWriter(2).u8(C2S.VIS).u8(state).view();

export const writeResync = (reason: number): Uint8Array => new ByteWriter(2).u8(C2S.RESYNC).u8(reason).view();

export const readClient = (msg: Uint8Array): ClientMsg | null => {
  if (msg.length < 2 || msg.length > MAX_MESSAGE) return null;
  const r = new ByteReader(msg);
  const t = r.u8();
  let out: ClientMsg | null = null;
  switch (t) {
    case C2S.UP: {
      const upSeq = r.u16();
      const ackFrame = r.u16();
      const ackDelayMs = r.u8() * 4;
      out = { t: 'up', upSeq, ackFrame, ackDelayMs, payload: r.rest() };
      break;
    }
    case C2S.ACK: {
      const ackFrame = r.u16();
      const ackDelayMs = r.u8() * 4;
      if (r.remaining !== 0) return null;
      out = { t: 'ack', ackFrame, ackDelayMs };
      break;
    }
    case C2S.EVT: {
      const evSeq = r.u16();
      if (r.remaining < 1) return null;
      out = { t: 'evt', evSeq, payload: r.rest() };
      break;
    }
    case C2S.PING: {
      const clientMs = r.u32();
      if (r.remaining !== 0) return null;
      out = { t: 'ping', clientMs };
      break;
    }
    case C2S.VIS: {
      const state = r.u8();
      if (r.remaining !== 0 || state > VIS.leaving) return null;
      out = { t: 'vis', state };
      break;
    }
    case C2S.RESYNC: {
      const reason = r.u8();
      if (r.remaining !== 0 || reason > RESYNC.mismatch) return null;
      out = { t: 'resync', reason };
      break;
    }
    default:
      return null;
  }
  return r.ok ? out : null;
};

/** Parse a HELLO text frame; null when it is not a well-formed HELLO. */
export const readHello = (text: string): Hello | null => {
  if (text.length > MAX_HELLO) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.t !== 'hello' || typeof o.proto !== 'number' || !o.codec || typeof o.codec !== 'object') return null;
  const codec: Partial<Record<'fuseyard' | 'bellwick', number>> = {};
  const c = o.codec as Record<string, unknown>;
  if (typeof c.fuseyard === 'number') codec.fuseyard = c.fuseyard;
  if (typeof c.bellwick === 'number') codec.bellwick = c.bellwick;
  if (typeof o.ticket === 'string' && o.ticket.length > 0 && o.ticket.length <= 400) return { t: 'hello', proto: o.proto, codec, ticket: o.ticket };
  if (typeof o.resume === 'string' && o.resume.length > 0 && o.resume.length <= 64) return { t: 'hello', proto: o.proto, codec, resume: o.resume };
  return null;
};

// ------------------------------------------------------------------ server → client

export const writeWelcome = (w: Welcome): Uint8Array =>
  new ByteWriter(48 + w.cfg.length)
    .u8(S2C.WELCOME)
    .u8(w.proto)
    .u8(w.game)
    .u8(w.codec)
    .u8(w.slot)
    .u8(w.queued ? 1 : 0)
    .u32(w.tick)
    .u8(w.tickHz)
    .u8(w.divisor)
    .u16(w.lastEvSeq)
    .bytes(w.resumeToken.length === RESUME_TOKEN_BYTES ? w.resumeToken : new Uint8Array(RESUME_TOKEN_BYTES))
    .u16(w.cfg.length)
    .bytes(w.cfg)
    .view();

export interface FrameParts {
  frameSeq: number;
  tick: number;
  ackUp: number;
  divisor: Divisor;
  lagging?: boolean;
  snapshot: Uint8Array | null;
  events: { count: number; bytes: Uint8Array } | null;
}

/** Bytes a FRAME takes on the wire before overhead, without building it. */
export const frameSize = (snapshot: Uint8Array | null, events: { count: number; bytes: Uint8Array } | null): number =>
  8 + (snapshot ? (snapshot.length < 128 ? 1 : 2) + snapshot.length : 0) + (events && events.count > 0 ? 1 + events.bytes.length : 0);

export const writeFrame = (f: FrameParts): Uint8Array => {
  const hasSnap = f.snapshot !== null;
  const hasEv = f.events !== null && f.events.count > 0;
  const flags = (hasSnap ? 1 : 0) | (hasEv ? 2 : 0) | (divisorIndex(f.divisor) << 2) | (f.lagging ? 16 : 0);
  const w = new ByteWriter(frameSize(f.snapshot, f.events)).u8(S2C.FRAME).u16(f.frameSeq).u16(f.tick).u16(f.ackUp).u8(flags);
  if (f.snapshot) w.varint(f.snapshot.length).bytes(f.snapshot);
  if (hasEv && f.events) {
    // The count is one byte. Clamping it would make the client walk 255 events and silently drop
    // the rest, so more than 255 is an encoder bug, like a ByteWriter overflow.
    if (f.events.count > 255) throw new RangeError('writeFrame: ' + f.events.count + ' events in one FRAME, at most 255');
    w.u8(f.events.count).bytes(f.events.bytes);
  }
  return w.view();
};

export const writeKeyframe = (frameSeq: number, tick: number, ackUp: number, reason: number, body: Uint8Array): Uint8Array =>
  new ByteWriter(10 + body.length).u8(S2C.KEYFRAME).u16(frameSeq).u16(tick).u16(ackUp).u8(reason).u16(body.length).bytes(body).view();

export const writeBeat = (tick: number): Uint8Array => new ByteWriter(3).u8(S2C.BEAT).u16(tick).view();

export const writePong = (clientMs: number, serverTick: number, phaseUs: number): Uint8Array =>
  new ByteWriter(11).u8(S2C.PONG).u32(clientMs).u32(serverTick).u16(Math.max(0, Math.min(0xffff, Math.round(phaseUs)))).view();

export const writePhase = (phase: number, reason: number, body: Uint8Array): Uint8Array =>
  new ByteWriter(5 + body.length).u8(S2C.PHASE).u8(phase).u8(reason).u16(body.length).bytes(body).view();

/** `body` is already deflate-raw compressed by the server. */
export const writeHandover = (simVersion: number, tick: number, body: Uint8Array): Uint8Array =>
  new ByteWriter(9 + body.length).u8(S2C.HANDOVER).u16(simVersion).u32(tick).u16(body.length).bytes(body).view();

export const writeBye = (code: number, reason: string): Uint8Array => {
  let text = utf8Encode(reason);
  if (text.length > 64) text = text.subarray(0, 64);
  return new ByteWriter(4 + text.length).u8(S2C.BYE).u16(code).u8(text.length).bytes(text).view();
};

export const readServer = (msg: Uint8Array): ServerMsg | null => {
  if (msg.length < 3) return null;
  const r = new ByteReader(msg);
  const t = r.u8();
  let out: ServerMsg | null = null;
  switch (t) {
    case S2C.WELCOME: {
      const proto = r.u8();
      const game = r.u8();
      const codec = r.u8();
      const slot = r.u8();
      const flags = r.u8();
      const tick = r.u32();
      const tickHz = r.u8();
      const divisor = r.u8();
      const lastEvSeq = r.u16();
      const resumeToken = r.bytes(RESUME_TOKEN_BYTES);
      const cfgLen = r.u16();
      const cfg = r.bytes(cfgLen);
      if (!(DIVISORS as readonly number[]).includes(divisor) || r.remaining !== 0) return null;
      out = { t: 'welcome', proto, game, codec, slot, queued: (flags & 1) === 1, tick, tickHz, divisor: divisor as Divisor, lastEvSeq, resumeToken, cfg };
      break;
    }
    case S2C.FRAME: {
      const frameSeq = r.u16();
      const tick = r.u16();
      const ackUp = r.u16();
      const flags = r.u8();
      if (flags & 0xe0) return null;
      let snapshot: Uint8Array | null = null;
      let events: { count: number; bytes: Uint8Array } | null = null;
      if (flags & 1) {
        const len = r.varint();
        snapshot = r.bytes(len);
      }
      if (flags & 2) {
        const count = r.u8();
        if (count === 0) return null;
        events = { count, bytes: r.rest() };
      }
      if (r.remaining !== 0) return null;
      out = { t: 'frame', frameSeq, tick, ackUp, divisor: DIVISORS[(flags >> 2) & 3] as Divisor, lagging: (flags & 16) !== 0, snapshot, events };
      break;
    }
    case S2C.KEYFRAME: {
      const frameSeq = r.u16();
      const tick = r.u16();
      const ackUp = r.u16();
      const reason = r.u8();
      const len = r.u16();
      const body = r.bytes(len);
      if (r.remaining !== 0 || reason > KEY_REASON.resync) return null;
      out = { t: 'keyframe', frameSeq, tick, ackUp, reason, body };
      break;
    }
    case S2C.BEAT: {
      const tick = r.u16();
      if (r.remaining !== 0) return null;
      out = { t: 'beat', tick };
      break;
    }
    case S2C.PONG: {
      const clientMs = r.u32();
      const serverTick = r.u32();
      const phaseUs = r.u16();
      if (r.remaining !== 0) return null;
      out = { t: 'pong', clientMs, serverTick, phaseUs };
      break;
    }
    case S2C.PHASE: {
      const phase = r.u8();
      const reason = r.u8();
      const len = r.u16();
      const body = r.bytes(len);
      if (r.remaining !== 0) return null;
      out = { t: 'phase', phase, reason, body };
      break;
    }
    case S2C.HANDOVER: {
      const simVersion = r.u16();
      const tick = r.u32();
      const len = r.u16();
      const body = r.bytes(len);
      if (r.remaining !== 0) return null;
      out = { t: 'handover', simVersion, tick, body };
      break;
    }
    case S2C.BYE: {
      const code = r.u16();
      const len = r.u8();
      const text = r.bytes(len);
      if (r.remaining !== 0 || len > 64) return null;
      out = { t: 'bye', code, reason: utf8Decode(text) };
      break;
    }
    default:
      return null;
  }
  return r.ok ? out : null;
};

/** Extend a wire u16 tick to the full tick closest to `ref` (a recent full tick). */
export const extendTick = (u16: number, ref: number): number => {
  const d = (((u16 - ref) & 0xffff) + 0x8000) % 0x10000 - 0x8000;
  return ref + d;
};
