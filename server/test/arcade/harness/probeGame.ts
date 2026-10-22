/**
 * A scriptable action game for integration tests and the probe bench: a MatchGameDef registered
 * in Fuseyard's place, whose runtime keeps a tiny public world (the tick and one input counter per
 * slot), confirms seat commands at the next step, and can be told to be slow, throw, start a round
 * or end. Everything a real game does on the lane, nothing it does in its rules.
 */
import { z } from 'zod';
import { ByteWriter } from '../../../src/arcade/core/bytes.js';
import { BUDGETS } from '../../../src/arcade/core/net/budget.js';
import type { CoreMatch, HostEvent, MatchResult, RecipientView, SeatCmd } from '../../../src/arcade/core/net/match.js';
import { wrapCore } from '../../../src/arcade/rooms/wrap.js';
import type { MatchGameDef, MatchRuntime, PersistApi } from '../../../src/arcade/rooms/types.js';

export interface ProbeControl {
  /** Busy-wait this long inside every step (overload tests). */
  stepMs: number;
  /** Throw from step() at this tick. */
  throwAtTick: number | null;
  /** Emit `end` at this tick. */
  endAtTick: number | null;
  /** Emit `roundStart` at these ticks. */
  roundStarts: number[];
  idle: boolean;
  /** Bytes of snapshot per recipient. */
  snapshotBytes: number;
}

export interface ProbeLog {
  seats: { slot: number; cmd: SeatCmd }[];
  ups: { slot: number; upSeq: number }[];
  events: { slot: number; payload: number[] }[];
  persisted: string[];
  rtts: { slot: number; rttMs: number }[];
  disposed: number;
  /** The newest tick any probe match stepped to. */
  tick: number;
  /** The mode the newest probe match was created with. */
  mode: string | null;
}

export const probeControl: ProbeControl = { stepMs: 0, throwAtTick: null, endAtTick: null, roundStarts: [], idle: false, snapshotBytes: 6 };
export const probeLog: ProbeLog = { seats: [], ups: [], events: [], persisted: [], rtts: [], disposed: 0, tick: 0, mode: null };

export const resetProbe = (): void => {
  Object.assign(probeControl, { stepMs: 0, throwAtTick: null, endAtTick: null, roundStarts: [], idle: false, snapshotBytes: 6 });
  Object.assign(probeLog, { seats: [], ups: [], events: [], persisted: [], rtts: [], disposed: 0, tick: 0, mode: null });
};

export const EV_INPUT = 0x01;

const createProbeCore = (players: number): CoreMatch => {
  let tick = 0;
  const counters = new Uint16Array(4);
  const acked = new Uint16Array(4);
  const seatState: ('live' | 'ghost' | 'bot' | 'left')[] = ['live', 'live', 'live', 'live'];
  const pendingSeats: { slot: number; state: 'live' | 'ghost' | 'bot' | 'left' }[] = [];
  const events: number[] = [];
  let host: HostEvent[] = [];
  const w = new ByteWriter(256);
  return {
    get idle() {
      return probeControl.idle;
    },
    get tick() {
      return tick;
    },
    step() {
      tick += 1;
      probeLog.tick = tick;
      if (probeControl.throwAtTick === tick) throw new Error('probe: scripted failure');
      if (probeControl.stepMs > 0) {
        const until = performance.now() + probeControl.stepMs;
        while (performance.now() < until) {
          /* busy */
        }
      }
      for (const change of pendingSeats.splice(0)) {
        seatState[change.slot] = change.state;
        host.push({ t: 'seat', slot: change.slot, state: change.state });
      }
      if (probeControl.roundStarts.includes(tick)) host.push({ t: 'roundStart' });
      if (probeControl.endAtTick === tick) {
        const result: MatchResult = { mode: 'probe', humans: players, summary: { tick }, players: [], stats: [] };
        host.push({ t: 'end', reason: 'done', result });
      }
    },
    onUp(slot, payload, upSeq) {
      if (payload.length === 0 || slot > 3) return;
      counters[slot] = ((counters[slot] as number) + 1) & 0xffff;
      acked[slot] = upSeq & 0xffff;
      events.push(slot);
      probeLog.ups.push({ slot, upSeq });
    },
    onEvent(slot, payload) {
      probeLog.events.push({ slot, payload: Array.from(payload) });
    },
    ackUp: (slot) => acked[slot] ?? 0,
    setSeat(slot, cmd) {
      probeLog.seats.push({ slot, cmd });
      const state = cmd === 'reclaim' ? 'live' : cmd;
      pendingSeats.push({ slot, state });
    },
    setRtt(slot, rttMs) {
      probeLog.rtts.push({ slot, rttMs });
    },
    welcomeCfg: () => Uint8Array.of(players),
    snapshotFor(_r: RecipientView) {
      const out = new Uint8Array(Math.max(2, probeControl.snapshotBytes));
      out[0] = tick & 0xff;
      out[1] = (tick >> 8) & 0xff;
      return out;
    },
    keyframeFor(_r: RecipientView) {
      w.reset().u16(tick);
      for (let i = 0; i < 4; i += 1) w.u16(counters[i] as number);
      return w.copy();
    },
    takeEvents(_r: RecipientView) {
      if (events.length === 0) return null;
      w.reset();
      for (const slot of events) w.u8(EV_INPUT).u8(slot);
      return { bytes: w.copy(), count: events.length };
    },
    takeHostEvents() {
      events.length = 0;
      const out = host;
      host = [];
      return out;
    },
    dump: () => Uint8Array.of(tick & 0xff),
  };
};

export const probeGame = (overrides: Partial<MatchGameDef> = {}): MatchGameDef => ({
  game: 'fuseyard',
  wireId: 1,
  seats: { min: 1, max: 4 },
  spectators: 4,
  join: 'nextRound',
  host: 'lowestSeat',
  grace: { episodeMs: 60_000, matchMs: 90_000, awayLimitMs: 60_000, after: 'bot' },
  idle: { noHumanMs: 30_000, noInputMs: 120_000 },
  sender: { skipUnchanged: false, budget: BUDGETS.fuseyard },
  serverLimit: null,
  botFill: true,
  cfgSchema: z.object({ fighters: z.number().int().min(1).max(4).optional() }).passthrough(),
  create(ctx): MatchRuntime {
    probeLog.mode = ctx.mode;
    const core = createProbeCore(ctx.seats.length);
    return wrapCore('fuseyard', ctx.id, core, {
      handover: () => Uint8Array.of(1, 2, 3, 4),
      replay: () => new Uint8Array(64),
      dispose: () => {
        probeLog.disposed += 1;
      },
    });
  },
  persist(e, _api: PersistApi) {
    probeLog.persisted.push(e.t === 'end' ? 'end:' + e.reason + (e.result ? '' : ':void') : 'persist');
  },
  ...overrides,
});
