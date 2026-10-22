import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { b64url } from '@arcade/core/bytes';
import { readClient, writeBeat, writeBye, writeFrame, writeKeyframe, writePong, writeWelcome, type ClientMsg, type Welcome } from '@arcade/core/net/lane';
import { CODEC } from '@arcade/core/version';
import { createLaneClient, laneUrl, type LaneEvents } from './laneClient';

/** A WebSocket stand-in: the test plays the server. */
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
  accept() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  push(b: Uint8Array) {
    this.onmessage?.({ data: b.slice().buffer });
  }
  drop(code: number, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  /** Decoded binary messages sent so far. */
  msgs(): ClientMsg[] {
    return this.sent.filter((d): d is Uint8Array => typeof d !== 'string').map((d) => readClient(d) as ClientMsg);
  }
  of<T extends ClientMsg['t']>(t: T): Extract<ClientMsg, { t: T }>[] {
    return this.msgs().filter((m): m is Extract<ClientMsg, { t: T }> => m.t === t);
  }
  hello(): Record<string, unknown> {
    return JSON.parse(this.sent[0] as string) as Record<string, unknown>;
  }
}

const TOKEN = new Uint8Array(32).fill(7);
const welcomeMsg = (o: Partial<Welcome> = {}): Uint8Array =>
  writeWelcome({ proto: 1, game: 1, codec: CODEC.fuseyard, slot: 0, queued: false, tick: 0, tickHz: 30, divisor: 2, lastEvSeq: 0, resumeToken: TOKEN, cfg: new Uint8Array(0), ...o });
const frameMsg = (frameSeq: number, tick: number, events: { count: number; bytes: Uint8Array } | null = null): Uint8Array =>
  writeFrame({ frameSeq, tick: tick & 0xffff, ackUp: 0, divisor: 2, snapshot: new Uint8Array([1, 2]), events });
const keyframeMsg = (frameSeq: number, tick: number, reason = 0, body = new Uint8Array([9])): Uint8Array => writeKeyframe(frameSeq, tick & 0xffff, 0, reason, body);

const last = (): FakeSocket => FakeSocket.all[FakeSocket.all.length - 1] as FakeSocket;

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const setup = (getTicket: () => Promise<string | null> = async () => 'fresh') => {
  const log = { welcome: [] as Welcome[], frames: [] as [number, number][], keyframes: [] as [number, number, number][], closed: [] as [number, string, boolean][] };
  const on: LaneEvents = {
    welcome: (w) => log.welcome.push(w),
    frame: (m) => log.frames.push([m.frameSeq, m.tick]),
    keyframe: (m) => log.keyframes.push([m.frameSeq, m.tick, m.reason]),
    phase: () => undefined,
    handover: () => undefined,
    closed: (code, reason, final) => log.closed.push([code, reason, final]),
  };
  const ticketSpy = vi.fn(getTicket);
  const lane = createLaneClient({ game: 'fuseyard', ticket: 'T1', getTicket: ticketSpy, on, url: 'ws://test/arcade/ws' });
  return { lane, log, getTicket: ticketSpy };
};

/** Open the current socket and welcome it. */
const live = (o: Partial<Welcome> = {}): FakeSocket => {
  const s = last();
  s.accept();
  s.push(welcomeMsg(o));
  return s;
};

describe('laneUrl', () => {
  it('turns the server URL into ws:// or wss:// plus /arcade/ws', () => {
    expect(laneUrl('/')).toBe('ws://' + location.host + '/arcade/ws');
    expect(laneUrl('https://chat.example.org')).toBe('wss://chat.example.org/arcade/ws');
    expect(laneUrl('http://10.0.2.2:4000')).toBe('ws://10.0.2.2:4000/arcade/ws');
  });
});

