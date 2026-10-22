/**
 * Client: signals and render (plan.md §3.2): with the server coalescing a burst of 100 lobby and
 * activity changes a second, the bindings write each platform signal once per push and at most
 * twice a second; 100 game frames a second write no signal at all; the voice page renders once
 * while frames flow; and lobby or activity updates change no route, play no sound, open no toast
 * and change nobody's view.
 */
import type { Signal } from '@preact/signals';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const counters = vi.hoisted(() => ({ voicePage: 0, sounds: [] as unknown[] }));

vi.mock('@/services/socket/client', async () => (await import('./online.test-util')).socketModule);
vi.mock('@/arcade/runtime/net/remoteHost', async () => (await import('./online.test-util')).remoteHostModule);
vi.mock('@/arcade/catalog', async (original) => {
  const real = (await original()) as object;
  const util = await import('./online.test-util');
  return { ...real, CATALOG: util.ONLINE_CATALOG, metaOf: (id: string) => util.ONLINE_CATALOG.find((meta) => meta.id === id) ?? null };
});
vi.mock('@/services/sounds', () => ({ sounds: { play: (...args: unknown[]) => void counters.sounds.push(args) } }));
vi.mock('@/features/voice/voiceManager', () => ({ voiceManager: new Proxy({}, { get: () => async () => undefined }) }));
// Rendered by the voice page on every one of its renders: a render counter for VoicePage.
vi.mock('@/features/arcade/ArcadeButton', () => ({
  ArcadeButton: () => {
    counters.voicePage += 1;
    return null;
  },
}));

import { installFakeFrames, stubCanvas, type FakeFrames } from '@/arcade/runtime/testing';
import { VoicePage } from '@/features/voice/VoicePage';
import { selectedChannelId } from '@/state/channels';
import { users } from '@/state/presence';
import { account, authStatus } from '@/state/session';
import { modal, toasts } from '@/state/ui';
import { voiceChannelId, voiceStatus } from '@/state/voice';
import type { Account, Channel, User } from '@/types/protocol';
import { enterLobby, installArcadeBindings } from './bindings';
import { fakeLog, installFakeAudio } from './fakeGame.test-util';
import { entry, fakeRemote, fakeSocket, lobbyView, until } from './online.test-util';
import { startStage, stopStage } from './remote';
import {
  arcadeActivity,
  arcadeConfig,
  arcadeHidden,
  arcadeInvites,
  arcadeLobby,
  arcadeSession,
  arcadeSignalWrites,
  arcadeStage,
  arcadeView,
  arcadeWallet,
} from './state';

const host = document.createElement('div');
document.body.appendChild(host);

const me = { id: 'me', username: 'me', displayName: 'Me', roles: ['user'], status: 'active' } as Account;
const person = (accountId: string): User => ({ id: 'socket-' + accountId, accountId, username: accountId, displayName: accountId, roles: ['user'], isSuperuser: false, voiceChannel: 'c1' });
const channel = { id: 'c1', name: 'Lounge', type: 'voice' } as Channel;

const SIGNALS: Record<string, Signal<unknown>> = { arcadeActivity, arcadeLobby, arcadeSession, arcadeWallet, arcadeConfig, arcadeHidden, arcadeInvites, arcadeStage } as Record<string, Signal<unknown>>;

/** Timestamps (Date.now) of every write to each platform signal from now on. */
const recordWrites = () => {
  const writes: Record<string, number[]> = {};
  const offs = Object.entries(SIGNALS).map(([name, sig]) => {
    let first = true;
    writes[name] = [];
    return sig.subscribe(() => {
      if (first) first = false;
      else writes[name]!.push(Date.now());
    });
  });
  return { writes, stop: () => offs.forEach((off) => off()) };
};

/** The most writes inside any one second. */
const peakPerSecond = (times: readonly number[]): number => times.reduce((peak, t, i) => Math.max(peak, times.slice(i).filter((u) => u < t + 1000).length), 0);

let lobbyCounter = 0;
const nextId = (): string => 'S' + (lobbyCounter += 1);

let fake: FakeFrames;
let canvas: ReturnType<typeof stubCanvas>;
let audio: ReturnType<typeof installFakeAudio>;

beforeAll(() => installArcadeBindings());

