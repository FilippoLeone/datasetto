/**
 * Fuseyard's byte budget (fuseyard.md §12 "fuseyard.budget", §3.8): a 4-bot Brawl round through the
 * REAL sender for four players and a spectator, the bots' inputs sent up as if they were human, wire
 * bytes counted with the platform's §5.1 model (76 B per lane message down, 80 B up, 26 B of TCP ACK
 * per message received, counted in the other direction).
 *
 * The link is clean (60 ms each way, no loss, no bandwidth limit): this measures what the game and
 * the sender produce at the default divisors (players 2, spectators 3), not how a bad link copes
 * (that is the bench's job). Clients follow laneClient.ts: UP every 2 ticks while the input is not
 * idle and once more after release, an ACK when a frame came and no UP went out for 250 ms, 5 PINGs
 * 200 ms apart and then one every 2 s.
 *
 * Budgets: per player mean down ≤ 2.2 KB/s and ≤ 3.2 KB in any 1 s window, up ≤ 1.8 KB/s;
 * spectator mean down ≤ 1.4 KB/s.
 */
import { describe, expect, it } from 'vitest';
import { OVERHEAD } from '../../../src/arcade/core/net/budget.js';
import { SEAT_STATE, type SeatStateCode } from '../../../src/arcade/core/net/events.js';
import { KEY_REASON, readClient, readServer, SPECTATOR, TICK_HZ, TICK_MS, writeAck, writePing, writePong, writeUp } from '../../../src/arcade/core/net/lane.js';
import { CODEC, PROTO, WIRE_GAME } from '../../../src/arcade/core/version.js';
import { BUDGET } from '../../../src/arcade/core/fuseyard/budget.js';
import { encodeUp } from '../../../src/arcade/core/fuseyard/codec.js';
import { createFuseyardCore } from '../../../src/arcade/core/fuseyard/runtime.js';
import { BotLevel, type Fighter, type MatchConfig } from '../../../src/arcade/core/fuseyard/rules.js';
import { createRecipient, type Recipient, type SendSink } from '../../../src/arcade/sender.js';
import { cpuMs } from './cpu.js';

const ONE_WAY_MS = 60;
const MAX_MS = 60_000;

interface Client {
  slot: number;
  recipient: Recipient;
  down: number[];
  up: number[];
  /** Messages in flight: arrival time, direction, bytes. */
  wire: { at: number; toClient: boolean; bytes: Uint8Array }[];
  ackFrame: number;
  frameAt: number;
  ackPending: boolean;
  lastAckAt: number;
  lastUpAt: number;
  pings: number;
  nextPingAt: number;
  upSeq: number;
  /** Inputs since the last UP (as the client's own ring would hold them). */
  held: number[];
  wasMoving: boolean;
  frames: number;
  keyframes: number;
}

