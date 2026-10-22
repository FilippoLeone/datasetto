/**
 * Fuseyard's client chunk (fuseyard.md §12 "Client"): an offline match against bots through the real
 * local host, keyboard play and the pause menu, nothing left behind after unmount, no signal writes
 * and no touch-overlay DOM churn per frame, the control rules, and the predictor's parity with the
 * server on recorded inputs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ByteReader } from '@arcade/core/bytes';
import { createFuseyardCore, type FuseyardCore } from '@arcade/core/fuseyard/runtime';
import { BotLevel, Dir, Phase, inputByte, type MatchConfig } from '@arcade/core/fuseyard/rules';
import { applyFrame, createWorld } from '@arcade/core/fuseyard/view';
import { decodeKeyframe, encodeUp } from '@arcade/core/fuseyard/codec';
import { PEV, SEAT_STATE } from '@arcade/core/net/events';
import { installFakeAudio } from '@/features/arcade/fakeGame.test-util';
import { arcadeSignalWrites } from '@/features/arcade/state';
import { defaultOptions } from '@/arcade/catalog';
import { createInput, ACT } from '@/arcade/runtime/input';
import { createLocalMatchHost } from '@/arcade/runtime/net/localHost';
import { frames } from '@/arcade/runtime/p0';
import { practiceWallet } from '@/arcade/runtime/practiceWallet';
import { DEFAULT_PREFS } from '@/arcade/runtime/prefs';
import { startLocalSession } from '@/arcade/runtime/session';
import { installFakeFrames, stubCanvas, trackResources, type FakeFrames } from '@/arcade/runtime/testing';
import type { MatchHost, MountOpts, SeatInfo } from '@/arcade/runtime/types';
import type { FrameView, KeyframeView, PhaseView, Welcome } from '@arcade/core/net/lane';
import { VERSION } from '@arcade/core/fuseyard/version';
import { AXIS_SWITCH, KEYMAP, createSteering, layoutFor } from './controls';
import chunk, { STATS_KEY, localConfig } from './index';
import { meta } from './meta';
import { createPredictor } from './predict';
import { fontSafe } from './render';

let fake: FakeFrames;
let canvas: ReturnType<typeof stubCanvas>;
let audio: ReturnType<typeof installFakeAudio>;

beforeEach(() => {
  fake = installFakeFrames();
  canvas = stubCanvas();
  audio = installFakeAudio();
});
/** Unmounts whatever a failed test left mounted, so one failure does not spill into the next. */
const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const c of cleanup.splice(0)) {
    try {
      c();
    } catch {
      // Already released by the test.
    }
  }
  fake.restore();
  canvas.restore();
  audio.restore();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const untilPlaying = (core: FuseyardCore): void => {
  for (let i = 0; i < 60 && core.match.current.phase !== Phase.Playing; i += 1) fake.advance(100);
  expect(core.match.current.phase).toBe(Phase.Playing);
};

const seatsFor = (n: number): SeatInfo[] =>
  Array.from({ length: n }, (_, slot) => ({ slot, accountId: slot === 0 ? 'me' : null, name: slot === 0 ? 'You' : 'Bot ' + slot, bot: slot !== 0, joinOrder: slot, extra: 0 }));

