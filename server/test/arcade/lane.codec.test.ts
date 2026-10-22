/**
 * Action-lane envelopes (server/src/arcade/core/net/lane.ts, platform.md §5.2, plan.md §3.2
 * "Envelopes"): every message round-trips, the sizes hold, and the readers never throw.
 */
import { describe, expect, it } from 'vitest';
import {
  C2S,
  DIVISORS,
  MAX_HELLO,
  MAX_MESSAGE,
  RESUME_TOKEN_BYTES,
  S2C,
  SPECTATOR,
  extendTick,
  frameSize,
  readClient,
  readHello,
  readServer,
  writeAck,
  writeBeat,
  writeBye,
  writeEvt,
  writeFrame,
  writeHandover,
  writeKeyframe,
  writePhase,
  writePing,
  writePong,
  writeResync,
  writeUp,
  writeVis,
  writeWelcome,
  type ClientMsg,
  type Divisor,
  type ServerMsg,
} from '../../src/arcade/core/net/lane.js';
import { xorshift32 } from '../../src/arcade/core/rng.js';

const seeded = (seed: number): (() => number) => {
  let s = seed >>> 0 || 1;
  return () => (s = xorshift32(s));
};

/** Typed arrays become plain arrays, so comparisons ignore views and offsets. */
const plain = (v: unknown): unknown => {
  if (v instanceof Uint8Array) return Array.from(v);
  if (Array.isArray(v)) return v.map(plain);
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = plain(x);
    return o;
  }
  return v;
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(plain(a)) === JSON.stringify(plain(b));

const encodeClient = (m: ClientMsg): Uint8Array => {
  switch (m.t) {
    case 'up':
      return writeUp(m.upSeq, m.ackFrame, m.ackDelayMs, m.payload);
    case 'ack':
      return writeAck(m.ackFrame, m.ackDelayMs);
    case 'evt':
      return writeEvt(m.evSeq, m.payload);
    case 'ping':
      return writePing(m.clientMs);
    case 'vis':
      return writeVis(m.state);
    case 'resync':
      return writeResync(m.reason);
  }
};

const encodeServer = (m: ServerMsg): Uint8Array => {
  switch (m.t) {
    case 'welcome':
      return writeWelcome(m);
    case 'frame':
      return writeFrame(m);
    case 'keyframe':
      return writeKeyframe(m.frameSeq, m.tick, m.ackUp, m.reason, m.body);
    case 'beat':
      return writeBeat(m.tick);
    case 'pong':
      return writePong(m.clientMs, m.serverTick, m.phaseUs);
    case 'phase':
      return writePhase(m.phase, m.reason, m.body);
    case 'handover':
      return writeHandover(m.simVersion, m.tick, m.body);
    case 'bye':
      return writeBye(m.code, m.reason);
  }
};

const CLIENT_TYPE: Record<ClientMsg['t'], number> = { up: C2S.UP, ack: C2S.ACK, evt: C2S.EVT, ping: C2S.PING, vis: C2S.VIS, resync: C2S.RESYNC };
const SERVER_TYPE: Record<ServerMsg['t'], number> = {
  welcome: S2C.WELCOME,
  frame: S2C.FRAME,
  keyframe: S2C.KEYFRAME,
  beat: S2C.BEAT,
  pong: S2C.PONG,
  phase: S2C.PHASE,
  handover: S2C.HANDOVER,
  bye: S2C.BYE,
};
const CLIENT_TYPES: readonly number[] = Object.values(C2S);
const SERVER_TYPES: readonly number[] = Object.values(S2C);
const OUTSIDE_TYPES: readonly number[] = Array.from({ length: 256 }, (_, t) => t).filter((t) => !CLIENT_TYPES.includes(t) && !SERVER_TYPES.includes(t));

const BYE_CHARS = ['a', 'Z', '0', ' ', '.', 'é', 'ü', '漢', '😀'];

