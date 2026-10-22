/**
 * One lossy-link scenario (platform.md §15.2, plan.md §3.2 "Link simulator"): the REAL sender
 * (`createRecipient`, so the real pacer and lane codecs) and the probe runtime on the server side, a
 * modelled client on the other side, and `lossyLink` between them, all in virtual time (1 ms steps).
 *
 * Server, every 33.33 ms tick: `runtime.step()`, this tick's events and host events into the recipient,
 * then `slotTick` with the snapshot, as server/src/arcade/match.ts does. ACK/UP/PING/VIS/RESYNC from
 * the client go to `onAck`/`onUp`/PONG/park/rekey. The sink's `bufferedAmount` is the lane's bytes not
 * yet accepted by the bottleneck. The server also writes one 200 B chat message per second on the app
 * socket and acks every request at once, and (unless `serverYieldRule: false`) applies the server-side
 * "chat first" rule of §4.2: a message waiting in the app socket's write buffer for over 1 s parks the
 * lane as `yield` until the buffer has been empty for 2 s and the client is not yielding itself.
 *
 * Client (laneClient.ts and chatFirst.ts, modelled in virtual time): `readServer` on every message;
 * frames are checked for consecutive `frameSeq` and applied to a probe world, which is compared with the
 * server's public view whenever the server had nothing pending after sending that frame. ACK when a
 * frame arrived and no UP went out in 250 ms (1 s while yielding); UP every 2 ticks while moving, once
 * more after release, never while yielding or with more than 512 B buffered; 5 PINGs 200 ms apart, then
 * one per 2 s. The chat prober sends an acked request every 2 s (8 s timeout); the "chat first" guard
 * yields (VIS 2) on any ack over 2 s or a probe unanswered after 3 s, probes every 2 s while yielding,
 * and resumes (VIS 0) after 2 probes under 600 ms; with no request for 5 s it probes as well.
 *
 * Wire bytes follow §5.1: 76 B per downlink lane message, 80 B per uplink one, 26 B of TCP ACK per
 * message received (counted in the reverse direction), 92 / 96 B for app-socket messages.
 */
import { BUDGETS, OVERHEAD, type GameBudget } from '../../../src/arcade/core/net/budget.js';
import { SEAT_STATE, type SeatStateCode } from '../../../src/arcade/core/net/events.js';
import { KEY_REASON, readClient, readServer, RESYNC, S2C, TICK_HZ, TICK_MS, VIS, writeAck, writePing, writePong, writeResync, writeUp, writeVis, type Divisor } from '../../../src/arcade/core/net/lane.js';
import type { Pacer, ParkReason } from '../../../src/arcade/core/net/pacer.js';
import { xorshift32 } from '../../../src/arcade/core/rng.js';
import { CODEC, PROTO, WIRE_GAME } from '../../../src/arcade/core/version.js';
import { createRecipient, type SendSink } from '../../../src/arcade/sender.js';
import { lossyLink, type LinkProfile } from './link.js';
import { probeApply, probeEqual, probeKeyframe, probeRuntime, type ProbeWorld } from './probe.js';

/** The probe shaped like a Fuseyard player (plan.md §3.2): 22 B snapshot, ~7 B of events per frame at d = 2, 4 players. */
export const FUSEYARD_PROBE = { snapshotBytes: 22, eventBytesPerTick: 3.5, players: 4 } as const;

