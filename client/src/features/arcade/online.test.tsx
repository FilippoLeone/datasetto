/**
 * The online shell (plan.md §3.2 "Layout", platform.md §9.2, §10.6): starting a game from the sheet
 * sends the create request and the host's Start opens the stage; Join and Watch send the join
 * request; the voice header's chips come from `arcadeActivity` and vanish with Hide Arcade; an
 * invite chip expires after 60 s; a remote session with a fake host mounts in GameStage and leaves
 * no timer or listener behind; touch targets are ≥ 44 px and nothing is wider than 360 px.
 */
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/socket/client', async () => (await import('./online.test-util')).socketModule);
vi.mock('@/arcade/runtime/net/remoteHost', async () => (await import('./online.test-util')).remoteHostModule);
vi.mock('@/arcade/catalog', async (original) => {
  const real = (await original()) as object;
  const util = await import('./online.test-util');
  return { ...real, CATALOG: util.ONLINE_CATALOG, metaOf: (id: string) => util.ONLINE_CATALOG.find((meta) => meta.id === id) ?? null };
});

import { frames } from '@/arcade/runtime/p0';
import { installFakeFrames, stubCanvas, trackResources, type FakeFrames } from '@/arcade/runtime/testing';
import { users } from '@/state/presence';
import { account, authStatus } from '@/state/session';
import { voiceChannelId, voiceStatus } from '@/state/voice';
import type { Account, User } from '@/types/protocol';
import { ArcadeSheet } from './ArcadeSheet';
import { enterLobby, installArcadeBindings, INVITE_MS } from './bindings';
import { fakeLog, installFakeAudio } from './fakeGame.test-util';
import { GameStage } from './GameStage';
import { ArcadeChips } from './LobbyChip';
import { entry, fakeRemote, fakeSocket, lobbyView, TALL, until, wideClasses } from './online.test-util';
import { leaveCurrent, startStage, stopStage } from './remote';
import { arcadeActivity, arcadeHidden, arcadeInvites, arcadeLobby, arcadeSession, arcadeStage } from './state';

const host = document.createElement('div');
document.body.appendChild(host);

const me: Account = { id: 'me', username: 'me', displayName: 'Me', roles: ['user'], status: 'active' } as Account;
const person = (accountId: string, name: string): User => ({ id: 'socket-' + accountId, accountId, username: accountId, displayName: name, roles: ['user'], isSuperuser: false, voiceChannel: 'c1' });

let lobbyCounter = 0;
const nextId = (): string => 'L' + (lobbyCounter += 1);

beforeAll(() => installArcadeBindings());

let fake: FakeFrames;
let canvas: ReturnType<typeof stubCanvas>;
let audio: ReturnType<typeof installFakeAudio>;

beforeEach(() => {
  fake = installFakeFrames();
  canvas = stubCanvas();
  audio = installFakeAudio();
  account.value = me;
  authStatus.value = 'authenticated';
  users.value = [person('me', 'Me'), person('sam', 'Sam'), person('kim', 'Kim')];
  voiceStatus.value = 'connected';
  voiceChannelId.value = 'c1';
  fakeSocket.reset();
  fakeRemote.hosts.length = 0;
});

afterEach(() => {
  act(() => render(null, host));
  stopStage();
  const lobby = arcadeLobby.peek();
  if (lobby) arcadeLobby.value = null;
  arcadeActivity.value = new Map();
  arcadeHidden.value = null;
  arcadeInvites.value = [];
  arcadeSession.value = null;
  vi.useRealTimers();
  fake.restore();
  canvas.restore();
  audio.restore();
});

const click = async (selector: string) => {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) throw new Error('missing ' + selector);
  await act(async () => {
    el.click();
  });
};

const buttonByText = (root: ParentNode, text: string): HTMLButtonElement => {
  const found = Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error('no button "' + text + '"');
  return found;
};

