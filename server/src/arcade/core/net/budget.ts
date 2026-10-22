/**
 * Per-client byte budgets (docs/arcade/plan.md §2.6.8). Every figure is wire bytes including the
 * framing of platform.md §5.1, for the 3G case (750 kbit/s down, 250 up, 300 ms RTT) in a
 * 4-person call with the cellular voice cap. Rates are bytes per second.
 *
 * The game numbers live in each game's own `core/<id>/budget.ts`; this module re-exports them so
 * the sender, the link simulator and the codec tests read one place.
 */
import { BUDGET as BELLWICK } from '../bellwick/budget.js';
import { BUDGET as FUSEYARD } from '../fuseyard/budget.js';
import { BUDGET as GLIMMER } from '../glimmer/budget.js';
import { BUDGET as LAMPLIGHT } from '../lamplight/budget.js';

/** Per-message overheads: action-lane down/up, the TCP ACK per message received, and the table lane (Socket.IO frame) down/up. */
export const OVERHEAD = { down: 76, up: 80, tcpAck: 26, tableDown: 92, tableUp: 96 } as const;

/** Action lane ceilings, B/s and B in any 1 s window (32 / 40 / 20 kbit/s). */
export const LANE_CEILING = { downAvgBps: 4000, downPeak1s: 5000, upAvgBps: 2500 } as const;
/** Table lane ceilings (4 kbit/s, 3 KB in any second, 2.4 kbit/s). */
export const TABLE_CEILING = { downAvgBps: 500, downPeak1s: 3000, upAvgBps: 300 } as const;

/** An action game's pacing budget (one player at the default divisor). */
export interface GameBudget {
  /** Down average, B/s. The sender's token bucket refills at 1.25 × this. */
  downAvg: number;
  /** Down, B in any 1 s window. */
  downPeak1s: number;
  /** Up average, B/s. */
  upAvg: number;
  /** Largest KEYFRAME body. */
  keyframeMax: number;
  /** Largest snapshot body. */
  snapshotMax: number;
  /** Typical FRAME body; sizes the bucket depth only. */
  frameTypMax: number;
  /** Largest UP payload. */
  upMax: number;
  /** Pending event bytes above which a recipient is parked as `overflow`. */
  overflowEvents: number;
}

/** A table game's budget per seated client (B/s and B in any 1 s window, wire bytes). */
export interface TableBudget {
  downAvg: number;
  downPeak1s: number;
  upAvg: number;
}

export const BUDGETS: { readonly fuseyard: GameBudget; readonly bellwick: GameBudget } = { fuseyard: FUSEYARD, bellwick: BELLWICK };
export const TABLE_BUDGETS: { readonly lamplight: TableBudget; readonly glimmer: TableBudget } = { lamplight: LAMPLIGHT, glimmer: GLIMMER };

/** Wire bytes of a KEYFRAME (10 B header) and a FRAME (8 B header) as sent, overhead included. */
export const keyframeWire = (body: number): number => body + 10 + OVERHEAD.down;
export const frameWire = (body: number): number => body + 8 + OVERHEAD.down;

/**
 * Token-bucket depth: one worst keyframe plus four typical frames, so a frame at the overflow
 * threshold always fits and the bucket can never deadlock (≥ 1,926 B for Fuseyard).
 */
export const bucketDepth = (b: GameBudget): number => keyframeWire(b.keyframeMax) + 4 * (b.frameTypMax + OVERHEAD.down);
