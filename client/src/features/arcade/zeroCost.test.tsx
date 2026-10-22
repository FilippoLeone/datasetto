/**
 * Zero cost when closed (plan.md §3.2 "Client: zero cost" and "signals and render"): opening and
 * closing the Arcade sheet, mounting and unmounting every stub chunk, and running a fake game at
 * full rate leave no frame subscription, timer, socket or listener behind, and game traffic writes
 * no Preact signal.
 */
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Catalog from '@/arcade/catalog';
import { fakeMeta, installFakeAudio } from './fakeGame.test-util';

vi.mock('@/arcade/catalog', async (original) => {
  const real = await original<typeof Catalog>();
  return { ...real, CATALOG: [...real.CATALOG.filter((m) => m.id !== 'fuseyard'), fakeMeta], realCatalog: real.CATALOG };
});

import * as catalog from '@/arcade/catalog';
import { frames } from '@/arcade/runtime/p0';
import { startLocalSession } from '@/arcade/runtime/session';
import { installFakeFrames, stubCanvas, trackResources, type FakeFrames } from '@/arcade/runtime/testing';
import type { MatchHost, MountOpts } from '@/arcade/runtime/types';
import { practiceWallet } from '@/arcade/runtime/practiceWallet';
import { DEFAULT_PREFS } from '@/arcade/runtime/prefs';
import { ArcadeButton } from './ArcadeButton';
import { arcadeSession, arcadeSignalWrites } from './state';

const host = document.createElement('div');
document.body.appendChild(host);

let fake: FakeFrames;
let canvas: ReturnType<typeof stubCanvas>;
let audio: ReturnType<typeof installFakeAudio>;

beforeEach(() => {
  fake = installFakeFrames();
  canvas = stubCanvas();
  audio = installFakeAudio();
});

afterEach(() => {
  act(() => render(null, host));
  arcadeSession.value = null;
  fake.restore();
  canvas.restore();
  audio.restore();
});

const until = async (check: () => boolean, label: string) => {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error('timed out waiting for ' + label);
};

const nullHost = (): MatchHost => ({
  mode: 'local',
  sendUp: () => undefined,
  sendEvent: () => undefined,
  onWelcome: () => undefined,
  onFrame: () => undefined,
  onKeyframe: () => undefined,
  onPhase: () => undefined,
  onHandover: () => undefined,
  onSeats: () => () => undefined,
  onClosed: () => undefined,
  setVisible: () => undefined,
  rttMs: () => 0,
  linkConstrained: () => false,
  estServerTick: () => 0,
  close: () => undefined,
});

const opts = (): MountOpts => ({
  mode: 'local',
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
});

describe('the Arcade costs nothing when closed', () => {
  it('opens and closes the sheet without leaving listeners or timers', async () => {
    act(() => render(<ArcadeButton channelId="c1" />, host));
    const toggle = () =>
      act(async () => {
        (host.querySelector('[data-arcade-button]') as HTMLElement).click();
      });
    // Warm-up: the first open imports the shell chunk, whose modules may install one-time listeners.
    await toggle();
    await until(() => document.querySelector('[data-arcade-sheet]') !== null, 'the sheet');
    await toggle();
    const resources = trackResources();
    const baseline = resources.live();
    await act(async () => {
      (host.querySelector('[data-arcade-button]') as HTMLElement).click();
    });
    await until(() => document.querySelector('[data-arcade-sheet]') !== null, 'the sheet');
    await act(async () => {
      (host.querySelector('[data-arcade-button]') as HTMLElement).click();
    });
    expect(document.querySelector('[data-arcade-sheet]')).toBeNull();
    const after = resources.live();
    expect(resources.listenerTypes()).toEqual({});
    expect(after).toEqual(baseline);
    expect(frames.active).toBe(0);
    resources.restore();
  });

  it('mounts and unmounts every stub chunk cleanly', async () => {
    const real = (catalog as unknown as { realCatalog: readonly catalog.GameMeta[] }).realCatalog;
    expect(real.map((m) => m.id)).toEqual(['lamplight', 'glimmer', 'fuseyard', 'bellwick']);
    // Games that have landed prove their own zero cost in their folder; this covers the stubs left.
    for (const meta of real.filter((m) => !m.ready.offline && !m.ready.online)) {
      const chunk = await meta.load();
      const el = document.createElement('div');
      const resources = trackResources();
      const handle = chunk.module.mount(el, nullHost(), opts());
      expect(el.textContent).toMatch(/coming soon/);
      handle.pause();
      handle.resume();
      handle.unmount();
      expect(el.childNodes.length).toBe(0);
      expect(resources.live()).toEqual({ timeouts: 0, intervals: 0, sockets: 0, listeners: 0 });
      resources.restore();
      expect(() => chunk.local({ mode: '', cfg: {}, seed: new Uint32Array(4), seats: [] })).toThrow();
    }
  });

  it('feeds 100 frames a second into a game without writing a signal, and releases everything', async () => {
    const resources = trackResources();
    const el = document.createElement('div');
    document.body.appendChild(el);
    const session = await startLocalSession({ meta: fakeMeta, mode: 'brawl', cfg: {}, el, onLeave: () => undefined, onMinimize: () => undefined });
    await act(async () => {
      fake.advance(200);
    });
    const before = { ...arcadeSignalWrites };
    await act(async () => {
      fake.advance(1000, 100);
    });
    expect(arcadeSignalWrites).toEqual(before);
    session.stop();
    el.remove();
    expect(frames.active).toBe(0);
    expect(fake.pending).toBe(0);
    expect(audio.closed).toBe(audio.contexts);
    const live = resources.live();
    expect(live.sockets).toBe(0);
    expect(live.timeouts).toBe(0);
    expect(live.intervals).toBe(0);
    expect(live.listeners).toBe(0);
    resources.restore();
  });
});
