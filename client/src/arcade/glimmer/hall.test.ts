/**
 * The hall in jsdom (glimmerhall.md §18.3, plan.md §3.4 "Client"): zero cost after unmount, still
 * reels schedule no frames, `arcadeWallet` written at most once per 2 s over 100 online spins,
 * hidden stops audio, bots, auto-spin and the Dash clock (and sends `glimmer:away` online), Space
 * is skipped when it is the push-to-talk key, `pointercancel` cancels a spin, the 700 ms floor
 * holds, and the gamepad poll exists only while a pad is connected. Virtual time throughout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seededRng } from '@arcade/core/glimmer/golden';
import { arcadeActivity, arcadeLobby, arcadeSession, arcadeWallet } from '@/features/arcade/state';
import { installFakeAudio } from '@/features/arcade/fakeGame.test-util';
import { createLocalTableHost } from '@/arcade/runtime/net/localHost';
import { frames } from '@/arcade/runtime/p0';
import { createPracticeWallet } from '@/arcade/runtime/practiceWallet';
import { DEFAULT_PREFS } from '@/arcade/runtime/prefs';
import { installFakeFrames, stubCanvas, trackResources, type FakeFrames } from '@/arcade/runtime/testing';
import type { GameHandle, KeyBinding, MountOpts, PracticeWallet, TableHost } from '@/arcade/runtime/types';
import { createLocalHall, type LocalHall } from './hosts/local';
import chunk from './index';
import { saveGlimmerPrefs, DEFAULT_GLIMMER_PREFS } from './store';

let fake: FakeFrames;
let canvas: ReturnType<typeof stubCanvas>;
let audio: ReturnType<typeof installFakeAudio>;
let rafCalls = 0;
const created: HTMLCanvasElement[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  fake = installFakeFrames();
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = (cb) => {
    rafCalls += 1;
    return raf(cb);
  };
  canvas = stubCanvas();
  audio = installFakeAudio();
  HTMLCanvasElement.prototype.toDataURL = () => 'data:,';
  const make = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, o?: ElementCreationOptions) => {
    const el = make(tag, o);
    if (tag === 'canvas') created.push(el as HTMLCanvasElement);
    return el;
  }) as typeof document.createElement);
  localStorage.clear();
  // Skip the first-open card.
  saveGlimmerPrefs({ ...DEFAULT_GLIMMER_PREFS, notice: true, steps: [0, 0, 0] });
  created.length = 0;
  rafCalls = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  fake.restore();
  canvas.restore();
  audio.restore();
  vi.useRealTimers();
  document.body.replaceChildren();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

/** Advance frames and timers together. */
const step = async (ms: number, fps = 30): Promise<void> => {
  for (let t = 0; t < ms; t += 50) {
    fake.advance(50, fps);
    vi.advanceTimersByTime(50);
    await flush();
  }
};

const shell = (practice: PracticeWallet, log: string[] = []) => ({
  status: (s: string) => log.push('status:' + s),
  attention: () => undefined,
  wakeLock: (on: boolean) => log.push('wake:' + on),
  minimize: () => log.push('minimize'),
  leave: () => log.push('leave'),
  idleAway: (ms: number | null) => log.push('idle:' + ms),
  names: (ids: readonly string[]) => ids.map((id) => 'Name ' + id.slice(-2)),
  practice,
});

const mountWith = (o: { mode: 'local' | 'remote'; ptt?: KeyBinding | null; reduced?: boolean }) => {
  const key = 'test.gh.' + Math.random();
  const wallet = createPracticeWallet(key);
  const local: LocalHall = createLocalHall({ wallet, rng: seededRng(5), storeKey: key + '.g' });
  const calls: string[] = [];
  let table: TableHost;
  if (o.mode === 'local') {
    const inner = createLocalTableHost(local);
    table = { ...inner, request: (ev, data, opts) => (calls.push(ev), inner.request(ev, data, opts)) };
  } else {
    const listeners = new Map<string, Set<(d: unknown) => void>>();
    local.attach((ev, d) => listeners.get(ev)?.forEach((cb) => cb(d)));
    table = {
      mode: 'remote',
      request: <T,>(ev: string, data: unknown) => (calls.push(ev), local.request(ev, data) as Promise<T>),
      on(ev, cb) {
        const set = listeners.get(ev) ?? new Set();
        listeners.set(ev, set);
        set.add(cb);
        return () => set.delete(cb);
      },
      connected: () => true,
      onConnection: () => () => undefined,
      ackRttMs: () => 0,
      setVisible: (v) => local.setVisible(v),
      close: () => local.dispose(),
    };
  }
  const el = document.createElement('div');
  document.body.append(el);
  const log: string[] = [];
  const opts: MountOpts = {
    mode: o.mode,
    lobby: null,
    me: { accountId: null, slot: 0 },
    prefs: DEFAULT_PREFS,
    ptt: o.ptt ?? null,
    reserved: [],
    reducedMotion: o.reduced ?? false,
    coarse: false,
    shell: shell(wallet, log),
  };
  const handle: GameHandle = chunk.module.mount(el, table, opts);
  const q = <T extends Element>(sel: string): T => el.querySelector(sel) as T;
  const press = (target: Element, type: string, init: PointerEventInit = {}) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, ...init }));
  const tap = (target: Element) => {
    press(target, 'pointerdown');
    press(target, 'pointerup');
  };
  const spinText = () => q('.gh-spin').textContent;
  const waitIdle = async (limit = 6000) => {
    for (let t = 0; t < limit; t += 50) {
      if (spinText() === 'SPIN' && !q('.gh-spin').classList.contains('busy')) return true;
      await step(50);
    }
    return false;
  };
  return { el, handle, table, local, calls, log, wallet, q, tap, press, spinText, waitIdle };
};