/** Seeded generators of valid messages. Bodies stay at or under `maxBody` bytes. */
const generators = (next: () => number) => {
  const u8 = (): number => next() & 0xff;
  const u16 = (): number => next() & 0xffff;
  const u32 = (): number => next() >>> 0;
  const bytes = (n: number): Uint8Array => {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) b[i] = u8();
    return b;
  };
  const divisor = (): Divisor => DIVISORS[next() % DIVISORS.length] as Divisor;
  const client = (): ClientMsg => {
    switch (next() % 6) {
      case 0:
        return { t: 'up', upSeq: u16(), ackFrame: u16(), ackDelayMs: (next() % 256) * 4, payload: bytes(next() % 12) };
      case 1:
        return { t: 'ack', ackFrame: u16(), ackDelayMs: (next() % 256) * 4 };
      case 2:
        return { t: 'evt', evSeq: u16(), payload: bytes(1 + (next() % 10)) };
      case 3:
        return { t: 'ping', clientMs: u32() };
      case 4:
        return { t: 'vis', state: next() % 4 };
      default:
        return { t: 'resync', reason: next() % 3 };
    }
  };
  const server = (maxBody: number): ServerMsg => {
    const body = (): Uint8Array => bytes(next() % (maxBody + 1));
    switch (next() % 8) {
      case 0:
        return {
          t: 'welcome',
          proto: u8(),
          game: u8(),
          codec: u8(),
          slot: u8(),
          queued: next() % 2 === 0,
          tick: u32(),
          tickHz: u8(),
          divisor: divisor(),
          lastEvSeq: u16(),
          resumeToken: bytes(RESUME_TOKEN_BYTES),
          cfg: body(),
        };
      case 1:
        return {
          t: 'frame',
          frameSeq: u16(),
          tick: u16(),
          ackUp: u16(),
          divisor: divisor(),
          lagging: next() % 4 === 0,
          snapshot: next() % 3 === 0 ? null : body(),
          events: next() % 3 === 0 ? null : { count: 1 + (next() % 255), bytes: body() },
        };
      case 2:
        return { t: 'keyframe', frameSeq: u16(), tick: u16(), ackUp: u16(), reason: next() % 6, body: body() };
      case 3:
        return { t: 'beat', tick: u16() };
      case 4:
        return { t: 'pong', clientMs: u32(), serverTick: u32(), phaseUs: u16() };
      case 5:
        return { t: 'phase', phase: next() % 6, reason: u8(), body: body() };
      case 6:
        return { t: 'handover', simVersion: u16(), tick: u32(), body: body() };
      default: {
        let reason = '';
        const n = next() % 16; // at most 15 characters of at most 4 bytes: always ≤ 64 bytes
        for (let i = 0; i < n; i += 1) reason += BYE_CHARS[next() % BYE_CHARS.length];
        return { t: 'bye', code: u16(), reason };
      }
    }
  };
  return { client, server, bytes };
};

const TOKEN = Uint8Array.from({ length: RESUME_TOKEN_BYTES }, (_, i) => (i * 37 + 11) & 0xff);
const range = (n: number, f: (i: number) => number = (i) => (i * 29 + 3) & 0xff): Uint8Array => Uint8Array.from({ length: n }, (_, i) => f(i));

/** Hand-picked messages at the edges of every field. */
const CLIENT_SAMPLES: ClientMsg[] = [
  { t: 'up', upSeq: 0xfffe, ackFrame: 513, ackDelayMs: 1020, payload: Uint8Array.of(2, 0x41, 0x42) },
  { t: 'up', upSeq: 0, ackFrame: 0xffff, ackDelayMs: 0, payload: new Uint8Array(0) },
  { t: 'ack', ackFrame: 0xffff, ackDelayMs: 248 },
  { t: 'ack', ackFrame: 0, ackDelayMs: 0 },
  { t: 'evt', evSeq: 7, payload: Uint8Array.of(9, 1, 2, 3) },
  { t: 'evt', evSeq: 0xffff, payload: Uint8Array.of(0) },
  { t: 'ping', clientMs: 0xfedcba98 },
  { t: 'ping', clientMs: 0 },
  { t: 'vis', state: 0 },
  { t: 'vis', state: 3 },
  { t: 'resync', reason: 0 },
  { t: 'resync', reason: 2 },
];

