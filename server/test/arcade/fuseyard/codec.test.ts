/**
 * Fuseyard's codec (docs/arcade/fuseyard.md §3.3, §12 "fuseyard.codec"): every message round-trips;
 * FRAME without events ≤ 32 B, UP ≤ 9 B at n = 2, keyframe ≤ 512 B with all pools full and ≤ 160 B
 * at round start, WELCOME ≤ 64 B; fuzzed bytes are rejected and never throw.
 */
import { describe, expect, it } from 'vitest';
import { ByteReader, ByteWriter } from '../../../src/arcade/core/bytes.js';
import { readServer, writeFrame, writeUp, writeWelcome } from '../../../src/arcade/core/net/lane.js';
import { xorshift32 } from '../../../src/arcade/core/rng.js';
import {
  CFG_BYTES,
  KEYFRAME_MAX,
  decodeCfg,
  decodeKeyframe,
  decodeResult,
  decodeUp,
  encodeCfg,
  encodeKeyframe,
  encodeResult,
  encodeSnapshot,
  encodeUp,
  sanitizeInput,
  worldFromMatch,
} from '../../../src/arcade/core/fuseyard/codec.js';
import { BUDGET } from '../../../src/arcade/core/fuseyard/budget.js';
import { ARENAS } from '../../../src/arcade/core/fuseyard/arenas.js';
import { CELLS, Cell, Item, MAX_BOMBS, Phase, REMOTE, inputByte } from '../../../src/arcade/core/fuseyard/rules.js';
import { applySnapshot, createWorld } from '../../../src/arcade/core/fuseyard/view.js';
import { createMatch } from '../../../src/arcade/core/fuseyard/sim.js';
import { addBomb, place, scenario, xy } from './helpers.js';

const keyBytes = (m: ReturnType<typeof scenario>, passers = true): Uint8Array =>
  encodeKeyframe(worldFromMatch(m, createWorld(m.config.fighters)), new ByteWriter(1024), passers).copy();

describe('UP', () => {
  it('is 9 B on the wire at n = 2 and round-trips', () => {
    const payload = encodeUp(new Uint8Array([inputByte(2, 1, false, false), inputByte(3, 0, true, false)]), 2);
    expect(payload.length).toBe(3);
    expect(writeUp(7, 1, 0, payload).length).toBe(BUDGET.upMax);
    expect(Array.from(decodeUp(payload)!)).toEqual([inputByte(2, 1, false, false), inputByte(3, 0, true, false)]);
  });
  it('rejects n outside 1–6 or a wrong length, and reads a bad direction as 0', () => {
    expect(decodeUp(new Uint8Array([0]))).toBeNull();
    expect(decodeUp(new Uint8Array([7, 1, 1, 1, 1, 1, 1, 1]))).toBeNull();
    expect(decodeUp(new Uint8Array([2, 1]))).toBeNull();
    expect(sanitizeInput(0b11_101_110)).toBe(0b11_000_000);
    expect(sanitizeInput(inputByte(4, 4, true, true))).toBe(inputByte(4, 4, true, true));
  });
});

describe('WELCOME cfg', () => {
  it('is 5 B, ≤ 64 B in its envelope, and round-trips every option', () => {
    for (const mode of ['brawl', 'quickfire'] as const)
      for (const arena of ['rotation', 'yard', 'depot'] as const)
        for (const fighters of [2, 3, 4] as const)
          for (const winsNeeded of [2, 3, 5] as const) {
            const c = { mode, arena, fighters, winsNeeded, botLevel: 2 as const };
            const b = encodeCfg(c);
            expect(b.length).toBe(CFG_BYTES);
            expect(decodeCfg(b)).toEqual(c);
          }
    const welcome = writeWelcome({ proto: 1, game: 1, codec: 1, slot: 0, queued: false, tick: 1, tickHz: 30, divisor: 2, lastEvSeq: 0, resumeToken: new Uint8Array(32), cfg: encodeCfg({ mode: 'brawl', arena: 'rotation', fighters: 4, winsNeeded: 3, botLevel: 1 }) });
    expect(welcome.length).toBeLessThanOrEqual(64);
    expect(decodeCfg(new Uint8Array([2, 0, 4, 3, 1]))).toBeNull();
    expect(decodeCfg(new Uint8Array([0, 9, 4, 3, 1]))).toBeNull();
    expect(decodeCfg(new Uint8Array([0, 0, 5, 3, 1]))).toBeNull();
    expect(decodeCfg(new Uint8Array([0, 0, 4, 4, 1]))).toBeNull();
  });
});

