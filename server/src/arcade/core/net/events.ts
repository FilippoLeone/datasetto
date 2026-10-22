/**
 * Platform event kinds inside every FRAME event block (platform.md §5.2). Kinds 0xF0–0xFF are
 * reserved for the platform; every game uses 0x00–0xEF for its own events.
 *
 * - SeatState `{u8 slot, u8 state}`: 0 live, 1 ghost, 2 bot, 3 left.
 * - Notice `{u8 code}`: a short message for the stage ("rate lowered", "paused so chat can catch up").
 * - At `{u8 back}`: the events after it happened at `frame.tick − back`. The sender inserts it when
 *   it merges the events of several ticks into one FRAME.
 */
import type { ByteReader, ByteWriter } from '../bytes.js';
import type { EventBlock } from './lane.js';

export const PEV = { SeatState: 0xf0, Notice: 0xf1, At: 0xf2 } as const;
/** First reserved kind. */
export const PEV_MIN = 0xf0;

export const SEAT_STATE = { live: 0, ghost: 1, bot: 2, left: 3 } as const;
export type SeatStateCode = 0 | 1 | 2 | 3;

export const NOTICE = {
  /** The server lowered your update rate (it is busy). */
  rateLowered: 1,
  /** Paused so chat and voice can catch up. */
  chatFirst: 2,
  /** The server is busy: new matches and watchers are refused for now. */
  serverBusy: 3,
  /** You are watching until the next round. */
  queued: 4,
} as const;

export type PlatformEvent = { k: 'seat'; slot: number; state: SeatStateCode } | { k: 'notice'; code: number };

export const writeSeatState = (w: ByteWriter, slot: number, state: SeatStateCode): ByteWriter => w.u8(PEV.SeatState).u8(slot).u8(state);
export const writeNotice = (w: ByteWriter, code: number): ByteWriter => w.u8(PEV.Notice).u8(code);
export const writeAt = (w: ByteWriter, back: number): ByteWriter => w.u8(PEV.At).u8(Math.max(0, Math.min(255, back)));

/**
 * Walks a block in order. `game` reads one event of its own kind from `r` (positioned after the kind
 * byte) and returns false for an unknown kind or a bad length; the walk then stops and returns false,
 * and the client sends RESYNC 1. `tick` is the tick the event happened at (after any At mark).
 */
export const forEachEvent = (
  block: EventBlock,
  game: (kind: number, r: ByteReader, tick: number) => boolean,
  platform: (e: PlatformEvent, tick: number) => void,
): boolean => {
  const r = block.r;
  let tick = block.tick;
  for (let i = 0; i < block.count; i += 1) {
    const kind = r.u8();
    if (!r.ok) return false;
    if (kind === PEV.At) {
      const back = r.u8();
      tick = block.tick - back;
    } else if (kind === PEV.SeatState) {
      const slot = r.u8();
      const state = r.u8();
      if (state > 3) return false;
      if (r.ok) platform({ k: 'seat', slot, state: state as SeatStateCode }, tick);
    } else if (kind === PEV.Notice) {
      const code = r.u8();
      if (r.ok) platform({ k: 'notice', code }, tick);
    } else if (kind >= PEV_MIN) {
      return false;
    } else if (!game(kind, r, tick)) {
      return false;
    }
    if (!r.ok) return false;
  }
  return true;
};