const opts = (o: Partial<MountOpts> = {}): MountOpts => ({
  mode: 'local',
  lobby: null,
  me: { accountId: 'me', slot: 0 },
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

const offline = (cfg: Record<string, unknown>, mode = 'brawl') => {
  const seats = seatsFor(Number(cfg.fighters ?? 4));
  const core = chunk.local({ mode, cfg, seed: new Uint32Array([1234, 0, 0, 0]), seats }) as FuseyardCore;
  const host = createLocalMatchHost(core, { selfSlot: 0, seats });
  return { core, host, seats };
};

describe('an offline match', () => {
  it('runs against bots, draws, and leaves nothing behind when unmounted', async () => {
    // Warm-up: the first mount pulls in app modules that install one-time listeners of their own.
    {
      const w = offline({ fighters: 2 });
      const warm = document.createElement('div');
      const h = chunk.module.mount(warm, w.host, opts());
      await flush();
      fake.advance(200);
      h.unmount();
      w.host.close();
      await flush();
    }
    const resources = trackResources();
    const el = document.createElement('div');
    document.body.append(el);
    const { core, host } = offline({ fighters: 4, bots: 'menace', arena: 'mill' });
    const handle = chunk.module.mount(el, host, opts());
    await flush();
    fake.advance(8000);
    // 8 s at 30 Hz.
    expect(core.tick).toBeGreaterThan(220);
    expect(core.match.current.phase).not.toBe(Phase.Countdown);
    expect(canvas.calls.filter((c) => c === 'drawImage').length).toBeGreaterThan(100);
    expect(el.querySelector('[data-fuseyard]')).not.toBeNull();
    handle.unmount();
    host.close();
    el.remove();
    await flush();
    expect(frames.active).toBe(0);
    expect(fake.pending).toBe(0);
    expect(audio.closed).toBe(audio.contexts);
    const live = resources.live();
    expect(resources.listenerTypes()).toEqual({});
    expect(live).toEqual({ timeouts: 0, intervals: 0, sockets: 0, listeners: 0 });
    expect(el.childNodes.length).toBe(0);
    resources.restore();
  });

  it('moves with the keyboard, pauses on Esc and resumes', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    const { core, host } = offline({ fighters: 2, bots: 'sprout', arena: 'yard' }, 'quickfire');
    const handle = chunk.module.mount(el, host, opts());
    cleanup.push(() => {
      handle.unmount();
      host.close();
      el.remove();
    });
    await flush();
    untilPlaying(core);
    const root = el.querySelector('[data-fuseyard]') as HTMLElement;
    const f = core.match.current.fighters[0]!;
    const x0 = f.x;
    root.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true }));
    fake.advance(300);
    root.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowRight', bubbles: true }));
    expect(f.x).toBeGreaterThan(x0);
    // Esc opens the pause menu and the offline sim stops.
    root.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    fake.advance(100);
    root.dispatchEvent(new KeyboardEvent('keyup', { code: 'Escape', bubbles: true }));
    const pause = el.querySelector('[data-fuseyard-pause]') as HTMLElement;
    expect(pause.classList.contains('hidden')).toBe(false);
    const t = core.tick;
    fake.advance(1000);
    expect(core.tick).toBe(t);
    (pause.querySelector('button') as HTMLButtonElement).click();
    fake.advance(500);
    expect(core.tick).toBeGreaterThan(t + 10);
    // Back: opens the menu (consumed), a second back lets the shell minimize.
    expect(handle.back?.()).toBe(true);
    expect(handle.back?.()).toBe(false);
    handle.unmount();
    host.close();
    el.remove();
  });

  it('shows the standings at match end, keeps stats on the device, and starts a rematch', async () => {
    localStorage.removeItem(STATS_KEY);
    const el = document.createElement('div');
    document.body.append(el);
    const { core, host } = offline({ fighters: 2, bots: 'sprout', arena: 'yard' }, 'quickfire');
    const handle = chunk.module.mount(el, host, opts());
    cleanup.push(() => {
      handle.unmount();
      host.close();
      el.remove();
    });
    await flush();
    untilPlaying(core);
    // End the round: the bot falls.
    core.match.current.fighters[1]!.alive = false;
    fake.advance(5000);
    const end = el.querySelector('[data-fuseyard-end]') as HTMLElement;
    expect(end.classList.contains('hidden')).toBe(false);
    expect(end.textContent).toMatch(/Ember/);
    expect(JSON.parse(localStorage.getItem(STATS_KEY) ?? '{}')).toMatchObject({ matches: 1, wins: 1, roundWins: 1 });
    const seedBefore = core.match.config.seed;
    (end.querySelector('button') as HTMLButtonElement).click();
    fake.advance(200);
    expect(core.match.config.seed).not.toBe(seedBefore);
    expect(end.classList.contains('hidden')).toBe(true);
    expect(core.match.current.phase).toBe(Phase.Countdown);
    handle.unmount();
    host.close();
    el.remove();
  });
});