beforeEach(() => {
  fake = installFakeFrames();
  canvas = stubCanvas();
  audio = installFakeAudio();
  account.value = me;
  authStatus.value = 'authenticated';
  users.value = [person('me'), person('sam')];
  voiceStatus.value = 'connected';
  voiceChannelId.value = 'c1';
  fakeSocket.reset();
  fakeSocket.responders.set('arcade:lobby:leave', () => ({ ok: true }));
  fakeRemote.hosts.length = 0;
});

afterEach(() => {
  act(() => render(null, host));
  stopStage();
  arcadeLobby.value = null;
  arcadeActivity.value = new Map();
  arcadeInvites.value = [];
  arcadeSession.value = null;
  vi.useRealTimers();
  fake.restore();
  canvas.restore();
  audio.restore();
});

/** Run the lobby's game on the stage with the fake remote host and the fake game, welcomed and live. */
const startLiveStage = async (rendered: () => boolean) => {
  const lobby = lobbyView({ id: nextId(), st: 'live' });
  const mounted = fakeLog.mounted;
  enterLobby(lobby, 'player');
  startStage(lobby, 'player', 'ticket');
  await until(act, () => fakeRemote.hosts.length > 0 && fakeLog.mounted > mounted && rendered(), 'the game to mount');
  const remote = fakeRemote.hosts[fakeRemote.hosts.length - 1]!;
  await act(async () => {
    remote.welcome();
    fake.advance(200);
  });
  return remote;
};

describe('platform signals', () => {
  it('are written once per coalesced server push and never more than twice a second', () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const id = nextId();
    enterLobby(lobbyView({ id }), 'player');
    const { writes, stop } = recordWrites();
    const pushed = { lobby: 0, activity: 0, wallet: 0 };
    let version = 1;
    let players = 1;
    let chips = 20_000;
    let lastLobby = -Infinity;
    let lastActivity = -Infinity;
    let lastWallet = -Infinity;
    // Five seconds of 100 changes a second, published the way the hub and the wallet coalesce them:
    // the lobby at most every 500 ms, activity and the wallet at most every 2 s.
    for (let t = 0; t < 5000; t += 10) {
      version += 1;
      players = (players % 3) + 1;
      chips += 1;
      if (t - lastLobby >= 500) {
        lastLobby = t;
        pushed.lobby += 1;
        const seats = [{ a: 'me', bot: false, st: 0 }, ...Array.from({ length: 3 }, (_, i) => ({ a: i < players - 1 ? 'p' + i : null, bot: false, st: 0 }))];
        fakeSocket.push('arcade:lobby', lobbyView({ id, v: version, seats }));
      }
      if (t - lastActivity >= 2000) {
        lastActivity = t;
        pushed.activity += 1;
        fakeSocket.push('arcade:activity', { ch: 'c1', a: [entry({ id, n: (pushed.activity % 3) + 1 })] });
        fakeSocket.push('arcade:activity', { ch: 'c2', a: [entry({ id: 'other', n: (pushed.activity % 2) + 1 })] });
      }
      if (t - lastWallet >= 2000) {
        lastWallet = t;
        pushed.wallet += 1;
        fakeSocket.push('arcade:wallet', { bal: chips, esc: 0, claim: false });
      }
      vi.advanceTimersByTime(10);
    }
    expect(writes.arcadeLobby).toHaveLength(pushed.lobby);
    expect(writes.arcadeActivity).toHaveLength(pushed.activity * 2);
    expect(writes.arcadeWallet).toHaveLength(pushed.wallet);
    for (const name of Object.keys(SIGNALS)) {
      const peak = peakPerSecond(writes[name]!);
      if (peak > 2) throw new Error(name + ' was written ' + peak + ' times in one second');
    }

    // A repeated or stale push writes nothing.
    const counts = Object.fromEntries(Object.entries(writes).map(([name, list]) => [name, list.length]));
    fakeSocket.push('arcade:lobby', arcadeLobby.peek());
    fakeSocket.push('arcade:lobby', { ...arcadeLobby.peek()!, v: 1 });
    fakeSocket.push('arcade:activity', { ch: 'c1', a: arcadeActivity.peek().get('c1') });
    fakeSocket.push('arcade:wallet', { ...arcadeWallet.peek()! });
    fakeSocket.push('arcade:prefs', { hidden: false, games: {}, reenableAt: null });
    fakeSocket.push('arcade:prefs', { hidden: false, games: {}, reenableAt: null });
    fakeSocket.push('arcade:config', { enabled: true, games: { fuseyard: true }, proto: { lamplight: 1 }, defs: { glimmer: 1 } });
    fakeSocket.push('arcade:config', { enabled: true, games: { fuseyard: true }, proto: { lamplight: 1 }, defs: { glimmer: 1 } });
    expect(Object.fromEntries(Object.entries(writes).map(([name, list]) => [name, list.length]))).toEqual({ ...counts, arcadeHidden: counts.arcadeHidden! + 1, arcadeConfig: counts.arcadeConfig! + 1 });
    stop();
  });

  it('are not written by 100 game frames a second', async () => {
    const remote = await startLiveStage(() => true);
    const before = { ...arcadeSignalWrites };
    const frames = fakeLog.frames;
    await act(async () => {
      for (let i = 0; i < 200; i += 1) {
        remote.frame();
        fake.advance(10, 100);
      }
    });
    expect(fakeLog.frames - frames).toBe(200);
    expect(arcadeSignalWrites).toEqual(before);
  });
});

