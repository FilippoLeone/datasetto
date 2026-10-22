/**
 * The shared core's byte layer (server/src/arcade/core/bytes.ts): little-endian writer and reader,
 * u16 serial numbers, base64url and UTF-8. Seeded data only, so every run sees the same bytes.
 */
import { describe, expect, it } from 'vitest';
import { ByteReader, ByteWriter, b64url, fromB64url, seqDelta, seqNewer, utf8Decode, utf8Encode } from '../../src/arcade/core/bytes.js';
import { xorshift32 } from '../../src/arcade/core/rng.js';

/** A seeded u32 source built on the core's xorshift32. */
const seeded = (seed: number): (() => number) => {
  let s = seed >>> 0 || 1;
  return () => (s = xorshift32(s));
};

const randomBytes = (next: () => number, n: number): Uint8Array => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = next() & 0xff;
  return out;
};

const VARINT_CASES: readonly [number, number[]][] = [
  [0, [0x00]],
  [1, [0x01]],
  [127, [0x7f]],
  [128, [0x80, 0x01]],
  [300, [0xac, 0x02]],
  [16383, [0xff, 0x7f]],
  [16384, [0x80, 0x80, 0x01]],
  [2 ** 21 - 1, [0xff, 0xff, 0x7f]],
  [2 ** 21, [0x80, 0x80, 0x80, 0x01]],
  [2 ** 28 - 1, [0xff, 0xff, 0xff, 0x7f]],
  [2 ** 28, [0x80, 0x80, 0x80, 0x80, 0x01]],
  [2 ** 32 - 1, [0xff, 0xff, 0xff, 0xff, 0x0f]],
];

