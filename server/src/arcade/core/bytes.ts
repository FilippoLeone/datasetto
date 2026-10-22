/**
 * Little-endian byte writing and reading for every Arcade codec (platform.md §5.1).
 *
 * `ByteWriter` writes into a preallocated buffer and throws a RangeError past its capacity: that is
 * an encoder bug, never bad input. `ByteReader` never throws: a read past the end marks it not `ok`
 * and returns 0 (or an empty array), so decoders check `ok` once at the end.
 */

export class ByteWriter {
  private readonly buf: Uint8Array;
  private readonly dv: DataView;
  private pos = 0;

  constructor(capacity: number) {
    this.buf = new Uint8Array(capacity);
    this.dv = new DataView(this.buf.buffer);
  }

  private room(n: number): number {
    const at = this.pos;
    if (at + n > this.buf.length) throw new RangeError('ByteWriter: capacity ' + this.buf.length + ' exceeded');
    this.pos = at + n;
    return at;
  }

  u8(v: number): this {
    this.buf[this.room(1)] = v & 0xff;
    return this;
  }

  i8(v: number): this {
    this.dv.setInt8(this.room(1), v);
    return this;
  }

  u16(v: number): this {
    this.dv.setUint16(this.room(2), v & 0xffff, true);
    return this;
  }

  i16(v: number): this {
    this.dv.setInt16(this.room(2), v, true);
    return this;
  }

  u32(v: number): this {
    this.dv.setUint32(this.room(4), v >>> 0, true);
    return this;
  }

  /** Unsigned LEB128 of a u32 (1–5 bytes). */
  varint(v: number): this {
    let x = v >>> 0;
    for (let i = 0; i < 5; i += 1) {
      if (x < 0x80) {
        this.buf[this.room(1)] = x;
        return this;
      }
      this.buf[this.room(1)] = (x & 0x7f) | 0x80;
      x >>>= 7;
    }
    return this;
  }

  bytes(b: Uint8Array): this {
    const at = this.room(b.length);
    this.buf.set(b, at);
    return this;
  }

  get length(): number {
    return this.pos;
  }

  /** Bytes still free. */
  get free(): number {
    return this.buf.length - this.pos;
  }

  reset(): this {
    this.pos = 0;
    return this;
  }

  /** The written bytes without a copy; valid until the next `reset()`. */
  view(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }

  copy(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

export class ByteReader {
  private readonly buf: Uint8Array;
  private readonly dv: DataView;
  private readonly end: number;
  private pos: number;
  private bad = false;

  constructor(buf: Uint8Array, offset = 0, end: number = buf.length) {
    this.buf = buf;
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.end = Math.max(0, Math.min(end, buf.length));
    this.pos = Math.max(0, Math.min(offset, this.end));
  }

  /** False after any read past the end; later reads return 0. */
  get ok(): boolean {
    return !this.bad;
  }

  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.bad ? 0 : this.end - this.pos;
  }

  private take(n: number): number {
    if (this.bad || n < 0 || this.pos + n > this.end) {
      this.bad = true;
      this.pos = this.end;
      return -1;
    }
    const at = this.pos;
    this.pos = at + n;
    return at;
  }

  u8(): number {
    const at = this.take(1);
    return at < 0 ? 0 : (this.buf[at] as number);
  }

  i8(): number {
    const at = this.take(1);
    return at < 0 ? 0 : this.dv.getInt8(at);
  }

  u16(): number {
    const at = this.take(2);
    return at < 0 ? 0 : this.dv.getUint16(at, true);
  }

  i16(): number {
    const at = this.take(2);
    return at < 0 ? 0 : this.dv.getInt16(at, true);
  }

  u32(): number {
    const at = this.take(4);
    return at < 0 ? 0 : this.dv.getUint32(at, true);
  }

  /** Unsigned LEB128 of at most 5 bytes; anything longer or above 2^32 − 1 marks the reader bad. */
  varint(): number {
    let value = 0;
    let shift = 0;
    for (let i = 0; i < 5; i += 1) {
      const at = this.take(1);
      if (at < 0) return 0;
      const byte = this.buf[at] as number;
      if (i === 4 && byte > 0x0f) {
        this.bad = true;
        return 0;
      }
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
      shift += 7;
    }
    this.bad = true;
    return 0;
  }

  /** `n` bytes as a view (no copy), or an empty array past the end. */
  bytes(n: number): Uint8Array {
    const at = this.take(n);
    return at < 0 ? new Uint8Array(0) : this.buf.subarray(at, at + n);
  }

  skip(n: number): void {
    this.take(n);
  }

  /** Everything left, as a view. */
  rest(): Uint8Array {
    return this.bytes(this.remaining);
  }
}

/** Is u16 serial number `a` newer than `b` (wrap-aware)? */
export const seqNewer = (a: number, b: number): boolean => {
  const d = (a - b) & 0xffff;
  return d !== 0 && d < 0x8000;
};

/** `a − b` for u16 serial numbers, signed, in [−32768, 32767]. */
export const seqDelta = (a: number, b: number): number => (((a - b + 0x8000) & 0xffff) - 0x8000);

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX: readonly number[] = ((): number[] => {
  const table: number[] = [];
  for (let i = 0; i < 128; i += 1) table.push(-1);
  for (let i = 0; i < B64.length; i += 1) table[B64.charCodeAt(i)] = i;
  return table;
})();

/** base64url without padding. */
export const b64url = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0;
    const c = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >>> 18) & 63];
    out += B64[(n >>> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >>> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
};

/** Decode base64url (no padding); null on any character outside the alphabet or a bad length. */
export const fromB64url = (s: string): Uint8Array | null => {
  if (s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let n = 0;
    let count = 0;
    for (let j = 0; j < 4; j += 1) {
      n <<= 6;
      if (i + j < s.length) {
        const code = s.charCodeAt(i + j);
        const v = code < 128 ? (B64_INDEX[code] as number) : -1;
        if (v < 0) return null;
        n |= v;
        count += 1;
      }
    }
    out[o++] = (n >>> 16) & 0xff;
    if (count > 2) out[o++] = (n >>> 8) & 0xff;
    if (count > 3) out[o++] = n & 0xff;
  }
  return out;
};

/** UTF-8 encode (core has no TextEncoder). Lone surrogates become U+FFFD. */
export const utf8Encode = (s: string): Uint8Array => {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i += 1;
      } else c = 0xfffd;
    } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
};

/**
 * UTF-8 decode; malformed sequences become U+FFFD, exactly as the WHATWG decoder does: overlong
 * forms, encoded surrogates and values above U+10FFFF are refused, and a broken sequence is one
 * U+FFFD with the byte that broke it read again (so it never swallows the ASCII after it).
 */
export const utf8Decode = (b: Uint8Array): string => {
  let out = '';
  let cp = 0;
  let need = 0;
  let lower = 0x80;
  let upper = 0xbf;
  for (let i = 0; i < b.length; i += 1) {
    const c = b[i] as number;
    if (need === 0) {
      if (c < 0x80) out += String.fromCharCode(c);
      else if (c >= 0xc2 && c <= 0xdf) {
        need = 1;
        cp = c & 0x1f;
      } else if (c >= 0xe0 && c <= 0xef) {
        if (c === 0xe0) lower = 0xa0;
        if (c === 0xed) upper = 0x9f;
        need = 2;
        cp = c & 0x0f;
      } else if (c >= 0xf0 && c <= 0xf4) {
        if (c === 0xf0) lower = 0x90;
        if (c === 0xf4) upper = 0x8f;
        need = 3;
        cp = c & 0x07;
      } else out += '�';
    } else if (c < lower || c > upper) {
      need = 0;
      lower = 0x80;
      upper = 0xbf;
      out += '�';
      i -= 1;
    } else {
      lower = 0x80;
      upper = 0xbf;
      cp = (cp << 6) | (c & 0x3f);
      need -= 1;
      if (need === 0) out += String.fromCodePoint(cp);
    }
  }
  return need === 0 ? out : out + '�';
};