describe('a server restart', () => {
  /** A remote host the test drives: it delivers what an online core produces, then a restart. */
  const fakeRemote = () => {
    const cb: {
      welcome?: (w: Welcome) => void;
      keyframe?: (k: KeyframeView) => void;
      frame?: (f: FrameView) => void;
      phase?: (p: PhaseView) => void;
      handover?: (body: Uint8Array, sim: number) => void;
      closed?: (code: number, reason: string) => void;
    } = {};
    let closed = false;
    const host: MatchHost = {
      mode: 'remote',
      sendUp: () => undefined,
      sendEvent: () => undefined,
      onWelcome: (f) => void (cb.welcome = f),
      onFrame: (f) => void (cb.frame = f),
      onKeyframe: (f) => void (cb.keyframe = f),
      onPhase: (f) => void (cb.phase = f),
      onHandover: (f) => void (cb.handover = f),
      onSeats: (f) => {
        f(seatsFor(4));
        return () => undefined;
      },
      onClosed: (f) => void (cb.closed = f),
      setVisible: () => undefined,
      rttMs: () => 40,
      linkConstrained: () => false,
      estServerTick: () => 0,
      close: () => void (closed = true),
    };
    return { host, cb, isClosed: () => closed };
  };

  it('offers to continue the match against bots from the HANDOVER, and plays it on locally', async () => {
    const server = createFuseyardCore({
      config: { mode: 'brawl', arena: 'yard', fighters: 4, winsNeeded: 3, botLevel: BotLevel.Scrapper, seed: 99 },
      seats: [
        { slot: 0, human: true, botLevel: 1 },
        { slot: 1, human: true, botLevel: 1 },
        { slot: 2, human: false, botLevel: 1 },
        { slot: 3, human: false, botLevel: 1 },
      ],
      offline: false,
    });
    for (let i = 0; i < 150; i += 1) server.step();
    const view = { slot: 0, view: 0 };
    const { host, cb, isClosed } = fakeRemote();
    const el = document.createElement('div');
    document.body.append(el);
    const handle = chunk.module.mount(el, host, opts({ mode: 'remote', me: { accountId: 'me', slot: 0 } }));
    cleanup.push(() => {
      handle.unmount();
      el.remove();
    });
    await flush();
    cb.welcome?.({ proto: 1, game: 1, codec: 1, slot: 0, queued: false, tick: server.tick, tickHz: 30, divisor: 2, lastEvSeq: 0, resumeToken: new Uint8Array(32), cfg: server.welcomeCfg() });
    cb.keyframe?.({ frameSeq: 1, tick: server.tick, ackUp: 0, reason: 0, body: new ByteReader(server.keyframeFor(view)) });
    fake.advance(100);
    const end = el.querySelector('[data-fuseyard-end]') as HTMLElement;
    expect(end.classList.contains('hidden')).toBe(true);

    // PHASE 4 (restart, no body), the HANDOVER, then the lane closes with 1012.
    cb.phase?.({ phase: 4, reason: 1, body: new ByteReader(new Uint8Array(0)) });
    cb.handover?.(server.dump(), VERSION.sim);
    cb.closed?.(1012, 'Server restarting');
    fake.advance(100);
    expect(end.classList.contains('hidden')).toBe(false);
    expect(end.textContent).toMatch(/The server restarted/);
    const go = Array.from(end.querySelectorAll('button')).find((b) => b.textContent === 'Continue vs bots') as HTMLButtonElement;
    expect(go.classList.contains('hidden')).toBe(false);

    const drawsBefore = canvas.calls.filter((c) => c === 'drawImage').length;
    go.click();
    expect(isClosed()).toBe(true);
    fake.advance(3000);
    expect(end.classList.contains('hidden')).toBe(true);
    // The local host runs: the board keeps drawing frame after frame.
    expect(canvas.calls.filter((c) => c === 'drawImage').length).toBeGreaterThan(drawsBefore + 50);
    expect(frames.active).toBeGreaterThan(0);
    handle.unmount();
    el.remove();
    await flush();
    // Its own local host goes with it.
    expect(frames.active).toBe(0);
  });

  it('without a usable HANDOVER only offers Leave', async () => {
    const { host, cb } = fakeRemote();
    const el = document.createElement('div');
    document.body.append(el);
    const handle = chunk.module.mount(el, host, opts({ mode: 'remote', me: { accountId: 'me', slot: 0 } }));
    cleanup.push(() => {
      handle.unmount();
      el.remove();
    });
    await flush();
    const server = createFuseyardCore({ config: { mode: 'brawl', arena: 'yard', fighters: 2, winsNeeded: 3, botLevel: 1, seed: 5 }, seats: [{ slot: 0, human: true, botLevel: 1 }], offline: false });
    cb.welcome?.({ proto: 1, game: 1, codec: 1, slot: 0, queued: false, tick: 0, tickHz: 30, divisor: 2, lastEvSeq: 0, resumeToken: new Uint8Array(32), cfg: server.welcomeCfg() });
    cb.keyframe?.({ frameSeq: 1, tick: 0, ackUp: 0, reason: 0, body: new ByteReader(server.keyframeFor({ slot: 0, view: 0 })) });
    // A dump from another sim version is no use.
    cb.handover?.(server.dump(), VERSION.sim + 1);
    cb.closed?.(1012, 'Server restarting');
    fake.advance(100);
    const end = el.querySelector('[data-fuseyard-end]') as HTMLElement;
    expect(end.textContent).toMatch(/could not be saved/);
    const go = Array.from(end.querySelectorAll('button')).find((b) => b.textContent === 'Continue vs bots') as HTMLButtonElement;
    expect(go.classList.contains('hidden')).toBe(true);
    handle.unmount();
    el.remove();
  });
});

