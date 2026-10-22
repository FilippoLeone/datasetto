/**
 * The action lane end to end (plan.md §3.2 "Lane integration"): upgrade routing, tickets, origin,
 * HELLO, payload and rate limits, resume and takeover, visibility, idle reapers, restart, exceptions
 * and overload, server limits. A fake clock drives the scheduler and every timer; sockets are real.
 */
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { b64url } from '../../src/arcade/core/bytes.js';
import { CLOSE, KEY_REASON, PHASE, S2C, VIS, type ServerMsg } from '../../src/arcade/core/net/lane.js';
import { startArcadeServer, type ArcadeTestServer, type TestAccount, type TestLane, type TestSocket } from './harness/server.js';
import { probeControl, probeGame, probeLog, resetProbe } from './harness/probeGame.js';

let server: ArcadeTestServer;

beforeEach(async () => {
  resetProbe();
  server = await startArcadeServer({ arcade: { matchGames: [probeGame(), null] } });
});

afterEach(async () => {
  await server.close();
});

const tick = (ms = 100) => server.clock.run(ms);

interface Player {
  account: TestAccount;
  socket: TestSocket;
}

/** n players in the voice channel, a started probe match, and each player's ticket. */
const startMatch = async (n = 2): Promise<{ players: Player[]; lobbyId: string; tickets: string[] }> => {
  const players: Player[] = [];
  for (let i = 0; i < n; i += 1) {
    const account = await server.account();
    const socket = await account.socket();
    await account.joinVoice(server.voiceChannel, socket);
    players.push({ account, socket });
  }
  const host = players[0] as Player;
  const created = await host.socket.request<{ ok: boolean; lobby: { id: string }; code?: string }>('arcade:lobby:create', { ch: server.voiceChannel, game: 'fuseyard', mode: 'brawl', cfg: {} });
  expect(created).toMatchObject({ ok: true });
  const lobbyId = created.lobby.id;
  for (const p of players.slice(1)) expect(await p.socket.request('arcade:lobby:join', { id: lobbyId, as: 'player' })).toMatchObject({ ok: true });
  expect(await host.socket.request('arcade:lobby:start', { id: lobbyId })).toMatchObject({ ok: true });
  const tickets: string[] = [];
  for (const p of players) {
    const t = await p.socket.request<{ ok: boolean; ticket: string }>('arcade:ticket', { id: lobbyId });
    expect(t.ok).toBe(true);
    tickets.push(t.ticket);
  }
  return { players, lobbyId, tickets };
};

const welcomeAndKeyframe = async (lane: TestLane): Promise<{ welcome: Extract<ServerMsg, { t: 'welcome' }>; keyframe: Extract<ServerMsg, { t: 'keyframe' }> }> => {
  const welcome = (await lane.next(S2C.WELCOME)) as Extract<ServerMsg, { t: 'welcome' }>;
  await tick(70);
  const keyframe = (await lane.next(S2C.KEYFRAME)) as Extract<ServerMsg, { t: 'keyframe' }>;
  return { welcome, keyframe };
};