const SERVER_SAMPLES: ServerMsg[] = [
  {
    t: 'welcome', proto: 1, game: 2, codec: 3, slot: SPECTATOR, queued: true, tick: 0xfedcba98,
    tickHz: 30, divisor: 6, lastEvSeq: 0xabcd, resumeToken: TOKEN, cfg: range(17),
  },
  { t: 'welcome', proto: 1, game: 1, codec: 1, slot: 0, queued: false, tick: 0, tickHz: 30, divisor: 2, lastEvSeq: 0, resumeToken: TOKEN, cfg: new Uint8Array(0) },
  { t: 'frame', frameSeq: 0xffff, tick: 0xfffe, ackUp: 1, divisor: 2, lagging: false, snapshot: range(22), events: null },
  { t: 'frame', frameSeq: 1, tick: 2, ackUp: 3, divisor: 3, lagging: true, snapshot: null, events: { count: 3, bytes: range(9) } },
  { t: 'frame', frameSeq: 4, tick: 5, ackUp: 6, divisor: 4, lagging: false, snapshot: range(200), events: { count: 255, bytes: range(30) } },
  { t: 'frame', frameSeq: 7, tick: 8, ackUp: 9, divisor: 6, lagging: false, snapshot: null, events: null },
  { t: 'frame', frameSeq: 7, tick: 8, ackUp: 9, divisor: 6, lagging: false, snapshot: new Uint8Array(0), events: null },
  { t: 'keyframe', frameSeq: 10, tick: 11, ackUp: 12, reason: 0, body: range(340) },
  { t: 'keyframe', frameSeq: 0xffff, tick: 0, ackUp: 0xffff, reason: 5, body: new Uint8Array(0) },
  { t: 'beat', tick: 0xffff },
  { t: 'pong', clientMs: 0xffffffff, serverTick: 0x12345678, phaseUs: 33333 },
  { t: 'phase', phase: 5, reason: 2, body: range(40) },
  { t: 'phase', phase: 0, reason: 0, body: new Uint8Array(0) },
  { t: 'handover', simVersion: 0x1234, tick: 0xfffffff0, body: range(1000) },
  { t: 'bye', code: 4429, reason: 'too many messages' },
  { t: 'bye', code: 1012, reason: 'redémarrage 😀' },
  { t: 'bye', code: 1000, reason: '' },
];

