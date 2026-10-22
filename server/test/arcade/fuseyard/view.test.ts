/**
 * The client's world model against the server (docs/arcade/fuseyard.md §12 "fuseyard.view" and
 * "fuseyard.hidden"). A runtime is stepped with bots and random human inputs and seat changes; a
 * stand-in sender merges ticks into FRAMEs with At marks at random divisors, skips slots, and sends
 * keyframes at random points and on rekeys. After every message the client's world, encoded as a
 * keyframe (passer masks aside, which events cannot carry), equals the server's public view.
 *
 * The same run checks that no item code reaches the client for a cell before its BlockBroken.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ByteReader, ByteWriter } from '../../../src/arcade/core/bytes.js';
import { xorshift32 } from '../../../src/arcade/core/rng.js';
import { decodeKeyframe, encodeKeyframe, worldFromMatch } from '../../../src/arcade/core/fuseyard/codec.js';
import { createFuseyardCore } from '../../../src/arcade/core/fuseyard/runtime.js';
import { BotLevel, CELLS, Control, EV, inputByte, type MatchConfig } from '../../../src/arcade/core/fuseyard/rules.js';
import { applyFrame, createWorld, type World } from '../../../src/arcade/core/fuseyard/view.js';
import { encodeUp } from '../../../src/arcade/core/fuseyard/codec.js';
import { createTestSender, eventBlock } from './sender.js';

const keyOf = (w: World): Uint8Array => encodeKeyframe(w, new ByteWriter(1024), false).copy();

const firstDiff = (a: Uint8Array, b: Uint8Array): string => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) if (a[i] !== b[i]) return `byte ${i}: client ${a[i]} server ${b[i]} (lengths ${a.length}/${b.length})`;
  return 'equal';
};

interface FuzzOpts {
  seed: number;
  ticks: number;
  arena: MatchConfig['arena'];
  mode: MatchConfig['mode'];
  /** Seat changes on the human slots. */
  seats: boolean;
}