export interface Scenario {
  name: string;
  /** Virtual length, ms; at most 60,000 (the default). */
  durationMs?: number;
  /** The link at t = 0. */
  link: LinkProfile;
  /** Link changes over virtual time (a collapse, an outage, recovery). */
  changes?: readonly { atMs: number; link: Partial<LinkProfile> }[];
  /** An app-socket backlog at the server: every chat message and ack written in [atMs, atMs + forMs) leaves `ms` late (forMs defaults to ms). */
  mainBacklog?: readonly { atMs: number; ms: number; forMs?: number }[];
  probe?: { snapshotBytes: number; eventBytesPerTick: number; players: number };
  /** 'always': UP every 2 ticks; 'never': ACKs only; 'bursts' (default): seeded 2–6 s moving, 0.5–2 s still. */
  moving?: 'always' | 'never' | 'bursts';
  /** The server-side half of "chat first" (§4.2). Default true. */
  serverYieldRule?: boolean;
  budget?: GameBudget;
  /** The game def's `sender.skipUnchanged` (Fuseyard: true, the default). */
  skipUnchanged?: boolean;
  seed?: number;
  /**
   * Called after every virtual second with the result so far; return 'pass' or 'fail' once the
   * outcome is certain and the run stops there (platform.md §15: abort as soon as it is certain).
   */
  settle?(r: ScenarioResult, nowMs: number): 'pass' | 'fail' | null;
  /** Called after every server tick with the recipient's pacer (for debugging and extra assertions). */
  observe?(nowMs: number, pacer: Pacer, parked: ParkReason | null): void;
}

export interface ScenarioResult {
  name: string;
  /** Virtual ms simulated: `durationMs`, or less when `settle` decided early. */
  ranMs: number;
  verdict: 'pass' | 'fail' | null;
  /** FRAMEs and KEYFRAMEs the client accepted in each 1 s window ([i] covers [i s, i + 1 s)). */
  framesPerSecond: number[];
  /** Chat messages: the server's send time and the one-way latency to the client, ms. */
  chat: { t: number; ms: number }[];
  /** Acked requests (the 2 s prober and the guard's probes): client send time and round trip; a timeout reports its timeout. */
  acks: { t: number; ms: number; probe: boolean; timedOut: boolean }[];
  /** Lane wire bytes per 1 s window, framing and TCP ACKs included (§5.1): server egress and client egress. */
  downPerSecond: number[];
  upPerSecond: number[];
  /** The largest game queue in each window: lane bytes waiting at the server plus in the bottleneck (wire). */
  queuePerSecond: number[];
  /** The pacer's divisor over time (first entry at t = 0). */
  ladder: { t: number; divisor: Divisor }[];
  /** Park changes over time. */
  parks: { t: number; park: ParkReason | null }[];
  /** Every KEYFRAME sent: time, wire bytes (framing included), body bytes, reason. */
  keyframes: { t: number; wire: number; body: number; reason: number }[];
  /** Each `stalled` park: when, and how long after the last ACK or UP reached the server. */
  stalls: { t: number; quietMs: number }[];
  /** VIS the client sent. */
  vis: { t: number; state: number }[];
  /** RTT samples as the pacer takes them, as queueing above its minimum RTT. */
  queueing: { t: number; q: number }[];
  /** The guard's probes: send time and round trip (null: no answer within 3 s). */
  probes: { t: number; ms: number | null }[];
  /** Client-side problems: frameSeq gaps, undecodable messages, frames whose world differs from the server's. */
  gaps: number;
  decodeErrors: number;
  resyncs: number;
  worldChecks: number;
  worldMismatches: number;
  /** Wire bytes by lane message type (WELCOME, FRAME, …, and `tcpAck`) over the whole run, each direction. */
  bytesByType: { down: Record<string, number>; up: Record<string, number> };
  voiceDroppedBytes: { down: number; up: number };
  lostSegments: number;
  wallMs: number;
}

type MainMsg = { k: 'chat' } | { k: 'req'; id: number } | { k: 'ack'; id: number };
type Data = Uint8Array | MainMsg;

export const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
export const percentile = (xs: readonly number[], p: number): number => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] as number;
};
/** Windows [fromS, toS) of a per-second series. */
export const windows = (perSecond: readonly number[], fromS: number, toS: number): number[] => perSecond.slice(Math.max(0, fromS), Math.max(0, toS));