describe('client messages', () => {
  it('round-trip the edge samples with exact field equality and documented sizes', () => {
    for (const m of CLIENT_SAMPLES) {
      const bytes = encodeClient(m);
      expect(bytes[0]).toBe(CLIENT_TYPE[m.t]);
      expect(plain(readClient(bytes)), m.t).toEqual(plain(m));
    }
    expect(writeAck(1, 0).length).toBe(4);
    expect(writePing(1).length).toBe(5);
    expect(writeVis(0).length).toBe(2);
    expect(writeResync(0).length).toBe(2);
    expect(writeUp(1, 2, 3, Uint8Array.of(2, 1, 1)).length).toBe(9); // a Fuseyard UP with n = 2
    expect(writeEvt(1, Uint8Array.of(1, 2, 3, 4)).length).toBe(7);
  });

  it('round-trip 3,000 seeded random messages', () => {
    const g = generators(seeded(0xc1));
    for (let i = 0; i < 3000; i += 1) {
      const m = g.client();
      expect(plain(readClient(encodeClient(m)))).toEqual(plain(m));
    }
  });

  it('quantise ackDelay to 4 ms units, clamped to 0..1020', () => {
    const delay = (ms: number): number => {
      const m = readClient(writeAck(1, ms));
      return m !== null && m.t === 'ack' ? m.ackDelayMs : -1;
    };
    expect(delay(0)).toBe(0);
    expect(delay(5)).toBe(4);
    expect(delay(6)).toBe(8);
    expect(delay(1020)).toBe(1020);
    expect(delay(2000)).toBe(1020);
    expect(delay(-10)).toBe(0);
    const up = readClient(writeUp(1, 2, 5000, new Uint8Array(0)));
    expect(up !== null && up.t === 'up' && up.ackDelayMs).toBe(1020);
  });

  it('reject malformed, unknown and oversize messages', () => {
    const bad: [string, number[]][] = [
      ['empty', []],
      ['type only', [C2S.VIS]],
      ['unknown 0x00', [0x00, 0]],
      ['unknown 0x07', [0x07, 0, 0, 0]],
      ['a server type', [S2C.BEAT, 0, 0]],
      ['vis 4', [C2S.VIS, 4]],
      ['resync 3', [C2S.RESYNC, 3]],
      ['vis trailing', [C2S.VIS, 0, 0]],
      ['resync trailing', [C2S.RESYNC, 0, 0]],
      ['ack short', [C2S.ACK, 1, 0]],
      ['ack trailing', [C2S.ACK, 1, 0, 0, 9]],
      ['ping short', [C2S.PING, 1, 2, 3]],
      ['ping trailing', [C2S.PING, 1, 2, 3, 4, 5]],
      ['evt without payload', [C2S.EVT, 1, 0]],
      ['up short', [C2S.UP, 1, 0, 2, 0]],
    ];
    for (const [name, bytes] of bad) expect(readClient(Uint8Array.from(bytes)), name).toBeNull();
    expect(readClient(writeUp(1, 1, 0, new Uint8Array(MAX_MESSAGE - 6)))).not.toBeNull();
    expect(readClient(writeUp(1, 1, 0, new Uint8Array(MAX_MESSAGE - 5)))).toBeNull();
  });
});

