/**
 * A minimal stand-in for the platform's sender, for Fuseyard's view tests: it steps a runtime,
 * keeps each tick's event blob (game events, then SeatState for applied seat changes), and at send
 * slots builds what a FRAME carries (events merged with At marks, the snapshot at the frame's tick).
 * Rekeys drop pending events and produce a KEYFRAME.
 */
import { ByteReader, ByteWriter } from '../../../src/arcade/core/bytes.js';
import { PEV, SEAT_STATE } from '../../../src/arcade/core/net/events.js';
import type { EventBlock } from '../../../src/arcade/core/net/lane.js';
import type { FuseyardCore } from '../../../src/arcade/core/fuseyard/runtime.js';

export interface SentFrame {
  kind: 'frame';
  tick: number;
  events: { count: number; bytes: Uint8Array } | null;
  snapshot: Uint8Array;
}
export interface SentKeyframe {
  kind: 'keyframe';
  tick: number;
  body: Uint8Array;
}
export type Sent = SentFrame | SentKeyframe;

export interface TestSender {
  /** Steps the core one tick and records its events. */
  tick(): void;
  /** What a FRAME sent now would carry (pending events are consumed). */
  frame(): SentFrame;
  /** A keyframe now (pending events dropped). */
  keyframe(): SentKeyframe;
  /** True when the core asked for a keyframe for `slot` since the last call. */
  takeRekey(): boolean;
  readonly pendingBytes: number;
  readonly phases: { phase: number; body: Uint8Array }[];
}

export const createTestSender = (core: FuseyardCore, slot: number): TestSender => {
  const pending: { tick: number; bytes: Uint8Array; count: number }[] = [];
  let rekey = false;
  const phases: { phase: number; body: Uint8Array }[] = [];
  return {
    tick() {
      core.step();
      const t = core.tick;
      const chunk = core.takeEvents({ slot, view: 0 });
      const host = core.takeHostEvents();
      const seats = host.filter((e) => e.t === 'seat');
      const w = new ByteWriter((chunk?.bytes.length ?? 0) + seats.length * 3);
      if (chunk) w.bytes(chunk.bytes);
      for (const e of seats) if (e.t === 'seat') w.u8(PEV.SeatState).u8(e.slot).u8(SEAT_STATE[e.state]);
      const count = (chunk?.count ?? 0) + seats.length;
      if (count > 0) pending.push({ tick: t, bytes: w.copy(), count });
      for (const e of host) {
        if (e.t === 'rekey' && (e.slot === slot || e.slot === 0xff)) rekey = true;
        if (e.t === 'phase') phases.push({ phase: e.phase, body: e.body.slice() });
      }
    },
    frame() {
      const t = core.tick;
      let count = 0;
      let size = 0;
      for (const p of pending) {
        count += p.count + (p.tick !== t ? 1 : 0);
        size += p.bytes.length + 2;
      }
      let events: SentFrame['events'] = null;
      if (pending.length > 0) {
        const w = new ByteWriter(size + 2);
        let marked = false;
        for (const p of pending) {
          if (p.tick !== t) {
            w.u8(PEV.At).u8(t - p.tick);
            marked = true;
          } else if (marked) {
            w.u8(PEV.At).u8(0);
            count += 1;
            marked = false;
          }
          w.bytes(p.bytes);
        }
        events = { count, bytes: w.copy() };
      }
      pending.length = 0;
      return { kind: 'frame', tick: t, events, snapshot: core.snapshotFor({ slot, view: 0 })!.slice() };
    },
    keyframe() {
      pending.length = 0;
      return { kind: 'keyframe', tick: core.tick, body: core.keyframeFor({ slot, view: 0 }).slice() };
    },
    takeRekey() {
      const r = rekey;
      rekey = false;
      return r;
    },
    get pendingBytes() {
      return pending.reduce((n, p) => n + p.bytes.length, 0);
    },
    phases,
  };
};

export const eventBlock = (f: SentFrame): EventBlock | null => (f.events ? { count: f.events.count, r: new ByteReader(f.events.bytes), tick: f.tick } : null);
