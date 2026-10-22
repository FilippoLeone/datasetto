/**
 * The event-block walker (server/src/arcade/core/net/events.ts): game events and the platform kinds
 * SeatState, Notice and At, with the tick each event happened at.
 */
import { describe, expect, it } from 'vitest';
import { ByteReader, ByteWriter } from '../../src/arcade/core/bytes.js';
import { PEV, PEV_MIN, forEachEvent, writeAt, writeNotice, writeSeatState, type PlatformEvent } from '../../src/arcade/core/net/events.js';
import { readServer, writeFrame, type EventBlock } from '../../src/arcade/core/net/lane.js';

/** A small game codec for the tests: 0x01 {u8}, 0x02 {u16}, 0x10 {}. */
const GAME = { One: 0x01, Two: 0x02, Bare: 0x10 } as const;

type Seen = { k: 'game'; kind: number; arg: number; tick: number } | { k: 'platform'; e: PlatformEvent; tick: number };

const walk = (bytes: Uint8Array, count: number, tick: number, refuse?: (kind: number, arg: number) => boolean) => {
  const seen: Seen[] = [];
  const block: EventBlock = { count, r: new ByteReader(bytes), tick };
  const ok = forEachEvent(
    block,
    (kind, r, t) => {
      let arg: number;
      if (kind === GAME.One) arg = r.u8();
      else if (kind === GAME.Two) arg = r.u16();
      else if (kind === GAME.Bare) arg = 0;
      else return false;
      if (!r.ok) return false;
      if (refuse?.(kind, arg)) return false;
      seen.push({ k: 'game', kind, arg, tick: t });
      return true;
    },
    (e, t) => seen.push({ k: 'platform', e, tick: t }),
  );
  return { ok, seen };
};

/** One block with every kind: 7 events. */
const sampleBlock = (): Uint8Array => {
  const w = new ByteWriter(64);
  w.u8(GAME.One).u8(5);
  writeAt(w, 3);
  w.u8(GAME.Two).u16(0x1234);
  writeSeatState(w, 1, 2);
  writeNotice(w, 4);
  writeAt(w, 0);
  w.u8(GAME.Bare);
  return w.copy();
};

describe('forEachEvent', () => {
  it('walks game and platform events in order, with At setting tick = block.tick − back', () => {
    const { ok, seen } = walk(sampleBlock(), 7, 1000);
    expect(ok).toBe(true);
    expect(seen).toEqual([
      { k: 'game', kind: GAME.One, arg: 5, tick: 1000 },
      { k: 'game', kind: GAME.Two, arg: 0x1234, tick: 997 },
      { k: 'platform', e: { k: 'seat', slot: 1, state: 2 }, tick: 997 },
      { k: 'platform', e: { k: 'notice', code: 4 }, tick: 997 },
      { k: 'game', kind: GAME.Bare, arg: 0, tick: 1000 },
    ]);
  });

  it('treats At as absolute from the block tick, not cumulative', () => {
    const w = new ByteWriter(16);
    writeAt(w, 5);
    writeAt(w, 2);
    w.u8(GAME.One).u8(9);
    const { ok, seen } = walk(w.copy(), 3, 500);
    expect(ok).toBe(true);
    expect(seen).toEqual([{ k: 'game', kind: GAME.One, arg: 9, tick: 498 }]);
    // writeAt clamps its argument to a byte.
    const c = new ByteWriter(4);
    writeAt(c, 999);
    writeAt(c, -4);
    expect(Array.from(c.view())).toEqual([PEV.At, 255, PEV.At, 0]);
  });

  it('reports every seat state and notice code', () => {
    const w = new ByteWriter(32);
    for (const state of [0, 1, 2, 3] as const) writeSeatState(w, state + 4, state);
    writeNotice(w, 0);
    writeNotice(w, 255);
    const { ok, seen } = walk(w.copy(), 6, 7);
    expect(ok).toBe(true);
    expect(seen.map((s) => (s.k === 'platform' ? s.e : null))).toEqual([
      { k: 'seat', slot: 4, state: 0 },
      { k: 'seat', slot: 5, state: 1 },
      { k: 'seat', slot: 6, state: 2 },
      { k: 'seat', slot: 7, state: 3 },
      { k: 'notice', code: 0 },
      { k: 'notice', code: 255 },
    ]);
  });

  it('an empty block is fine and calls nothing', () => {
    expect(walk(new Uint8Array(0), 0, 1)).toEqual({ ok: true, seen: [] });
  });

  it('stops and returns false on every unknown reserved kind (0xF3 to 0xFF)', () => {
    expect(PEV_MIN).toBe(0xf0);
    for (let kind = 0xf3; kind <= 0xff; kind += 1) {
      const w = new ByteWriter(8).u8(GAME.One).u8(1).u8(kind).u8(0).u8(0).u8(GAME.One).u8(2);
      const { ok, seen } = walk(w.copy(), 3, 10);
      expect(ok, kind.toString(16)).toBe(false);
      expect(seen).toEqual([{ k: 'game', kind: GAME.One, arg: 1, tick: 10 }]);
    }
  });

  it('stops and returns false when the game callback refuses an event', () => {
    // An unknown game kind.
    const unknown = new ByteWriter(8).u8(GAME.One).u8(1).u8(0x33).u8(GAME.One).u8(2).copy();
    const a = walk(unknown, 3, 10);
    expect(a.ok).toBe(false);
    expect(a.seen.length).toBe(1);
    // A known kind the game rejects (say, a bad length or value).
    const b = walk(sampleBlock(), 7, 1000, (kind) => kind === GAME.Two);
    expect(b.ok).toBe(false);
    expect(b.seen).toEqual([{ k: 'game', kind: GAME.One, arg: 5, tick: 1000 }]);
  });

  it('returns false when a seat state is out of range', () => {
    const w = new ByteWriter(8).u8(PEV.SeatState).u8(1).u8(4).u8(GAME.Bare);
    const { ok, seen } = walk(w.copy(), 2, 1);
    expect(ok).toBe(false);
    expect(seen).toEqual([]);
  });

  it('returns false on any truncation, and never reports a half-read event', () => {
    const full = sampleBlock();
    const complete = walk(full, 7, 1000).seen;
    for (let k = 0; k < full.length; k += 1) {
      const { ok, seen } = walk(full.subarray(0, k), 7, 1000);
      expect(ok, 'cut at ' + k).toBe(false);
      // Whatever was reported is a prefix of the full walk.
      expect(seen).toEqual(complete.slice(0, seen.length));
    }
    // A count that promises more events than the bytes hold.
    expect(walk(full, 8, 1000).ok).toBe(false);
  });

  it('walks the event block of a decoded FRAME', () => {
    const events = sampleBlock();
    const msg = readServer(writeFrame({ frameSeq: 1, tick: 1000, ackUp: 0, divisor: 2, snapshot: Uint8Array.of(1, 2, 3), events: { count: 7, bytes: events } }));
    expect(msg !== null && msg.t === 'frame').toBe(true);
    if (msg === null || msg.t !== 'frame' || msg.events === null) return;
    const { ok, seen } = walk(msg.events.bytes, msg.events.count, msg.tick);
    expect(ok).toBe(true);
    expect(seen).toEqual(walk(events, 7, 1000).seen);
  });
});