describe('server messages', () => {
  it('round-trip the edge samples with exact field equality', () => {
    for (const m of SERVER_SAMPLES) {
      const bytes = encodeServer(m);
      expect(bytes[0]).toBe(SERVER_TYPE[m.t]);
      expect(plain(readServer(bytes)), m.t).toEqual(plain(m));
    }
  });

  it('round-trip 3,000 seeded random messages', () => {
    const g = generators(seeded(0x5e));
    for (let i = 0; i < 3000; i += 1) {
      const m = g.server(300);
      expect(plain(readServer(encodeServer(m)))).toEqual(plain(m));
    }
  });

  it('WELCOME is exactly 48 B + cfg, inside the 64 B + cfg budget', () => {
    for (const n of [0, 1, 17, 200, 1000]) {
      const w = writeWelcome({ proto: 1, game: 1, codec: 1, slot: 3, queued: false, tick: 99, tickHz: 30, divisor: 2, lastEvSeq: 5, resumeToken: TOKEN, cfg: range(n) });
      expect(w.length).toBe(48 + n);
      expect(w.length).toBeLessThanOrEqual(64 + n);
    }
  });

  it('a FRAME with a 22 B snapshot and no events is at most 32 B', () => {
    const f = writeFrame({ frameSeq: 1, tick: 2, ackUp: 3, divisor: 2, snapshot: range(22), events: null });
    expect(f.length).toBe(31);
    expect(f.length).toBeLessThanOrEqual(32);
    expect(frameSize(range(22), null)).toBe(31);
    expect(writeFrame({ frameSeq: 1, tick: 2, ackUp: 3, divisor: 6, lagging: true, snapshot: range(22), events: null }).length).toBe(31);
  });

  it('frameSize matches what writeFrame writes; a header-only FRAME is 8 B', () => {
    const g = generators(seeded(0xf5));
    for (let i = 0; i < 500; i += 1) {
      const snapshot = i % 3 === 0 ? null : g.bytes(i % 300);
      const events = i % 4 === 0 ? null : { count: 1 + (i % 200), bytes: g.bytes(i % 50) };
      expect(writeFrame({ frameSeq: i, tick: i, ackUp: i, divisor: 2, snapshot, events }).length).toBe(frameSize(snapshot, events));
    }
    expect(writeFrame({ frameSeq: 1, tick: 2, ackUp: 3, divisor: 2, snapshot: null, events: null }).length).toBe(8);
    // The count is one byte: more than 255 events is an encoder bug, never a silently clamped count.
    expect(() => writeFrame({ frameSeq: 1, tick: 2, ackUp: 3, divisor: 2, snapshot: null, events: { count: 256, bytes: g.bytes(256) } })).toThrow(RangeError);
    // An event block with no events is left out.
    const empty = readServer(writeFrame({ frameSeq: 1, tick: 2, ackUp: 3, divisor: 2, snapshot: null, events: { count: 0, bytes: new Uint8Array(0) } }));
    expect(empty !== null && empty.t === 'frame' && empty.events).toBeNull();
  });

  it('fixed sizes: KEYFRAME 10 + body, BEAT 3, PONG 11, PHASE 5 + body, HANDOVER 9 + body, BYE 4 + text', () => {
    expect(writeKeyframe(1, 2, 3, 0, range(340)).length).toBe(350);
    expect(writeBeat(1).length).toBe(3);
    expect(writePong(1, 2, 3).length).toBe(11);
    expect(writePhase(1, 2, range(7)).length).toBe(12);
    expect(writeHandover(1, 2, range(100)).length).toBe(109);
    expect(writeBye(4400, 'bad').length).toBe(7);
  });

  it('clamp PONG phase and BYE text, and zero a resume token of the wrong length', () => {
    const phase = (us: number): number => {
      const m = readServer(writePong(1, 2, us));
      return m !== null && m.t === 'pong' ? m.phaseUs : -1;
    };
    expect(phase(70000)).toBe(0xffff);
    expect(phase(-5)).toBe(0);
    expect(phase(12.6)).toBe(13);

    const long = readServer(writeBye(4000, 'x'.repeat(100)));
    expect(long !== null && long.t === 'bye' && long.reason).toBe('x'.repeat(64));
    // Cut inside a multi-byte character: still decodes, never throws.
    const cut = readServer(writeBye(4000, 'a' + 'é'.repeat(40)));
    expect(cut !== null && cut.t === 'bye' && cut.reason.startsWith('aé')).toBe(true);

    const w = readServer(writeWelcome({ proto: 1, game: 1, codec: 1, slot: 0, queued: false, tick: 0, tickHz: 30, divisor: 2, lastEvSeq: 0, resumeToken: new Uint8Array(5), cfg: new Uint8Array(0) }));
    expect(w !== null && w.t === 'welcome' && Array.from(w.resumeToken)).toEqual(new Array(RESUME_TOKEN_BYTES).fill(0));
  });

  it('reject malformed, unknown and inconsistent messages', () => {
    const welcome = encodeServer(SERVER_SAMPLES[0] as ServerMsg);
    const patched = (src: Uint8Array, at: number, v: number): Uint8Array => {
      const b = src.slice();
      b[at] = v;
      return b;
    };
    const frame = writeFrame({ frameSeq: 1, tick: 2, ackUp: 3, divisor: 2, snapshot: range(4), events: null });
    const bad: [string, Uint8Array][] = [
      ['empty', new Uint8Array(0)],
      ['too short', Uint8Array.of(S2C.BEAT, 0)],
      ['welcome divisor 5', patched(welcome, 11, 5)],
      ['welcome divisor 1', patched(welcome, 11, 1)],
      ['welcome trailing', Uint8Array.from([...welcome, 0])],
      ['welcome cfg cut', welcome.subarray(0, welcome.length - 1)],
      ['frame flag b5', patched(frame, 7, frame[7]! | 0x20)],
      ['frame flag b6', patched(frame, 7, frame[7]! | 0x40)],
      ['frame flag b7', patched(frame, 7, frame[7]! | 0x80)],
      ['frame zero events', Uint8Array.of(S2C.FRAME, 0, 0, 0, 0, 0, 0, 0x02, 0x00)],
      ['frame trailing without events', Uint8Array.from([...frame, 1])],
      ['frame snapshot past the end', patched(frame, 8, 40)],
      ['keyframe reason 6', patched(writeKeyframe(1, 2, 3, 0, range(4)), 7, 6)],
      ['keyframe trailing', Uint8Array.from([...writeKeyframe(1, 2, 3, 0, range(4)), 0])],
      ['beat trailing', Uint8Array.of(S2C.BEAT, 0, 0, 0)],
      ['pong trailing', Uint8Array.from([...writePong(1, 2, 3), 0])],
      ['phase trailing', Uint8Array.from([...writePhase(1, 2, range(3)), 0])],
      ['handover trailing', Uint8Array.from([...writeHandover(1, 2, range(3)), 0])],
      ['bye over 64 bytes', Uint8Array.from([S2C.BYE, 0xa0, 0x0f, 65, ...range(65, () => 0x61)])],
      ['bye length mismatch', Uint8Array.from([S2C.BYE, 0xa0, 0x0f, 3, 0x61])],
      ['a client type', Uint8Array.of(C2S.PING, 1, 2, 3, 4)],
      ['unknown 0x87', Uint8Array.of(0x87, 0, 0, 0)],
      ['unknown 0x8e', Uint8Array.of(0x8e, 0, 0, 0)],
      ['unknown 0x90', Uint8Array.of(0x90, 0, 0, 0)],
      ['unknown 0xff', Uint8Array.of(0xff, 0, 0, 0)],
    ];
    for (const [name, bytes] of bad) expect(readServer(bytes), name).toBeNull();
  });

  it('each direction refuses the other direction’s messages', () => {
    const g = generators(seeded(0xd1));
    for (let i = 0; i < 500; i += 1) {
      expect(readServer(encodeClient(g.client()))).toBeNull();
      expect(readClient(encodeServer(g.server(40)))).toBeNull();
    }
  });
});

