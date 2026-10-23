/**
 * Bellwick in jsdom (bellwick.md §13 tests 4 and 11):
 * - the golden replay gives the same hashes here as in Node;
 * - Solo Tale on the platform's local host: the title, a new tale, hiding stops frames, audio and the
 *   sim, 100 frames a second write no signal, and `unmount` leaves nothing behind;
 * - Party Tale through a stand-in remote host wired to a server-mode runtime: the hero moves on the
 *   server, and a restart's HANDOVER leaves a Party copy on the device;
 * - the A button and dialogues, in both tales: the press that closes a sign never opens it again, a
 *   quick second tap does nothing, a later tap reads it again (J, Space, Z and a gamepad's A); Party
 *   Tale: the J that closes a dialogue in front of the sign, held past the re-talk cooldown, never
 *   reaches the hero; the J let go and pressed again inside one frame is a new press; mashing A at the
 *   shop counter never buys (the question starts on No, and says so to screen readers);
 * - Solo Tale: a Rootsword charged before the pause or the map keeps charging while J stays down.
 */
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { goldenButtons, GOLDEN, runLog } from '@arcade/core/bellwick/golden';
import { createBellwick, type BellwickMatch } from '@arcade/core/bellwick/runtime';
import { Act, Btn, DIR, ItemBit } from '@arcade/core/bellwick/types';
import { ByteReader } from '@arcade/core/bytes';
import { createLocalMatchHost } from '@/arcade/runtime/net/localHost';
import { frames } from '@/arcade/runtime/p0';
import { practiceWallet } from '@/arcade/runtime/practiceWallet';
import { DEFAULT_PREFS } from '@/arcade/runtime/prefs';
import { removeLocal } from '@/arcade/runtime/store';
import { installFakeFrames, stubCanvas, trackResources, type FakeFrames } from '@/arcade/runtime/testing';
import type { CoreMatch, FrameView, GameHandle, KeyframeView, MatchHost, MountOpts, Welcome } from '@/arcade/runtime/types';
import { installFakeAudio } from '@/features/arcade/fakeGame.test-util';
import { arcadeSignalWrites } from '@/features/arcade/state';
import chunk from './index';
import { loadTales, PARTY_COPY, SAVES_KEY } from './localSaves';
import type { LocalTale } from './offline';

let fake: FakeFrames;
let canvas: ReturnType<typeof stubCanvas>;
let audio: ReturnType<typeof installFakeAudio>;