const S2C_NAME: Record<number, string> = { 0x80: 'WELCOME', 0x81: 'FRAME', 0x82: 'KEYFRAME', 0x83: 'BEAT', 0x84: 'PONG', 0x85: 'PHASE', 0x86: 'HANDOVER', 0x8f: 'BYE' };
const C2S_NAME: Record<number, string> = { 0x01: 'UP', 0x02: 'ACK', 0x03: 'EVT', 0x04: 'PING', 0x05: 'VIS', 0x06: 'RESYNC' };
const tally = (into: Record<string, number>, name: string, bytes: number): void => {
  into[name] = (into[name] ?? 0) + bytes;
};

const WELCOME_AT = 100;
const CHAT_EVERY = 1000;
const REQUEST_EVERY = 2000;
const REQUEST_TIMEOUT = 8000;
const GUARD = { idleMs: 5000, yieldProbeMs: 2000, probeTimeoutMs: 3000, slowAckMs: 2000, goodMs: 600, goodRun: 2 } as const;

export const runScenario = (s: Scenario): ScenarioResult => {
  const wall0 = performance.now();
  const duration = Math.min(60_000, s.durationMs ?? 60_000);
  const seconds = Math.ceil(duration / 1000);
  const seed = (s.seed ?? 1) >>> 0 || 1;
  const link = lossyLink<Data>({ seed, ...s.link });
  const changes = [...(s.changes ?? [])].sort((a, b) => a.atMs - b.atMs);
  const budget = s.budget ?? BUDGETS.fuseyard;
  const runtime = probeRuntime({ ...(s.probe ?? FUSEYARD_PROBE), seed: (seed * 7919 + 13) >>> 0 });
  const serverRule = s.serverYieldRule ?? true;
  let rng = (seed * 2654435761) >>> 0 || 7;
  const unit = (): number => (rng = xorshift32(rng)) / 0x100000000;

  const zeros = (): number[] => new Array<number>(seconds).fill(0);
  const res: ScenarioResult = {
    name: s.name,
    ranMs: 0,
    verdict: null,
    framesPerSecond: zeros(),
    chat: [],
    acks: [],
    downPerSecond: zeros(),
    upPerSecond: zeros(),
    queuePerSecond: zeros(),
    ladder: [{ t: 0, divisor: 2 }],
    parks: [],
    keyframes: [],
    stalls: [],
    vis: [],
    queueing: [],
    probes: [],
    gaps: 0,
    decodeErrors: 0,
    resyncs: 0,
    worldChecks: 0,
    worldMismatches: 0,
    bytesByType: { down: {}, up: {} },
    voiceDroppedBytes: link.stats.voiceDroppedBytes,
    lostSegments: 0,
    wallMs: 0,
  };
  const now = (): number => link.now;
  const sec = (): number => Math.min(seconds - 1, Math.floor(link.now / 1000));

  // ---------------------------------------------------------------- server
  const sentAt = new Map<number, number>();
  const serverViews = new Map<number, Uint8Array>();
  let tickFrameSeq: number | null = null;
  const sink: SendSink = {
    send(bytes) {
      const msg = bytes.slice();
      const t = msg[0];
      if (t === S2C.FRAME || t === S2C.KEYFRAME) {
        const seq = (msg[1] as number) | ((msg[2] as number) << 8);
        sentAt.set(seq, now());
        if (sentAt.size > 512) sentAt.delete(sentAt.keys().next().value as number);
        tickFrameSeq = seq;
        if (t === S2C.KEYFRAME) res.keyframes.push({ t: now(), wire: msg.length + OVERHEAD.down, body: msg.length - 10, reason: msg[7] as number });
      }
      res.downPerSecond[sec()] += msg.length + OVERHEAD.down;
      tally(res.bytesByType.down, S2C_NAME[t as number] ?? '?', msg.length + OVERHEAD.down);
      link.write('down', 'lane', msg.length + OVERHEAD.down, msg.length, msg);
    },
    get bufferedAmount() {
      return link.buffered('down', 'lane');
    },
  };
  const recipient = createRecipient({ slot: 0, spectator: false, budget, defaultDivisor: 2, skipUnchanged: s.skipUnchanged ?? true, now });
  const view = { slot: 0, view: 0 };
  let phase: { phase: number; reason: number; body: Uint8Array } | null = null;
  let lastProgressAt = 0;
  let lastUpSeq: number | null = null;
  let lastSampled: number | null = null;
  let clientVis: number = VIS.live;
  let serverYield = false;
  let mainBusyAt = -Infinity;
  let seenPark: ParkReason | null = null;
  let seenDivisor: Divisor = 2;

  // A yield takes over a stall or an overflow (same seat effect), so the game resumes only once chat
  // is healthy and with one keyframe; an `away` park stays as it is.
  const applyYield = (): void => {
    const want = clientVis === VIS.yield || serverYield;
    const p = recipient.parked;
    if (want && (p === null || p === 'stalled' || p === 'overflow')) recipient.park('yield');
    else if (!want && recipient.parked === 'yield' && clientVis === VIS.live) recipient.unpark();
  };

  const serverLane = (bytes: Uint8Array): void => {
    link.fluid('down', OVERHEAD.tcpAck);
    res.downPerSecond[sec()] += OVERHEAD.tcpAck;
    tally(res.bytesByType.down, 'tcpAck', OVERHEAD.tcpAck);
    const m = readClient(bytes);
    if (!m) return;
    const t = now();
    if (m.t === 'up' || m.t === 'ack') {
      const at = sentAt.get(m.ackFrame);
      if (at !== undefined && (lastSampled === null || ((m.ackFrame - lastSampled) & 0xffff) < 0x8000) && m.ackFrame !== lastSampled) {
        res.queueing.push({ t, q: t - at - m.ackDelayMs - recipient.pacer.minRttMs });
        lastSampled = m.ackFrame;
      }
      lastProgressAt = t;
      recipient.onAck(m.ackFrame, m.ackDelayMs);
      if (m.t === 'up' && (lastUpSeq === null || ((m.upSeq - lastUpSeq) & 0xffff) - 1 < 0x7fff)) {
        lastUpSeq = m.upSeq;
        recipient.onUp();
        runtime.onUp(0, m.payload, m.upSeq);
      }
    } else if (m.t === 'ping') recipient.sendRaw(writePong(m.clientMs, runtime.tick >>> 0, 0));
    else if (m.t === 'vis') {
      clientVis = m.state;
      if (m.state === VIS.live) {
        if (!serverYield) recipient.unpark();
      } else recipient.park(m.state === VIS.yield ? 'yield' : 'away');
    } else if (m.t === 'resync') recipient.rekey(KEY_REASON.resync);
  };

  const serverMain = (m: MainMsg): void => {
    link.fluid('down', OVERHEAD.tcpAck);
    if (m.k === 'req') link.write('down', 'main', 20 + OVERHEAD.tableDown, 20, { k: 'ack', id: m.id });
  };

  const serverTick = (): void => {
    runtime.step();
    const tick = runtime.tick >>> 0;
    const chunk = runtime.takeEvents(view);
    if (chunk) recipient.pushEvents(tick, chunk);
    for (const e of runtime.takeHostEvents()) {
      if (e.t === 'phase') {
        phase = { phase: e.phase, reason: e.reason, body: e.body };
        recipient.pushPhase(e.phase, e.reason, e.body);
      } else if (e.t === 'seat') recipient.pushSeat(tick, e.slot, SEAT_STATE[e.state] as SeatStateCode);
      else if (e.t === 'rekey' && e.slot === 0) {
        recipient.view = e.view;
        recipient.rekey(e.reason);
      }
    }
    tickFrameSeq = null;
    recipient.slotTick({ tick, snapshot: runtime.snapshotFor(view), ackUp: runtime.ackUp(0), keyframe: () => runtime.keyframeFor(view), phase, floor: 2 });
    if (tickFrameSeq !== null && recipient.parked === null && recipient.pendingBytes === 0) {
      serverViews.set(tickFrameSeq, runtime.keyframeFor(view).slice());
      if (serverViews.size > 256) serverViews.delete(serverViews.keys().next().value as number);
    }
    // The server-side "chat first" rule (§4.2). A message written in this very millisecond is not a
    // backlog yet, so "waiting" means the oldest message in the write buffer is at least 5 ms old.
    if (serverRule) {
      const t = now();
      const since = link.oldestBuffered('down', 'main');
      if (since !== null && t - since >= 5) mainBusyAt = t;
      if (since !== null && t - since > 1000) serverYield = true;
      else if (serverYield && t - mainBusyAt >= 2000) serverYield = false;
      applyYield();
    }
    const park = recipient.parked;
    if (park !== seenPark) {
      res.parks.push({ t: now(), park });
      if (park === 'stalled') res.stalls.push({ t: now(), quietMs: now() - lastProgressAt });
      seenPark = park;
    }
    const d = recipient.pacer.divisor;
    if (d !== seenDivisor) {
      res.ladder.push({ t: now(), divisor: d });
      seenDivisor = d;
    }
    res.queuePerSecond[sec()] = Math.max(res.queuePerSecond[sec()] as number, link.backlog('down', 'lane'));
    s.observe?.(now(), recipient.pacer, park);
  };

  // ---------------------------------------------------------------- client
  let welcomed = false;
  let resyncing = true;
  let expected = 0;
  let world: ProbeWorld | null = null;
  let ackFrame = 0;
  let frameAt = 0;
  let ackPending = false;
  let lastAckAt = -Infinity;
  let lastUpAt = -Infinity;
  let vis: number = VIS.live;
  let pings = 0;
  let nextPingAt = Infinity;
  let clientTick = 0;
  let nextClientTickAt = 5;
  let lastUpTick = 0;
  let wasMoving = false;
  let moving = s.moving === 'always';
  let moveFlipAt = s.moving === 'bursts' || s.moving === undefined ? 1000 + unit() * 2000 : Infinity;
  // Requests and the guard.
  let reqId = 0;
  const pendingReq = new Map<number, { sentAt: number; probe: boolean; timeoutAt: number }>();
  let lastRequestAt = 0;
  let nextRequestAt = 1000 + Math.floor(unit() * 1000);
  let yielding = false;
  let probeInflight = false;
  let good = 0;
  let lastProbeAt = 0;
  let lastDoneAt = 0;

  const laneUp = (bytes: Uint8Array): void => {
    res.upPerSecond[sec()] += bytes.length + OVERHEAD.up;
    tally(res.bytesByType.up, C2S_NAME[bytes[0] as number] ?? '?', bytes.length + OVERHEAD.up);
    link.write('up', 'lane', bytes.length + OVERHEAD.up, bytes.length, bytes);
  };
  const setVis = (state: number): void => {
    if (state === vis) return;
    vis = state;
    res.vis.push({ t: now(), state });
    laneUp(writeVis(state));
  };
  const setYield = (v: boolean): void => {
    good = 0;
    if (v === yielding) return;
    yielding = v;
    lastDoneAt = now();
    setVis(v ? VIS.yield : VIS.live);
  };
  const request = (probe: boolean): void => {
    reqId += 1;
    const t = now();
    pendingReq.set(reqId, { sentAt: t, probe, timeoutAt: t + (probe ? GUARD.probeTimeoutMs : REQUEST_TIMEOUT) });
    lastRequestAt = t;
    const size = probe ? 16 : 30;
    link.write('up', 'main', size + OVERHEAD.tableUp, size, { k: 'req', id: reqId });
  };
  const probeDone = (rtt: number | null): void => {
    probeInflight = false;
    lastDoneAt = now();
    res.probes.push({ t: now() - (rtt ?? GUARD.probeTimeoutMs), ms: rtt });
    if (rtt === null || rtt > GUARD.slowAckMs) setYield(true);
    else if (yielding && rtt < GUARD.goodMs) {
      good += 1;
      if (good >= GUARD.goodRun) setYield(false);
    } else good = 0;
  };
  const onAck = (rtt: number): void => {
    if (rtt > GUARD.slowAckMs) setYield(true);
  };

  const gotFrame = (seq: number): void => {
    ackFrame = seq;
    frameAt = now();
    ackPending = true;
  };
  const checkWorld = (seq: number): void => {
    const server = serverViews.get(seq);
    if (!server || !world) return;
    serverViews.delete(seq);
    res.worldChecks += 1;
    const w = probeKeyframe(server);
    if (!w || !probeEqual(world, w)) res.worldMismatches += 1;
  };

  const clientLane = (bytes: Uint8Array): void => {
    link.fluid('up', OVERHEAD.tcpAck);
    res.upPerSecond[sec()] += OVERHEAD.tcpAck;
    tally(res.bytesByType.up, 'tcpAck', OVERHEAD.tcpAck);
    const m = readServer(bytes);
    if (!m) {
      res.decodeErrors += 1;
      return;
    }
    if (m.t === 'welcome') {
      welcomed = true;
      resyncing = true;
      pings = 0;
      nextPingAt = now();
      lastProbeAt = lastDoneAt = now();
      if (vis !== VIS.live) laneUp(writeVis(vis));
    } else if (m.t === 'keyframe') {
      gotFrame(m.frameSeq);
      expected = (m.frameSeq + 1) & 0xffff;
      resyncing = false;
      world = probeKeyframe(m.body);
      if (!world) res.decodeErrors += 1;
      res.framesPerSecond[sec()] += 1;
      checkWorld(m.frameSeq);
    } else if (m.t === 'frame') {
      gotFrame(m.frameSeq);
      if (resyncing) return;
      if (m.frameSeq !== expected) {
        res.gaps += 1;
        resyncing = true;
        res.resyncs += 1;
        laneUp(writeResync(RESYNC.gap));
        return;
      }
      expected = (m.frameSeq + 1) & 0xffff;
      res.framesPerSecond[sec()] += 1;
      if (m.events && world && !probeApply(world, m.events.count, m.events.bytes)) {
        res.decodeErrors += 1;
        resyncing = true;
        res.resyncs += 1;
        laneUp(writeResync(RESYNC.decode));
        return;
      }
      checkWorld(m.frameSeq);
    }
  };

  const clientMain = (m: MainMsg, sentAtMs: number): void => {
    link.fluid('up', OVERHEAD.tcpAck);
    const t = now();
    if (m.k === 'chat') res.chat.push({ t: sentAtMs, ms: t - sentAtMs });
    else if (m.k === 'ack') {
      const p = pendingReq.get(m.id);
      if (!p) return;
      pendingReq.delete(m.id);
      res.acks.push({ t: p.sentAt, ms: t - p.sentAt, probe: p.probe, timedOut: false });
      onAck(t - p.sentAt);
      if (p.probe) probeDone(t - p.sentAt);
    }
  };

  const clientMs = (): void => {
    const t = now();
    if (t >= moveFlipAt) {
      moving = !moving;
      moveFlipAt = t + (moving ? 2000 + unit() * 4000 : 500 + unit() * 1500);
    }
    // Requests, timeouts and the guard.
    if (t >= nextRequestAt) {
      nextRequestAt += REQUEST_EVERY;
      request(false);
    }
    for (const [id, p] of pendingReq) {
      if (t < p.timeoutAt) continue;
      pendingReq.delete(id);
      const ms = p.probe ? GUARD.probeTimeoutMs : REQUEST_TIMEOUT;
      res.acks.push({ t: p.sentAt, ms, probe: p.probe, timedOut: true });
      onAck(ms);
      if (p.probe) probeDone(null);
    }
    if (welcomed && !probeInflight) {
      const due = yielding ? lastDoneAt + GUARD.yieldProbeMs : Math.max(lastRequestAt, lastProbeAt) + GUARD.idleMs;
      if (t >= due) {
        probeInflight = true;
        lastProbeAt = t;
        request(true);
      }
    }
    if (!welcomed) return;
    // PING.
    if (t >= nextPingAt) {
      pings += 1;
      nextPingAt = t + (pings < 5 ? 200 : 2000);
      laneUp(writePing(t >>> 0));
    }
    // UP at the client's own tick, every 2 ticks while moving and once more after release.
    if (t >= nextClientTickAt) {
      nextClientTickAt += TICK_MS;
      clientTick += 1;
      if (clientTick % 2 === 0 && (moving || wasMoving)) {
        wasMoving = moving;
        if (vis !== VIS.yield && link.buffered('up', 'lane') <= 512) {
          const n = Math.max(1, Math.min(6, clientTick - lastUpTick));
          const payload = new Uint8Array(1 + n);
          payload[0] = n;
          for (let i = 1; i <= n; i += 1) payload[i] = moving ? 1 : 0;
          lastUpTick = clientTick;
          laneUp(writeUp(clientTick & 0xffff, ackFrame, t - frameAt, payload));
          lastUpAt = t;
          ackPending = false;
        }
      }
    }
    // ACK.
    if (ackPending && t >= Math.max(lastUpAt + 250, lastAckAt + (vis === VIS.yield ? 1000 : 250))) {
      laneUp(writeAck(ackFrame, t - frameAt));
      lastAckAt = t;
      ackPending = false;
    }
  };

  // ---------------------------------------------------------------- the run
  const deliver = (dir: 'down' | 'up', stream: 'lane' | 'main', data: Data, sent: number): void => {
    if (dir === 'down') {
      if (stream === 'lane') clientLane(data as Uint8Array);
      else clientMain(data as MainMsg, sent);
    } else if (stream === 'lane') serverLane(data as Uint8Array);
    else serverMain(data as MainMsg);
  };

  let nextTickAt = TICK_MS;
  let nextChatAt = 500;
  let change = 0;
  for (const b of s.mainBacklog ?? []) link.delay('down', 'main', b.atMs, b.atMs + (b.forMs ?? b.ms), b.ms);
  let welcomeSent = false;
  for (let ms = 1; ms <= duration; ms += 1) {
    while (change < changes.length && (changes[change] as { atMs: number }).atMs <= ms) {
      link.set((changes[change] as { link: Partial<LinkProfile> }).link);
      change += 1;
    }
    link.step(deliver);
    const t = now();
    if (!welcomeSent && t >= WELCOME_AT) {
      welcomeSent = true;
      recipient.attach(sink);
      recipient.welcome(
        { proto: PROTO, game: WIRE_GAME.fuseyard, codec: CODEC.fuseyard, slot: 0, queued: false, tick: runtime.tick >>> 0, tickHz: TICK_HZ, divisor: 2, lastEvSeq: 0, resumeToken: new Uint8Array(32), cfg: runtime.welcomeCfg() },
        KEY_REASON.join,
      );
    }
    if (t >= nextChatAt) {
      nextChatAt += CHAT_EVERY;
      link.write('down', 'main', 200 + OVERHEAD.tableDown, 200, { k: 'chat' });
    }
    if (t >= nextTickAt) {
      nextTickAt += TICK_MS;
      serverTick();
    }
    clientMs();
    if (t % 1000 === 0 && s.settle) {
      res.ranMs = t;
      const v = s.settle(res, t);
      if (v) {
        res.verdict = v;
        break;
      }
    }
    res.ranMs = t;
  }
  res.lostSegments = link.stats.lostSegments;
  res.wallMs = performance.now() - wall0;
  return res;
};