describe('truncation', () => {
  /**
   * Where a message's opaque tail starts: UP's and EVT's payloads and FRAME's event block run to the
   * end of the WebSocket message (WebSocket framing cannot cut a message in transit). A cut inside
   * that tail reads as a shorter tail, which the game codec and forEachEvent reject on their own.
   * Every other cut, and every cut of a length-prefixed message, must give null.
   */
  const clientTail = (m: ClientMsg): number | null => (m.t === 'up' ? 6 : m.t === 'evt' ? 4 : null);
  const serverTail = (m: ServerMsg, bytes: Uint8Array): number | null => {
    if (m.t !== 'frame' || m.events === null) return null;
    return bytes.length - m.events.bytes.length;
  };

  it('every strict prefix of a client message is null, except a shorter opaque payload', () => {
    for (const m of CLIENT_SAMPLES) {
      const bytes = encodeClient(m);
      const tail = clientTail(m);
      for (let k = 0; k < bytes.length; k += 1) {
        const got = readClient(bytes.subarray(0, k));
        if (tail === null || k < tail) expect(got, m.t + ' cut at ' + k).toBeNull();
        else {
          expect(got?.t).toBe(m.t);
          expect(got !== null && (got.t === 'up' || got.t === 'evt') && Array.from(got.payload)).toEqual(Array.from(bytes.subarray(tail - (m.t === 'evt' ? 1 : 0), k)));
        }
      }
    }
  });

  it('every strict prefix of a server message is null, except a shorter event block', () => {
    for (const m of SERVER_SAMPLES) {
      const bytes = encodeServer(m);
      const tail = serverTail(m, bytes);
      for (let k = 0; k < bytes.length; k += 1) {
        const got = readServer(bytes.subarray(0, k));
        if (tail === null || k < tail) expect(got, m.t + ' cut at ' + k).toBeNull();
        else {
          expect(got !== null && got.t === 'frame' && got.events !== null && Array.from(got.events.bytes)).toEqual(Array.from(bytes.subarray(tail, k)));
        }
      }
    }
  });
});

