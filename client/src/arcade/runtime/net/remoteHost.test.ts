import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ByteWriter } from '@arcade/core/bytes';
import { forEachEvent } from '@arcade/core/net/events';
import { readClient, writeBeat, writeFrame, writeHandover, writeKeyframe, writeWelcome, type ClientMsg, type FrameView } from '@arcade/core/net/lane';
import { CODEC } from '@arcade/core/version';
import { arcadeLobby } from '@/features/arcade/state';
import { socketClient } from '@/services/socket/client';
import { users } from '@/state/presence';
import { connectionStatus } from '@/state/session';
import type { User } from '@/types/protocol';
import type { LobbyView, SeatInfo } from '../types';
import { createRemoteMatchHost, createRemoteTableHost } from './remoteHost';

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  bufferedAmount = 0;
  sent: (string | Uint8Array)[] = [];
  closedWith: number | null = null;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(d: string | Uint8Array) {
    this.sent.push(typeof d === 'string' ? d : d.slice());
  }
  close(code?: number) {
    this.readyState = 3;
    this.closedWith = code ?? 1005;
  }
  push(b: Uint8Array) {
    this.onmessage?.({ data: b.slice().buffer });
  }
  of<T extends ClientMsg['t']>(t: T): Extract<ClientMsg, { t: T }>[] {
    return this.sent
      .filter((d): d is Uint8Array => typeof d !== 'string')
      .map((d) => readClient(d) as ClientMsg)
      .filter((m): m is Extract<ClientMsg, { t: T }> => m.t === t);
  }
}

/** A stand-in for the Socket.IO socket inside `socketClient`, so `request()` runs for real. */
interface Pending {
  ev: string;
  payload: unknown;
  ms: number;
  cb: (error: Error | null, response?: unknown) => void;
}
const io = {
  connected: true,
  pending: [] as Pending[],
  handlers: new Map<string, Set<(d: unknown) => void>>(),
  timeout(ms: number) {
    return { emit: (ev: string, payload: unknown, cb: Pending['cb']) => io.pending.push({ ev, payload, ms, cb }) };
  },
  on(ev: string, h: (d: unknown) => void) {
    if (!io.handlers.has(ev)) io.handlers.set(ev, new Set());
    io.handlers.get(ev)?.add(h);
  },
  off(ev: string, h: (d: unknown) => void) {
    io.handlers.get(ev)?.delete(h);
  },
  /** Ack the oldest pending request for `ev`. */
  answer(ev: string, response: unknown = { ok: true }) {
    const i = io.pending.findIndex((p) => p.ev === ev);
    const [p] = io.pending.splice(i, 1);
    p?.cb(null, response);
  },
};
const inner = socketClient as unknown as { socket: unknown; acks: number[] };

const last = (): FakeSocket => FakeSocket.all[FakeSocket.all.length - 1] as FakeSocket;
const welcome = (tick = 0) =>
  writeWelcome({ proto: 1, game: 1, codec: CODEC.fuseyard, slot: 0, queued: false, tick, tickHz: 30, divisor: 2, lastEvSeq: 0, resumeToken: new Uint8Array(32), cfg: new Uint8Array(0) });
