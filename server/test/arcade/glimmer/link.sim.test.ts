/**
 * Glimmerhall on a simulated 3G link (glimmerhall.md §18.2, plan.md §3.4 "Pacing"), in virtual time.
 *
 * The measured phone shares a 750/250 kbit/s link (300 ms ± 25 ms, 147 kbit/s of voice each way) with
 * a chat prober. It spins at the 700 ms client floor; three other members spin at the server's 2 per
 * second (hall and Dash spins) and react at their cap. The hall's pushes go through the platform's
 * real paced emitter (3 KB/s socket bucket, the 200 B/s Glimmerhall sub-bucket, chat first while the
 * socket's write buffer holds anything). A 3 s main-socket backlog is injected half way.
 *
 * Checks: chat one-way p95 < 300 ms (< 450 ms with 1 % loss); spin ack round trip p95 < RTT + 100 ms;
 * Glimmerhall down ≤ 4 kbit/s average and ≤ 3 KB in any second, up ≤ 2.4 kbit/s; no push is written
 * while the write buffer holds anything, and the first push after the backlog carries what waited.
 */
import { describe, expect, it } from 'vitest';
import type { Server, Socket } from 'socket.io';
import { OVERHEAD } from '../../../src/arcade/core/net/budget.js';
import { DEFS } from '../../../src/arcade/core/version.js';
import type { FeedView, SpinOk } from '../../../src/arcade/core/glimmer/wire.js';
import { createPacedEmitter } from '../../../src/arcade/handlers.js';
import { lossyLink, percentile, withWallCap } from '../harness/sim.js';
import { createHarness, scripted, sid } from './harness.js';

interface Msg {
  kind: 'chat' | 'push' | 'ack' | 'spin' | 'other';
  sentAt: number;
  data?: unknown;
}

const CH = 'chan_sim';
const PHONE = 'phone';
const OTHERS = ['o1', 'o2', 'o3'];
const DURATION = 60_000;
const BACKLOG = { from: 30_000, to: 33_000 };

const run = (loss: number) =>
  withWallCap(5_000, (progress) => {
    const link = lossyLink<Msg>({ downBps: 750_000, upBps: 250_000, rttMs: 300, jitterMs: 50, loss, voiceBps: 147_000, seed: 7 });
    const r = scripted(101);
    let emitter: ReturnType<typeof createPacedEmitter> | null = null;
    const downPerSecond: number[] = new Array(Math.ceil(DURATION / 1000)).fill(0);
    const upPerSecond: number[] = new Array(Math.ceil(DURATION / 1000)).fill(0);
    const pushesWhileBusy: number[] = [];
    const pushes: { at: number; view: FeedView }[] = [];
    const h = createHarness({
      rng: r.rng,
      potRng: () => 999_999,
      emit: (socketId, ev, data, opts) => {
        if (socketId === 's-' + PHONE) emitter?.emit(socketId, ev, data, opts);
      },
    });
    const clock = h.clock;
    const t0 = clock.now();
    /** Link time: ms since the start, as the link and the loop count it. */
    const simNow = (): number => clock.now() - t0;
    // The phone's socket as the emitter sees it: writes go into the link; its write buffer is what waits at the sender.
    const phoneSocket = {
      id: 's-' + PHONE,
      connected: true,
      conn: {},
      emit(ev: string, data: unknown) {
        const payload = ev.length + JSON.stringify(data).length;
        if (link.buffered('down', 'main') > 0) pushesWhileBusy.push(simNow());
        link.write('down', 'main', payload + OVERHEAD.tableDown, payload, { kind: 'push', sentAt: simNow(), data });
        const sec = Math.floor(simNow() / 1000);
        if (sec < downPerSecond.length) downPerSecond[sec] = (downPerSecond[sec] as number) + payload + OVERHEAD.tableDown;
        if (ev === 'glimmer:feed') pushes.push({ at: simNow(), view: data as FeedView });
        return true;
      },
    } as unknown as Socket;
    const io = { sockets: { sockets: new Map([[phoneSocket.id, phoneSocket]]) } } as unknown as Server;
    emitter = createPacedEmitter({ io, clock, onEgress: () => undefined, busy: () => link.buffered('down', 'main') > 0 });

    const all = [PHONE, ...OTHERS];
    h.addAccount(...all);
    for (const id of all) {
      h.voice.set(id, CH);
      h.call(h.ctx(id), 'glimmer:enter', { ch: CH, v: DEFS.glimmer });
    }
    // A Dash with everyone in it.
    const dash = h.call<{ ok: true; dash: { id: string } }>(h.ctx('o1'), 'glimmer:dash:create', { m: 1, len: 10, buy: 0 }).dash.id;
    for (const id of all) if (id !== 'o1') h.call(h.ctx(id), 'glimmer:dash:join', { id: dash });
    h.call(h.ctx('o1'), 'glimmer:dash:start', { id: dash });

    const chat: number[] = [];

    const acks: number[] = [];
    let nextSpin = 100;
    let nextChat = 50;
    let nextOther = 0;
    let nextReact = 0;
    let lostAcks = 0;
    for (let t = 0; t < DURATION; t += 1) {
      clock.advance(1);
      if (t === BACKLOG.from) link.delay('down', 'main', BACKLOG.from, BACKLOG.to, BACKLOG.to - BACKLOG.from);
      if (t >= nextChat) {
        link.write('down', 'main', 150, 58, { kind: 'chat', sentAt: t });
        nextChat += 500;
      }
      if (t >= nextSpin) {
        const payload = 36;
        link.write('up', 'main', payload + OVERHEAD.tableUp, payload, { kind: 'spin', sentAt: t, data: sid() });
        upPerSecond[Math.floor(t / 1000)] += payload + OVERHEAD.tableUp;
        nextSpin += 700;
      }
      if (t >= nextOther) {
        for (const id of OTHERS) {
          const m = (t / 500) % 3;
          if ((t / 500) % 2 === 0) h.call(h.ctx(id), 'glimmer:spin', { m, b: m === 0 ? 50 : 40, id: sid() });
          else h.call(h.ctx(id), 'glimmer:dash:spin', { d: dash, id: sid() });
        }
        nextOther += 500;
      }
      if (t >= nextReact) {
        for (const id of OTHERS) h.call(h.ctx(id), 'glimmer:react', { to: 0, e: 1 });
        nextReact += 3000;
      }
      link.step((dir, _stream, msg, sentAt) => {
        if (dir === 'down') {
          // The phone's TCP acks for what it received.
          link.fluid('up', OVERHEAD.tcpAck);
          upPerSecond[Math.floor(t / 1000)] += OVERHEAD.tcpAck;
          // Messages written during the injected backlog leave 3 s late and everything behind them waits
          // until they drain (about 3 s after it ends): that stretch has its own checks.
          const inBacklog = msg.sentAt >= BACKLOG.from - 1000 && msg.sentAt < BACKLOG.to + 3000;
          if (msg.kind === 'chat' && !inBacklog) chat.push(t - sentAt);

          if (msg.kind === 'ack' && !inBacklog) acks.push(t - msg.sentAt);
          return;
        }
        link.fluid('down', OVERHEAD.tcpAck);
        if (msg.kind !== 'spin') return;
        const ack = h.call<SpinOk>(h.ctx(PHONE), 'glimmer:spin', { m: 1, b: 20, id: msg.data as string });
        if (!ack.ok) {
          lostAcks += 1;
          return;
        }
        emitter?.chargeAck('s-' + PHONE, ack);
        const payload = JSON.stringify(ack).length;
        link.write('down', 'main', payload + OVERHEAD.tableDown, payload, { kind: 'ack', sentAt: msg.sentAt });
        downPerSecond[Math.floor(t / 1000)] += payload + OVERHEAD.tableDown;
      });
      if (t % 5000 === 0) progress(t);
    }
    emitter.stop();
    h.game.stop();
    return { chat, acks, downPerSecond, upPerSecond, pushes, pushesWhileBusy, lostAcks, link };
  });

