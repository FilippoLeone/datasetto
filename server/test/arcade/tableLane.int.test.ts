/**
 * The table lane's paced emitter and event rules (plan.md §3.2 "Table lane"): the 3 KB/s socket
 * bucket with a 6 KB depth, chat first (Arcade pushes wait while the main socket has chat queued),
 * the overflow policy, send-time stamping and queue-wait reports, sub-buckets, per-socket fan-out,
 * quiet refusals, hidden and disabled games. A fake table game stands in for Lamplight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { LobbyRecord, TableApi, TableGame, TableGameDef } from '../../src/arcade/tables/types.js';
import { startArcadeServer, type ArcadeTestServer, type TestSocket } from './harness/server.js';

interface TableLog {
  sentWaits: number[];
  stamped: number[];
  api: TableApi | null;
  created: LobbyRecord[];
  joins: string[];
}

const log: TableLog = { sentWaits: [], stamped: [], api: null, created: [], joins: [] };
const busySockets = new Set<string>();

const fakeTable: TableGameDef = {
  game: 'lamplight',
  proto: 1,
  modes: ['open'],
  cfgSchema: null,
  start(api): TableGame {
    log.api = api;
    api.queuePolicy('lamplight', { maxEvents: 32, maxAgeMs: 2000, onOverflow: () => ({ ev: 'lamplight:snap', data: { snap: true } }) });
    api.on('lamplight:ping', { schema: z.object({ n: z.number() }), limiter: 'arcadeAct', acked: true }, (_c, p) => ({ ok: true, n: p.n }));
    api.on(
      'lamplight:burst',
      { schema: z.object({ n: z.number(), pad: z.number(), coalesce: z.boolean().optional(), sub: z.boolean().optional(), stamp: z.boolean().optional() }), limiter: 'arcade', acked: true },
      (c, p) => {
        for (let i = 0; i < p.n; i += 1) {
          api.emit(c.socketId, 'lamplight:blob', { i, pad: 'x'.repeat(p.pad), deadline: 10_000 }, {
            queue: 'lamplight',
            coalesce: p.coalesce ? 'blob' : undefined,
            sub: p.sub ? { rateBps: 200, depth: 800 } : undefined,
            stamp: p.stamp
              ? (data, sentAt) => {
                  log.stamped.push(sentAt);
                  return { ...(data as object), ms: 10_000 - sentAt };
                }
              : undefined,
            onSent: (waited) => log.sentWaits.push(waited),
          });
        }
        return { ok: true };
      },
    );
    api.on('lamplight:room', { schema: z.object({}), limiter: 'arcade', acked: true }, (c) => {
      api.rooms.join(c.socketId, 'table:t1');
      api.emitRoom('table:t1', 'lamplight:hello', (socketId) => ({ to: socketId }), { queue: 'lamplight' });
      return { ok: true, size: api.rooms.size('table:t1') };
    });
    return {
      lobby: {
        onCreate: () => ({ ok: true }),
        onCreated: (c, lobby) => {
          log.created.push(lobby);
          // A cash table seats people through its own events and keeps the record in step.
          api.hub.update(lobby.id, { seats: [{ accountId: c.accountId, bot: false, state: 0 }, { accountId: null, bot: true, state: 0 }], state: 'live' });
        },
        onJoin: (c) => {
          log.joins.push(c.accountId);
          return { ok: true };
        },
        onLeave: () => undefined,
        onStart: () => ({ ok: true }),
      },
      onAway: () => undefined,
      onBack: () => undefined,
      onVoiceLeft: () => undefined,
      onSocketGone: () => undefined,
      onRestarting: () => undefined,
      onBoot: () => undefined,
      daily: () => undefined,
      onDisable: () => undefined,
      activity: () => [],
      stop: () => undefined,
    };
  },
};

let server: ArcadeTestServer;
let me: TestSocket;
let socketId: string;

beforeEach(async () => {
  log.sentWaits = [];
  log.stamped = [];
  log.created = [];
  log.joins = [];
  busySockets.clear();
  server = await startArcadeServer({ arcade: { tableGames: [fakeTable, null], tableLaneBusy: (id) => busySockets.has(id) } });
  const account = await server.account();
  me = await account.socket();
  socketId = me.raw.id as string;
});

afterEach(async () => {
  await server.close();
});

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const blobs = () => me.received('lamplight:blob') as { i: number; ms?: number }[];

describe('the paced emitter', () => {
  it('sends a 6 KB burst at once and the rest at 3 KB/s', async () => {
    // Each blob is about 1,000 B on the wire.
    expect(await me.request('lamplight:burst', { n: 12, pad: 880 })).toEqual({ ok: true });
    await settle();
    const first = blobs().length;
    expect(first).toBeGreaterThanOrEqual(4);
    expect(first).toBeLessThanOrEqual(6);
    server.clock.advance(1000);
    await settle();
    const after = blobs().length - first;
    expect(after).toBeGreaterThanOrEqual(2);
    expect(after).toBeLessThanOrEqual(4);
    server.clock.advance(5000);
    await settle();
    expect(blobs().map((b) => b.i)).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  it('lets chat go first: pushes wait in 50 ms steps while the main socket has something queued', async () => {
    busySockets.add(socketId);
    await me.request('lamplight:burst', { n: 1, pad: 10 });
    const serverSocket = server.sockets.io.sockets.sockets.get(socketId);
    serverSocket?.emit('chat:message', { text: 'hello' });
    await settle();
    expect(me.received('chat:message')).toHaveLength(1);
    expect(blobs()).toHaveLength(0);
    server.clock.advance(200);
    await settle();
    expect(blobs()).toHaveLength(0);
    busySockets.delete(socketId);
    server.clock.advance(60);
    await settle();
    expect(blobs()).toHaveLength(1);
    expect(log.sentWaits[0]).toBeGreaterThanOrEqual(250);
  });

  it('replaces an overflowing queue with the policy event', async () => {
    // Empty the bucket first, then queue more than 32 events.
    await me.request('lamplight:burst', { n: 6, pad: 980 });
    await me.request('lamplight:burst', { n: 40, pad: 10 });
    server.clock.advance(5000);
    await settle();
    expect(me.received('lamplight:snap')).toEqual([{ snap: true }]);
    expect(blobs().length).toBeLessThan(46);
  });

  it('stamps at send time and reports the queue wait', async () => {
    await me.request('lamplight:burst', { n: 6, pad: 980 });
    const queuedAt = server.clock.now();
    await me.request('lamplight:burst', { n: 1, pad: 10, stamp: true });
    server.clock.advance(1000);
    await settle();
    const stamped = blobs().find((b) => b.ms !== undefined);
    expect(stamped?.ms).toBe(10_000 - (log.stamped[0] as number));
    expect((log.stamped[0] as number) - queuedAt).toBeGreaterThan(0);
    expect(Math.max(...log.sentWaits)).toBeGreaterThan(0);
  });

  it('applies a per-game sub-bucket (200 B/s, 800 B depth) and newest-wins coalescing', async () => {
    await me.request('lamplight:burst', { n: 6, pad: 200, sub: true });
    await settle();
    const now = blobs().length;
    expect(now).toBeLessThanOrEqual(3);
    server.clock.advance(2000);
    await settle();
    expect(blobs().length - now).toBeGreaterThanOrEqual(1);
    expect(blobs().length - now).toBeLessThanOrEqual(2);
    // Coalesced: of 5 queued behind a full bucket, only the newest is delivered.
    await me.request('lamplight:burst', { n: 6, pad: 980 });
    const before = blobs().length;
    await me.request('lamplight:burst', { n: 5, pad: 10, coalesce: true });
    server.clock.advance(10_000);
    await settle();
    const coalesced = blobs().slice(before).filter((b) => b.i < 5 && b.ms === undefined);
    expect(coalesced.length).toBeLessThan(10);
  });

  it('fans out per socket, never through io.to()', async () => {
    const to = vi.spyOn(server.sockets.io, 'to');
    expect(await me.request('lamplight:room', {})).toEqual({ ok: true, size: 1 });
    await settle();
    expect(me.received('lamplight:hello')).toEqual([{ to: socketId }]);
    expect(to).not.toHaveBeenCalled();
  });
});

describe('table-lane refusals', () => {
  it('acks a limiter refusal with {ok: false, code: busy} and never emits error', async () => {
    const answers: unknown[] = [];
    for (let i = 0; i < 6; i += 1) answers.push(await me.request('lamplight:ping', { n: i }));
    expect(answers.slice(0, 4)).toEqual([0, 1, 2, 3].map((n) => ({ ok: true, n })));
    expect(answers[4]).toEqual({ ok: false, code: 'busy' });
    expect(await me.request('lamplight:ping', { n: 'bad' as unknown as number })).toEqual({ ok: false, code: 'busy' });
    server.clock.advance(1100);
    await settle(1100);
    expect(await me.request('lamplight:ping', { n: 'bad' as unknown as number })).toEqual({ ok: false, code: 'invalid' });
    expect(me.received('error')).toEqual([]);
  });

  it('hands a table game its new lobby and lets it update the record', async () => {
    const account = await server.account();
    const host = await account.socket();
    await account.joinVoice(server.voiceChannel, host);
    const res = await host.request<{ ok: boolean; lobby: { id: string } }>('arcade:lobby:create', { ch: server.voiceChannel, game: 'lamplight', mode: 'open', cfg: {} });
    expect(res).toMatchObject({ ok: true });
    expect(log.created).toHaveLength(1);
    expect(log.created[0]).toMatchObject({ id: res.lobby.id, game: 'lamplight', host: account.id, state: 'open' });
    expect(log.created[0]?.seats[0]?.accountId).toBe(account.id);
    expect(log.joins).toEqual([]);
    expect(log.api?.db).toBeTruthy();
    const record = log.api?.hub.get(res.lobby.id);
    expect(record?.state).toBe('live');
    expect(record?.seats.map((x) => x.bot)).toEqual([false, true]);
  });

  it('refuses a hidden game with `hidden`', async () => {
    expect(await me.request('arcade:prefs:set', { games: { lamplight: false } })).toMatchObject({ ok: true });
    expect(await me.request('lamplight:ping', { n: 1 })).toEqual({ ok: false, code: 'hidden' });
    expect(me.received('error')).toEqual([]);
  });
});
