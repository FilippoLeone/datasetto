/**
 * Lobbies, activity, invites and seats across a match (plan.md §3.2 "Lane integration" and
 * "Table lane"): opt-in rules, coalescing, hidden accounts, the late-join queue and reclaim, rematch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { b64url } from '../../src/arcade/core/bytes.js';
import { KEY_REASON, S2C, SPECTATOR, type ServerMsg } from '../../src/arcade/core/net/lane.js';
import { startArcadeServer, type ArcadeTestServer, type TestAccount, type TestSocket } from './harness/server.js';
import { probeControl, probeGame, probeLog, resetProbe } from './harness/probeGame.js';

let server: ArcadeTestServer;

beforeEach(async () => {
  resetProbe();
  server = await startArcadeServer({ arcade: { matchGames: [probeGame(), null] } });
});

afterEach(async () => {
  await server.close();
});

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

interface Player {
  account: TestAccount;
  socket: TestSocket;
}

const player = async (inVoice = true): Promise<Player> => {
  const account = await server.account();
  const socket = await account.socket();
  if (inVoice) await account.joinVoice(server.voiceChannel, socket);
  return { account, socket };
};

const create = (p: Player, cfg: unknown = {}) =>
  p.socket.request<{ ok: boolean; lobby: { id: string; seats: { a: string | null }[] }; code?: string }>('arcade:lobby:create', { ch: server.voiceChannel, game: 'fuseyard', mode: 'brawl', cfg });

describe('lobbies', () => {
  it('lets only voice members create and sit, and anyone who can view the channel watch', async () => {
    const outsider = await player(false);
    expect(await create(outsider)).toEqual({ ok: false, code: 'not-in-voice' });
    const host = await player();
    const lobby = await create(host);
    expect(lobby.ok).toBe(true);
    expect(lobby.lobby.seats[0]?.a).toBe(host.account.id);
    expect(await outsider.socket.request('arcade:lobby:join', { id: lobby.lobby.id, as: 'player' })).toEqual({ ok: false, code: 'not-in-voice' });
    expect(await outsider.socket.request('arcade:lobby:join', { id: lobby.lobby.id, as: 'spectator' })).toMatchObject({ ok: true });
  });

  it('coalesces lobby updates to 2 Hz and activity to one per 2 s, ≤ 150 B, viewers outside the call get activity only', async () => {
    const host = await player();
    const outsider = await player(false);
    const lobby = await create(host);
    const id = lobby.lobby.id;
    await settle();
    server.clock.advance(2100);
    await settle();
    const firstActivity = outsider.socket.received('arcade:activity');
    expect(firstActivity.length).toBe(1);
    expect(JSON.stringify(firstActivity[0]).length).toBeLessThanOrEqual(150);
    // Five joins and leaves in a burst.
    const guests: Player[] = [];
    for (let i = 0; i < 3; i += 1) guests.push(await player());
    const lobbyBefore = host.socket.received('arcade:lobby').length;
    for (const g of guests) await g.socket.request('arcade:lobby:join', { id, as: 'player' });
    await g0leave(guests[0] as Player, id);
    server.clock.advance(400);
    await settle();
    server.clock.advance(200);
    await settle();
    const lobbyUpdates = host.socket.received('arcade:lobby').length - lobbyBefore;
    expect(lobbyUpdates).toBeLessThanOrEqual(2);
    server.clock.advance(2100);
    await settle();
    expect(outsider.socket.received('arcade:activity').length).toBe(2);
    // The outsider never got the lobby itself.
    expect(outsider.socket.received('arcade:lobby')).toEqual([]);
  });

  it('delivers an invite at most once a minute per pair', async () => {
    const host = await player();
    const friend = await player();
    const lobby = await create(host);
    const id = lobby.lobby.id;
    expect(await host.socket.request('arcade:invite', { id, to: friend.account.id })).toEqual({ ok: true });
    await settle();
    expect(friend.socket.received('arcade:invited')).toEqual([{ id, from: host.account.id, game: 'fuseyard', ch: server.voiceChannel }]);
    expect(await host.socket.request('arcade:invite', { id, to: friend.account.id })).toEqual({ ok: false, code: 'busy' });
    server.clock.advance(61_000);
    expect(await host.socket.request('arcade:invite', { id, to: friend.account.id })).toEqual({ ok: true });
  });

  it('refuses a hidden account with `hidden` and sends it no activity', async () => {
    const host = await player();
    const shy = await player();
    expect(await shy.socket.request('arcade:prefs:set', { hidden: true })).toMatchObject({ ok: true, hidden: true });
    expect(await create(shy)).toEqual({ ok: false, code: 'hidden' });
    await create(host);
    server.clock.advance(2100);
    await settle();
    expect(shy.socket.received('arcade:activity').every((a) => (a as { a: unknown[] }).a.length === 0)).toBe(true);
    // Turning it back on waits 24 h (self-exclusion).
    const back = await shy.socket.request<{ hidden: boolean; reenableAt: number | null }>('arcade:prefs:set', { hidden: false });
    expect(back.hidden).toBe(true);
    expect(back.reenableAt).toBeGreaterThan(server.clock.now());
  });

  it('closes an unstarted lobby after 10 minutes', async () => {
    const host = await player();
    const lobby = await create(host);
    server.clock.advance(10 * 60_000 + 1000);
    await settle();
    const updates = host.socket.received('arcade:lobby') as { id: string; st: string }[];
    expect(updates.at(-1)).toMatchObject({ id: lobby.lobby.id, st: 'ended' });
  });
});

const g0leave = (p: Player, id: string) => p.socket.request('arcade:lobby:leave', { id });

describe('seats across a match', () => {
  it('queues a late joiner until the round starts, then re-sends WELCOME with the seat', async () => {
    const host = await player();
    const lobby = await create(host, { fighters: 2 });
    const id = lobby.lobby.id;
    expect(await host.socket.request('arcade:lobby:start', { id })).toMatchObject({ ok: true });
    const hostTicket = await host.socket.request<{ ticket: string }>('arcade:ticket', { id });
    const hostLane = await host.account.lane(hostTicket.ticket);
    await hostLane.next(S2C.WELCOME);
    // Seat 1 is a bot; a late joiner waits for the round.
    const late = await player();
    const joined = await late.socket.request<{ ok: boolean; ticket: string }>('arcade:lobby:join', { id, as: 'player' });
    expect(joined.ok).toBe(true);
    const lane = await late.account.lane(joined.ticket);
    const queued = (await lane.next(S2C.WELCOME)) as Extract<ServerMsg, { t: 'welcome' }>;
    expect(queued.slot).toBe(SPECTATOR);
    expect(queued.queued).toBe(true);
    probeControl.roundStarts.push(probeTick() + 3);
    await server.clock.run(300);
    const seated = (await lane.next(S2C.WELCOME)) as Extract<ServerMsg, { t: 'welcome' }>;
    expect(seated.slot).toBe(1);
    expect(seated.queued).toBe(false);
    await server.clock.run(100);
    const keyframes = lane.received.filter((m) => m.t === 'keyframe') as Extract<ServerMsg, { t: 'keyframe' }>[];
    expect(keyframes.at(-1)?.reason).toBe(KEY_REASON.round);
    expect(probeLog.seats).toContainEqual({ slot: 1, cmd: 'reclaim' });
    // The player already seated gets a round keyframe too (a new round means a new layout).
    const hostKeyframes = hostLane.received.filter((m) => m.t === 'keyframe') as Extract<ServerMsg, { t: 'keyframe' }>[];
    expect(hostKeyframes.map((k) => k.reason)).toContain(KEY_REASON.round);
    expect(probeLog.mode).toBe('brawl');
  });

  it('gives a dropped seat to a bot after the grace and lets its owner reclaim it at the next round', async () => {
    const host = await player();
    const friend = await player();
    const lobby = await create(host, { fighters: 2 });
    const id = lobby.lobby.id;
    await friend.socket.request('arcade:lobby:join', { id, as: 'player' });
    await host.socket.request('arcade:lobby:start', { id });
    const hostLane = await host.account.lane((await host.socket.request<{ ticket: string }>('arcade:ticket', { id })).ticket);
    await hostLane.next(S2C.WELCOME);
    const lane = await friend.account.lane((await friend.socket.request<{ ticket: string }>('arcade:ticket', { id })).ticket);
    const welcome = (await lane.next(S2C.WELCOME)) as Extract<ServerMsg, { t: 'welcome' }>;
    expect(welcome.slot).toBe(1);
    lane.ws.terminate();
    await settle();
    // The grace lasts 60 s; the host keeps the match alive with input; then a bot holds the seat.
    for (let s = 0; s < 61; s += 1) {
      hostLane.sendUp(Uint8Array.of(1));
      await server.clock.run(1000, 250);
    }
    expect(probeLog.seats).toContainEqual({ slot: 1, cmd: 'ghost' });
    expect(probeLog.seats).toContainEqual({ slot: 1, cmd: 'bot' });
    // The resume token is gone with the grace; a fresh ticket queues the owner, the round start reclaims.
    const stale = await friend.account.lane(b64url(welcome.resumeToken), { resume: true });
    expect(await stale.closed()).toBe(4401);
    const t2 = await friend.socket.request<{ ok: boolean; ticket: string }>('arcade:ticket', { id });
    const back = await friend.account.lane(t2.ticket);
    expect(((await back.next(S2C.WELCOME)) as Extract<ServerMsg, { t: 'welcome' }>).queued).toBe(true);
    probeControl.roundStarts.push(probeTick() + 2);
    await server.clock.run(300);
    expect(((await back.next(S2C.WELCOME)) as Extract<ServerMsg, { t: 'welcome' }>).slot).toBe(1);
  });

  it('opens the lobby again when the match ends (rematch through the lobby)', async () => {
    const host = await player();
    const lobby = await create(host);
    const id = lobby.lobby.id;
    await host.socket.request('arcade:lobby:start', { id });
    const t = await host.socket.request<{ ticket: string }>('arcade:ticket', { id });
    const lane = await host.account.lane(t.ticket);
    await lane.next(S2C.WELCOME);
    probeControl.endAtTick = probeTick() + 3;
    await server.clock.run(400);
    expect(await lane.closed()).toBe(1000);
    expect(probeLog.persisted).toContain('end:done');
    server.clock.advance(600);
    await settle();
    const updates = host.socket.received('arcade:lobby') as { st: string }[];
    expect(updates.at(-1)?.st).toBe('open');
    expect(await host.socket.request('arcade:lobby:start', { id })).toMatchObject({ ok: true });
  });

  it('sends arcade:activity:all after sign-in when something runs', async () => {
    const host = await player();
    await create(host);
    const late = await server.account();
    const socket = await late.socket();
    await settle();
    const all = socket.received('arcade:activity:all') as { chs: { ch: string; a: { g: string }[] }[] }[];
    expect(all[0]?.chs[0]?.ch).toBe(server.voiceChannel);
    expect(all[0]?.chs[0]?.a[0]?.g).toBe('fuseyard');
  });

  it('sends your lobby again after a reload', async () => {
    const host = await player();
    const lobby = await create(host);
    const again = await host.account.socket();
    await settle();
    expect(again.received('arcade:lobby')).toMatchObject([{ id: lobby.lobby.id, host: host.account.id }]);
    const stranger = await (await server.account()).socket();
    await settle();
    expect(stranger.received('arcade:lobby')).toEqual([]);
  });
});

const probeTick = (): number => probeLog.tick;