describe('ByteWriter and ByteReader', () => {
  it('round-trips every fixed-width method at its edges, negatives included', () => {
    const u8s = [0, 1, 0x7f, 0x80, 0xfe, 0xff];
    const i8s = [-128, -127, -1, 0, 1, 126, 127];
    const u16s = [0, 1, 0xff, 0x100, 0x7fff, 0x8000, 0xfffe, 0xffff];
    const i16s = [-32768, -32767, -256, -1, 0, 1, 255, 32767];
    const u32s = [0, 1, 0xffff, 0x10000, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff];
    const w = new ByteWriter(128);
    for (const v of u8s) w.u8(v);
    for (const v of i8s) w.i8(v);
    for (const v of u16s) w.u16(v);
    for (const v of i16s) w.i16(v);
    for (const v of u32s) w.u32(v);
    expect(w.length).toBe(u8s.length + i8s.length + 2 * (u16s.length + i16s.length) + 4 * u32s.length);

    const r = new ByteReader(w.view());
    expect(u8s.map(() => r.u8())).toEqual(u8s);
    expect(i8s.map(() => r.i8())).toEqual(i8s);
    expect(u16s.map(() => r.u16())).toEqual(u16s);
    expect(i16s.map(() => r.i16())).toEqual(i16s);
    expect(u32s.map(() => r.u32())).toEqual(u32s);
    expect(r.ok).toBe(true);
    expect(r.remaining).toBe(0);
  });

  it('writes little-endian and masks unsigned values to their width', () => {
    const w = new ByteWriter(32).u16(0x1234).u32(0x12345678).i16(-2).i8(-1);
    expect(Array.from(w.view())).toEqual([0x34, 0x12, 0x78, 0x56, 0x34, 0x12, 0xfe, 0xff, 0xff]);

    const m = new ByteWriter(16).u8(0x1ff).u16(0x12345).u32(-1).u32(2 ** 32 + 5);
    const r = new ByteReader(m.view());
    expect([r.u8(), r.u16(), r.u32(), r.u32()]).toEqual([0xff, 0x2345, 0xffffffff, 5]);
  });

  it('round-trips a long seeded mix of every method', () => {
    const next = seeded(0xb17e5);
    type Op = { k: 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'varint'; v: number } | { k: 'bytes'; v: Uint8Array };
    const ops: Op[] = [];
    for (let i = 0; i < 2000; i += 1) {
      const x = next();
      switch (x % 7) {
        case 0: ops.push({ k: 'u8', v: next() & 0xff }); break;
        case 1: ops.push({ k: 'i8', v: (next() & 0xff) - 128 }); break;
        case 2: ops.push({ k: 'u16', v: next() & 0xffff }); break;
        case 3: ops.push({ k: 'i16', v: (next() & 0xffff) - 32768 }); break;
        case 4: ops.push({ k: 'u32', v: next() >>> 0 }); break;
        case 5: ops.push({ k: 'varint', v: next() >>> (next() % 32) }); break;
        default: ops.push({ k: 'bytes', v: randomBytes(next, next() % 9) });
      }
    }
    const w = new ByteWriter(2000 * 8);
    for (const op of ops) {
      if (op.k === 'bytes') w.bytes(op.v);
      else w[op.k](op.v);
    }
    const r = new ByteReader(w.copy());
    for (const op of ops) {
      if (op.k === 'bytes') expect(Array.from(r.bytes(op.v.length))).toEqual(Array.from(op.v));
      else expect(r[op.k]()).toBe(op.v);
    }
    expect(r.ok).toBe(true);
    expect(r.remaining).toBe(0);
  });

  it('encodes varints as LEB128 of 1 to 5 bytes and reads them back', () => {
    for (const [value, bytes] of VARINT_CASES) {
      const w = new ByteWriter(5).varint(value);
      expect(Array.from(w.view()), String(value)).toEqual(bytes);
      const r = new ByteReader(w.view());
      expect(r.varint()).toBe(value);
      expect(r.ok).toBe(true);
      expect(r.remaining).toBe(0);
    }
  });

  it('marks a varint over 5 bytes, or above 2^32 − 1, as bad', () => {
    const bad: number[][] = [
      [0x80, 0x80, 0x80, 0x80, 0x80, 0x00], // a sixth byte
      [0xff, 0xff, 0xff, 0xff, 0x8f, 0x00], // continuation bit on the fifth byte
      [0xff, 0xff, 0xff, 0xff, 0x10], // 2^32
      [0x80, 0x80, 0x80, 0x80, 0x1f], // above 2^32 − 1
      [0x80], // truncated
      [0xff, 0xff],
      [],
    ];
    for (const bytes of bad) {
      // Bytes after a complete-but-bad varint must not be handed out; a truncated one gets none
      // (they would complete it).
      const trailing = bytes.length >= 5 ? [0x07, 0x07] : [];
      const r = new ByteReader(Uint8Array.from([...bytes, ...trailing]));
      expect(r.varint(), JSON.stringify(bytes)).toBe(0);
      expect(r.ok).toBe(false);
      expect(r.remaining).toBe(0);
      expect(r.u8()).toBe(0); // the 0x07 after it is not handed out
    }
  });

  it('reading past the end sets ok to false and every later read returns 0', () => {
    const r = new ByteReader(Uint8Array.of(1, 2, 3));
    expect(r.u16()).toBe(0x0201);
    expect(r.ok).toBe(true);
    expect(r.remaining).toBe(1);
    expect(r.u16()).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.offset).toBe(3);
    // The third byte exists, but a bad reader hands nothing out any more.
    expect([r.u8(), r.i8(), r.u16(), r.i16(), r.u32(), r.varint()]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(r.bytes(1).length).toBe(0);
    expect(r.ok).toBe(false);
  });

  it('fails each method on its own when the bytes run out', () => {
    const cases: [Uint8Array, (r: ByteReader) => number][] = [
      [new Uint8Array(0), (r) => r.u8()],
      [new Uint8Array(0), (r) => r.i8()],
      [Uint8Array.of(0xff), (r) => r.u16()],
      [Uint8Array.of(0xff), (r) => r.i16()],
      [Uint8Array.of(0xff, 0xff, 0xff), (r) => r.u32()],
      [Uint8Array.of(0x80, 0x80), (r) => r.varint()],
      [Uint8Array.of(1, 2, 3, 4), (r) => r.bytes(5).length],
      [Uint8Array.of(1, 2, 3, 4), (r) => (r.skip(5), r.u8())],
      [Uint8Array.of(1, 2, 3, 4), (r) => (r.skip(-1), r.u8())],
      [Uint8Array.of(1, 2, 3, 4), (r) => r.bytes(-1).length],
    ];
    for (const [buf, read] of cases) {
      const r = new ByteReader(buf);
      expect(read(r)).toBe(0);
      expect(r.ok).toBe(false);
    }
  });

  it('reads only inside its offset and end window, clamped to the buffer', () => {
    const buf = Uint8Array.of(10, 11, 12, 13, 14, 15);
    const r = new ByteReader(buf, 2, 4);
    expect(r.remaining).toBe(2);
    expect([r.u8(), r.u8()]).toEqual([12, 13]);
    expect(r.u8()).toBe(0);
    expect(r.ok).toBe(false);

    expect(new ByteReader(buf, 10).remaining).toBe(0);
    expect(new ByteReader(buf, 4, 99).remaining).toBe(2);
    expect(new ByteReader(buf, -3).offset).toBe(0);
    // A reader over a subarray respects the view's own offset.
    const sub = new ByteReader(buf.subarray(3));
    expect(sub.u16()).toBe(13 | (14 << 8));
  });

  it('hands out bytes() as a view, with no copy', () => {
    const buf = Uint8Array.of(1, 2, 3, 4);
    const view = new ByteReader(buf).bytes(4);
    buf[0] = 99;
    expect(view[0]).toBe(99);
    const r = new ByteReader(buf);
    r.skip(1);
    expect(Array.from(r.rest())).toEqual([2, 3, 4]);
    expect(r.remaining).toBe(0);
    expect(r.ok).toBe(true);
  });

  it('throws a RangeError when a write passes the capacity', () => {
    expect(() => new ByteWriter(0).u8(1)).toThrow(RangeError);
    expect(() => new ByteWriter(0).i8(1)).toThrow(RangeError);
    expect(() => new ByteWriter(1).u16(1)).toThrow(RangeError);
    expect(() => new ByteWriter(1).i16(1)).toThrow(RangeError);
    expect(() => new ByteWriter(3).u32(1)).toThrow(RangeError);
    expect(() => new ByteWriter(1).varint(128)).toThrow(RangeError);
    expect(() => new ByteWriter(4).varint(2 ** 32 - 1)).toThrow(RangeError);
    expect(() => new ByteWriter(2).bytes(new Uint8Array(3))).toThrow(RangeError);

    const w = new ByteWriter(3).u16(1);
    expect(() => w.u16(2)).toThrow(RangeError);
    expect(w.length).toBe(2); // a refused fixed-width write leaves the writer as it was
    w.u8(9);
    expect(w.length).toBe(3);
    expect(w.free).toBe(0);
  });

  it('view() shares the buffer until reset(); copy() does not', () => {
    const w = new ByteWriter(4).u16(0xaaaa);
    const view = w.view();
    const copy = w.copy();
    w.reset().u16(0x5555);
    expect(w.length).toBe(2);
    expect(Array.from(view)).toEqual([0x55, 0x55]);
    expect(Array.from(copy)).toEqual([0xaa, 0xaa]);
  });
});