describe('Glimmerhall in jsdom', () => {
  it('hashes the golden replay to the same value as the server suite', async () => {
    const { goldenHash } = await import('@arcade/core/glimmer/golden');
    expect(goldenHash(0x61177e12, 10_000)).toBe(0x6562190a);
  });

  it('costs nothing after unmount, and still reels schedule no frames', async () => {
    // jsdom's selector engine adds its own window listeners on the first query: warm it up first.
    document.querySelector('body > .warm-up');
    const resources = trackResources();
    const h = mountWith({ mode: 'local' });
    await step(400);
    expect(h.q('.gh canvas')).not.toBeNull();
    // Still reels for 5 s: no frame is asked for (bots only touch the DOM).
    await step(600);
    rafCalls = 0;
    await step(5000);
    expect(rafCalls).toBe(0);
    expect(frames.active).toBe(0);
    // Unlock audio, spin once, open and close a sheet.
    h.press(h.q('.gh'), 'pointerdown');
    await step(100);
    h.tap(h.q('.gh-spin'));
    expect(await h.waitIdle()).toBe(true);
    h.tap(h.q('.gh-round'));
    expect(h.q('.gh-card')).not.toBeNull();
    expect(h.handle.back?.()).toBe(true);
    expect(h.q('.gh-card')).toBeNull();
    expect(audio.contexts).toBe(1);
    h.handle.unmount();
    h.table.close();
    await flush();
    expect(frames.active).toBe(0);
    expect(fake.pending).toBe(0);
    expect(audio.closed).toBe(audio.contexts);
    expect(resources.listenerTypes()).toEqual({});
    expect(resources.live()).toEqual({ timeouts: 0, intervals: 0, sockets: 0, listeners: 0 });
    expect(h.el.childNodes.length).toBe(0);
    expect(created.length).toBeGreaterThan(0);
    for (const c of created) expect([c.width, c.height]).toEqual([0, 0]);
    expect(h.log).toContain('idle:600000');
    expect(h.log).toContain('idle:null');
    resources.restore();
  });

  it('writes arcadeWallet at most once per 2 s over 100 online spins, and no other signal', async () => {
    const writes: number[] = [];
    const other: string[] = [];
    const offs = [
      arcadeWallet.subscribe(() => writes.push(Date.now())),
      arcadeSession.subscribe(() => other.push('session')),
      arcadeLobby.subscribe(() => other.push('lobby')),
      arcadeActivity.subscribe(() => other.push('activity')),
    ];
    writes.length = 0;
    other.length = 0;
    const h = mountWith({ mode: 'remote', reduced: true });
    await step(400);
    const start = Date.now();
    let spins = 0;
    for (let i = 0; i < 100; i += 1) {
      h.tap(h.q('.gh-spin'));
      if (!(await h.waitIdle(60_000))) break;
      // A vault: open a door and let it settle.
      if (h.spinText() === 'OPEN' || !h.q<HTMLElement>('.gh-hits').hidden) {
        h.tap(h.el.querySelectorAll('.gh-hits button')[0] as Element);
        await h.waitIdle(20_000);
      }
      spins += 1;
      await step(700);
    }
    await step(2100);
    expect(spins).toBe(100);
    expect(h.calls.filter((c) => c === 'glimmer:spin').length).toBe(100);
    const elapsed = Date.now() - start;
    for (let i = 1; i < writes.length; i += 1) expect(writes[i]! - writes[i - 1]!).toBeGreaterThanOrEqual(2000);
    expect(writes.length).toBeLessThanOrEqual(Math.ceil(elapsed / 2000) + 1);
    expect(arcadeWallet.peek()?.bal).toBe(h.wallet.balance());
    expect(other).toEqual([]);
    h.handle.unmount();
    h.table.close();
    for (const off of offs) off();
    arcadeWallet.value = null;
  }, 20_000);

  it('hidden: audio suspended, auto-spin and bots stopped, the Dash clock frozen; online sends glimmer:away', async () => {
    const h = mountWith({ mode: 'local', reduced: true });
    await step(400);
    h.press(h.q('.gh'), 'pointerdown');
    await step(100);
    // Start auto-spin from its sheet.
    h.tap(h.q('.gh-auto'));
    const start = [...h.el.querySelectorAll('.gh-go')].find((b) => b.textContent === 'Start') as HTMLButtonElement;
    start.click();
    await step(500);
    expect(h.log).toContain('wake:true');
    expect(h.q('.gh-auto').classList.contains('on')).toBe(true);
    // An offline Dash running in the background.
    const created = (await h.table.request('glimmer:dash:create', { m: 1, len: 5, buy: 0 })) as { dash: { id: string } };
    await h.table.request('glimmer:dash:start', { id: created.dash.id });
    await step(2000);
    // The platform hides the stage: host first, then the game.
    const suspend = vi.spyOn((window as unknown as { AudioContext: { prototype: AudioContext } }).AudioContext.prototype, 'suspend');
    h.table.setVisible(false);
    h.handle.pause();
    expect(suspend).toHaveBeenCalled();
    await step(1500);
    expect(h.q('.gh-auto').classList.contains('on')).toBe(false);
    expect(h.log).toContain('wake:false');
    expect(h.local.debug.timers()).toBe(0);
    const t = h.local.debug.dash()?.t;
    const spinsBefore = h.calls.filter((c) => c === 'glimmer:spin').length;
    rafCalls = 0;
    await step(10_000);
    expect(h.local.debug.dash()?.t).toBe(t);
    expect(h.calls.filter((c) => c === 'glimmer:spin').length).toBe(spinsBefore);
    expect(rafCalls).toBe(0);
    expect(frames.active).toBe(0);
    expect(h.q('.gh-paused')?.textContent).toBe('Paused · tap to return');
    h.table.setVisible(true);
    h.handle.resume();
    expect(h.q('.gh-paused')).toBeNull();
    expect(h.local.debug.timers()).toBeGreaterThan(0);
    h.handle.unmount();
    h.table.close();

    const r = mountWith({ mode: 'remote' });
    await step(400);
    r.handle.pause();
    expect(r.calls).toContain('glimmer:away');
    r.handle.resume();
    await step(100);
    expect(r.calls.filter((c) => c === 'glimmer:enter').length).toBe(2);
    r.handle.unmount();
    r.table.close();
  });

  it('skips Space when it is the push-to-talk key; Enter still spins', async () => {
    const h = mountWith({ mode: 'remote', ptt: { code: 'Space', ctrl: false, shift: false, alt: false, meta: false }, reduced: true });
    await step(400);
    const root = h.q('.gh');
    root.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
    await step(100);
    expect(h.calls).not.toContain('glimmer:spin');
    root.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true }));
    await step(50);
    expect(h.calls.filter((c) => c === 'glimmer:spin').length).toBe(1);
    h.handle.unmount();
    h.table.close();
  });

  it('cancels a press on pointercancel and keeps 700 ms between spins', async () => {
    const h = mountWith({ mode: 'remote', reduced: true });
    await step(400);
    const spin = h.q('.gh-spin');
    h.press(spin, 'pointerdown');
    h.press(spin, 'pointercancel');
    h.press(spin, 'pointerup');
    await step(100);
    expect(h.calls).not.toContain('glimmer:spin');
    h.tap(spin);
    expect(await h.waitIdle()).toBe(true);
    // Settled in under 700 ms (reduced motion): a tap now is ignored.
    h.tap(spin);
    await flush();
    expect(h.calls.filter((c) => c === 'glimmer:spin').length).toBe(1);
    await step(700);
    h.tap(spin);
    await flush();
    expect(h.calls.filter((c) => c === 'glimmer:spin').length).toBe(2);
    h.handle.unmount();
    h.table.close();
  });

  it('polls a gamepad at 10 Hz only while one is connected and the hall is visible', async () => {
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [] });
    const h = mountWith({ mode: 'local' });
    await step(800);
    expect(frames.active).toBe(0);
    const labels = (): string[] => (window as unknown as { __frames: { subscribers: string[] } }).__frames.subscribers;
    expect(labels()).not.toContain('glimmer-pad');
    window.dispatchEvent(new Event('gamepadconnected'));
    expect(labels()).toEqual(['glimmer-pad']);
    h.handle.pause();
    expect(labels()).toEqual([]);
    h.handle.resume();
    expect(labels()).toContain('glimmer-pad');
    window.dispatchEvent(new Event('gamepaddisconnected'));
    await step(100);
    expect(labels()).toEqual([]);
    expect(frames.active).toBe(0);
    h.handle.unmount();
    h.table.close();
  });
});