describe('per-frame cost', () => {
  it('100 frames a second write no signal and cause no touch-overlay DOM changes', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    const session = await startLocalSession({ meta, mode: 'brawl', cfg: defaultOptions(meta, 'brawl'), el, onLeave: () => undefined, onMinimize: () => undefined });
    await flush();
    fake.advance(500);
    const before = { ...arcadeSignalWrites };
    fake.advance(1000, 100);
    expect(arcadeSignalWrites).toEqual(before);
    session.stop();
    el.remove();
    expect(frames.active).toBe(0);

    const el2 = document.createElement('div');
    document.body.append(el2);
    const { host } = offline({ fighters: 4 });
    const handle = chunk.module.mount(el2, host, opts({ coarse: true }));
    await flush();
    const overlay = el2.querySelector('[data-arcade-touch]') as HTMLElement;
    expect(overlay).not.toBeNull();
    const records: MutationRecord[] = [];
    const mo = new MutationObserver((r) => records.push(...r));
    mo.observe(overlay, { childList: true, subtree: true });
    fake.advance(10_000, 60);
    await flush();
    mo.disconnect();
    expect(records.filter((r) => r.type === 'childList')).toEqual([]);
    handle.unmount();
    host.close();
    el2.remove();
  });
});

describe('controls', () => {
  const sample = (o: Partial<{ held: number; pressed: number; stickX: number; stickY: number }>) => ({ held: 0, pressed: 0, stickX: 0, stickY: 0, ...o });
  const dirs = (b: number): [number, number] => [b & 7, (b >> 3) & 7];

  it('the stick switches axis only on a 15 % lead and adds the minor axis above 35 %', () => {
    const st = createSteering();
    expect(dirs(st.sample(sample({ stickX: 0.8, stickY: 0.5 })).byte)).toEqual([Dir.E, Dir.S]);
    expect(dirs(st.sample(sample({ stickX: 0.6, stickY: 0.6 * AXIS_SWITCH - 0.01 })).byte)).toEqual([Dir.E, Dir.S]);
    expect(dirs(st.sample(sample({ stickX: 0.6, stickY: 0.6 * AXIS_SWITCH + 0.02 })).byte)).toEqual([Dir.S, Dir.E]);
    expect(dirs(st.sample(sample({ stickX: 0.3, stickY: -0.9 })).byte)).toEqual([Dir.N, 0]);
    expect(dirs(st.sample(sample({ stickX: -0.36, stickY: -0.9 })).byte)).toEqual([Dir.N, Dir.W]);
  });

  it('keys: the newest held direction is primary, the one before it secondary', () => {
    const st = createSteering();
    expect(dirs(st.sample(sample({ held: ACT.right, pressed: ACT.right })).byte)).toEqual([Dir.E, 0]);
    expect(dirs(st.sample(sample({ held: ACT.right | ACT.up, pressed: ACT.up })).byte)).toEqual([Dir.N, Dir.E]);
    expect(dirs(st.sample(sample({ held: ACT.right })).byte)).toEqual([Dir.E, 0]);
    // Re-pressed between two samples: newest again.
    expect(dirs(st.sample(sample({ held: ACT.right | ACT.down, pressed: ACT.down })).byte)).toEqual([Dir.S, Dir.E]);
    expect(dirs(st.sample(sample({ held: ACT.right | ACT.down, pressed: ACT.right })).byte)).toEqual([Dir.E, Dir.S]);
  });

  it('a 10 ms tap between two samples still drops a bomb, and the push-to-talk key is never bound', () => {
    const target = document.createElement('div');
    document.body.append(target);
    const input = createInput(target, { keys: KEYMAP, ptt: { code: 'Space', ctrl: false, alt: false, shift: false, meta: false }, touch: null, gamepad: false });
    const st = createSteering();
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', bubbles: true }));
    target.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyJ', bubbles: true }));
    expect(st.sample(input.sample()).byte & 0x40).toBe(0x40);
    expect(st.sample(input.sample()).byte & 0x40).toBe(0);
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    expect(st.sample(input.sample()).byte & 0x40).toBe(0);
    input.dispose();
    target.remove();
  });

  it('lays the board out per orientation', () => {
    const portrait = layoutFor(360, 640, true);
    expect(portrait.orientation).toBe('portrait');
    expect(640 - (portrait.top + portrait.height)).toBeGreaterThanOrEqual(200);
    expect(portrait.height).toBeLessThanOrEqual(640 * 0.6);
    expect(layoutFor(640, 360, true)).toMatchObject({ orientation: 'landscape', overlay: true });
    expect(layoutFor(900, 360, true)).toMatchObject({ orientation: 'landscape', overlay: false });
    expect(layoutFor(1280, 720, false).orientation).toBe('desktop');
  });

  it('builds the offline config from the options form', () => {
    expect(localConfig('quickfire', { arena: 'pond', fighters: 3, wins: 5, bots: 'menace' }, 9, 4)).toEqual({ mode: 'quickfire', arena: 'pond', fighters: 3, winsNeeded: 5, botLevel: BotLevel.Menace, seed: 9 });
    expect(localConfig('brawl', { arena: 'nowhere' }, 1, 2)).toMatchObject({ arena: 'rotation', fighters: 2, winsNeeded: 3, botLevel: BotLevel.Scrapper });
  });
});