describe('createLaneClient', () => {
  it('sends HELLO as text on open, then only binary', () => {
    const { lane } = setup();
    const s = last();
    expect(s.url).toBe('ws://test/arcade/ws');
    expect(s.sent).toEqual([]);
    s.accept();
    expect(s.binaryType).toBe('arraybuffer');
    expect(s.sent[0]).toBe(JSON.stringify({ t: 'hello', proto: 1, codec: { fuseyard: CODEC.fuseyard }, ticket: 'T1' }));
    // Nothing binary before WELCOME.
    lane.sendUp(new Uint8Array([1]));
    expect(s.sent).toHaveLength(1);
    s.push(welcomeMsg());
    lane.sendUp(new Uint8Array([1]));
    expect(s.sent.length).toBeGreaterThan(2);
    expect(s.sent.slice(1).every((d) => d instanceof Uint8Array)).toBe(true);
    expect(s.msgs().map((m) => m.t)).toEqual(['ping', 'up']);
    lane.close();
  });

  it('delivers KEYFRAME and FRAMEs with ticks extended across the u16 wrap', () => {
    const { lane, log } = setup();
    const anchor = 0x2fff0;
    live({ tick: anchor });
    const s = last();
    // A FRAME before the first keyframe has no base: dropped without a RESYNC.
    s.push(frameMsg(4, anchor + 1));
    s.push(keyframeMsg(5, anchor + 2));
    for (let i = 1; i <= 12; i += 1) s.push(frameMsg(5 + i, anchor + 2 + i * 2));
    expect(log.welcome[0]?.tick).toBe(anchor);
    expect(log.keyframes).toEqual([[5, anchor + 2, 0]]);
    expect(log.frames.map((f) => f[1])).toEqual(Array.from({ length: 12 }, (_, i) => anchor + 4 + i * 2));
    expect(log.frames.some((f) => f[1] > 0x30000)).toBe(true);
    expect(s.of('resync')).toEqual([]);
    lane.close();
  });

  it('on a gap sends RESYNC 0 once and drops FRAMEs until the next KEYFRAME', () => {
    const { lane, log } = setup();
    const s = live({ tick: 100 });
    s.push(keyframeMsg(10, 100));
    s.push(frameMsg(11, 102));
    s.push(frameMsg(13, 106));
    s.push(frameMsg(14, 108));
    expect(s.of('resync')).toEqual([{ t: 'resync', reason: 0 }]);
    expect(log.frames.map((f) => f[0])).toEqual([11]);
    s.push(keyframeMsg(15, 110, 5));
    s.push(frameMsg(16, 112));
    expect(log.keyframes.map((k) => k[0])).toEqual([10, 15]);
    expect(log.frames.map((f) => f[0])).toEqual([11, 16]);
    // resync() from the host (a decode error) also waits for a keyframe.
    lane.resync(1);
    s.push(frameMsg(17, 114));
    expect(log.frames.map((f) => f[0])).toEqual([11, 16]);
    expect(s.of('resync').map((r) => r.reason)).toEqual([0, 1]);
    lane.close();
  });

  it('skips UP while more than 512 B are buffered, numbers it, and acks the newest frame with it', () => {
    const { lane } = setup();
    const s = live();
    s.push(keyframeMsg(1, 2));
    vi.advanceTimersByTime(40);
    s.bufferedAmount = 600;
    lane.sendUp(new Uint8Array([5]));
    expect(s.of('up')).toEqual([]);
    s.bufferedAmount = 512;
    lane.sendUp(new Uint8Array([6]));
    lane.sendUp(new Uint8Array([7]), 300);
    lane.sendUp(new Uint8Array([8]));
    const ups = s.of('up');
    expect(ups.map((u) => [u.upSeq, u.payload[0]])).toEqual([
      [2, 6],
      [300, 7],
      [301, 8],
    ]);
    expect(ups[0]?.ackFrame).toBe(1);
    expect(ups[0]?.ackDelayMs).toBe(40);
    lane.close();
  });

  it('ACKs at about 4 Hz while frames flow, none when they stop, and none while UPs flow', () => {
    const { lane } = setup();
    const s = live();
    s.push(keyframeMsg(0, 0));
    let seq = 0;
    const flow = (ms: number, up: boolean) => {
      for (let t = 0; t < ms; t += 66) {
        vi.advanceTimersByTime(66);
        s.push(frameMsg(++seq, seq * 2));
        if (up) lane.sendUp(new Uint8Array([1]));
      }
    };
    flow(2000, false);
    const acks = s.of('ack');
    expect(acks.length).toBeGreaterThanOrEqual(7);
    expect(acks.length).toBeLessThanOrEqual(9);
    expect(acks[acks.length - 1]?.ackFrame).toBeGreaterThan(seq - 4);
    for (const a of acks) expect(a.ackDelayMs).toBeLessThan(250);
    // Frames stop: at most the one ACK still due, then none (beats keep the lane alive).
    const before = s.of('ack').length;
    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(1000);
      s.push(writeBeat(i));
    }
    expect(s.of('ack').length - before).toBeLessThanOrEqual(1);
    const quiet = s.of('ack').length;
    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(1000);
      s.push(writeBeat(i));
    }
    expect(s.of('ack').length).toBe(quiet);
    // UPs carry the ack: no ACK messages at all.
    flow(2000, true);
    expect(s.of('ack').length).toBe(quiet + 1);
    lane.close();
  });

  it('while yielding (VIS 2) stops UP and ACKs at 1 Hz', () => {
    const { lane } = setup();
    const s = live();
    s.push(keyframeMsg(0, 0));
    lane.setVis(2);
    expect(s.of('vis')).toEqual([{ t: 'vis', state: 2 }]);
    const acks = s.of('ack').length;
    for (let i = 1; i <= 60; i += 1) {
      vi.advanceTimersByTime(66);
      s.push(frameMsg(i, i * 2));
      lane.sendUp(new Uint8Array([1]));
    }
    expect(s.of('up')).toEqual([]);
    const n = s.of('ack').length - acks;
    expect(n).toBeGreaterThanOrEqual(3);
    expect(n).toBeLessThanOrEqual(5);
    lane.setVis(0);
    lane.sendUp(new Uint8Array([1]));
    expect(s.of('up')).toHaveLength(1);
    lane.close();
  });

  it('pings 5 times about 200 ms apart, then every 2 s; PONG feeds the tick clock', () => {
    const { lane } = setup();
    const s = live({ tick: 1000 });
    vi.advanceTimersByTime(999);
    const early = s.of('ping');
    expect(early).toHaveLength(5);
    // Answer a ping 40 ms after it went out.
    const pongAt = performance.now();
    s.push(writePong(pongAt - 40 >>> 0, 1500, 0));
    expect(lane.rttMs).toBeCloseTo(40, 0);
    expect(lane.serverTickAt(performance.now())).toBeCloseTo(1500 + 20 / (1000 / 30), 1);
    for (let i = 0; i < 8; i += 1) {
      vi.advanceTimersByTime(1000);
      s.push(writeBeat(1500 + i * 30));
    }
    // 1 s → 9 s: pings at 2.8, 4.8, 6.8 and 8.8 s.
    expect(s.of('ping')).toHaveLength(9);
    lane.close();
  });

  it('treats 5 s of silence as a dead lane and resumes with the token', () => {
    const { lane, log } = setup();
    const s = live();
    vi.advanceTimersByTime(4999);
    expect(s.closedWith).toBeNull();
    vi.advanceTimersByTime(1);
    // Not 1000: that would give the seat up.
    expect(s.closedWith).toBe(1005);
    expect(log.closed).toEqual([[1006, 'no answer', false]]);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(700);
    expect(FakeSocket.all).toHaveLength(2);
    last().accept();
    expect(last().hello()).toEqual({ t: 'hello', proto: 1, codec: { fuseyard: CODEC.fuseyard }, resume: b64url(TOKEN) });
    lane.close();
  });

  it('falls back once to a fresh ticket after 4401 on a resume', async () => {
    const { lane, log, getTicket } = setup();
    live();
    last().drop(1006);
    await vi.advanceTimersByTimeAsync(700);
    last().accept();
    expect(last().hello().resume).toBe(b64url(TOKEN));
    last().drop(4401);
    expect(log.closed[1]).toEqual([4401, '', false]);
    await vi.advanceTimersByTimeAsync(1300);
    expect(getTicket).toHaveBeenCalledTimes(1);
    expect(FakeSocket.all).toHaveLength(3);
    last().accept();
    expect(last().hello().ticket).toBe('fresh');
    last().drop(4401);
    expect(log.closed[2]).toEqual([4401, '', true]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSocket.all).toHaveLength(3);
    expect(getTicket).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    lane.close();
  });

  it('stops for good on 1000, 1012, 4000, 4403, 4404, 4409, 4426 and a 4401 on a ticket', async () => {
    for (const code of [1000, 1012, 4000, 4403, 4404, 4409, 4426, 4401]) {
      FakeSocket.all = [];
      const { log } = setup();
      const s = live();
      s.push(writeBye(code, 'bye ' + code));
      s.drop(code, 'ignored');
      expect(log.closed).toEqual([[code, 'bye ' + code, true]]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(FakeSocket.all).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('retries other closes, and stops when no fresh ticket can be had', async () => {
    const { lane, log } = setup(async () => null);
    // Dropped before any WELCOME: no token, the first ticket is spent, so it asks for a new one.
    last().accept();
    last().drop(1006, 'gone');
    expect(log.closed).toEqual([[1006, 'gone', false]]);
    await vi.advanceTimersByTimeAsync(700);
    expect(log.closed[1]).toEqual([4401, 'no ticket', true]);
    expect(FakeSocket.all).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    lane.close();
  });

  it('resends EVTs above WELCOME.lastEvSeq after a resume, and VIS', async () => {
    const { lane } = setup();
    // Sent before the first WELCOME: queued, then sent after it.
    lane.sendEvent(new Uint8Array([0x10]));
    const s = live();
    expect(s.of('evt').map((e) => e.evSeq)).toEqual([1]);
    lane.sendEvent(new Uint8Array([0x11]));
    lane.sendEvent(new Uint8Array([0x12]));
    lane.setVis(1);
    expect(s.of('evt').map((e) => [e.evSeq, e.payload[0]])).toEqual([
      [1, 0x10],
      [2, 0x11],
      [3, 0x12],
    ]);
    s.drop(1006);
    lane.sendEvent(new Uint8Array([0x13]));
    await vi.advanceTimersByTimeAsync(700);
    const s2 = live({ lastEvSeq: 2 });
    expect(s2.of('evt').map((e) => [e.evSeq, e.payload[0]])).toEqual([
      [3, 0x12],
      [4, 0x13],
    ]);
    expect(s2.of('vis')).toEqual([{ t: 'vis', state: 1 }]);
    // Confirmed ones are forgotten: the next resume with lastEvSeq 4 resends nothing.
    s2.drop(1006);
    await vi.advanceTimersByTimeAsync(700);
    const s3 = live({ lastEvSeq: 4 });
    expect(s3.of('evt')).toEqual([]);
    lane.close();
  });

  it('close() sends VIS 3, closes with 1000 and leaves no timer', async () => {
    const { lane, log } = setup();
    const s = live();
    s.push(keyframeMsg(0, 0));
    vi.advanceTimersByTime(66);
    s.push(frameMsg(1, 2));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    lane.close();
    expect(s.msgs().pop()).toEqual({ t: 'vis', state: 3 });
    expect(s.closedWith).toBe(1000);
    expect(s.onmessage).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(log.closed).toEqual([]);
    // Also while waiting to reconnect.
    const b = setup();
    last().accept();
    last().push(welcomeMsg());
    last().drop(1006);
    expect(vi.getTimerCount()).toBe(1);
    b.lane.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSocket.all).toHaveLength(2);
  });
});