describe('u16 serial numbers', () => {
  it('compares across the wrap', () => {
    expect(seqNewer(1, 0)).toBe(true);
    expect(seqNewer(0, 1)).toBe(false);
    expect(seqNewer(0, 0xffff)).toBe(true);
    expect(seqNewer(0xffff, 0)).toBe(false);
    expect(seqNewer(5, 0xfff0)).toBe(true);
    expect(seqNewer(7, 7)).toBe(false);
    expect(seqNewer(0x7fff, 0)).toBe(true);
    // Exactly half the circle apart: neither is newer.
    expect(seqNewer(0x8000, 0)).toBe(false);
    expect(seqNewer(0, 0x8000)).toBe(false);

    expect(seqDelta(0, 0xffff)).toBe(1);
    expect(seqDelta(0xffff, 0)).toBe(-1);
    expect(seqDelta(10, 65530)).toBe(16);
    expect(seqDelta(65530, 10)).toBe(-16);
    expect(seqDelta(0x7fff, 0)).toBe(32767);
    expect(seqDelta(0x8000, 0)).toBe(-32768);
    expect(seqDelta(1234, 1234)).toBe(0);
  });

  it('agrees with plain arithmetic for seeded pairs', () => {
    const next = seeded(0x5e9);
    for (let i = 0; i < 20000; i += 1) {
      const a = next() & 0xffff;
      const b = next() & 0xffff;
      const d = seqDelta(a, b);
      expect(d >= -32768 && d <= 32767).toBe(true);
      expect((b + d) & 0xffff).toBe(a);
      expect(seqNewer(a, b)).toBe(d > 0);
    }
  });
});