describe('prediction', () => {
  it('matches the server on recorded inputs (belts, ice, plain floor; no kicks or pads)', () => {
    for (const arena of ['yard', 'mill', 'pond'] as const) {
      const config: MatchConfig = { mode: 'brawl', arena, fighters: 2, winsNeeded: 3, botLevel: 1, seed: 4242 };
      const core = createFuseyardCore({ config, seats: [{ slot: 0, human: true, botLevel: 1 }, { slot: 1, human: true, botLevel: 1 }], offline: false });
      const world = createWorld(2);
      const predictor = createPredictor();
      // Frames reach the client 3 ticks late; inputs are applied by the server as they arrive.
      const DELAY = 3;
      const frameQueue: { tick: number; events: Uint8Array | null; count: number; snapshot: Uint8Array; ack: number }[] = [];
      let seed = 99;
      let seq = 0;
      let dir = Dir.E;
      let compared = 0;
      expect(decodeKeyframe(new ByteReader(core.keyframeFor({ slot: 0, view: 0 })), core.tick, world)).toBe(true);
      for (let t = 0; t < 900; t += 1) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        if (seed % 9 === 0) dir = ((seed >>> 8) % 4) + 1;
        const byte = inputByte(dir, (seed >>> 12) % 5, false, false);
        seq += 1;
        core.onUp(0, encodeUp(new Uint8Array([byte]), 1), seq);
        predictor.sent(seq, byte);
        core.step();
        const chunkEv = core.takeEvents({ slot: 0, view: 0 });
        const seats = core.takeHostEvents().filter((e) => e.t === 'seat');
        let events: Uint8Array | null = chunkEv ? chunkEv.bytes.slice() : null;
        let count = chunkEv?.count ?? 0;
        if (seats.length) {
          const extra = new Uint8Array(seats.length * 3);
          seats.forEach((e, i) => e.t === 'seat' && extra.set([PEV.SeatState, e.slot, SEAT_STATE[e.state]], i * 3));
          events = events ? new Uint8Array([...events, ...extra]) : extra;
          count += seats.length;
        }
        frameQueue.push({ tick: core.tick, events, count, snapshot: core.snapshotFor({ slot: 0, view: 0 })!.slice(), ack: core.ackUp(0) });
        if (frameQueue.length > DELAY) {
          const f = frameQueue.shift()!;
          applyFrame(world, f.tick, f.events ? { count: f.count, r: new ByteReader(f.events), tick: f.tick } : null, new ByteReader(f.snapshot));
          predictor.reconcile(world, 0, f.ack);
          if (core.match.current.phase === Phase.Playing && world.phase === Phase.Playing && world.fight[0]!.alive) {
            const sf = core.match.current.fighters[0]!;
            expect([predictor.rawX, predictor.rawY]).toEqual([sf.x, sf.y]);
            compared += 1;
          }
        }
      }
      expect(compared).toBeGreaterThan(500);
    }
  });
});

describe('names on the board', () => {
  it('keep to the ASCII font: other characters fall back, long names are shortened', () => {
    expect(fontSafe('Pip', 20)).toBe('Pip');
    expect(fontSafe('Zoë', 20)).toBe('');
    expect(fontSafe('\u{1F525} hot', 20)).toBe('');
    expect(fontSafe('A very long display name here', 20)).toBe('A very long displa..');
  });
});