describe('the Arcade sheet online', () => {
  it('starts a game: create, bots, Start, and the stage opens when the server says it is live', async () => {
    const id = nextId();
    fakeSocket.responders.set('arcade:lobby:create', () => ({ ok: true, lobby: lobbyView({ id }) }));
    fakeSocket.responders.set('arcade:lobby:bots', () => ({ ok: true }));
    fakeSocket.responders.set('arcade:lobby:start', () => ({ ok: true }));
    fakeSocket.responders.set('arcade:ticket', () => ({ ok: true, ticket: 'ticket-1', exp: 0 }));
    fakeSocket.responders.set('arcade:lobby:leave', () => ({ ok: true }));
    const onClose = vi.fn();
    act(() => render(<ArcadeSheet channelId="c1" anchor={null} onClose={onClose} />, host));

    await click('[data-arcade-row="start-fuseyard"]');
    expect(document.querySelector('[data-arcade-setup="fuseyard"]')).not.toBeNull();
    await click('[data-arcade-create]');
    await until(act, () => document.querySelector('[data-arcade-lobby="' + id + '"]') !== null, 'the lobby panel');
    expect(fakeSocket.sent('arcade:lobby:create')).toEqual([{ ch: 'c1', game: 'fuseyard', mode: 'brawl', cfg: { fighters: 4 } }]);
    expect(arcadeLobby.value?.id).toBe(id);

    // One human: Start waits for a second seat (a bot here).
    const start = document.querySelector('[data-arcade-start-lobby]') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    await click('[aria-label="More bots"]');
    expect(fakeSocket.sent('arcade:lobby:bots')).toEqual([{ id, count: 1, level: 1 }]);
    await until(act, () => !(document.querySelector('[data-arcade-start-lobby]') as HTMLButtonElement).disabled, 'Start enabled');
    await click('[data-arcade-start-lobby]');
    expect(fakeSocket.sent('arcade:lobby:start')).toEqual([{ id }]);

    // The server starts the match: the stage opens on this screen and the sheet gets out of the way.
    await act(async () => {
      fakeSocket.push('arcade:lobby', lobbyView({ id, st: 'live', v: 2, seats: [{ a: 'me', bot: false, st: 0 }, { a: null, bot: true, st: 0 }] }));
    });
    await until(act, () => fakeRemote.hosts.length === 1, 'the remote host');
    expect(fakeRemote.hosts[0]?.args).toEqual({ lobbyId: id, ticket: 'ticket-1', game: 'fuseyard' });
    expect(arcadeStage.value).toMatchObject({ lobbyId: id, ch: 'c1', role: 'player', error: null });
    expect(onClose).toHaveBeenCalled();
    leaveCurrent();
    expect(fakeSocket.sent('arcade:lobby:leave')).toEqual([{ id }]);
    expect(arcadeLobby.value).toBeNull();
  });

  it('joins a seat and watches from the channel list, and invites a voice member', async () => {
    const id = nextId();
    arcadeActivity.value = new Map([['c1', [entry({ id })]]]);
    fakeSocket.responders.set('arcade:lobby:join', (p) => ({ ok: true, lobby: lobbyView({ id, host: 'sam', seats: [{ a: 'sam', bot: false, st: 0 }, { a: (p as { as: string }).as === 'player' ? 'me' : null, bot: false, st: 0 }] }) }));
    fakeSocket.responders.set('arcade:invite', () => ({ ok: true }));
    act(() => render(<ArcadeSheet channelId="c1" anchor={null} onClose={() => undefined} />, host));

    await click('[data-arcade-watch="' + id + '"]');
    expect(fakeSocket.sent('arcade:lobby:join')).toEqual([{ id, as: 'spectator' }]);
    await until(act, () => arcadeLobby.value?.id === id, 'the lobby');

    // Back out and take a seat instead.
    arcadeLobby.value = null;
    await act(async () => undefined);
    await click('[data-arcade-join="' + id + '"]');
    expect(fakeSocket.sent('arcade:lobby:join')[1]).toEqual({ id, as: 'player' });
    await until(act, () => document.querySelector('[data-arcade-lobby="' + id + '"]') !== null, 'the lobby panel');
    expect(document.querySelector('[data-arcade-lobby]')?.textContent).toContain('Waiting for the host to start');

    await click('[data-arcade-invite-open]');
    expect(document.querySelector('[data-arcade-invite-to="sam"]')).toBeNull();
    await click('[data-arcade-invite-to="kim"]');
    expect(fakeSocket.sent('arcade:invite')).toEqual([{ id, to: 'kim' }]);
    await until(act, () => document.body.textContent?.includes('Invited') ?? false, 'the invited mark');
  });

  it('shows a refusal in the sheet instead of a toast', async () => {
    arcadeActivity.value = new Map([['c1', [entry({ id: 'full-one' })]]]);
    fakeSocket.responders.set('arcade:lobby:join', () => ({ ok: false, code: 'full' }));
    act(() => render(<ArcadeSheet channelId="c1" anchor={null} onClose={() => undefined} />, host));
    await click('[data-arcade-join="full-one"]');
    await until(act, () => document.querySelector('[data-arcade-error]') !== null, 'the error');
    expect(document.querySelector('[data-arcade-error]')?.textContent).toBe('That game is full.');
    expect(arcadeLobby.value).toBeNull();
  });
});