const fuzz = (o: FuzzOpts): { frames: number; keyframes: number; compared: number } => {
  const config: MatchConfig = { mode: o.mode, arena: o.arena, fighters: 4, winsNeeded: 2, botLevel: BotLevel.Scrapper, seed: o.seed };
  const core = createFuseyardCore({
    config,
    seats: [
      { slot: 0, human: true, botLevel: 1 },
      { slot: 1, human: true, botLevel: 1 },
      { slot: 2, human: false, botLevel: BotLevel.Menace },
      { slot: 3, human: false, botLevel: BotLevel.Sprout },
    ],
    offline: false,
  });
  const sender = createTestSender(core, 0);
  const world = createWorld(4);
  const serverWorld = createWorld(4);
  let s = (o.seed * 2654435761) >>> 0 || 1;
  const rnd = (n: number): number => {
    s = xorshift32(s);
    return s % n;
  };
  const divisors = [1, 2, 3, 4, 6];
  let divisor = 2;
  let upSeq = [0, 0];
  let frames = 0;
  let keyframes = 0;
  let compared = 0;
  // Blocks broken so far, as the client learns them; items must never show up anywhere else first.
  const broken = new Uint8Array(CELLS);
  const knownItem = (cell: number): boolean => broken[cell] === 1;

  const checkHidden = (w: World): void => {
    for (let c = 0; c < CELLS; c += 1) {
      if ((w.items[c] || w.pending[c]) && !knownItem(c)) throw new Error(`item at ${c} reached the client before its BlockBroken`);
    }
  };
  const noteEvents = (bytes: Uint8Array | null): void => {
    if (!bytes) return;
    // Walk the merged block for BlockBroken and ItemDropped cells (sizes include the kind byte).
    const sizes = [0, 7, 4, 4, 8, 3, 4, 2, 2, 2, 3, 4, 4, 5, 8];
    for (let i = 0; i < bytes.length; ) {
      const k = bytes[i]!;
      if (k === 0xf2) {
        i += 2;
        continue;
      }
      if (k === 0xf0) {
        i += 3;
        continue;
      }
      if (k === EV.BlockBroken || k === EV.ItemDropped) broken[bytes[i + 1]!] = 1;
      i += sizes[k] ?? 1;
    }
  };

  const sendKey = (): void => {
    const k = sender.keyframe();
    const w2 = createWorld(4);
    expect(decodeKeyframe(new ByteReader(k.body), k.tick, w2)).toBe(true);
    // Keyframes may carry items revealed long ago; mark the cells they name as known.
    for (let c = 0; c < CELLS; c += 1) if (w2.items[c] || w2.pending[c]) broken[c] = 1;
    expect(decodeKeyframe(new ByteReader(k.body), k.tick, world)).toBe(true);
    keyframes += 1;
  };

  const compare = (label: string): void => {
    const a = keyOf(world);
    const b = keyOf(worldFromMatch(core.match, serverWorld));
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) throw new Error(`${label} at tick ${core.tick}: ${firstDiff(a, b)}`);
    compared += 1;
  };

  sendKey();
  for (let t = 1; t <= o.ticks; t += 1) {
    // Humans: random inputs, sent as UPs of one input per tick.
    for (let h = 0; h < 2; h += 1) {
      if (rnd(3) === 0) continue;
      upSeq[h] = (upSeq[h]! + 1) & 0xffff;
      core.onUp(h, encodeUp(new Uint8Array([inputByte(rnd(5), rnd(5), rnd(12) === 0, rnd(25) === 0)]), 1), upSeq[h]!);
    }
    if (o.seats && rnd(90) === 0) {
      const h = rnd(2);
      const f = core.match.current.fighters[h]!;
      const cmd = f.control === Control.Ghost ? (rnd(4) === 0 ? 'bot' : 'live') : f.control === Control.Bot ? 'reclaim' : 'ghost';
      core.setSeat(h, cmd);
    }
    sender.tick();
    if (sender.takeRekey()) {
      sendKey();
      compare('after rekey keyframe');
      continue;
    }
    if (rnd(200) === 0) divisor = divisors[rnd(divisors.length)]!;
    const due = core.tick % divisor === 0;
    // Skipped slots (pacing, parking) just let events pile up into a later FRAME.
    if (!due || rnd(7) === 0) continue;
    if (rnd(150) === 0) {
      sendKey();
      compare('after keyframe');
      continue;
    }
    const f = sender.frame();
    noteEvents(f.events?.bytes ?? null);
    expect(applyFrame(world, f.tick, eventBlock(f), new ByteReader(f.snapshot))).toBe(true);
    frames += 1;
    checkHidden(world);
    compare('after frame');
  }
  return { frames, keyframes, compared };
};

describe('the client world', () => {
  it('equals the server view after every frame and keyframe (bots, random inputs, all arenas)', () => {
    let total = 0;
    for (const [i, arena] of (['yard', 'mill', 'pond', 'garden', 'depot'] as const).entries()) {
      const r = fuzz({ seed: 101 + i, ticks: 2400, arena, mode: 'brawl', seats: false });
      expect(r.frames).toBeGreaterThan(200);
      total += r.compared;
    }
    expect(total).toBeGreaterThan(2000);
  });

  it('stays equal through ghosts, returns, bot takeovers, reclaims, round ends and Closing Time', () => {
    for (let seed = 1; seed <= 3; seed += 1) {
      const r = fuzz({ seed: 700 + seed, ticks: 4200, arena: 'rotation', mode: 'quickfire', seats: true });
      expect(r.keyframes).toBeGreaterThan(1);
    }
  });
});

describe('hidden items', () => {
  it('never appear in the modules that build what clients and bots see (fuseyard.md §12 "fuseyard.hidden")', () => {
    // The hidden layer (items under unbroken blocks) lives only in the sim; these files must not read it.
    for (const file of ['codec.ts', 'view.ts', 'danger.ts', 'bots.ts']) {
      const src = readFileSync(fileURLToPath(new URL('../../../src/arcade/core/fuseyard/' + file, import.meta.url)), 'utf8');
      expect(/hidden/i.test(src), file).toBe(false);
    }
  });
});