describe('snapshot and FRAME', () => {
  it('is 22 B for 4 fighters, FRAME without events ≤ 32 B, +6 B per sliding bomb', () => {
    const m = scenario({ fighters: 4 });
    const w = new ByteWriter(256);
    encodeSnapshot(m, w);
    expect(w.length).toBe(BUDGET.snapshotMax);
    const frame = writeFrame({ frameSeq: 1, tick: 100, ackUp: 3, divisor: 2, lagging: false, snapshot: w.copy(), events: null });
    expect(frame.length).toBeLessThanOrEqual(32);
    const b = addBomb(m, 0, xy(3, 3));
    b.slideDir = 2;
    b.slideSpeed = 16;
    expect(encodeSnapshot(m, w.reset()).length).toBe(BUDGET.snapshotMax + 6);
    const parsed = readServer(frame);
    expect(parsed?.t).toBe('frame');
  });
  it('round-trips into the view', () => {
    const m = scenario({ fighters: 3 });
    place(m, 1, xy(5, 3)).moving = true;
    const world = createWorld(3);
    world.ready = true;
    const bytes = encodeSnapshot(m, new ByteWriter(256)).copy();
    expect(applySnapshot(world, new ByteReader(bytes))).toBe(true);
    expect(world.fight[1]!.x).toBe(m.current.fighters[1]!.x);
    expect(world.fight[1]!.moving).toBe(true);
    expect(world.fight[2]!.alive).toBe(true);
  });
});

describe('KEYFRAME', () => {
  it('is ≤ 160 B at round start', () => {
    for (const fighters of [2, 3, 4] as const) {
      const m = createMatch({ mode: 'brawl', arena: 'rotation', fighters, winsNeeded: 3, botLevel: 1, seed: 5 }, []);
      expect(keyBytes(m as never).length).toBeLessThanOrEqual(160);
    }
  });

  it('is ≤ 512 B with every pool full, and round-trips', () => {
    const m = scenario({ fighters: 4 });
    const r = m.current;
    // 21 items (some pending), 32 bombs, a full flame map, 5 warnings.
    let items = 0;
    for (let c = 16; c < CELLS && items < 21; c += 1) {
      if (r.cells[c] !== Cell.Floor) continue;
      if (items % 3 === 0) r.pendingItem[c] = Item.SpareFuse;
      else r.items[c] = Item.WideSpark;
      items += 1;
    }
    let bombs = 0;
    for (let c = 30; c < CELLS && bombs < MAX_BOMBS; c += 1) {
      if (r.cells[c] !== Cell.Floor || r.items[c] || r.pendingItem[c]) continue;
      const b = addBomb(m, bombs % 4, c, { fuse: bombs % 2 ? REMOTE : 40, range: 8, passers: 15 });
      b.slideDir = (bombs % 5) as 0;
      b.slideSpeed = b.slideDir ? 16 : 0;
      bombs += 1;
    }
    for (let c = 0; c < CELLS; c += 1) if (r.cells[c] === Cell.Floor) r.flame[c] = 1 + (c % 14);
    for (let k = 0; k < 5; k += 1) r.warn[16 + k * 2] = 30 - k * 6;
    r.phase = Phase.Frozen;
    r.holdTicks = 77;
    r.holdWinner = 2;
    const bytes = keyBytes(m);
    expect(bytes.length).toBeLessThanOrEqual(KEYFRAME_MAX);
    expect(bytes.length).toBeGreaterThan(450);
    const world = createWorld(4);
    expect(decodeKeyframe(new ByteReader(bytes), m.tick, world)).toBe(true);
    expect(encodeKeyframe(world, new ByteWriter(1024)).copy()).toEqual(bytes);
  });

  it('round-trips a running match', () => {
    const m = createMatch({ mode: 'brawl', arena: 'garden', fighters: 4, winsNeeded: 3, botLevel: 2, seed: 9 }, []);
    const bytes = keyBytes(m as never);
    const world = createWorld(4);
    expect(decodeKeyframe(new ByteReader(bytes), m.tick, world)).toBe(true);
    expect(world.arena).toBe(ARENAS.findIndex((a) => a.id === 'garden'));
    expect(encodeKeyframe(world, new ByteWriter(1024)).copy()).toEqual(bytes);
  });
});

describe('result body', () => {
  it('is 16 B and round-trips', () => {
    const m = scenario({ fighters: 4 });
    m.scores[2] = 3;
    m.current.fighters[1]!.kills = 4;
    const body = encodeResult(m);
    expect(body.length).toBe(16);
    expect(decodeResult(new ByteReader(body))![2]!.roundWins).toBe(3);
    expect(decodeResult(new ByteReader(body))![1]!.kills).toBe(4);
    expect(decodeResult(new ByteReader(body.subarray(0, 10)))).toBeNull();
  });
});

describe('fuzz', () => {
  it('random bytes never throw and are mostly rejected', () => {
    let s = 0x13579bdf;
    const rnd = (): number => (s = xorshift32(s));
    let accepted = 0;
    for (let i = 0; i < 4000; i += 1) {
      const len = rnd() % 520;
      const b = new Uint8Array(len);
      for (let k = 0; k < len; k += 1) b[k] = rnd() & 0xff;
      const world = createWorld(4);
      world.ready = true;
      expect(() => decodeKeyframe(new ByteReader(b), 100, world)).not.toThrow();
      expect(() => applySnapshot(world, new ByteReader(b))).not.toThrow();
      expect(() => decodeUp(b)).not.toThrow();
      expect(() => decodeCfg(b)).not.toThrow();
      if (decodeKeyframe(new ByteReader(b), 100, createWorld(4))) accepted += 1;
    }
    expect(accepted).toBeLessThan(40);
  });
});