const run = (o: { arena: MatchConfig['arena']; seed: number }) => {
  const config: MatchConfig = { mode: 'brawl', arena: o.arena, fighters: 4, winsNeeded: 3, botLevel: BotLevel.Scrapper, seed: o.seed };
  const core = createFuseyardCore({
    config,
    seats: [
      { slot: 0, human: false, botLevel: BotLevel.Menace },
      { slot: 1, human: false, botLevel: BotLevel.Scrapper },
      { slot: 2, human: false, botLevel: BotLevel.Scrapper },
      { slot: 3, human: false, botLevel: BotLevel.Sprout },
    ],
    offline: false,
  });
  let t = 0;
  const now = (): number => t;
  const sec = (): number => Math.floor(t / 1000);
  const add = (series: number[], bytes: number): void => {
    const s = sec();
    while (series.length <= s) series.push(0);
    series[s] = (series[s] as number) + bytes;
  };

  const clients: Client[] = [];
  const makeClient = (slot: number): Client => {
    const c: Client = {
      slot,
      recipient: createRecipient({ slot, spectator: slot === SPECTATOR, budget: BUDGET, defaultDivisor: slot === SPECTATOR ? 3 : 2, skipUnchanged: true, now }),
      down: [],
      up: [],
      wire: [],
      ackFrame: 0,
      frameAt: 0,
      ackPending: false,
      lastAckAt: -Infinity,
      lastUpAt: -Infinity,
      pings: 0,
      nextPingAt: 0,
      upSeq: 0,
      held: [],
      wasMoving: false,
      frames: 0,
      keyframes: 0,
    };
    const sink: SendSink = {
      send(bytes) {
        add(c.down, bytes.length + OVERHEAD.down);
        c.wire.push({ at: t + ONE_WAY_MS, toClient: true, bytes: bytes.slice() });
      },
      get bufferedAmount() {
        return 0;
      },
    };
    c.recipient.attach(sink);
    c.recipient.welcome(
      { proto: PROTO, game: WIRE_GAME.fuseyard, codec: CODEC.fuseyard, slot, queued: false, tick: core.tick >>> 0, tickHz: TICK_HZ, divisor: 2, lastEvSeq: 0, resumeToken: new Uint8Array(32), cfg: core.welcomeCfg() },
      KEY_REASON.join,
    );
    return c;
  };
  for (const slot of [0, 1, 2, 3, SPECTATOR]) clients.push(makeClient(slot));

  const clientUp = (c: Client, bytes: Uint8Array): void => {
    add(c.up, bytes.length + OVERHEAD.up);
    c.wire.push({ at: t + ONE_WAY_MS, toClient: false, bytes });
  };

  /** Delivers what has arrived, both ways. */
  const deliver = (c: Client): void => {
    while (c.wire.length > 0 && (c.wire[0] as { at: number }).at <= t) {
      const m = c.wire.shift() as { toClient: boolean; bytes: Uint8Array };
      if (m.toClient) {
        add(c.up, OVERHEAD.tcpAck);
        const s = readServer(m.bytes);
        if (s && (s.t === 'frame' || s.t === 'keyframe')) {
          c.ackFrame = s.frameSeq;
          c.frameAt = t;
          c.ackPending = true;
          if (s.t === 'frame') c.frames += 1;
          else c.keyframes += 1;
        }
      } else {
        add(c.down, OVERHEAD.tcpAck);
        const s = readClient(m.bytes);
        if (!s) continue;
        if (s.t === 'up' || s.t === 'ack') {
          c.recipient.onAck(s.ackFrame, s.ackDelayMs);
          if (s.t === 'up') c.recipient.onUp();
        } else if (s.t === 'ping') c.recipient.sendRaw(writePong(s.clientMs, core.tick >>> 0, 0));
      }
    }
  };

  let phase: { phase: number; reason: number; body: Uint8Array } | null = null;
  let nextTickAt = TICK_MS;
  let clientTick = 0;
  let maxKeyframe = 0;
  let degraded = false;
  const m = core.match;
  for (t = 1; t <= MAX_MS; t += 1) {
    for (const c of clients) deliver(c);
    if (t >= nextTickAt) {
      nextTickAt += TICK_MS;
      // The server tick, as server/src/arcade/match.ts runs it.
      core.step();
      const tick = core.tick >>> 0;
      for (const c of clients) {
        const chunk = core.takeEvents({ slot: c.slot, view: 0 });
        if (chunk) c.recipient.pushEvents(tick, chunk);
      }
      for (const e of core.takeHostEvents()) {
        if (e.t === 'phase') {
          phase = { phase: e.phase, reason: e.reason, body: e.body };
          for (const c of clients) c.recipient.pushPhase(e.phase, e.reason, e.body);
        } else if (e.t === 'seat') for (const c of clients) c.recipient.pushSeat(tick, e.slot, SEAT_STATE[e.state] as SeatStateCode);
        else if (e.t === 'roundStart') for (const c of clients) c.recipient.rekey(KEY_REASON.round);
      }
      for (const c of clients) {
        c.recipient.slotTick({ tick, snapshot: core.snapshotFor({ slot: c.slot, view: 0 }), ackUp: c.slot === SPECTATOR ? 0 : core.ackUp(c.slot), keyframe: () => core.keyframeFor({ slot: c.slot, view: 0 }), phase, floor: 2 });
      }
      maxKeyframe = Math.max(maxKeyframe, core.keyframeFor({ slot: 0, view: 0 }).length);
      for (const c of clients) if (c.slot !== SPECTATOR && c.recipient.pacer.divisor !== 2) degraded = true;
      // The clients' ticks: each player's input is what its bot chose this tick.
      clientTick += 1;
      for (const c of clients) {
        if (c.slot === SPECTATOR) continue;
        c.held.push((m.current.fighters[c.slot] as Fighter).lastInput);
        if (clientTick % 2 !== 0) continue;
        const moving = c.held.some((v) => v !== 0);
        if (moving || c.wasMoving) {
          const n = Math.min(6, c.held.length);
          const payload = encodeUp(Uint8Array.from(c.held.slice(-n)), n);
          c.upSeq = (c.upSeq + 1) & 0xffff;
          clientUp(c, writeUp(c.upSeq, c.ackFrame, t - c.frameAt, payload));
          c.lastUpAt = t;
          c.ackPending = false;
        }
        c.wasMoving = moving;
        c.held.length = 0;
      }
      if (m.current.roundEnded || m.matchEnded) break;
    }
    for (const c of clients) {
      if (t >= c.nextPingAt) {
        c.pings += 1;
        c.nextPingAt = t + (c.pings < 5 ? 200 : 2000);
        clientUp(c, writePing(t >>> 0));
      }
      if (c.ackPending && t >= Math.max(c.lastUpAt + 250, c.lastAckAt + 250)) {
        clientUp(c, writeAck(c.ackFrame, t - c.frameAt));
        c.lastAckAt = t;
        c.ackPending = false;
      }
    }
  }
  const seconds = t / 1000;
  const players = clients.filter((c) => c.slot !== SPECTATOR);
  const spectator = clients.find((c) => c.slot === SPECTATOR) as Client;
  const full = (xs: number[]): number[] => xs.slice(0, Math.floor(seconds));
  return {
    seconds,
    maxKeyframe,
    players: players.map((c) => ({
      downMean: c.down.reduce((a, b) => a + b, 0) / seconds,
      downPeak: Math.max(...full(c.down)),
      upMean: c.up.reduce((a, b) => a + b, 0) / seconds,
      frames: c.frames,
      keyframes: c.keyframes,
    })),
    spectator: { downMean: spectator.down.reduce((a, b) => a + b, 0) / seconds, downPeak: Math.max(...full(spectator.down)), frames: spectator.frames },
    degraded,
  };
};

describe('Fuseyard byte budget (real sender, §5.1 wire model)', () => {
  it('a 4-bot Brawl round stays inside the player and spectator budgets', () => {
    const c0 = cpuMs();
    // Night Depot: belts and pads make it the busiest arena for events.
    const results = [run({ arena: 'depot', seed: 8 })];
    const usedMs = cpuMs() - c0;
    for (const r of results) {
      expect(r.seconds).toBeGreaterThan(20);
      expect(r.maxKeyframe).toBeLessThanOrEqual(BUDGET.keyframeMax);
      // On a clean link the pacer never leaves the default divisor.
      expect(r.degraded).toBe(false);
      for (const p of r.players) {
        expect(p.downMean).toBeLessThanOrEqual(2200);
        expect(p.downPeak).toBeLessThanOrEqual(3200);
        expect(p.upMean).toBeLessThanOrEqual(1800);
        // 15 frames a second at divisor 2 while anything moves; unchanged frames are skipped.
        expect(p.frames / r.seconds).toBeGreaterThan(10);
      }
      expect(r.spectator.downMean).toBeLessThanOrEqual(1400);
    }
    expect(usedMs).toBeLessThan(1000);
  });
});
