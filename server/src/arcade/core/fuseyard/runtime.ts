/**
 * Fuseyard's match runtime: the platform's `CoreMatch` (core/net/match.ts) around the sim. The server
 * wraps it with `wrapCore` (rooms/fuseyard.ts); offline the device steps it through
 * `createLocalMatchHost`, so a game module has one code path.
 *
 * - Input queue per human slot (fuseyard.md §3.5): an 8-entry ring, one input popped per tick;
 *   duplicate seqs dropped; when empty the last direction repeats (press bits cleared) for up to 6
 *   ticks; above 4 queued the queue is trimmed to 2 with the dropped presses OR-ed into the next
 *   kept input. `ackUp` is the seq of the newest input applied. Ghosting clears the ring and UPs
 *   received while a ghost are dropped.
 * - Seat commands are applied at the next tick (§2.3 step 0); ghost requests wait for the danger lock.
 * - Dodge grace per human from the smoothed lane RTT, read at round setup (§3.6).
 * - Host events: PHASE 2 at the first tick, a round-start notice and keyframe requests, applied seat
 *   changes, and at the end PHASE 4 with the 16 B result body followed by `end` (online).
 *   Offline the match waits after PHASE 4 for a rematch event instead of ending.
 */
import { ByteWriter, seqNewer } from '../bytes.js';
import { PHASE, PHASE_REASON } from '../net/lane.js';
import type { CoreMatch, EventChunk, HostEvent, MatchResult, RecipientView, SeatCmd as PlatformSeatCmd } from '../net/match.js';
import { CFG_BYTES, KEYFRAME_MAX, SNAPSHOT_MAX, decodeUp, encodeCfg, encodeKeyframe, encodeResult, encodeSnapshot, sanitizeInput, worldFromMatch } from './codec.js';
import { createReplayRing, dumpMatch, type ReplayRing } from './replay.js';
import { Control, IN_BOMB, IN_DETONATE, Phase, Seat, SeatCmd, graceFromRtt, newStepIn, type Fighter, type Match, type MatchConfig } from './rules.js';
import { createMatch, seatState, step, type SeatSetup } from './sim.js';
import { createWorld } from './view.js';

export interface FuseyardCoreOpts {
  config: MatchConfig;
  seats: readonly SeatSetup[];
  /** Offline: no `end` at match end; a rematch event restarts with a new seed. */
  offline: boolean;
  /** Continue from a restored match (HANDOVER) instead of creating one. */
  match?: Match;
  /** Keep a replay ring (the server's watchdog dumps); off offline. */
  replay?: boolean;
}

/** onEvent payloads (offline only). */
export const CORE_EVENT = { rematch: 1 } as const;

export interface FuseyardCore extends CoreMatch {
  readonly match: Match;
  /** The replay ring's bytes (raw; the server deflates). Empty without a ring. */
  replayBytes(): Uint8Array;
  /** The match result, available once the match has ended. */
  result(): MatchResult | null;
}

const QUEUE = 8;
const QUEUE_TRIM_ABOVE = 4;
const QUEUE_TRIM_TO = 2;
const REPEAT_TICKS = 6;
/** No non-zero human input for this long (while a live human plays) ends the match. */
export const NO_INPUT_TICKS = 120 * 30;

const PRESS = IN_BOMB | IN_DETONATE;
const EMPTY_EVENTS: readonly HostEvent[] = [];

