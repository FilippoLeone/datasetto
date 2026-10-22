/**
 * The pure match runtime contract (plan.md §2.6.2). Each action game implements `CoreMatch` in its
 * `core/<id>/runtime.ts`. The server wraps it into a `MatchRuntime` (rooms/wrap.ts) and the device
 * steps it directly through `createLocalMatchHost` (client/src/arcade/runtime/net/localHost.ts), so a
 * game module has one code path online and offline.
 *
 * Rules: `step()` is one 30 Hz tick with bounded work and no allocation; nothing here may throw on
 * bad input (malformed payloads are dropped). Buffers returned by `snapshotFor`, `keyframeFor` and
 * `takeEvents` may be shared per tick and are valid until the next `step()`.
 */

export interface RecipientView {
  /** 0xff for a spectator. */
  slot: number;
  /** Routing key: the Bellwick room id, else 0. */
  view: number;
}

/** One tick's events visible to a recipient, in the game's wire format, without At marks. */
export interface EventChunk {
  bytes: Uint8Array;
  count: number;
}

export type SeatCmd = 'live' | 'ghost' | 'bot' | 'left' | 'reclaim';

export interface MatchResult {
  mode: string;
  humans: number;
  summary: unknown;
  players: readonly { slot: number; place: number | null; score: number | null }[];
  stats: readonly { slot: number; stat: string; op: 'add' | 'max'; value: number }[];
}

export type HostEvent =
  /** Sent after this tick's events, in order. */
  | { t: 'phase'; phase: number; reason: number; body: Uint8Array }
  /** A seat change actually applied (a ghost only after its danger lock). */
  | { t: 'seat'; slot: number; state: 'live' | 'ghost' | 'bot' | 'left' }
  /** Drop the recipient's pending events and send it a KEYFRAME for `view`. */
  | { t: 'rekey'; slot: number; reason: 4 | 5; view: number }
  /** Queued joiners and reclaims may take seats now. */
  | { t: 'roundStart' }
  /** Bellwick autosave (SaveV1). */
  | { t: 'persist'; data: Uint8Array }
  | { t: 'end'; reason: 'done' | 'idle' | 'host'; result: MatchResult | null };

export interface CoreMatch {
  /** True → the scheduler may skip this match. */
  readonly idle: boolean;
  readonly tick: number;
  /** One 30 Hz tick, bounded work, no allocation. */
  step(): void;
  /**
   * Malformed → dropped silently. `upSeq` is the UP envelope's u16 sequence: the game's own number for
   * its newest input when the client passed one to `sendUp`, else the host's per-message counter. The
   * platform has already dropped UPs whose upSeq is not newer than the last one from this slot.
   */
  onUp(slot: number, payload: Uint8Array, upSeq: number): void;
  /** `evSeq` is already deduplicated by the platform. */
  onEvent(slot: number, payload: Uint8Array): void;
  /** The newest UP sequence applied for `slot` (FRAME's `ackUp`), in the same numbering as `upSeq`. */
  ackUp(slot: number): number;
  /** 'ghost' is a request; a 'seat' host event confirms it. */
  setSeat(slot: number, cmd: SeatCmd): void;
  /** Smoothed RTT; dodge grace is read at round start. */
  setRtt(slot: number, rttMs: number): void;
  /** WELCOME's `cfg`. */
  welcomeCfg(): Uint8Array;
  /** null: unchanged or frozen; the sender then sends nothing for this slot. */
  snapshotFor(r: RecipientView): Uint8Array | null;
  /** Public view only, never hidden state. */
  keyframeFor(r: RecipientView): Uint8Array;
  /** This tick's events visible to `r`. */
  takeEvents(r: RecipientView): EventChunk | null;
  /** Drained after every `step()`. */
  takeHostEvents(): readonly HostEvent[];
  /** Canonical full state including hidden state (hashes, HANDOVER source). */
  dump(): Uint8Array;
}