describe('fuzz', () => {
  it('10,000 seeded random and mutated buffers give null or a valid message, and never throw', () => {
    const next = seeded(0xf022);
    const g = generators(next);
    const pick = (xs: readonly number[]): number => xs[next() % xs.length] as number;
    const pool: Uint8Array[] = [];
    for (let i = 0; i < 300; i += 1) {
      pool.push(encodeClient(g.client()));
      pool.push(encodeServer(g.server(24)));
    }
    const mutate = (src: Uint8Array): Uint8Array => {
      const kind = next() % 4;
      const b = src.slice(0, 80);
      if (kind === 0 && b.length > 0) b[next() % b.length]! ^= 1 << (next() % 8);
      else if (kind === 1) return b.subarray(0, next() % (b.length + 1));
      else if (kind === 2) return Uint8Array.from([...b, ...g.bytes(1 + (next() % 4))]).subarray(0, 80);
      else if (b.length > 0) b[0] = pick(next() % 2 === 0 ? CLIENT_TYPES : SERVER_TYPES);
      return b;
    };

    const problems: string[] = [];
    let accepted = 0;
    for (let i = 0; i < 10000; i += 1) {
      let buf: Uint8Array;
      if (i % 2 === 0) {
        buf = g.bytes(next() % 81);
        if (buf.length > 0) {
          const r = next() % 3;
          buf[0] = pick(r === 0 ? CLIENT_TYPES : r === 1 ? SERVER_TYPES : OUTSIDE_TYPES);
        }
      } else buf = mutate(pool[next() % pool.length] as Uint8Array);

      const out = { c: null as ClientMsg | null, s: null as ServerMsg | null };
      expect(() => {
        out.c = readClient(buf);
        out.s = readServer(buf);
      }).not.toThrow();

      const { c, s } = out;
      if (c !== null) {
        accepted += 1;
        if (CLIENT_TYPE[c.t] !== buf[0]) problems.push('client type ' + c.t + ' from ' + buf[0]);
        if (!same(readClient(encodeClient(c)), c)) problems.push('client ' + c.t + ' does not re-encode: ' + Array.from(buf).join(','));
      }
      if (s !== null) {
        accepted += 1;
        if (SERVER_TYPE[s.t] !== buf[0]) problems.push('server type ' + s.t + ' from ' + buf[0]);
        const again = readServer(encodeServer(s));
        if (s.t === 'bye') {
          if (again === null || again.t !== 'bye' || again.code !== s.code || s.reason.length > 64) problems.push('bye ' + Array.from(buf).join(','));
        } else if (!same(again, s)) problems.push('server ' + s.t + ' does not re-encode: ' + Array.from(buf).join(','));
      }
      if (c !== null && s !== null) problems.push('both directions accepted ' + Array.from(buf).join(','));
    }
    expect(problems).toEqual([]);
    expect(accepted).toBeGreaterThan(1500); // the fuzz really reaches the decoders' accepting paths
  });
});