export const createFuseyardCore = (o: FuseyardCoreOpts): FuseyardCore => {
  let m = o.match ?? createMatch(o.config, o.seats);
  const humanAtStart = new Uint8Array(4);
  for (let s = 0; s < 4; s += 1) humanAtStart[s] = (m.current.fighters[s] as Fighter).control === Control.Human ? 1 : 0;

  const input = newStepIn();
  const pendingSeat = new Uint8Array([SeatCmd.None, SeatCmd.None, SeatCmd.None, SeatCmd.None]);
  const rtt = new Float64Array(4);
  // Input rings.
  const qIn = new Uint8Array(4 * QUEUE);
  const qSeq = new Uint16Array(4 * QUEUE);
  const qHead = new Uint8Array(4);
  const qLen = new Uint8Array(4);
  const lastSeq = new Int32Array([-1, -1, -1, -1]);
  const acked = new Uint16Array(4);
  const lastIn = new Uint8Array(4);
  const repeat = new Uint8Array(4);
  // Results bookkeeping.
  const roundWinsLive = new Uint8Array(4);
  const liveAtFinalStart = new Uint8Array(4);
  const playedLive = new Uint8Array(4);

  let started = false;
  let ended = false;
  let finalResult: MatchResult | null = null;
  let noInputTicks = 0;
  let hostEvents: HostEvent[] = EMPTY_EVENTS as HostEvent[];
  /** Host events are rare: an array is made only when a tick has one. */
  const emit = (e: HostEvent): void => {
    if (hostEvents === EMPTY_EVENTS) hostEvents = [];
    hostEvents.push(e);
  };
  let ring: ReplayRing | null = o.replay ? createReplayRing() : null;

  const snapW = new ByteWriter(SNAPSHOT_MAX);
  const keyW = new ByteWriter(KEYFRAME_MAX + 64);
  const world = createWorld(m.config.fighters);
  let snapTick = -1;
  let keyTick = -1;
  let cfg = encodeCfg(m.config);
  const chunk: EventChunk = { bytes: new Uint8Array(0), count: 0 };

  const clearQueue = (s: number): void => {
    qHead[s] = 0;
    qLen[s] = 0;
    repeat[s] = REPEAT_TICKS;
    lastIn[s] = 0;
  };

  const push = (s: number, v: number, seq: number): void => {
    if ((qLen[s] as number) >= QUEUE) {
      // Full: drop the oldest, keeping its presses.
      const h = qHead[s] as number;
      const dropped = qIn[s * QUEUE + h] as number;
      qHead[s] = (h + 1) % QUEUE;
      qLen[s] = (qLen[s] as number) - 1;
      const n = s * QUEUE + (qHead[s] as number);
      qIn[n] = (qIn[n] as number) | (dropped & PRESS);
    }
    const at = s * QUEUE + (((qHead[s] as number) + (qLen[s] as number)) % QUEUE);
    qIn[at] = v;
    qSeq[at] = seq;
    qLen[s] = (qLen[s] as number) + 1;
  };

  /** Backlog (after a whole UP is queued): above 4, keep the newest two; dropped presses ride on the first kept. */
  const trim = (s: number): void => {
    if ((qLen[s] as number) > QUEUE_TRIM_ABOVE) {
      let presses = 0;
      for (let k = (qLen[s] as number) - QUEUE_TRIM_TO; k > 0; k -= 1) {
        const h = qHead[s] as number;
        presses |= (qIn[s * QUEUE + h] as number) & PRESS;
        qHead[s] = (h + 1) % QUEUE;
        qLen[s] = (qLen[s] as number) - 1;
      }
      const first = s * QUEUE + (qHead[s] as number);
      qIn[first] = (qIn[first] as number) | presses;
    }
  };

  const toCmd = (cmd: PlatformSeatCmd): number =>
    cmd === 'live' ? SeatCmd.Return : cmd === 'ghost' ? SeatCmd.Ghost : cmd === 'bot' ? SeatCmd.BotTakeover : cmd === 'left' ? SeatCmd.Left : SeatCmd.Reclaim;

  const seatName = (state: number): 'live' | 'ghost' | 'bot' | 'left' => (state === Seat.Ghost ? 'ghost' : state === Seat.Bot ? 'bot' : state === Seat.Left ? 'left' : 'live');

  const buildResult = (): MatchResult => {
    const c = m.config;
    const fighters = m.current.fighters;
    let top = 0;
    for (let s = 0; s < c.fighters; s += 1) if ((m.scores[s] as number) > top) top = m.scores[s] as number;
    const players: { slot: number; place: number | null; score: number | null }[] = [];
    const stats: { slot: number; stat: string; op: 'add' | 'max'; value: number }[] = [];
    let humans = 0;
    for (let s = 0; s < c.fighters; s += 1) {
      if (humanAtStart[s] === 1 || playedLive[s] === 1) humans += 1;
    }
    for (let s = 0; s < c.fighters; s += 1) {
      if (playedLive[s] !== 1) continue;
      const f = fighters[s] as Fighter;
      const live = f.control === Control.Human;
      let better = 0;
      for (let o2 = 0; o2 < c.fighters; o2 += 1) if ((m.scores[o2] as number) > (m.scores[s] as number)) better += 1;
      players.push({ slot: s, place: live && !f.left ? better + 1 : null, score: m.scores[s] as number });
      stats.push({ slot: s, stat: 'matches', op: 'add', value: 1 });
      if (top > 0 && (m.scores[s] as number) === top && liveAtFinalStart[s] === 1) stats.push({ slot: s, stat: 'wins', op: 'add', value: 1 });
      if ((roundWinsLive[s] as number) > 0) stats.push({ slot: s, stat: 'round_wins', op: 'add', value: roundWinsLive[s] as number });
      if (f.kills > 0) stats.push({ slot: s, stat: 'kills', op: 'add', value: f.kills });
      if (f.blocksBroken > 0) stats.push({ slot: s, stat: 'blocks', op: 'add', value: f.blocksBroken });
    }
    const arenas: number[] = [];
    for (let i = 0; i <= m.round && i < m.arenasPlayed.length; i += 1) arenas.push(m.arenasPlayed[i] as number);
    return {
      mode: c.mode,
      humans,
      summary: { arenas, rounds: m.round + 1, winsNeeded: c.winsNeeded, scores: Array.from(m.scores.subarray(0, c.fighters)), draws: m.draws },
      players,
      stats,
    };
  };

  const afterStep = (): void => {
    const r = m.current;
    // Applied seat changes.
    for (let i = 0; i < m.seatOutLen; i += 1) {
      const slot = m.seatOut[i * 2] as number;
      const state = m.seatOut[i * 2 + 1] as number;
      if (state === Seat.Ghost) clearQueue(slot);
      if (state === Seat.Live) lastSeq[slot] = -1;
      emit({ t: 'seat', slot, state: seatName(state) });
    }
    if (m.roundStarted) {
      for (let s = 0; s < 4; s += 1) liveAtFinalStart[s] = (r.fighters[s] as Fighter).control === Control.Human ? 1 : 0;
      emit({ t: 'roundStart' });
      // The new board is a keyframe for everyone: blocks are random, so events cannot describe it.
      for (let s = 0; s < m.config.fighters; s += 1) emit({ t: 'rekey', slot: s, reason: 5, view: 0 });
      emit({ t: 'rekey', slot: 0xff, reason: 5, view: 0 });
    }
    // Round bookkeeping for results: a round counts for a seat that was live when it ended.
    if (m.roundEnded) {
      for (let s = 0; s < m.config.fighters; s += 1) {
        const f = r.fighters[s] as Fighter;
        if (f.control !== Control.Human) continue;
        playedLive[s] = 1;
        if (r.winner === s) roundWinsLive[s] = (roundWinsLive[s] as number) + 1;
      }
    }
    if (m.matchEnded && !ended) {
      ended = true;
      finalResult = buildResult();
      emit({ t: 'phase', phase: PHASE.ending, reason: PHASE_REASON.none, body: encodeResult(m) });
      if (!o.offline) emit({ t: 'end', reason: 'done', result: finalResult });
    }
  };

  const core: FuseyardCore = {
    get match() {
      return m;
    },
    get idle() {
      return ended;
    },
    get tick() {
      return m.tick;
    },
    step() {
      if (!started) {
        started = true;
        emit({ t: 'phase', phase: PHASE.running, reason: PHASE_REASON.none, body: new Uint8Array(0) });
      }
      if (ended) return;
      const r = m.current;
      let anyInput = false;
      let liveHuman = false;
      for (let s = 0; s < 4; s += 1) {
        const f = r.fighters[s] as Fighter;
        let v = 0;
        if (f.control === Control.Human && f.seated) {
          if ((qLen[s] as number) > 0) {
            const at = s * QUEUE + (qHead[s] as number);
            v = qIn[at] as number;
            acked[s] = qSeq[at] as number;
            qHead[s] = ((qHead[s] as number) + 1) % QUEUE;
            qLen[s] = (qLen[s] as number) - 1;
            lastIn[s] = v;
            repeat[s] = 0;
          } else if ((repeat[s] as number) < REPEAT_TICKS) {
            v = (lastIn[s] as number) & ~PRESS;
            repeat[s] = (repeat[s] as number) + 1;
          }
          if (f.alive) liveHuman = true;
          if (v !== 0) anyInput = true;
          input.grace[s] = graceFromRtt(rtt[s] as number);
        } else {
          input.grace[s] = 0;
        }
        input.inputs[s] = v;
        input.seats[s] = pendingSeat[s] as number;
        pendingSeat[s] = SeatCmd.None;
      }
      ring?.record(m, input);
      step(m, input);
      // The no-input clock runs only while a live human plays an unfrozen round.
      if (r.phase === Phase.Playing && liveHuman) {
        noInputTicks = anyInput ? 0 : noInputTicks + 1;
        if (noInputTicks >= NO_INPUT_TICKS && !o.offline && !ended) {
          ended = true;
          finalResult = null;
          emit({ t: 'end', reason: 'idle', result: null });
          return;
        }
      }
      afterStep();
    },
    onUp(slot, payload, upSeq) {
      if (slot < 0 || slot > 3 || ended) return;
      const f = m.current.fighters[slot] as Fighter;
      if (!f.seated || f.control !== Control.Human) return;
      const inputs = decodeUp(payload);
      if (!inputs) return;
      const n = inputs.length;
      for (let i = 0; i < n; i += 1) {
        const seq = (upSeq - n + 1 + i) & 0xffff;
        const last = lastSeq[slot] as number;
        if (last >= 0 && !seqNewer(seq, last)) continue;
        lastSeq[slot] = seq;
        push(slot, sanitizeInput(inputs[i] as number), seq);
      }
      trim(slot);
    },
    onEvent(_slot, payload) {
      if (!o.offline || payload.length < 5 || payload[0] !== CORE_EVENT.rematch) return;
      // Offline rematch: same seats and options, a new seed from the device.
      const seed = ((payload[1] as number) | ((payload[2] as number) << 8) | ((payload[3] as number) << 16) | ((payload[4] as number) << 24)) >>> 0;
      const seats: SeatSetup[] = [];
      for (let s = 0; s < 4; s += 1) {
        const f = m.current.fighters[s] as Fighter;
        seats.push({ slot: s, human: humanAtStart[s] === 1, botLevel: f.botLevel });
      }
      m = createMatch({ ...m.config, seed }, seats);
      cfg = encodeCfg(m.config);
      ended = false;
      finalResult = null;
      noInputTicks = 0;
      roundWinsLive.fill(0);
      playedLive.fill(0);
      for (let s = 0; s < 4; s += 1) clearQueue(s);
      lastSeq.fill(-1);
      snapTick = -1;
      keyTick = -1;
      ring = o.replay ? createReplayRing() : null;
      emit({ t: 'phase', phase: PHASE.running, reason: PHASE_REASON.none, body: new Uint8Array(0) });
      for (let s = 0; s < m.config.fighters; s += 1) emit({ t: 'rekey', slot: s, reason: 5, view: 0 });
    },
    ackUp(slot) {
      return slot >= 0 && slot < 4 ? (acked[slot] as number) : 0;
    },
    setSeat(slot, cmd) {
      if (slot < 0 || slot > 3) return;
      pendingSeat[slot] = toCmd(cmd);
      if (cmd === 'ghost') clearQueue(slot);
    },
    setRtt(slot, rttMs) {
      if (slot >= 0 && slot < 4 && rttMs >= 0) rtt[slot] = rttMs;
    },
    welcomeCfg() {
      return cfg.subarray(0, CFG_BYTES);
    },
    snapshotFor(_r: RecipientView) {
      if (snapTick !== m.tick) {
        snapW.reset();
        encodeSnapshot(m, snapW);
        snapTick = m.tick;
      }
      return snapW.view();
    },
    keyframeFor(_r: RecipientView) {
      if (keyTick !== m.tick) {
        keyW.reset();
        encodeKeyframe(worldFromMatch(m, world), keyW);
        keyTick = m.tick;
      }
      return keyW.view();
    },
    takeEvents(_r: RecipientView) {
      if (m.eventCount === 0) return null;
      chunk.bytes = m.events.subarray(0, m.eventsLen);
      chunk.count = m.eventCount;
      return chunk;
    },
    takeHostEvents() {
      const out = hostEvents;
      hostEvents = EMPTY_EVENTS as HostEvent[];
      return out;
    },
    dump() {
      return dumpMatch(m);
    },
    replayBytes() {
      return ring ? ring.bytes() : new Uint8Array(0);
    },
    result() {
      return finalResult;
    },
  };
  return core;
};

/** Seat state of a slot as the platform names it. */
export const seatOfSlot = (m: Match, slot: number): 'live' | 'ghost' | 'bot' | 'left' => {
  const st = seatState(m.current.fighters[slot] as Fighter);
  return st === Seat.Ghost ? 'ghost' : st === Seat.Bot ? 'bot' : st === Seat.Left ? 'left' : 'live';
};