describe('Glimmerhall on a simulated 3G link', () => {
  for (const loss of [0, 0.01]) {
    it('keeps chat first, acks quick and the bytes in budget' + (loss ? ' with 1 % loss' : ''), () => {
      const t0 = performance.now();
      const res = run(loss);
      const chatP95 = percentile(res.chat, 95);
      const ackP95 = percentile(res.acks, 95);
      const steady = res.downPerSecond.slice(1);
      const downAvg = steady.reduce((a, b) => a + b, 0) / steady.length;
      const upAvg = res.upPerSecond.slice(1).reduce((a, b) => a + b, 0) / (res.upPerSecond.length - 1);
      const summary = { chatP95, ackP95, downAvgBps: Math.round(downAvg), downMax1s: Math.max(...steady), upAvgBps: Math.round(upAvg), pushes: res.pushes.length, wallMs: Math.round(performance.now() - t0) };
      expect(res.lostAcks).toBe(0);
      expect(res.acks.length).toBeGreaterThan(70);
      expect(chatP95, JSON.stringify(summary)).toBeLessThan(loss ? 450 : 300);
      // §18.2 states the ack target for the clean 3G link; with loss a retransmission (RTO 600 ms) shows in the tail.
      if (!loss) expect(ackP95, JSON.stringify(summary)).toBeLessThan(300 + 100);
      expect(downAvg, JSON.stringify(summary)).toBeLessThanOrEqual(500);
      expect(Math.max(...steady), JSON.stringify(summary)).toBeLessThanOrEqual(3000);
      expect(upAvg, JSON.stringify(summary)).toBeLessThanOrEqual(300);
      // Pushes never queue behind a busy write buffer, at most one per second.
      expect(res.pushesWhileBusy).toEqual([]);
      for (let i = 1; i < res.pushes.length; i += 1) expect((res.pushes[i] as { at: number }).at - (res.pushes[i - 1] as { at: number }).at).toBeGreaterThanOrEqual(990);
      // While the backlog holds the write buffer nothing goes out (and nothing is written while it drains,
      // checked above); the first push after it carries what waited.
      const during = res.pushes.filter((p) => p.at > BACKLOG.from + 100 && p.at < BACKLOG.to);
      expect(during).toEqual([]);
      const firstAfter = res.pushes.find((p) => p.at >= BACKLOG.to);
      expect(firstAfter).toBeTruthy();
      const carried = (firstAfter?.view.r?.length ?? 0) + (firstAfter?.view.e?.length ?? 0) + (firstAfter?.view.d ? 1 : 0);
      expect(carried).toBeGreaterThanOrEqual(2);
      console.log('[glimmer link sim]', loss ? '3G + 1 % loss' : '3G', JSON.stringify(summary));
    }, 10_000);
  }
});
