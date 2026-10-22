/**
 * Fuseyard over the real action lane (fuseyard.md §12 "Lane integration"): the arcade server with
 * Fuseyard's game definition, real sockets, and a fake clock driving the scheduler. Each client decodes
 * every WELCOME, KEYFRAME and FRAME into the client's `view.ts` world, as the game module does.
 *
 * The platform's own lane tests cover the generic rules with a probe game (tickets, limits, the 30 s
 * no-human end, exceptions and overload); these cover what Fuseyard adds: seats as fighters (ghosts,
 * shields, bot takeovers, reclaims and late joins at a round start), its own 120 s no-input end, and a
 * HANDOVER body that restores the match.
 */
import { inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { b64url, ByteReader } from '../../../src/arcade/core/bytes.js';
import { decodeCfg, decodeKeyframe, encodeUp } from '../../../src/arcade/core/fuseyard/codec.js';
import { restoreMatch } from '../../../src/arcade/core/fuseyard/replay.js';
import { Cell, CELLS, Dir, inputByte, Phase } from '../../../src/arcade/core/fuseyard/rules.js';
import { applyFrame, createWorld, type World } from '../../../src/arcade/core/fuseyard/view.js';
import { CLOSE, extendTick, KEY_REASON, PHASE, SPECTATOR, VIS, writeAck, writeUp, type ServerMsg } from '../../../src/arcade/core/net/lane.js';
import { startArcadeServer, type ArcadeTestServer, type TestAccount, type TestLane, type TestSocket } from '../harness/server.js';

let server: ArcadeTestServer;

beforeEach(async () => {
  server = await startArcadeServer();
});

afterEach(async () => {
  await server.close();
});

interface Player {
  account: TestAccount;
  socket: TestSocket;
}

interface Client {
  lane: TestLane;
  slot: number;
  queued: boolean;
  welcome: Extract<ServerMsg, { t: 'welcome' }> | null;
  welcomes: number;
  world: World;
  tick: number;
  read: number;
  frameSeq: number;
  keyframes: number[];
  phases: { phase: number; reason: number }[];
  /** Answer frames (ACK or UP) on each pump. */
  acking: boolean;
  /** The input held down; a bomb press is sent once. */
  input: number;
  upSeq: number;
  closed: number | null;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** Applies every message received since the last call to the client's world. */
const consume = (c: Client): void => {
  const got = c.lane.received;
  for (; c.read < got.length; c.read += 1) {
    const m = got[c.read] as ServerMsg;
    if (m.t === 'welcome') {
      const cfg = decodeCfg(m.cfg);
      if (!cfg) throw new Error('WELCOME cfg does not decode');
      c.welcome = m;
      c.welcomes += 1;
      c.slot = m.slot;
      c.queued = m.queued;
      c.tick = m.tick;
      c.world = createWorld(cfg.fighters);
    } else if (m.t === 'keyframe') {
      c.tick = extendTick(m.tick, c.tick);
      if (!decodeKeyframe(new ByteReader(m.body), c.tick, c.world)) throw new Error(`KEYFRAME (${m.body.length} B) does not decode`);
      c.keyframes.push(m.reason);
      c.frameSeq = m.frameSeq;
    } else if (m.t === 'frame') {
      c.tick = extendTick(m.tick, c.tick);
      const events = m.events ? { count: m.events.count, r: new ByteReader(m.events.bytes), tick: c.tick } : null;
      if (!applyFrame(c.world, c.tick, events, m.snapshot ? new ByteReader(m.snapshot) : null)) throw new Error(`FRAME at tick ${c.tick} does not apply`);
      c.frameSeq = m.frameSeq;
    } else if (m.t === 'phase') c.phases.push({ phase: m.phase, reason: m.reason });
    // Hidden items never reach a client: nothing shows under a block that has not broken.
    if (m.t === 'keyframe' || m.t === 'frame') {
      for (let cell = 0; cell < CELLS; cell += 1) {
        if ((c.world.items[cell] || c.world.pending[cell]) && c.world.cells[cell] === Cell.Block) throw new Error(`an item under the unbroken block at cell ${cell} reached slot ${c.slot}`);
      }
    }
  }
};

/** Runs the fake clock for `ms` in `stepMs` slices; after each, clients read and answer as laneClient.ts would. */
const pump = async (clients: readonly Client[], ms: number, stepMs = 250): Promise<void> => {
  for (let t = 0; t < ms; t += stepMs) {
    await server.clock.run(Math.min(stepMs, ms - t));
    await settle();
    for (const c of clients) {
      consume(c);
      if (!c.acking || c.lane.ws.readyState !== c.lane.ws.OPEN) continue;
      if (c.input !== 0) {
        const n = Math.min(6, Math.max(1, Math.round(stepMs / 33.33)));
        const inputs = new Uint8Array(n).fill(c.input & 0x3f);
        inputs[0] = c.input;
        c.upSeq = (c.upSeq + 1) & 0xffff;
        c.lane.sendRaw(writeUp(c.upSeq, c.frameSeq, 0, encodeUp(inputs, n)));
        c.input &= 0x3f;
      } else c.lane.sendRaw(writeAck(c.frameSeq, 0));
    }
  }
  await settle();
  for (const c of clients) consume(c);
};

/** Pumps until `done()` or `maxMs` of fake time; returns whether it happened. */
const pumpUntil = async (clients: readonly Client[], done: () => boolean, maxMs: number, stepMs = 250): Promise<boolean> => {
  for (let t = 0; t < maxMs && !done(); t += stepMs) await pump(clients, stepMs, stepMs);
  return done();
};

const connect = async (p: Player, claim: string, o?: { resume?: boolean }): Promise<Client> => {
  const lane = await p.account.lane(claim, o);
  const c: Client = {
    lane,
    slot: -1,
    queued: false,
    welcome: null,
    welcomes: 0,
    world: createWorld(4),
    tick: 0,
    read: 0,
    frameSeq: 0,
    keyframes: [],
    phases: [],
    acking: true,
    input: 0,
    upSeq: 0,
    closed: null,
  };
  void lane.closed(600_000).then(
    (code) => (c.closed = code),
    () => undefined,
  );
  return c;
};

const player = async (): Promise<Player> => {
  const account = await server.account();
  const socket = await account.socket();
  await account.joinVoice(server.voiceChannel, socket);
  return { account, socket };
};

/** `n` players in voice and a started Fuseyard match with `cfg`; each player's ticket. */
const startMatch = async (n: number, cfg: Record<string, unknown>, mode = 'brawl'): Promise<{ players: Player[]; lobbyId: string; tickets: string[] }> => {
  const players: Player[] = [];
  for (let i = 0; i < n; i += 1) players.push(await player());
  const host = players[0] as Player;
  const created = await host.socket.request<{ ok: boolean; lobby: { id: string } }>('arcade:lobby:create', { ch: server.voiceChannel, game: 'fuseyard', mode, cfg });
  expect(created).toMatchObject({ ok: true });
  const lobbyId = created.lobby.id;
  for (const p of players.slice(1)) expect(await p.socket.request('arcade:lobby:join', { id: lobbyId, as: 'player' })).toMatchObject({ ok: true });
  expect(await host.socket.request('arcade:lobby:start', { id: lobbyId })).toMatchObject({ ok: true });
  const tickets: string[] = [];
  for (const p of players) tickets.push((await p.socket.request<{ ok: boolean; ticket: string }>('arcade:ticket', { id: lobbyId })).ticket);
  return { players, lobbyId, tickets };
};

const BOMB = inputByte(Dir.None, Dir.None, true, false);

describe('Fuseyard on the action lane', () => {
  it('2 humans and 2 bots: decoded frames, moving, a stall ghost the other player sees, away and back with a shield, resume, HANDOVER', async () => {
    const { players, tickets } = await startMatch(2, { arena: 'yard', fighters: 4, wins: 2, bots: 'sprout' });
    const a = await connect(players[0] as Player, tickets[0] as string);
    const b = await connect(players[1] as Player, tickets[1] as string);
    await pump([a, b], 500);
    expect([a.slot, b.slot]).toEqual([0, 1]);
    expect(decodeCfg((a.welcome as { cfg: Uint8Array }).cfg)).toMatchObject({ mode: 'brawl', arena: 'yard', fighters: 4, winsNeeded: 2 });
    expect(a.keyframes[0]).toBe(KEY_REASON.join);
    expect(a.world.ready && b.world.ready).toBe(true);
    // Both humans live, the other two seats bots.
    expect(b.world.fight.map((f) => f.seat)).toEqual([0, 0, 2, 2]);

    // The countdown, then A walks east along its row.
    await pump([a, b], 3200);
    expect(b.world.phase).toBe(Phase.Playing);
    const x0 = (b.world.fight[0] as { x: number }).x;
    a.input = inputByte(Dir.E, Dir.None, false, false);
    await pump([a, b], 1000);
    a.input = 0;
    expect((b.world.fight[0] as { x: number }).x).toBeGreaterThan(x0 + 64);
    expect((a.world.fight[0] as { x: number }).x).toBe((b.world.fight[0] as { x: number }).x);

    // A goes quiet: stalled after 2.5 s, a ghost after the danger lock; B sees the SeatState.
    a.acking = false;
    await pump([a, b], 4000);
    expect((b.world.fight[0] as { seat: number }).seat).toBe(1);
    // A answers again: a keyframe (unpark), live again, shielded if alive.
    a.acking = true;
    await pump([a, b], 750);
    expect(a.keyframes.at(-1)).toBe(KEY_REASON.unpark);
    expect((b.world.fight[0] as { seat: number }).seat).toBe(0);

    // B hides the app: nothing but pongs while away; back with VIS 0: a keyframe and a shield.
    b.lane.sendVis(VIS.away);
    b.acking = false;
    await pump([a, b], 250);
    const before = b.lane.received.length;
    await pump([a, b], 2000);
    expect(b.lane.received.slice(before).filter((m) => m.t !== 'pong')).toEqual([]);
    expect((a.world.fight[1] as { seat: number }).seat).toBe(1);
    b.lane.sendVis(VIS.live);
    b.acking = true;
    await pump([a, b], 500);
    expect(b.keyframes.at(-1)).toBe(KEY_REASON.unpark);
    expect((a.world.fight[1] as { seat: number }).seat).toBe(0);
    const fb = b.world.fight[1] as { alive: boolean; shieldEnd: number };
    if (fb.alive) expect(fb.shieldEnd).toBeGreaterThan(b.world.roundTick);

    // A's socket dies; it resumes within the grace and keeps slot 0.
    a.lane.ws.terminate();
    a.acking = false;
    // Let the server see the close in real time before the fake clock races on (else a stall comes first).
    await new Promise((resolve) => setTimeout(resolve, 30));
    await pump([b], 2000);
    expect((b.world.fight[0] as { seat: number }).seat).toBe(1);
    const back = await connect(players[0] as Player, b64url((a.welcome as { resumeToken: Uint8Array }).resumeToken), { resume: true });
    await pump([back, b], 500);
    expect(back.slot).toBe(0);
    expect(back.keyframes[0]).toBe(KEY_REASON.resume);
    expect((b.world.fight[0] as { seat: number }).seat).toBe(0);

    // A server restart: PHASE ending, then a HANDOVER whose body restores the match.
    await server.sockets.arcade.onRestarting();
    await settle();
    await pump([back, b], 100);
    expect(back.phases.some((p) => p.phase === PHASE.ending)).toBe(true);
    const handover = back.lane.received.find((m) => m.t === 'handover') as Extract<ServerMsg, { t: 'handover' }> | undefined;
    expect(handover).toBeDefined();
    const restored = restoreMatch(inflateRawSync((handover as { body: Uint8Array }).body));
    expect(restored?.config).toMatchObject({ mode: 'brawl', arena: 'yard', fighters: 4, winsNeeded: 2 });
    expect(await back.lane.closed()).toBe(CLOSE.restart);
  });

  it('a seat away for 60 s becomes a bot, its owner reclaims it at the next round, and Leave hands a seat to a bot at once', async () => {
    // Three humans: with A a ghost, B and C play on (two live fighters), so the round runs past the grace.
    const { players, lobbyId, tickets } = await startMatch(3, { arena: 'yard', fighters: 3, wins: 3, bots: 'sprout' });
    const a = await connect(players[0] as Player, tickets[0] as string);
    const b = await connect(players[1] as Player, tickets[1] as string);
    const c = await connect(players[2] as Player, tickets[2] as string);
    await pump([a, b, c], 3500);
    expect(b.world.phase).toBe(Phase.Playing);

    a.lane.ws.terminate();
    a.acking = false;
    // Let the server see the close in real time before the fake clock races on (else a stall comes first).
    await new Promise((resolve) => setTimeout(resolve, 30));
    await pump([b, c], 30_000, 1000);
    expect((b.world.fight[0] as { seat: number }).seat).toBe(1);
    await pump([b, c], 32_000, 1000);
    // A Scrapper bot has the seat (with a shield).
    expect((b.world.fight[0] as { seat: number }).seat).toBe(2);

    // A comes back with a fresh ticket: queued (a watcher) until the round ends.
    const t = await (players[0] as Player).socket.request<{ ok: boolean; ticket: string }>('arcade:ticket', { id: lobbyId });
    expect(t.ok).toBe(true);
    const a2 = await connect(players[0] as Player, t.ticket);
    await pump([a2, b, c], 500);
    expect(a2.slot).toBe(SPECTATOR);
    expect(a2.queued).toBe(true);

    // B and C end the round with bombs at their feet; at the round start A gets its seat back.
    b.input = BOMB;
    c.input = BOMB;
    expect(await pumpUntil([a2, b, c], () => a2.welcomes >= 2, 20_000)).toBe(true);
    await pump([a2, b, c], 500);
    expect(a2.slot).toBe(0);
    expect(a2.queued).toBe(false);
    expect(a2.keyframes.at(-1)).toBe(KEY_REASON.round);
    expect((b.world.fight[0] as { seat: number }).seat).toBe(0);
    expect(a2.world.round).toBe(b.world.round);

    // B leaves (close 1000): its fighter is a bot at once.
    b.lane.close(1000);
    b.acking = false;
    await pump([a2, c], 250);
    expect((a2.world.fight[1] as { seat: number }).seat).toBe(2);
  });

  it('a late joiner waits for the round start, and 120 s without input ends the match', async () => {
    const { players, lobbyId, tickets } = await startMatch(2, { arena: 'yard', fighters: 3, wins: 3, bots: 'sprout' });
    const a = await connect(players[0] as Player, tickets[0] as string);
    const b = await connect(players[1] as Player, tickets[1] as string);
    await pump([a, b], 3500);

    const late = await player();
    expect(await late.socket.request('arcade:lobby:join', { id: lobbyId, as: 'player' })).toMatchObject({ ok: true });
    const t = await late.socket.request<{ ok: boolean; ticket: string }>('arcade:ticket', { id: lobbyId });
    const c = await connect(late, t.ticket);
    await pump([a, b, c], 500);
    expect(c.slot).toBe(SPECTATOR);
    expect(c.queued).toBe(true);

    // A and B end the round; the late joiner takes the bot's seat at the round start.
    a.input = BOMB;
    b.input = BOMB;
    expect(await pumpUntil([a, b, c], () => c.welcomes >= 2, 15_000)).toBe(true);
    await pump([a, b, c], 250);
    expect(c.slot).toBe(2);
    expect(c.keyframes.at(-1)).toBe(KEY_REASON.round);
    expect(a.world.fight.slice(0, 3).map((f) => f.seat)).toEqual([0, 0, 0]);

    // Everyone acks, nobody moves. The no-input clock runs while a live human plays: Closing Time
    // crushes the idle fighters at about 95 s, the clock waits through the next countdown, and the
    // match ends after 120 s of play without input.
    const from = server.clock.now();
    expect(await pumpUntil([a, b, c], () => a.closed !== null, 160_000, 1000)).toBe(true);
    const ranMs = server.clock.now() - from;
    expect({ closed: [a.closed, b.closed, c.closed], longEnough: ranMs > 120_000 }, `closed after ${ranMs} ms`).toEqual({ closed: [CLOSE.left, CLOSE.left, CLOSE.left], longEnough: true });
  });
});