const events = (...kinds: number[]) => {
  const w = new ByteWriter(64);
  for (const k of kinds) w.u8(k).u8(k + 1);
  return { count: kinds.length, bytes: w.copy() };
};

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  io.pending = [];
  io.handlers.clear();
  io.connected = true;
  inner.socket = io;
  inner.acks = [];
});
afterEach(() => {
  inner.socket = null;
  arcadeLobby.value = null;
  users.value = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const open = (tick = 0) => {
  const host = createRemoteMatchHost({ lobbyId: 'L1', ticket: 'T1', game: 'fuseyard' });
  const s = last();
  s.readyState = 1;
  s.onopen?.(new Event('open'));
  return { host, s, start: () => s.push(welcome(tick)) };
};

describe('createRemoteMatchHost', () => {
  it('builds FrameViews and KeyframeViews with extended ticks, and RESYNC 1 when a game leaves bytes', () => {
    const { host, s, start } = open(0xfff0);
    const seen: { tick: number; local: boolean; divisor: number; lagging: boolean; snap: number[]; ev: number[]; evTick: number }[] = [];
    let consume = true;
    host.onFrame((f: FrameView) => {
      const snap = f.snapshot ? [f.snapshot.u8(), f.snapshot.u8()] : [];
      const ev: number[] = [];
      if (f.events && consume) forEachEvent(f.events, (k, r) => (ev.push(k, r.u8()), true), () => undefined);
      else if (f.events) ev.push(f.events.r.u8());
      seen.push({ tick: f.tick, local: f.local, divisor: f.divisor, lagging: f.lagging, snap, ev, evTick: f.events?.tick ?? -1 });
    });
    const keyframes: number[] = [];
    let keyRead = 1;
    host.onKeyframe((k) => {
      keyframes.push(k.tick);
      for (let i = 0; i < keyRead; i += 1) k.body.u8();
    });
    start();
    s.push(writeKeyframe(1, 0xfff2, 0, 0, new Uint8Array([7])));
    s.push(writeFrame({ frameSeq: 2, tick: 0x0004, ackUp: 0, divisor: 3, lagging: true, snapshot: new Uint8Array([3, 4]), events: events(1, 2) }));
    expect(keyframes).toEqual([0xfff2]);
    expect(seen).toEqual([{ tick: 0x10004, local: false, divisor: 3, lagging: true, snap: [3, 4], ev: [1, 2, 2, 3], evTick: 0x10004 }]);
    expect(s.of('resync')).toEqual([]);
    // The game reads one byte of a two-event block: decode error.
    consume = false;
    s.push(writeFrame({ frameSeq: 3, tick: 0x0006, ackUp: 0, divisor: 2, snapshot: null, events: events(1, 2) }));
    expect(s.of('resync')).toEqual([{ t: 'resync', reason: 1 }]);
    // Dropped until the keyframe the server sends back.
    s.push(writeFrame({ frameSeq: 4, tick: 0x0008, ackUp: 0, divisor: 2, snapshot: null, events: null }));
    expect(seen).toHaveLength(2);
    // A keyframe body left half read is a decode error too.
    keyRead = 1;
    s.push(writeKeyframe(5, 0x000a, 0, 5, new Uint8Array([1, 2])));
    expect(s.of('resync').map((r) => r.reason)).toEqual([1, 1]);
    expect(keyframes).toEqual([0xfff2, 0x1000a]);
    host.close();
  });

  it('inflates a HANDOVER before onHandover, and reports the restart close after it', async () => {
    const { host, s, start } = open();
    const log: string[] = [];
    host.onHandover((body, sim) => log.push('handover ' + sim + ' ' + Array.from(body).join(',')));
    host.onClosed((code, reason) => log.push('closed ' + code + ' ' + reason));
    start();
    s.push(writeHandover(3, 900, new Uint8Array(deflateRawSync(Buffer.from([5, 6, 7, 8])))));
    s.onclose?.({ code: 1012, reason: 'restart' });
    expect(log).toEqual([]);
    await vi.waitFor(() => expect(log).toHaveLength(2));
    expect(log).toEqual(['handover 3 5,6,7,8', 'closed 1012 restart']);
    // A non-final close is not reported: the lane reconnects on its own.
    const b = open();
    const closes: number[] = [];
    b.host.onClosed((code) => closes.push(code));
    b.start();
    b.s.onclose?.({ code: 1006, reason: '' });
    expect(closes).toEqual([]);
    b.host.close();
    host.close();
  });

  it('asks for a fresh ticket with the lobby id after a 4401 on a resume', async () => {
    const { host, s, start } = open();
    start();
    s.onclose?.({ code: 1006, reason: '' });
    await vi.advanceTimersByTimeAsync(700);
    last().onclose?.({ code: 4401, reason: '' });
    await vi.advanceTimersByTimeAsync(1300);
    expect(io.pending.map((p) => [p.ev, p.payload])).toEqual([['arcade:ticket', { id: 'L1' }]]);
    io.answer('arcade:ticket', { ok: true, ticket: 'T2', exp: 1 });
    await vi.advanceTimersByTimeAsync(0);
    const s3 = last();
    s3.onopen?.(new Event('open'));
    expect(JSON.parse(s3.sent[0] as string).ticket).toBe('T2');
    host.close();
  });

  it('maps lobby seats and presence names, and calls back at once and on change only', () => {
    const user = (accountId: string, displayName: string): User => ({ id: 's-' + accountId, accountId, username: accountId, displayName, roles: [], isSuperuser: false });
    users.value = [user('a1', 'Ada'), user('a2', 'Bo')];
    const lobby = (seats: LobbyView['seats'], id = 'L1'): LobbyView => ({ id, game: 'fuseyard', ch: 'c', mode: 'brawl', st: 'live', host: 'a1', seats, spec: 0, cfg: {}, v: 1 });
    arcadeLobby.value = lobby([
      { a: 'a1', bot: false, st: 0 },
      { a: null, bot: true, st: 0 },
      { a: 'a2', bot: false, st: 0 },
      { a: 'a9', bot: false, st: 0 },
    ]);
    const { host } = open();
    const calls: SeatInfo[][] = [];
    const off = host.onSeats((seats) => calls.push([...seats]));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      { slot: 0, accountId: 'a1', name: 'Ada', bot: false, joinOrder: 0, extra: 0 },
      { slot: 1, accountId: null, name: 'Bot 1', bot: true, joinOrder: 1, extra: 0 },
      { slot: 2, accountId: 'a2', name: 'Bo', bot: false, joinOrder: 2, extra: 0 },
      { slot: 3, accountId: 'a9', name: 'Player', bot: false, joinOrder: 3, extra: 0 },
    ]);
    // A presence change that changes no seat: no call.
    users.value = [...users.value, user('a5', 'Cy')];
    expect(calls).toHaveLength(1);
    users.value = [user('a1', 'Ada L.'), user('a2', 'Bo')];
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[0]?.name).toBe('Ada L.');
    // Another lobby: no seats.
    vi.advanceTimersByTime(1100);
    arcadeLobby.value = lobby([{ a: 'a1', bot: false, st: 0 }], 'L2');
    expect(calls[2]).toEqual([]);
    off();
    vi.advanceTimersByTime(1100);
    arcadeLobby.value = lobby([{ a: 'a1', bot: false, st: 0 }]);
    expect(calls).toHaveLength(3);
    host.close();
  });

  it('sends VIS on setVisible, VIS 2 while chat first yields, and resends after reconnect', async () => {
    const { host, s, start } = open();
    const yields: boolean[] = [];
    const offYield = host.onYield((y) => yields.push(y));
    start();
    host.setVisible(false);
    host.setVisible(true);
    expect(s.of('vis').map((v) => v.state)).toEqual([1, 0]);
    // A chat request whose ack takes 2.5 s: yield.
    void socketClient.request('chat:send', { text: 'hi' });
    await vi.advanceTimersByTimeAsync(2500);
    // Keep the lane alive while the test plays with time.
    s.push(writeBeat(0));
    io.answer('chat:send');
    expect(yields).toEqual([true]);
    expect(s.of('vis').map((v) => v.state)).toEqual([1, 0, 2]);
    // Hidden while yielding: VIS 2 still wins.
    host.setVisible(false);
    expect(s.of('vis').map((v) => v.state)).toEqual([1, 0, 2]);
    host.sendUp(new Uint8Array([1]));
    expect(s.of('up')).toEqual([]);
    // Probes every 2 s; two quick answers resume (hidden, so VIS 1).
    for (let i = 0; i < 2; i += 1) {
      await vi.advanceTimersByTimeAsync(2000);
      s.push(writeBeat(0));
      expect(io.pending.map((p) => p.ev)).toEqual(['arcade:probe']);
      await vi.advanceTimersByTimeAsync(50);
      io.answer('arcade:probe');
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(yields).toEqual([true, false]);
    expect(s.of('vis').map((v) => v.state)).toEqual([1, 0, 2, 1]);
    // A reconnect resends the current VIS after WELCOME.
    s.onclose?.({ code: 1006, reason: '' });
    await vi.advanceTimersByTimeAsync(700);
    const s2 = last();
    s2.onopen?.(new Event('open'));
    s2.push(welcome());
    expect(s2.of('vis').map((v) => v.state)).toEqual([1]);
    offYield();
    host.close();
  });

  it('exposes rtt, server tick and link state; close() sends VIS 3, closes 1000 and leaves nothing', () => {
    const { host, s, start } = open(500);
    const calls: number[] = [];
    host.onSeats(() => calls.push(1));
    start();
    expect(host.rttMs()).toBe(0);
    expect(host.estServerTick(performance.now())).toBe(500);
    expect(host.linkConstrained()).toBe(false);
    s.push(writeKeyframe(1, 501, 0, 0, new Uint8Array(0)));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const acks = (socketClient as unknown as { ackListeners: Set<unknown> }).ackListeners;
    expect(acks.size).toBe(1);
    host.close();
    expect(s.of('vis').pop()).toEqual({ t: 'vis', state: 3 });
    expect(s.closedWith).toBe(1000);
    expect(vi.getTimerCount()).toBe(0);
    expect(acks.size).toBe(0);
    arcadeLobby.value = { id: 'L1', game: 'fuseyard', ch: 'c', mode: 'brawl', st: 'live', host: 'a1', seats: [{ a: 'a1', bot: false, st: 0 }], spec: 0, cfg: {}, v: 2 };
    expect(calls).toHaveLength(1);
  });
});