describe('base64url', () => {
  it('round-trips seeded byte arrays of every length from 0 to 40', () => {
    const next = seeded(0xb64);
    for (let len = 0; len <= 40; len += 1) {
      for (let k = 0; k < 12; k += 1) {
        const bytes = randomBytes(next, len);
        const s = b64url(bytes);
        expect(s).toBe(Buffer.from(bytes).toString('base64url'));
        expect(s).toMatch(/^[A-Za-z0-9_-]*$/);
        const back = fromB64url(s);
        expect(back).not.toBeNull();
        expect(Array.from(back as Uint8Array)).toEqual(Array.from(bytes));
      }
    }
  });

  it('returns null for characters outside the alphabet and for a length of 4n + 1', () => {
    for (const bad of ['+', '/', '=', ' ', '.', '\n', 'é', 'Ā', '\u007f']) {
      expect(fromB64url('AAA' + bad), JSON.stringify(bad)).toBeNull();
      expect(fromB64url(bad + 'AAAAAA'), JSON.stringify(bad)).toBeNull();
    }
    expect(fromB64url('AA==')).toBeNull(); // padding is not part of this codec
    expect(fromB64url('😀AA')).toBeNull();
    for (const s of ['A', 'AAAAA', 'AAAAAAAAA']) expect(fromB64url(s), s).toBeNull();
    expect(Array.from(fromB64url('') as Uint8Array)).toEqual([]);
    expect(Array.from(fromB64url('AA') as Uint8Array)).toEqual([0]);
    expect(Array.from(fromB64url('AAA') as Uint8Array)).toEqual([0, 0]);
  });
});

describe('UTF-8', () => {
  const samples = [
    '',
    'hello, world',
    'café crème brûlée, àéîõü ñ ß Łódź',
    '漢字かな Русский עברית',
    '😀 👍🏽 👨‍👩‍👧 🇳🇱',
    '\u0000\u007f\u0080߿ࠀ￿𐀀􏿿',
  ];

  it('round-trips ASCII, accents, other scripts and emoji, byte-identical to Node', () => {
    for (const s of samples) {
      const bytes = utf8Encode(s);
      expect(Array.from(bytes)).toEqual(Array.from(Buffer.from(s, 'utf8')));
      expect(utf8Decode(bytes)).toBe(s);
    }
  });

  it('encodes lone surrogates as U+FFFD, like Node', () => {
    for (const s of ['a\ud800b', '\udc00', 'x\ud800', '\ud800𐀀', '\udfff\ud800']) {
      expect(Array.from(utf8Encode(s)), JSON.stringify(s)).toEqual(Array.from(Buffer.from(s, 'utf8')));
    }
    const next = seeded(0x7e57);
    for (let i = 0; i < 2000; i += 1) {
      const units: number[] = [];
      const n = next() % 12;
      for (let j = 0; j < n; j += 1) {
        const r = next() % 4;
        units.push(r === 0 ? next() & 0x7f : r === 1 ? 0xd800 + (next() & 0x7ff) : next() & 0xffff);
      }
      const s = String.fromCharCode(...units);
      expect(Array.from(utf8Encode(s))).toEqual(Array.from(Buffer.from(s, 'utf8')));
    }
  });

  it('decodes malformed bytes to U+FFFD without eating the bytes that follow', () => {
    const F = '�';
    expect(utf8Decode(Uint8Array.of(0xff))).toBe(F);
    expect(utf8Decode(Uint8Array.of(0xc3))).toBe(F);
    expect(utf8Decode(Uint8Array.of(0xc3, 0x41))).toBe(F + 'A');
    expect(utf8Decode(Uint8Array.of(0xe2, 0x82, 0x41))).toBe(F + 'A');
    expect(utf8Decode(Uint8Array.of(0xc0, 0x80))).toBe(F + F); // overlong
    expect(utf8Decode(Uint8Array.of(0xed, 0xa0, 0x80, 0x41))).toBe(F + F + F + 'A'); // an encoded surrogate
    expect(utf8Decode(Uint8Array.of(0xf4, 0x90, 0x80, 0x80))).toBe(F + F + F + F); // above U+10FFFF
  });

  it('decodes any byte string exactly like the WHATWG decoder, and never throws', () => {
    const next = seeded(0xdec0de);
    const ref = new TextDecoder('utf-8');
    const lead = [0x41, 0x80, 0xbf, 0xc2, 0xdf, 0xe0, 0xed, 0xef, 0xf0, 0xf4, 0xf5, 0xff, 0xa0, 0x9f, 0x90, 0x8f];
    for (let i = 0; i < 20000; i += 1) {
      const n = next() % 10;
      const bytes = new Uint8Array(n);
      // Half the bytes come from the interesting boundaries, so short sequences hit every branch.
      for (let j = 0; j < n; j += 1) bytes[j] = next() % 2 === 0 ? (lead[next() % lead.length] as number) : next() & 0xff;
      expect(utf8Decode(bytes)).toBe(ref.decode(bytes));
    }
  });
});
