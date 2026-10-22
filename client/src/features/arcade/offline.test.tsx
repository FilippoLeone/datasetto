/**
 * Offline play (plan.md §3.2 "Offline"): the overlay mounts from the sign-in screen while fetch
 * rejects and the socket never connects, a game starts against bots, and closing it releases
 * everything (the zero-cost rule, platform.md §10.2).
 */
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Catalog from '@/arcade/catalog';
import { fakeLog, fakeMeta, installFakeAudio } from './fakeGame.test-util';

vi.mock('@/arcade/catalog', async (original) => {
  const real = await original<typeof Catalog>();
  return { ...real, CATALOG: [fakeMeta], metaOf: (id: string) => (id === fakeMeta.id ? fakeMeta : null) };
});

import { AuthScreen } from '@/features/auth/AuthScreen';
import { frames } from '@/arcade/runtime/p0';
import { installFakeFrames, stubCanvas, trackResources, type FakeFrames } from '@/arcade/runtime/testing';
import { ArcadeHost } from './ArcadeHost';
import { arcadeSession, arcadeView } from './state';

const host = document.createElement('div');
document.body.appendChild(host);

let fake: FakeFrames;
let canvas: ReturnType<typeof stubCanvas>;
let audio: ReturnType<typeof installFakeAudio>;

beforeEach(() => {
  fake = installFakeFrames();
  canvas = stubCanvas();
  audio = installFakeAudio();
  vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
});

afterEach(() => {
  act(() => render(null, host));
  arcadeView.value = null;
  arcadeSession.value = null;
  fake.restore();
  canvas.restore();
  audio.restore();
  vi.unstubAllGlobals();
});

const click = async (selector: string) => {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) throw new Error('missing ' + selector);
  await act(async () => {
    el.click();
  });
};

const until = async (check: () => boolean, label: string) => {
  for (let i = 0; i < 50; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error('timed out waiting for ' + label);
};

describe('offline play from the sign-in screen', () => {
  it('starts a game against bots with no server and leaves nothing running when closed', async () => {
    act(() =>
      render(
        <>
          <AuthScreen resuming={false} />
          <ArcadeHost />
        </>,
        host,
      ),
    );
    const resources = trackResources();
    const baseline = resources.live();

    await click('[data-play-offline]');
    await until(() => document.querySelector('[data-arcade-tile]') !== null, 'the catalogue');
    await click('[data-arcade-tile="fuseyard"]');
    await click('[data-arcade-start]');
    await until(() => fakeLog.mounted === 1, 'the game to mount');
    expect(arcadeSession.value).toMatchObject({ game: 'fuseyard', mode: 'local' });

    // Play: the local host steps the core and the game gets frames.
    await act(async () => {
      fake.advance(500);
    });
    expect(fakeLog.frames).toBeGreaterThan(10);
    expect(arcadeSession.value?.status).toBe('live');
    expect(audio.contexts).toBe(1);

    // Leave the game, then close the Arcade.
    await click('[aria-label="Leave game"]');
    expect(fakeLog.unmounted).toBe(1);
    expect(arcadeView.value).toBeNull();
    expect(arcadeSession.value).toBeNull();
    await act(async () => {
      fake.advance(100);
    });

    expect(frames.active).toBe(0);
    expect(fake.pending).toBe(0);
    expect(audio.closed).toBe(1);
    expect(fakeLog.canvases.every((c) => c.canvas.width === 0 && c.canvas.height === 0 && !c.canvas.isConnected)).toBe(true);
    const after = resources.live();
    expect(after.sockets).toBe(0);
    expect(after.intervals).toBe(baseline.intervals);
    expect(after.timeouts).toBe(baseline.timeouts);
    expect(after.listeners).toBe(baseline.listeners);
    expect(document.querySelector('[data-arcade-overlay]')).toBeNull();
    resources.restore();
  });
});