describe('upgrade routing', () => {
  it('upgrades /socket.io/ and /arcade/ws on one server and destroys any other path at once', async () => {
    const account = await server.account();
    const socket = await account.socket();
    expect(socket.raw.connected).toBe(true);
    const { tickets } = await startMatch(1);
    // A ticket is a bearer token for its seat: the lane upgrades and welcomes.
    const lane = await account.lane(tickets[0] as string);
    expect((await lane.next(S2C.WELCOME)).t).toBe('welcome');

    const started = Date.now();
    const destroyed = await new Promise<number>((resolve) => {
      const raw = net.connect(Number(new URL(server.url).port), '127.0.0.1', () => {
        raw.write('GET /nope HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
      });
      raw.on('close', () => resolve(Date.now() - started));
      raw.on('error', () => undefined);
    });
    expect(destroyed).toBeLessThan(500);
  });
});

describe('tickets and hello', () => {
  it('accepts a ticket once and only within 30 s', async () => {
    const { players, lobbyId, tickets } = await startMatch(1);
    const me = players[0] as Player;
    const lane = await me.account.lane(tickets[0] as string);
    const { welcome, keyframe } = await welcomeAndKeyframe(lane);
    expect(welcome.slot).toBe(0);
    expect(welcome.resumeToken.length).toBe(32);
    expect(keyframe.reason).toBe(KEY_REASON.join);
    // The same ticket again: refused.
    const again = await me.account.lane(tickets[0] as string);
    expect(await again.closed()).toBe(CLOSE.ticket);
    // A fresh ticket that is 31 s old: expired.
    const fresh = await me.socket.request<{ ticket: string }>('arcade:ticket', { id: lobbyId });
    server.clock.advance(31_000);
    const late = await me.account.lane(fresh.ticket);
    expect(await late.closed()).toBe(CLOSE.ticket);
  });

  it('refuses a bad origin with 403 and a stale codec with 4426', async () => {
    const { players, tickets } = await startMatch(1);
    const me = players[0] as Player;
    const evil = await me.account.lane(tickets[0] as string, { origin: 'https://evil.example' });
    expect(await evil.closed()).toBe(403);
    const old = await me.account.lane(tickets[0] as string, { codec: 99 });
    expect(await old.closed()).toBe(CLOSE.update);
  });

  it('closes with 4408 when no hello comes within 5 s, and 4400 on binary before hello', async () => {
    const account = await server.account();
    const lane = await account.lane('x');
    lane.ws.removeAllListeners('open');
    // The harness sent a hello for 'x' (a bad ticket): use a raw socket instead.
    expect(await lane.closed()).toBe(CLOSE.ticket);
    const WebSocket = (await import('ws')).default;
    const raw = new WebSocket(server.url.replace('http', 'ws') + '/arcade/ws');
    const code = await new Promise<number>((resolve) => {
      raw.on('open', async () => {
        await tick(5100);
      });
      raw.on('close', (c: number) => resolve(c));
    });
    expect(code).toBe(CLOSE.helloTimeout);
    const binary = new WebSocket(server.url.replace('http', 'ws') + '/arcade/ws');
    const code2 = await new Promise<number>((resolve) => {
      binary.on('open', () => binary.send(Buffer.from([1, 2, 3])));
      binary.on('close', (c: number) => resolve(c));
    });
    expect(code2).toBe(CLOSE.malformed);
  });
});

describe('limits on a bound lane', () => {
  it('closes on a message over 4 KB, on flooding and on the 10th malformed message', async () => {
    const { players, lobbyId, tickets } = await startMatch(1);
    const me = players[0] as Player;
    const big = await me.account.lane(tickets[0] as string);
    await welcomeAndKeyframe(big);
    big.sendRaw(new Uint8Array(5000));
    expect(await big.closed()).toBe(1009);

    const t2 = await me.socket.request<{ ticket: string }>('arcade:ticket', { id: lobbyId });
    const junk = await me.account.lane(t2.ticket);
    await welcomeAndKeyframe(junk);
    for (let i = 0; i < 10; i += 1) junk.sendRaw(Uint8Array.of(0x7f, 1, 2));
    expect(await junk.closed()).toBe(CLOSE.malformed);

    const t3 = await me.socket.request<{ ticket: string }>('arcade:ticket', { id: lobbyId });
    const flood = await me.account.lane(t3.ticket);
    await welcomeAndKeyframe(flood);
    for (let i = 0; i < 250; i += 1) flood.sendPing(i);
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.clock.advance(1000);
    for (let i = 0; i < 250; i += 1) flood.sendPing(i);
    expect(await flood.closed()).toBe(CLOSE.rate);
  });

  it('caps lanes per IP', async () => {
    await server.close();
    resetProbe();
    server = await startArcadeServer({ arcade: { matchGames: [probeGame(), null] }, settings: { limits: { lanePerIp: 2 } as never } });
    const WebSocket = (await import('ws')).default;
    const url = server.url.replace('http', 'ws') + '/arcade/ws';
    // Lanes that have not said hello yet count too (the hello timeout runs on the fake clock).
    const open = (): Promise<{ ws: InstanceType<typeof WebSocket>; status: number }> =>
      new Promise((resolve) => {
        const ws = new WebSocket(url);
        ws.on('open', () => resolve({ ws, status: 101 }));
        ws.on('unexpected-response', (_req, res) => resolve({ ws, status: res.statusCode ?? 0 }));
        ws.on('error', () => undefined);
      });
    const first = await open();
    const second = await open();
    const third = await open();
    expect([first.status, second.status, third.status]).toEqual([101, 101, 429]);
    first.ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = await open();
    expect(again.status).toBe(101);
    second.ws.terminate();
    again.ws.terminate();
  });
});

describe('seats', () => {
  it('keeps the seat on a resume within the grace and gives a second tab the seat (4409)', async () => {
    const { players, lobbyId, tickets } = await startMatch(2);
    const me = players[0] as Player;
    const lane = await me.account.lane(tickets[0] as string);
    const { welcome } = await welcomeAndKeyframe(lane);
    lane.ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick(2000);
    expect(probeLog.seats).toContainEqual({ slot: 0, cmd: 'ghost' });
    const resumed = await me.account.lane(b64url(welcome.resumeToken), { resume: true });
    const back = await welcomeAndKeyframe(resumed);
    expect(back.welcome.slot).toBe(0);
    expect(back.keyframe.reason).toBe(KEY_REASON.resume);
    expect(probeLog.seats).toContainEqual({ slot: 0, cmd: 'live' });

    // Another tab: takes the seat; the first gets 4409.
    const t = await me.socket.request<{ ticket: string }>('arcade:ticket', { id: lobbyId });
    const second = await me.account.lane(t.ticket);
    await second.next(S2C.WELCOME);
    expect(await resumed.closed()).toBe(CLOSE.takenOver);
    const bye = resumed.received.find((m) => m.t === 'bye') as Extract<ServerMsg, { t: 'bye' }> | undefined;
    expect(bye?.code).toBe(CLOSE.takenOver);
  });

  it('parks a hidden client: pings only while away, a keyframe when it comes back', async () => {
    const { players, tickets } = await startMatch(1);
    const me = players[0] as Player;
    const lane = await me.account.lane(tickets[0] as string);
    await welcomeAndKeyframe(lane);
    await tick(300);
    expect(lane.received.some((m) => m.t === 'frame')).toBe(true);
    lane.sendVis(VIS.away);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const before = lane.received.length;
    await tick(2000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(lane.received.slice(before).filter((m) => m.t !== 'pong')).toEqual([]);
    lane.sendVis(VIS.live);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick(100);
    const keyframe = (await lane.next(S2C.KEYFRAME)) as Extract<ServerMsg, { t: 'keyframe' }>;
    expect(keyframe.reason).toBe(KEY_REASON.unpark);
  });
});

describe('chat first, server side', () => {
  it('parks a player as yield while the main socket has chat queued for over 1 s, and unparks after 2 s calm', async () => {
    await server.close();
    resetProbe();
    const busy = new Set<string>();
    server = await startArcadeServer({ arcade: { matchGames: [probeGame(), null], tableLaneBusy: (id) => busy.has(id) } });
    const { players, tickets } = await startMatch(1);
    const me = players[0] as Player;
    const lane = await me.account.lane(tickets[0] as string);
    await welcomeAndKeyframe(lane);
    busy.add(me.socket.raw.id as string);
    await tick(1500);
    expect(probeLog.seats).toContainEqual({ slot: 0, cmd: 'ghost' });
    const before = lane.received.length;
    await tick(2000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Parked as yield: a BEAT a second, no frames.
    const parked = lane.received.slice(before);
    expect(parked.some((m) => m.t === 'frame')).toBe(false);
    expect(parked.filter((m) => m.t === 'beat').length).toBeGreaterThanOrEqual(1);
    busy.clear();
    await tick(2600);
    const keyframe = (await lane.next(S2C.KEYFRAME)) as Extract<ServerMsg, { t: 'keyframe' }>;
    expect(keyframe.reason).toBe(KEY_REASON.unpark);
  });
});

describe('match lifecycle', () => {
  it('ends a match 30 s after the last human disconnects', async () => {
    const { players, tickets } = await startMatch(1);
    const lane = await (players[0] as Player).account.lane(tickets[0] as string);
    await welcomeAndKeyframe(lane);
    lane.ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick(29_000);
    expect(probeLog.disposed).toBe(0);
    await tick(2000);
    expect(probeLog.disposed).toBe(1);
  });

  it('ends a match after 120 s without input', async () => {
    const { players, tickets } = await startMatch(1);
    const lane = await (players[0] as Player).account.lane(tickets[0] as string);
    await welcomeAndKeyframe(lane);
    for (let i = 0; i < 12; i += 1) {
      await tick(10_000);
      lane.sendAck(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick(1000);
    expect(probeLog.disposed).toBe(1);
    expect(await lane.closed()).toBe(CLOSE.left);
  });

  it('on restart sends PHASE 4, a HANDOVER and closes with 1012', async () => {
    const { players, tickets } = await startMatch(1);
    const lane = await (players[0] as Player).account.lane(tickets[0] as string);
    await welcomeAndKeyframe(lane);
    await server.sockets.arcade.onRestarting();
    const phase = (await lane.next(S2C.PHASE)) as Extract<ServerMsg, { t: 'phase' }>;
    expect(phase.phase).toBe(PHASE.ending);
    const handover = (await lane.next(S2C.HANDOVER)) as Extract<ServerMsg, { t: 'handover' }>;
    expect(handover.body.length).toBeGreaterThan(0);
    expect(await lane.closed()).toBe(CLOSE.restart);
    expect(probeLog.persisted.some((p) => p.endsWith(':void') || p === 'persist') || probeLog.disposed === 1).toBe(true);
  });

  it('isolates a throwing step and ends a slow one as overload', async () => {
    const { players, tickets } = await startMatch(1);
    const lane = await (players[0] as Player).account.lane(tickets[0] as string);
    await welcomeAndKeyframe(lane);
    probeControl.stepMs = 25;
    await tick(100);
    expect(await lane.closed()).toBe(CLOSE.restart);
    const phase = lane.received.find((m) => m.t === 'phase') as Extract<ServerMsg, { t: 'phase' }> | undefined;
    expect(phase?.phase).toBe(PHASE.ending);
    probeControl.stepMs = 0;

    // A new match; this one throws.
    const host = players[0] as Player;
    const created = await host.socket.request<{ ok: boolean; lobby: { id: string } }>('arcade:lobby:create', { ch: server.voiceChannel, game: 'fuseyard', mode: 'brawl', cfg: {} });
    expect(created.ok).toBe(true);
    expect(await host.socket.request('arcade:lobby:start', { id: created.lobby.id })).toMatchObject({ ok: true });
    probeControl.throwAtTick = 3;
    await tick(200);
    expect(probeLog.disposed).toBe(2);
  });

  it('refuses a match beyond the server-wide limit', async () => {
    await server.close();
    resetProbe();
    server = await startArcadeServer({ arcade: { matchGames: [probeGame(), null] }, settings: { limits: { actionMatches: 1 } as never } });
    await startMatch(1);
    const other = server.ctx.channels.create({ name: 'second-voice', type: 'voice' });
    const account = await server.account();
    const socket = await account.socket();
    await account.joinVoice(other.id, socket);
    const refused = await socket.request<{ ok: boolean; code: string }>('arcade:lobby:create', { ch: other.id, game: 'fuseyard', mode: 'brawl', cfg: {} });
    expect(refused).toEqual({ ok: false, code: 'server-limit' });
  });
});
