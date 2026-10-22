/**
 * Bellwick in jsdom (bellwick.md §13 tests 4 and 11):
 * - the golden replay gives the same hashes here as in Node;
 * - Solo Tale on the platform's local host: the title, a new tale, hiding stops frames, audio and the
 *   sim, 100 frames a second write no signal, and `unmount` leaves nothing behind;
 * - Party Tale through a stand-in remote host wired to a server-mode runtime: the hero moves on the
 *   server, and a restart's HANDOVER leaves a Party copy on the device.
 */
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { goldenButtons, GOLDEN, runLog } from '@arcade/core/bellwick/golden';
import { createBellwick, type BellwickMatch } from '@arcade/core/bellwick/runtime';
import { ByteReader } from '@arcade/core/bytes';
import { createLocalMatchHost } from '@/arcade/runtime/net/localHost';
import { frames } from '@/arcade/runtime/p0';
import { practiceWallet } from '@/arcade/runtime/practiceWallet';
import { DEFAULT_PREFS } from '@/arcade/runtime/prefs';
import { installFakeFrames, stubCanvas, trackResources, type FakeFrames } from '@/arcade/runtime/testing';
import type { CoreMatch, FrameView, GameHandle, KeyframeView, MatchHost, MountOpts, Welcome } from '@/arcade/runtime/types';
import { installFakeAudio } from '@/features/arcade/fakeGame.test-util';
import { arcadeSignalWrites } from '@/features/arcade/state';
import chunk from './index';
import { loadTales, PARTY_COPY, SAVES_KEY } from './localSaves';

let fake: FakeFrames;
let canvas: ReturnType<typeof stubCanvas>;
let audio: ReturnType<typeof installFakeAudio>;

beforeEach(() => {
  fake = installFakeFrames();
  canvas = stubCanvas();
  audio = installFakeAudio();
  localStorage.removeItem(SAVES_KEY);
});

afterEach(() => {
  fake.restore();
  canvas.restore();
  audio.restore();
});

const opts = (mode: 'local' | 'remote', o: Partial<MountOpts> = {}): MountOpts => ({
  mode,
  lobby: null,
  me: { accountId: null, slot: 0 },
  prefs: DEFAULT_PREFS,
  ptt: null,
  reserved: [],
  reducedMotion: false,
  coarse: false,
  shell: {
    status: () => undefined,
    attention: () => undefined,
    wakeLock: () => undefined,
    minimize: () => undefined,
    leave: () => undefined,
    idleAway: () => undefined,
    names: (ids) => ids.map(() => 'x'),
    practice: practiceWallet,
  },
  ...o,
});

const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/** Frames at 60 Hz for `ms`, letting promises (the art bake) settle between. */
const run = async (ms: number, fps = 60): Promise<void> => {
  for (let t = 0; t < ms; t += 100) {
    fake.advance(Math.min(100, ms - t), fps);
    await flush();
  }
};

const key = (el: HTMLElement, code: string, type: 'keydown' | 'keyup'): void => {
  el.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true }));
};

const press = async (el: HTMLElement, code: string): Promise<void> => {
  key(el, code, 'keydown');
  await run(50);
  key(el, code, 'keyup');
  await run(50);
};

type Dev = { cw: { hasRoom: boolean; me: { x: number; y: number }; tick: number }; mode: string } | undefined;
const dev = (): Dev => (window as unknown as { __bellwick?: Dev }).__bellwick;

describe('Bellwick golden replay in jsdom', () => {
  it('hashes the 4-hero log as in Node', () => {
    const log = goldenButtons(GOLDEN.seed, 4, 1800);
    expect(runLog(GOLDEN.seed, 4, log, [300, 1800])).toEqual([GOLDEN.t300, GOLDEN.t1800]);
  });
});

describe('Bellwick Solo Tale lifecycle', () => {
  const mountLocal = (el: HTMLElement): { handle: GameHandle; host: MatchHost; core: CoreMatch } => {
    const core = chunk.local({ mode: 'solo', cfg: {}, seed: new Uint32Array([5, 0, 0, 0]), seats: [] }) as CoreMatch;
    const host = createLocalMatchHost(core, { selfSlot: 0, seats: [{ slot: 0, accountId: null, name: 'Me', bot: false, joinOrder: 0, extra: 0 }] });
    const handle = chunk.module.mount(el, host, opts('local'));
    return { handle, host, core };
  };

  it('starts a tale from the title, stops everything while hidden, and leaves nothing after unmount', async () => {
    const resources = trackResources();
    const el = document.createElement('div');
    document.body.appendChild(el);
    const { handle, host, core } = mountLocal(el);
    handle.resume();
    await run(500);
    expect(dev()?.mode).toBe('title');
    await press(el, 'KeyJ');
    await run(500);
    expect(dev()?.cw.hasRoom).toBe(true);
    // A new tale opens with a word from the village: read it, and the world runs.
    for (let i = 0; i < 6 && dev()?.mode !== 'play'; i += 1) await press(el, 'KeyJ');
    expect(dev()?.mode).toBe('play');
    await run(1000);
    expect(core.tick).toBeGreaterThan(20);
    // Walk: the hero moves.
    const x0 = dev()!.cw.me.x;
    key(el, 'KeyD', 'keydown');
    await run(500);
    key(el, 'KeyD', 'keyup');
    expect(dev()!.cw.me.x).not.toBe(x0);
    // 100 frames a second: no signal is written.
    const before = { ...arcadeSignalWrites };
    await run(1000, 100);
    expect(arcadeSignalWrites).toEqual(before);
    // Hidden: no frames, no sim, audio suspended.
    handle.pause();
    await run(100);
    const t0 = core.tick;
    const pending0 = fake.pending;
    await run(2000);
    expect(core.tick).toBe(t0);
    expect(fake.pending).toBe(pending0);
    expect(frames.active).toBe(0);
    handle.resume();
    await run(300);
    expect(core.tick).toBeGreaterThan(t0);
    // The tale was saved when it was hidden.
    expect(loadTales().slots[0]).not.toBeNull();
    handle.unmount();
    // The platform's session closes the host after the game unmounts.
    host.close();
    el.remove();
    await flush();
    expect(frames.active).toBe(0);
    expect(fake.pending).toBe(0);
    expect(audio.closed).toBe(audio.contexts);
    expect(el.childNodes.length).toBe(0);
    expect(resources.live()).toEqual({ timeouts: 0, intervals: 0, sockets: 0, listeners: 0 });
    resources.restore();
  });
});