describe('HELLO', () => {
  it('accepts the ticket and the resume shapes, keeping only the known fields', () => {
    expect(readHello(JSON.stringify({ t: 'hello', proto: 1, codec: { fuseyard: 1 }, ticket: 'abc.def' }))).toEqual({
      t: 'hello',
      proto: 1,
      codec: { fuseyard: 1 },
      ticket: 'abc.def',
    });
    expect(readHello(JSON.stringify({ t: 'hello', proto: 1, codec: { bellwick: 2, fuseyard: 3 }, resume: 'tok', extra: [1, 2] }))).toEqual({
      t: 'hello',
      proto: 1,
      codec: { bellwick: 2, fuseyard: 3 },
      resume: 'tok',
    });
    // Codec entries of the wrong type, or for other games, are dropped.
    expect(readHello(JSON.stringify({ t: 'hello', proto: 1, codec: { fuseyard: '1', lamplight: 4 }, ticket: 'x' }))).toEqual({
      t: 'hello',
      proto: 1,
      codec: {},
      ticket: 'x',
    });
    expect(readHello(JSON.stringify({ t: 'hello', proto: 1, codec: {}, ticket: 'x'.repeat(400) }))).not.toBeNull();
    expect(readHello(JSON.stringify({ t: 'hello', proto: 1, codec: {}, resume: 'r'.repeat(64) }))).not.toBeNull();
  });

  it('rejects junk, wrong types and oversize text', () => {
    const base = { t: 'hello', proto: 1, codec: { fuseyard: 1 } };
    const bad: [string, string][] = [
      ['empty', ''],
      ['not json', 'hello'],
      ['cut json', '{"t":"hello"'],
      ['null', 'null'],
      ['number', '1'],
      ['string', '"hello"'],
      ['array', '[]'],
      ['empty object', '{}'],
      ['wrong t', JSON.stringify({ ...base, t: 'hi', ticket: 'x' })],
      ['proto as string', JSON.stringify({ ...base, proto: '1', ticket: 'x' })],
      ['no codec', JSON.stringify({ t: 'hello', proto: 1, ticket: 'x' })],
      ['codec null', JSON.stringify({ ...base, codec: null, ticket: 'x' })],
      ['codec string', JSON.stringify({ ...base, codec: 'fuseyard', ticket: 'x' })],
      ['neither ticket nor resume', JSON.stringify(base)],
      ['ticket number', JSON.stringify({ ...base, ticket: 5 })],
      ['ticket empty', JSON.stringify({ ...base, ticket: '' })],
      ['ticket too long', JSON.stringify({ ...base, ticket: 'x'.repeat(401) })],
      ['resume number', JSON.stringify({ ...base, resume: 5 })],
      ['resume empty', JSON.stringify({ ...base, resume: '' })],
      ['resume too long', JSON.stringify({ ...base, resume: 'r'.repeat(65) })],
      ['oversize', JSON.stringify({ ...base, ticket: 'x', pad: ' '.repeat(MAX_HELLO) })],
    ];
    for (const [name, text] of bad) expect(readHello(text), name).toBeNull();
  });
});

describe('extendTick', () => {
  it('extends a wire u16 tick to the full tick nearest the reference, across the wrap', () => {
    expect(extendTick(4, 65530)).toBe(65540);
    expect(extendTick(65530, 65540)).toBe(65530);
    expect(extendTick(0, 0xffff)).toBe(0x10000);
    expect(extendTick(0xffff, 0x10000)).toBe(0xffff);
    expect(extendTick(0x1234, 0x51234)).toBe(0x51234);
    expect(extendTick(0x1235, 0x51234)).toBe(0x51235);
    expect(extendTick(0x1233, 0x51234)).toBe(0x51233);
    // Half the circle back is the furthest it reaches.
    expect(extendTick((0x40000 + 0x8000) & 0xffff, 0x40000)).toBe(0x40000 - 0x8000);
    expect(extendTick((0x40000 + 0x7fff) & 0xffff, 0x40000)).toBe(0x40000 + 0x7fff);
  });

  it('recovers any full tick within ±32767 of the reference', () => {
    const next = seeded(0x71c);
    for (let i = 0; i < 20000; i += 1) {
      const ref = (next() >>> 0) % 0xfff00000;
      const full = Math.max(0, ref + ((next() % 65535) - 32767));
      expect(extendTick(full & 0xffff, ref)).toBe(full);
    }
  });
});