beforeEach(() => {
  fake = installFakeFrames();
  canvas = stubCanvas();
  audio = installFakeAudio();
  // The store keeps a copy in memory too (for windows without storage): clear both.
  removeLocal(SAVES_KEY);
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

type Dev =
  | { cw: { hasRoom: boolean; room: number; items: number; me: { x: number; y: number; facing: number; act: number; charged: boolean; btn: number }; tick: number }; mode: string }
  | undefined;
const dev = (): Dev => (window as unknown as { __bellwick?: Dev }).__bellwick;

/** A stand-in remote host in front of a server-mode runtime; `tick()` steps the server once. */
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

describe('Bellwick dialogues and the A button', () => {
  /** One letter per frame for the mode the game is in; in play S, H, X, B, V: the hero swings, charges, spins, raises the Buckler, throws the Vinehook. */
  const LETTER: Readonly<Record<string, string>> = { loading: 'L', title: 'T', play: 'P', dialogue: 'D', choice: 'C', menu: 'M', map: 'A' };
  const HERO_ACT: Readonly<Record<number, string>> = { [Act.Slash]: 'S', [Act.Charge]: 'H', [Act.Spin]: 'X', [Act.Shield]: 'B', [Act.Hook]: 'V' };
  /** Kettlebrook Square (the start room) and Pell's Sundries. */
  const SQUARE = 17;
  const SHOP = 21;
  /** Frames past the re-talk cooldown (12 hero ticks, 24 frames here) with room to spare. */
  const PAST_COOLDOWN = 40;
  /** About a second each here; room for a busy machine. */
  const SLOW = 20_000;

  type Gift = 'sword' | 'buckler' | 'hook';

  interface Rig {
    el: HTMLElement;
    /** `n` frames at 60 Hz (Party Tale: a server tick every second frame); the mode after each, one letter a frame. */
    frames(n: number): Promise<string>;
    /** Puts the own hero in the middle of tile (tx, ty) of its room, facing `facing` (online on the server too). */
    place(tx: number, ty: number, facing: number): Promise<void>;
    /** The party has the Rootsword, the Bark Buckler or the Vinehook (on both sides). */
    give(item: Gift): void;
    /** The party's purse and Buckler on the side that runs the tale. */
    party(): { purse: number; buckler: boolean };
    end(): void;
  }

  /** A button the tests hold and let go: a key, or A on a standard gamepad. */
  interface Button {
    name: string;
    down(): void;
    up(): void;
  }

  const stepper = (serverTick: (() => void) | null): ((n: number) => Promise<string>) => {
    let frame = 0;
    return async (n) => {
      let seen = '';
      for (let i = 0; i < n; i += 1) {
        frame += 1;
        if (serverTick && frame % 2 === 0) serverTick();
        fake.advance(1000 / 60, 60);
        // Modes change inside the frame callbacks; promises only need to settle now and then.
        if (frame % 8 === 0) await flush();
        const d = dev();
        seen += d?.mode === 'play' ? (HERO_ACT[d.cw.me.act] ?? 'P') : (LETTER[d?.mode ?? ''] ?? '?');
      }
      return seen;
    };
  };

  const middle = (t: number): number => t * 256 + 128;

  /** A key held for three frames, then three frames up. */
  const tapKey = async (rig: Pick<Rig, 'el' | 'frames'>, code: string): Promise<string> => {
    key(rig.el, code, 'keydown');
    const s = await rig.frames(3);
    key(rig.el, code, 'keyup');
    return s + (await rig.frames(3));
  };

  /**
   * A new tale opens with the intro on screen. `keep` leaves it there; otherwise Escape reads it (Escape
   * pages dialogues and never reaches the hero).
   */
  const intro = async (rig: Pick<Rig, 'el' | 'frames'>, keep: boolean): Promise<void> => {
    for (let i = 0; i < 120 && dev()?.mode !== 'dialogue'; i += 1) await rig.frames(1);
    expect(dev()?.cw.room).toBe(SQUARE);
    expect(dev()?.mode).toBe('dialogue');
    if (keep) return;
    for (let i = 0; i < 12 && dev()?.mode === 'dialogue'; i += 1) await tapKey(rig, 'Escape');
    expect(dev()?.mode).toBe('play');
  };

  /** Solo Tale on the platform's local host, a new tale started from the title. */
  const soloRig = async (keepIntro = false): Promise<Rig & { tale: LocalTale }> => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const tale = chunk.local({ mode: 'solo', cfg: {}, seed: new Uint32Array([5, 0, 0, 0]), seats: [] }) as LocalTale;
    const host = createLocalMatchHost(tale, { selfSlot: 0, seats: [{ slot: 0, accountId: null, name: 'Me', bot: false, joinOrder: 0, extra: 0 }] });
    const handle = chunk.module.mount(el, host, opts('local'));
    const end = (): void => {
      handle.unmount();
      host.close();
      el.remove();
    };
    const frames = stepper(null);
    try {
      handle.resume();
      await run(500);
      expect(dev()?.mode).toBe('title');
      await press(el, 'KeyJ');
      await intro({ el, frames }, keepIntro);
    } catch (e) {
      end();
      throw e;
    }
    return {
      el,
      tale,
      frames,
      async place(tx, ty, facing) {
        const me = dev()!.cw.me;
        me.x = middle(tx);
        me.y = middle(ty);
        me.facing = facing;
        await frames(6);
      },
      give(item) {
        tale.match!.world.party[item] = true;
        dev()!.cw.items |= ItemBit[item];
      },
      party: () => tale.match!.world.party,
      end,
    };
  };

  /** Party Tale through the stand-in remote host, one server tick per two frames. */
  const partyRig = async (keepIntro = false): Promise<Rig> => {
    const core = createBellwick({ seed: 9, mode: 'server', save: null, taleSlot: 0xff, matchId: 'jsdom' });
    core.setSeat(1, 'live');
    const r = remote(core, 1);
    const el = document.createElement('div');
    document.body.appendChild(el);
    const handle = chunk.module.mount(el, r.host, opts('remote', { me: { accountId: 'a', slot: 1 } }));
    const end = (): void => {
      handle.unmount();
      el.remove();
    };
    const frames = stepper(() => r.tick());
    try {
      handle.resume();
      await run(300);
      r.start();
      await intro({ el, frames }, keepIntro);
    } catch (e) {
      end();
      throw e;
    }
    return {
      el,
      frames,
      async place(tx, ty, facing) {
        const me = dev()!.cw.me;
        const h = core.world.heroes[1]!;
        me.x = h.x = middle(tx);
        me.y = h.y = middle(ty);
        me.facing = h.facing = facing;
        await frames(6);
      },
      give(item) {
        core.world.party[item] = true;
        dev()!.cw.items |= ItemBit[item];
      },
      party: () => core.world.party,
      end,
    };
  };

  const keyButton = (el: HTMLElement, code: string): Button => ({
    name: code,
    down: () => key(el, code, 'keydown'),
    up: () => key(el, code, 'keyup'),
  });

  /** A standard-mapping pad behind navigator.getGamepads, announced as connected; A is button 0. */
  const padButton = (): Button & { unplug(): void } => {
    let a = false;
    const pad = (): Gamepad =>
      ({
        index: 0,
        connected: true,
        mapping: 'standard',
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === 0 && a, touched: false, value: i === 0 && a ? 1 : 0 })),
      }) as unknown as Gamepad;
    Object.defineProperty(navigator, 'getGamepads', { value: () => [pad()], configurable: true });
    const announce = (type: string) => window.dispatchEvent(Object.assign(new Event(type), { gamepad: { index: 0 } }));
    announce('gamepadconnected');
    return {
      name: 'gamepad A',
      down: () => (a = true),
      up: () => (a = false),
      unplug() {
        announce('gamepaddisconnected');
        delete (navigator as { getGamepads?: unknown }).getGamepads;
      },
    };
  };

  /**
   * The hero faces the Kettlebrook Square sign. A tap of `btn` reads it and taps page through it; the
   * press that closes it is held a while and the sign stays closed; a quick second tap (about a quarter
   * of a second after the close) does nothing; a later tap reads it again.
   */
  const talkCycle = async (rig: Rig, btn: Button): Promise<void> => {
    const tap = async (): Promise<string> => {
      btn.down();
      const s = await rig.frames(3);
      btn.up();
      return s + (await rig.frames(3));
    };
    const what = btn.name;
    expect(await tap(), `${what}: a tap reads the sign`).toContain('D');
    let closing = '';
    for (let i = 0; i < 12; i += 1) {
      btn.down();
      closing = await rig.frames(4);
      if (/[^D]/.test(closing)) break;
      btn.up();
      await rig.frames(4);
    }
    expect(closing, `${what}: a press closes the sign`).toMatch(/[^D]/);
    let after = closing.slice(closing.search(/[^D]/)) + (await rig.frames(8));
    btn.up();
    after += await rig.frames(3);
    expect(after, `${what}: the press that closed the sign, held and let go, does not open it again`).toMatch(/^P+$/);
    expect(await tap(), `${what}: a quick tap right after the close does nothing`).toMatch(/^P+$/);
    await rig.frames(30);
    expect(await tap(), `${what}: a later tap reads the sign again`).toContain('D');
    // Read it to the end and let the moment pass, ready for the next button.
    for (let i = 0; i < 12 && dev()?.mode !== 'play'; i += 1) await tap();
    expect(dev()?.mode, `${what}: the sign closes again`).toBe('play');
    await rig.frames(40);
  };

  const talkAllButtons = async (rig: Rig): Promise<void> => {
    await rig.place(9, 5, DIR.down);
    for (const code of ['KeyJ', 'Space', 'KeyZ']) await talkCycle(rig, keyButton(rig.el, code));
    const pad = padButton();
    try {
      await talkCycle(rig, pad);
    } finally {
      pad.unplug();
    }
  };

  it('Solo Tale: the press that closes a sign never reopens it; a quick re-tap waits, a later tap talks', async () => {
    const rig = await soloRig();
    try {
      await talkAllButtons(rig);
    } finally {
      rig.end();
    }
  }, SLOW);

  it('Party Tale: the press that closes a sign never reopens it; a quick re-tap waits, a later tap talks', async () => {
    const rig = await partyRig();
    try {
      await talkAllButtons(rig);
    } finally {
      rig.end();
    }
  }, SLOW);

  /**
   * Party Tale, the hero facing the sign. The J that closes the intro (the sign was never talked to, so
   * no cooldown covers it) and then the J that closes the sign are each held past the re-talk cooldown
   * before they are let go: the hero never sees A, and the sign stays closed. Only the swallow holds it.
   */
  it('Party Tale: the J that closes a dialogue in front of the sign, held past the re-talk cooldown, never reads it', async () => {
    const rig = await partyRig(true);
    try {
      await rig.place(9, 5, DIR.down);
      const j = keyButton(rig.el, 'KeyJ');
      const closeAndHold = async (what: string): Promise<void> => {
        let closing = '';
        for (let i = 0; i < 12; i += 1) {
          j.down();
          closing = await rig.frames(4);
          if (/[^D]/.test(closing)) break;
          j.up();
          await rig.frames(4);
        }
        expect(closing, `${what}: a press closes it`).toMatch(/[^D]/);
        let after = closing.slice(closing.search(/[^D]/));
        let saw = 0;
        for (let i = 0; i < PAST_COOLDOWN; i += 1) {
          after += await rig.frames(1);
          saw |= dev()!.cw.me.btn;
        }
        j.up();
        after += await rig.frames(10);
        expect(saw & Btn.a, `${what}: the hero never sees the J that closed it`).toBe(0);
        expect(after, `${what}: that J, held past the cooldown and let go, does not read the sign`).toMatch(/^P+$/);
      };
      await closeAndHold('the intro');
      await rig.frames(30);
      expect(await tapKey(rig, 'KeyJ'), 'a tap reads the sign').toContain('D');
      await closeAndHold('the sign');
      await rig.frames(30);
      expect(await tapKey(rig, 'KeyJ'), 'a later tap reads it again').toContain('D');
    } finally {
      rig.end();
    }
  }, SLOW);

  /**
   * The hero has the Rootsword. The J that closes the intro, or that picks "Back to the tale" in the
   * pause menu, is held a while and let go: the hero does not swing. A J of its own does.
   */
  const noStraySwing = async (rig: Rig): Promise<void> => {
    const j = keyButton(rig.el, 'KeyJ');
    rig.give('sword');
    let closing = '';
    for (let i = 0; i < 12; i += 1) {
      j.down();
      closing = await rig.frames(4);
      if (/[^D]/.test(closing)) break;
      j.up();
      await rig.frames(4);
    }
    closing += await rig.frames(10);
    j.up();
    closing += await rig.frames(10);
    expect(closing, 'the J that closed the intro, held and let go').toMatch(/^D*P+$/);
    await rig.place(5, 4, DIR.down);
    j.down();
    let swing = await rig.frames(4);
    j.up();
    swing += await rig.frames(10);
    expect(swing, 'a J of its own swings the sword').toContain('S');
    await rig.frames(30);
    expect(await tapKey(rig, 'Escape'), 'Escape pauses').toMatch(/M$/);
    j.down();
    let back = await rig.frames(14);
    j.up();
    back += await rig.frames(10);
    expect(back, 'the J that picked "Back to the tale", held and let go').toMatch(/^M*P+$/);
  };

  it('Solo Tale: the J that closes the intro or the pause menu does not swing the sword', async () => {
    const rig = await soloRig(true);
    try {
      await noStraySwing(rig);
    } finally {
      rig.end();
    }
  }, SLOW);

  it('Party Tale: the J that closes the intro or the pause menu does not swing the sword', async () => {
    const rig = await partyRig(true);
    try {
      await noStraySwing(rig);
    } finally {
      rig.end();
    }
  }, SLOW);

  /**
   * The hero has the Rootsword. The J that picks "Back to the tale" is held, so the hero ignores it; let
   * go and pressed again inside one frame, it is a new press: the hero swings and, J held, charges.
   */
  const rePress = async (rig: Rig): Promise<void> => {
    const j = keyButton(rig.el, 'KeyJ');
    rig.give('sword');
    await rig.place(5, 4, DIR.down);
    expect(await tapKey(rig, 'Escape'), 'Escape pauses').toMatch(/M$/);
    j.down();
    expect(await rig.frames(10), 'the J that picked "Back to the tale" does not swing').toMatch(/^M*P+$/);
    j.up();
    j.down();
    const seen = await rig.frames(70);
    j.up();
    await rig.frames(20);
    expect(seen, 'let go and pressed again between two samples: a swing, then the charge').toMatch(/^P*S+H+$/);
  };

  it('Solo Tale: a held J let go and pressed again between two samples is a new press', async () => {
    const rig = await soloRig();
    try {
      await rePress(rig);
    } finally {
      rig.end();
    }
  }, SLOW);

  it('Party Tale: a held J let go and pressed again between two samples is a new press', async () => {
    const rig = await partyRig();
    try {
      await rePress(rig);
    } finally {
      rig.end();
    }
  }, SLOW);

  it('Solo Tale: a Rootsword charged before the pause or the map keeps charging while J stays down', async () => {
    const rig = await soloRig();
    try {
      rig.give('sword');
      await rig.place(5, 4, DIR.down);
      const j = keyButton(rig.el, 'KeyJ');
      j.down();
      // A swing, then the charge: 10 + 18 hero ticks at 30 Hz, about 56 frames.
      expect(await rig.frames(70), 'J held swings, then charges').toMatch(/^P*S+H+$/);
      expect(dev()!.cw.me.charged, 'the charge is full').toBe(true);
      let seen = await tapKey(rig, 'Escape');
      seen += await tapKey(rig, 'Escape');
      seen += await rig.frames(10);
      seen += await tapKey(rig, 'KeyM');
      seen += await tapKey(rig, 'KeyM');
      seen += await rig.frames(10);
      expect(seen, 'paused and back, the map and back, J down all along: no Spin, still charging').toMatch(/^M+H+A+H+$/);
      expect(dev()!.cw.me.charged, 'still charged').toBe(true);
      j.up();
      expect(await rig.frames(10), 'letting go of J releases the Spin').toContain('X');
    } finally {
      rig.end();
    }
  }, SLOW);

  it('Solo Tale: the K that closes the pause menu raises the Buckler while held, and never throws the Vinehook', async () => {
    const rig = await soloRig();
    try {
      const k = keyButton(rig.el, 'KeyK');
      const closeWithK = async (): Promise<string> => {
        expect(await tapKey(rig, 'Escape'), 'Escape pauses').toMatch(/M$/);
        k.down();
        const seen = await rig.frames(14);
        k.up();
        return seen + (await rig.frames(10));
      };
      rig.give('buckler');
      await rig.place(5, 4, DIR.down);
      expect(await closeWithK(), 'B raises the Buckler while held, so the K held after the menu raises it').toMatch(/^M*P*B+P+$/);
      rig.give('hook');
      expect(await tapKey(rig, 'KeyL'), 'swap picks the Vinehook').toMatch(/^P+$/);
      await rig.frames(10);
      expect(await closeWithK(), 'the Vinehook is thrown on a press, so the K that closed the menu throws nothing').toMatch(/^M*P+$/);
      expect(await tapKey(rig, 'KeyK'), 'a K of its own throws it').toContain('V');
    } finally {
      rig.end();
    }
  }, SLOW);

  /**
   * Into Pell's Sundries and up to the counter, in front of the Bark Buckler, with glints to spare.
   * Mashing J never buys; the question starts on No and says so; Up selects Yes and says so; J buys.
   */
  const shopCycle = async (rig: Rig): Promise<void> => {
    const party = rig.party();
    // Walk up through its door from (9,3) of the square.
    await rig.place(9, 3, DIR.up);
    key(rig.el, 'KeyW', 'keydown');
    for (let i = 0; i < 90 && dev()?.cw.room !== SHOP; i += 1) await rig.frames(1);
    key(rig.el, 'KeyW', 'keyup');
    expect(dev()?.cw.room).toBe(SHOP);
    await rig.frames(60);
    await rig.place(3, 3, DIR.up);
    party.purse = 100;
    const j = keyButton(rig.el, 'KeyJ');
    let seen = '';
    for (let i = 0; i < 40; i += 1) {
      j.down();
      seen += await rig.frames(3);
      j.up();
      seen += await rig.frames(3);
    }
    expect(seen, 'the question came up').toContain('C');
    expect({ purse: party.purse, buckler: party.buckler }, 'mashing J bought nothing').toEqual({ purse: 100, buckler: false });
    // Escape leaves whatever is open; then ask again, pick Yes and buy.
    for (let i = 0; i < 12 && dev()?.mode !== 'play'; i += 1) await tapKey(rig, 'Escape');
    expect(dev()?.mode).toBe('play');
    await rig.frames(30);
    for (let i = 0; i < 12 && dev()?.mode !== 'choice'; i += 1) await tapKey(rig, 'KeyJ');
    expect(dev()?.mode).toBe('choice');
    const live = rig.el.querySelector('[aria-live]');
    expect(live?.textContent, 'the question says which answer is selected').toBe('Buy it for 30 glints? Yes, No. No selected.');
    await tapKey(rig, 'KeyW');
    expect(live?.textContent, 'and which one the selection moves to').toBe('Yes selected.');
    await tapKey(rig, 'KeyJ');
    await rig.frames(30);
    expect({ purse: party.purse, buckler: party.buckler }, 'Yes buys').toEqual({ purse: 70, buckler: true });
  };

  it('Solo Tale: mashing A at the shop counter never buys, and picking Yes still does', async () => {
    const rig = await soloRig();
    try {
      await shopCycle(rig);
    } finally {
      rig.end();
    }
  }, SLOW);

  it('Party Tale: mashing A at the shop counter never buys, and picking Yes still does', async () => {
    const rig = await partyRig();
    try {
      await shopCycle(rig);
    } finally {
      rig.end();
    }
  }, SLOW);
});