describe('the voice header chips', () => {
  it('render from arcadeActivity and disappear with Hide Arcade', async () => {
    arcadeActivity.value = new Map([
      [
        'c1',
        [
          entry({ id: 'A', n: 2, max: 4 }),
          entry({ g: 'glimmer', id: 'G', st: 'open', n: 3, max: 16, x: 'Cobble 25/50', j: { amt: 12000 } }),
        ],
      ],
      ['c2', [entry({ id: 'B' })]],
    ]);
    act(() => render(<ArcadeChips channelId="c1" />, host));
    const fuse = host.querySelector('[data-arcade-chip="A"]') as HTMLElement;
    expect(fuse.textContent).toContain('Fuseyard · 2/4');
    expect(buttonByText(fuse, 'Join seat')).toBeTruthy();
    expect(buttonByText(fuse, 'Watch')).toBeTruthy();
    const hall = host.querySelector('[data-arcade-chip="G"]') as HTMLElement;
    expect(hall.textContent).toContain('Glimmerhall · Cobble 25/50 · 3 playing');
    expect(hall.textContent).toContain('Pot 12,000');
    expect(buttonByText(hall, 'Open')).toBeTruthy();
    expect(host.querySelector('[data-arcade-chip="B"]')).toBeNull();

    // Join from a chip.
    fakeSocket.responders.set('arcade:lobby:join', () => ({ ok: true, lobby: lobbyView({ id: 'A', host: 'sam', seats: [{ a: 'sam', bot: false, st: 0 }, { a: 'me', bot: false, st: 0 }] }) }));
    await act(async () => {
      buttonByText(fuse, 'Join seat').click();
    });
    await until(act, () => (host.querySelector('[data-arcade-chip="A"]')?.textContent ?? '').includes("You're in"), 'the joined chip');
    expect(fakeSocket.sent('arcade:lobby:join')).toEqual([{ id: 'A', as: 'player' }]);

    // One game hidden, then the whole Arcade.
    await act(async () => {
      arcadeHidden.value = { hidden: false, games: { glimmer: false }, reenableAt: null };
    });
    expect(host.querySelector('[data-arcade-chip="G"]')).toBeNull();
    expect(host.querySelector('[data-arcade-chip="A"]')).not.toBeNull();
    await act(async () => {
      arcadeHidden.value = { hidden: true, games: {}, reenableAt: null };
    });
    expect(host.querySelector('[data-arcade-chips]')).toBeNull();
  });

  it('shows an invite as a dismissible chip that expires after 60 s', async () => {
    vi.useFakeTimers();
    act(() => render(<ArcadeChips channelId="c1" />, host));
    await act(async () => {
      fakeSocket.push('arcade:invited', { id: 'inv-1', from: 'sam', game: 'fuseyard' });
    });
    const chip = host.querySelector('[data-arcade-invite="inv-1"]') as HTMLElement;
    expect(chip.textContent).toContain('Sam invites you to Fuseyard');
    await act(async () => {
      vi.advanceTimersByTime(INVITE_MS - 1);
    });
    expect(host.querySelector('[data-arcade-invite="inv-1"]')).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(host.querySelector('[data-arcade-invite="inv-1"]')).toBeNull();
    expect(arcadeInvites.value).toEqual([]);

    // Dismissed by hand; its timer goes with it.
    await act(async () => {
      fakeSocket.push('arcade:invited', { id: 'inv-2', from: 'kim', game: 'fuseyard' });
    });
    await act(async () => {
      (host.querySelector('[data-arcade-invite="inv-2"] [aria-label="Dismiss invite"]') as HTMLElement).click();
    });
    expect(host.querySelector('[data-arcade-invite="inv-2"]')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the online stage', () => {
  beforeEach(() => {
    fakeSocket.responders.set('arcade:lobby:leave', () => ({ ok: true }));
  });

  const run = async (id: string) => {
    const lobby = lobbyView({ id, st: 'live' });
    const hosts = fakeRemote.hosts.length;
    const mounted = fakeLog.mounted;
    enterLobby(lobby, 'player');
    startStage(lobby, 'player', 'ticket-' + id);
    act(() => render(<GameStage />, host));
    await until(act, () => fakeRemote.hosts.length > hosts && host.querySelector('[data-arcade-stage="' + id + '"]') !== null && fakeLog.mounted > mounted, 'the game to mount');
    return fakeRemote.hosts[fakeRemote.hosts.length - 1]!;
  };

  it('mounts a remote game in the stage, shows the yield notice, and leaves nothing behind', async () => {
    // Warm-up: the first session loads the runtime modules, which may set up one-time state.
    await run(nextId());
    leaveCurrent();
    act(() => render(null, host));

    const resources = trackResources();
    const baseline = resources.live();
    const mountedBefore = fakeLog.mounted;
    const id = nextId();
    const remote = await run(id);
    expect(fakeLog.mounted).toBe(mountedBefore + 1);
    expect(remote.args.ticket).toBe('ticket-' + id);
    expect(arcadeSession.value).toMatchObject({ id, mode: 'remote', role: 'player', status: 'connecting' });

    await act(async () => {
      remote.welcome();
      fake.advance(100);
    });
    expect(host.querySelector('[data-arcade-status]')?.textContent).toBe('Live');
    for (let i = 0; i < 30; i += 1) remote.frame();
    expect(fakeLog.frames).toBeGreaterThanOrEqual(30);

    // Chat first: the lane yields, the header says why.
    await act(async () => {
      remote.yieldTo(true);
    });
    expect(arcadeSession.value).toMatchObject({ status: 'paused', yielding: true });
    expect(host.querySelector('[data-arcade-yield]')?.textContent).toBe('Paused so chat and voice can catch up');
    await act(async () => {
      remote.yieldTo(false);
    });
    expect(host.querySelector('[data-arcade-yield]')).toBeNull();
    expect(host.querySelector('[data-arcade-status]')?.textContent).toBe('Live');

    // Back to call minimizes (the game is hidden), Leave closes it and releases the seat.
    await click('[data-arcade-back]');
    expect(arcadeSession.value?.minimized).toBe(true);
    await click('[data-arcade-leave]');
    expect(fakeSocket.sent('arcade:lobby:leave')).toContainEqual({ id });
    expect(remote.closed).toBe(true);
    expect(arcadeSession.value).toBeNull();
    expect(arcadeStage.value).toBeNull();
    act(() => render(null, host));
    await act(async () => {
      fake.advance(100);
    });

    expect(frames.active).toBe(0);
    expect(fake.pending).toBe(0);
    expect(audio.closed).toBe(audio.contexts);
    expect(document.querySelector('[data-arcade-stage]')).toBeNull();
    const after = resources.live();
    expect(resources.listenerTypes()).toEqual({});
    expect(after).toEqual(baseline);
    resources.restore();
  });

  it('shows a failed start in the stage with Try again', async () => {
    fakeSocket.responders.set('arcade:ticket', () => ({ ok: false, code: 'gone' }));
    const lobby = lobbyView({ id: nextId(), st: 'live' });
    enterLobby(lobby, 'player');
    startStage(lobby, 'player');
    act(() => render(<GameStage />, host));
    await until(act, () => arcadeStage.value?.error !== null, 'the error');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('That game has ended.');
    expect(arcadeSession.value).toBeNull();
    expect(buttonByText(host, 'Try again')).toBeTruthy();
  });
});

describe('layout', () => {
  it('keeps touch targets at 44 px or more and nothing wider than 360 px', async () => {
    arcadeActivity.value = new Map([['c1', [entry({ id: 'X1' }), entry({ g: 'glimmer', id: 'X2', st: 'open', n: 1, max: 16 })]]]);
    arcadeInvites.value = [{ id: 'X3', from: 'sam', game: 'fuseyard', at: 0 }];
    enterLobby(lobbyView({ id: nextId() }), 'player');
    act(() =>
      render(
        <>
          <ArcadeChips channelId="c1" />
          <ArcadeSheet channelId="c1" anchor={null} onClose={() => undefined} />
        </>,
        host,
      ),
    );
    const chips = host.querySelector('[data-arcade-chips]') as HTMLElement;
    const sheet = document.querySelector('[data-arcade-sheet]') as HTMLElement;
    const chipButtons = Array.from(chips.querySelectorAll('button'));
    expect(chipButtons.length).toBeGreaterThan(4);
    for (const el of [...chipButtons, ...Array.from(chips.children)]) expect(el.className).toMatch(TALL);
    const rows = Array.from(sheet.querySelectorAll('[data-arcade-row]'));
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) expect(row.className).toMatch(TALL);
    const sheetButtons = Array.from(sheet.querySelectorAll('[data-arcade-row] button, [data-arcade-lobby] button, button[data-arcade-row]'));
    for (const button of sheetButtons) expect(button.className).toMatch(TALL);
    expect(wideClasses(chips)).toEqual([]);
    expect(wideClasses(sheet.parentElement as HTMLElement)).toEqual([]);
    act(() => render(null, host));

    // The stage header (after a failed start, so no game is needed).
    fakeSocket.responders.set('arcade:ticket', () => ({ ok: false, code: 'gone' }));
    const lobby = lobbyView({ id: nextId(), st: 'live' });
    enterLobby(lobby, 'player');
    startStage(lobby, 'player');
    act(() => render(<GameStage />, host));
    await until(act, () => arcadeStage.value?.error !== null, 'the stage');
    const header = host.querySelector('[data-arcade-stage-header]') as HTMLElement;
    const headerButtons = Array.from(header.querySelectorAll('button'));
    expect(headerButtons.map((b) => b.textContent?.trim())).toEqual(['Back to call', 'Leave']);
    for (const button of headerButtons) expect(button.className).toMatch(TALL);
    expect(wideClasses(host)).toEqual([]);
  });
});