describe('Bellwick Party Tale client', () => {
  /** A stand-in remote host in front of a server-mode runtime, one server tick per 33 ms of frames. */
  const remote = (core: BellwickMatch, slot: number) => {
    let welcome: ((w: Welcome) => void) | null = null;
    let frame: ((f: FrameView) => void) | null = null;
    let keyframe: ((k: KeyframeView) => void) | null = null;
    let handover: ((body: Uint8Array, sim: number) => void) | null = null;
    let upSeq = 0;
    const host: MatchHost = {
      mode: 'remote',
      sendUp: (p) => core.onUp(slot, p, (upSeq = (upSeq + 1) & 0xffff)),
      sendEvent: (p) => core.onEvent(slot, p),
      onWelcome: (cb) => (welcome = cb),
      onFrame: (cb) => (frame = cb),
      onKeyframe: (cb) => (keyframe = cb),
      onPhase: () => undefined,
      onHandover: (cb) => (handover = cb),
      onSeats: () => () => undefined,
      onClosed: () => undefined,
      setVisible: () => undefined,
      rttMs: () => 60,
      linkConstrained: () => false,
      estServerTick: () => core.tick + 0.5,
      close: () => undefined,
    };
    let seq = 0;
    return {
      host,
      start() {
        welcome?.({ proto: 1, game: 2, codec: 1, slot, queued: false, tick: core.tick, tickHz: 30, divisor: 2, lastEvSeq: 0, resumeToken: new Uint8Array(32), cfg: core.welcomeCfg() });
        keyframe?.({ frameSeq: seq++, tick: core.tick, ackUp: 0, reason: 0, body: new ByteReader(core.keyframeFor({ slot, view: 0 })) });
      },
      tick() {
        core.step();
        const r = { slot, view: 0 };
        for (const e of core.takeHostEvents()) {
          if (e.t === 'rekey' && e.slot === slot) {
            keyframe?.({ frameSeq: seq++, tick: core.tick, ackUp: 0, reason: e.reason, body: new ByteReader(core.keyframeFor(r)) });
            return;
          }
        }
        const snap = core.snapshotFor(r);
        const ev = core.takeEvents(r);
        frame?.({
          local: false,
          frameSeq: seq++,
          tick: core.tick,
          ackUp: core.ackUp(slot),
          divisor: 1,
          lagging: false,
          snapshot: snap ? new ByteReader(snap.slice()) : null,
          events: ev ? { count: ev.count, r: new ByteReader(ev.bytes.slice()), tick: core.tick } : null,
        });
      },
      handover: (body: Uint8Array) => handover?.(body, 1),
    };
  };

  it('moves its hero on the server, and keeps a Party copy when the server hands the tale over', async () => {
    const core = createBellwick({ seed: 9, mode: 'server', save: null, taleSlot: 0xff, matchId: 'jsdom' });
    core.setSeat(1, 'live');
    const r = remote(core, 1);
    const el = document.createElement('div');
    document.body.appendChild(el);
    const handle = chunk.module.mount(el, r.host, opts('remote', { me: { accountId: 'a', slot: 1 } }));
    handle.resume();
    await run(300);
    r.start();
    const serve = async (ms: number): Promise<void> => {
      for (let t = 0; t < ms; t += 33) {
        r.tick();
        fake.advance(33, 60);
        await flush();
      }
    };
    await serve(500);
    expect(dev()?.cw.hasRoom).toBe(true);
    // The intro dialogue of a new tale: close it, then walk east.
    for (let i = 0; i < 4; i += 1) await press(el, 'KeyJ');
    const x0 = core.world.heroes[1]!.x;
    key(el, 'KeyD', 'keydown');
    await serve(800);
    key(el, 'KeyD', 'keyup');
    await serve(200);
    expect(core.world.heroes[1]!.x).toBeGreaterThan(x0 + 200);
    // A restart: the body the server would deflate, as the remote host hands it on inflated.
    r.handover(core.handover());
    await serve(100);
    const copy = loadTales().slots[PARTY_COPY];
    expect(copy).not.toBeNull();
    expect(Object.keys(copy!.heroes)).toEqual(['solo']);
    handle.unmount();
    el.remove();
  });
});