describe('createRemoteTableHost', () => {
  it('requests and listens on the app socket, follows the connection, and close() removes listeners', async () => {
    const host = createRemoteTableHost('lamplight');
    expect(host.mode).toBe('remote');
    const reply = host.request<{ ok: boolean }>('lamplight:act', { a: 'fold' });
    await vi.advanceTimersByTimeAsync(10);
    const quick = host.request('lamplight:sit', {}, { timeoutMs: 2000 });
    expect(io.pending.map((p) => [p.ev, p.ms])).toEqual([
      ['lamplight:act', 8000],
      ['lamplight:sit', 2000],
    ]);
    await vi.advanceTimersByTimeAsync(110);
    io.answer('lamplight:act', { ok: true });
    await expect(reply).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(80);
    io.answer('lamplight:sit', { ok: true });
    await quick;
    // The ring holds 120 and 190 ms; the median of two is the upper one.
    expect(host.ackRttMs()).toBe(190);
    expect(socketClient.lastRequestAt()).toBe(10);

    const got: unknown[] = [];
    host.on('lamplight:hand', (d) => got.push(d));
    const off = host.on('lamplight:act', (d) => got.push(d));
    io.handlers.get('lamplight:hand')?.forEach((h) => h({ n: 1 }));
    expect(got).toEqual([{ n: 1 }]);
    off();
    expect(io.handlers.get('lamplight:act')?.size).toBe(0);

    expect(host.connected()).toBe(true);
    io.connected = false;
    expect(host.connected()).toBe(false);
    connectionStatus.value = 'connected';
    const ups: boolean[] = [];
    host.onConnection((up) => ups.push(up));
    connectionStatus.value = 'reconnecting';
    connectionStatus.value = 'offline';
    connectionStatus.value = 'connected';
    expect(ups).toEqual([true, false, true]);

    host.setVisible(false);
    expect(host.visible).toBe(false);
    host.close();
    expect(io.handlers.get('lamplight:hand')?.size).toBe(0);
    connectionStatus.value = 'offline';
    expect(ups).toEqual([true, false, true]);
  });

  it('counts a timed-out request as a round trip of its timeout', async () => {
    const host = createRemoteTableHost('glimmer');
    const rtts: number[] = [];
    const off = socketClient.onAck((ms) => rtts.push(ms));
    const p = host.request('glimmer:spin', {}, { timeoutMs: 3000 });
    const [pending] = io.pending;
    pending?.cb(new Error('operation has timed out'));
    await expect(p).rejects.toThrow('timed out');
    expect(rtts).toEqual([3000]);
    off();
    host.close();
  });
});