describe('the voice page', () => {
  it('renders once while game frames flow', async () => {
    act(() => render(<VoicePage channel={channel} />, host));
    const remote = await startLiveStage(() => host.querySelector('[data-arcade-game-stage] [data-arcade-stage]') !== null);
    expect(host.querySelector('[data-voice-strip]')).not.toBeNull();
    const renders = counters.voicePage;
    expect(renders).toBeGreaterThan(0);
    const frames = fakeLog.frames;
    await act(async () => {
      for (let i = 0; i < 100; i += 1) {
        remote.frame();
        fake.advance(10, 100);
      }
    });
    expect(fakeLog.frames - frames).toBe(100);
    expect(counters.voicePage).toBe(renders);
  });

  it('changes no route, plays no sound, opens no toast and changes no view on lobby and activity updates', async () => {
    selectedChannelId.value = 'c1';
    const href = window.location.href;
    const pushState = vi.spyOn(window.history, 'pushState');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    act(() => render(<VoicePage channel={channel} />, host));
    const renders = counters.voicePage;
    await act(async () => {
      // Someone else starts games here and elsewhere, plays, ends; someone invites you; chips move.
      fakeSocket.push('arcade:activity', { ch: 'c1', a: [entry({ id: 'theirs', st: 'lobby' })] });
      fakeSocket.push('arcade:activity', { ch: 'c1', a: [entry({ id: 'theirs', st: 'live', n: 4 })] });
      fakeSocket.push('arcade:activity:all', { chs: [{ ch: 'c1', a: [entry({ id: 'theirs', st: 'live' })] }, { ch: 'c2', a: [entry({ id: 'far' })] }] });
      fakeSocket.push('arcade:lobby', lobbyView({ id: 'not-mine', host: 'sam', st: 'live', seats: [{ a: 'sam', bot: false, st: 0 }] }));
      fakeSocket.push('arcade:lobby', lobbyView({ id: 'not-mine', host: 'sam', st: 'ended', v: 9 }));
      fakeSocket.push('arcade:invited', { id: 'theirs', from: 'sam', game: 'fuseyard' });
      fakeSocket.push('arcade:wallet', { bal: 5, esc: 0, claim: true });
    });
    expect(host.querySelector('[data-arcade-chip="theirs"]')).not.toBeNull();
    expect(host.querySelector('[data-arcade-invite="theirs"]')).not.toBeNull();
    expect(counters.sounds).toEqual([]);
    expect(toasts.value).toEqual([]);
    expect(modal.value).toBeNull();
    expect(window.location.href).toBe(href);
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(selectedChannelId.value).toBe('c1');
    expect(arcadeStage.value).toBeNull();
    expect(arcadeSession.value).toBeNull();
    expect(arcadeView.value).toBeNull();
    expect(arcadeLobby.value).toBeNull();
    expect(host.querySelector('[data-arcade-game-stage]')).toBeNull();
    // The chips are their own component: the page itself did not re-render.
    expect(counters.voicePage).toBe(renders);
    pushState.mockRestore();
    replaceState.mockRestore();
  });
});
