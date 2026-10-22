/**
 * The contract between the Arcade shell, the runtime and each game chunk (docs/arcade/plan.md §2.6.6).
 * Frozen at tag arcade-p-m1: a change is a platform PR with a note in docs/arcade/platform.md.
 *
 * A game chunk (client/src/arcade/<id>/index.ts) default-exports a `GameChunk`. The shell mounts its
 * `module` into a stage element with a host: a `MatchHost` for action games (Fuseyard, Bellwick), a
 * `TableHost` for table games (Lamplight, Glimmerhall); remote online, local offline. The game draws
 * on its own canvas and owns its DOM inside the stage; it never writes Preact signals per tick.
 *
 * This file holds types only, so the main bundle may import it without pulling in the runtime.
 */
import type { CoreMatch } from '@arcade/core/net/match';
import type { FrameView, KeyframeView, PhaseView, Welcome } from '@arcade/core/net/lane';
import type { GameId } from '@arcade/core/version';
import type { Shortcut } from '@/lib/shortcut';

export type { CoreMatch, EventChunk, HostEvent, MatchResult, RecipientView, SeatCmd } from '@arcade/core/net/match';
export type { EventBlock, FrameView, KeyframeView, PhaseView, Welcome } from '@arcade/core/net/lane';
export type { ActionGameId, GameId, TableGameId } from '@arcade/core/version';

/** The push-to-talk key (and any other app shortcut) as Settings stores it. */
export type KeyBinding = Shortcut;

/** `KeyboardEvent.code` → ACT bits (input/index.ts). */
export type KeyMap = Readonly<Record<string, number>>;

export type AnyHost = MatchHost | TableHost;

export interface GameModule<H extends AnyHost = AnyHost> {
  mount(el: HTMLElement, host: H, opts: MountOpts): GameHandle;
}

export interface GameHandle {
  pause(): void;
  resume(): void;
  /** Frees everything: frame subscription, listeners, gamepad poll, AudioContext, canvases (0 × 0). */
  unmount(): void;
  /** Android back and Esc: true = consumed (e.g. a menu closed); false lets the shell minimize. */
  back?(): boolean;
}

/** What `arcade:lobby` carries (the lobby you are in). */
export interface LobbyView {
  id: string;
  game: GameId;
  /** Voice channel id. */
  ch: string;
  mode: string;
  st: 'open' | 'live' | 'ended';
  /** Account id of the host. */
  host: string;
  seats: readonly { a: string | null; bot: boolean; st: number }[];
  /** Watchers. */
  spec: number;
  cfg: unknown;
  /** Version, increases with every change. */
  v: number;
}

/** Device preferences (`datasetto.arcade.prefs.v1`), plus the account-level hide switches. */
export interface ArcadePrefs {
  /** Game volume, 0–1 (default 0.4, below voice: speaker audio leaks into the mic). */
  volume: number;
  /** Music (off by default online). */
  music: boolean;
  /** 10 ms vibration on touch buttons (Android; off by default). */
  vibrate: boolean;
  /** Touch movement control. */
  stick: 'float' | 'dpad';
  /** Main touch button size in CSS px. */
  buttonPx: 56 | 76;
  /** Bellwick: draw at 30 fps. */
  batterySaver: boolean;
}

export type SessionStatus = 'connecting' | 'live' | 'lagging' | 'paused' | 'away' | 'ended';

export interface MountOpts {
  readonly mode: 'local' | 'remote';
  readonly lobby: LobbyView | null;
  readonly me: { accountId: string | null; slot: number | null };
  readonly prefs: ArcadePrefs;
  /** Never bind this key (pass it to createInput, which excludes it). */
  readonly ptt: KeyBinding | null;
  /** Other app shortcuts never to bind (the clip key); pass to createInput as `reserved`. */
  readonly reserved: readonly KeyBinding[];
  readonly reducedMotion: boolean;
  /** `(pointer: coarse)`: show touch controls. */
  readonly coarse: boolean;
  readonly shell: ShellBridge;
}

export interface ShellBridge {
  /** Coalesced into `arcadeSession`. */
  status(s: SessionStatus): void;
  /** `arcadeSession.attention`, a tab-title prefix and the desktop shell's flashing taskbar entry. */
  attention(on: boolean): void;
  /** Screen Wake Lock while a game is live and visible (no-op where unsupported). */
  wakeLock(on: boolean): void;
  /** "Back to call": the stage collapses to a chip; the game is then hidden (`away`). */
  minimize(): void;
  /** Close the game. */
  leave(): void;
  /**
   * Table games: after `ms` without input on the stage (pointer, key, wheel) while visible, treat the
   * game as hidden (pause, and online `away`) until the next input; null turns it off. Glimmerhall: 10 min.
   */
  idleAway(ms: number | null): void;
  /** Display names from presence, looked up on demand (never per tick). */
  names(accountIds: readonly string[]): readonly string[];
  /** Practice chips for offline poker and slots. */
  readonly practice: PracticeWallet;
}

export interface SeatInfo {
  slot: number;
  accountId: string | null;
  name: string;
  bot: boolean;
  joinOrder: number;
  /** Game-specific (Bellwick: the tunic). */
  extra: number;
}

export interface MatchHost {
  readonly mode: 'local' | 'remote';
  /**
   * Newest wins; skipped while ws.bufferedAmount > 512 B. `upSeq` (u16) is the game's own number for the
   * newest input in the payload (Fuseyard numbers inputs per tick); without it the host numbers messages.
   * It reaches `CoreMatch.onUp` and comes back as FRAME `ackUp`.
   */
  sendUp(payload: Uint8Array, upSeq?: number): void;
  /** Reliable; evSeq assigned and resent after a resume. */
  sendEvent(payload: Uint8Array): void;
  onWelcome(cb: (w: Welcome) => void): void;
  onFrame(cb: (f: FrameView) => void): void;
  onKeyframe(cb: (k: KeyframeView) => void): void;
  onPhase(cb: (p: PhaseView) => void): void;
  onHandover(cb: (body: Uint8Array, simVersion: number) => void): void;
  onSeats(cb: (seats: readonly SeatInfo[]) => void): () => void;
  onClosed(cb: (code: number, reason: string) => void): void;
  /** Remote: VIS; local: pause the sim and audio. */
  setVisible(visible: boolean): void;
  rttMs(): number;
  linkConstrained(): boolean;
  estServerTick(nowMs: number): number;
  close(): void;
}

export interface TableHost {
  readonly mode: 'local' | 'remote';
  request<T>(ev: string, data: unknown, opts?: { timeoutMs?: number }): Promise<T>;
  on(ev: string, cb: (data: unknown) => void): () => void;
  connected(): boolean;
  onConnection(cb: (up: boolean) => void): () => void;
  ackRttMs(): number;
  setVisible(visible: boolean): void;
  close(): void;
}

/** Supplied by a table game's chunk for offline play. */
export interface LocalTableServer {
  request(ev: string, data: unknown): Promise<unknown>;
  attach(emit: (ev: string, data: unknown) => void): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

/** The default export of client/src/arcade/<id>/index.ts. */
export interface GameChunk {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  module: GameModule<any>;
  /** Offline: a `CoreMatch` for action games, a `LocalTableServer` for table games. */
  local(o: { mode: string; cfg: unknown; seed: Uint32Array; seats: readonly SeatInfo[] }): CoreMatch | LocalTableServer;
}

export interface PracticeWallet {
  balance(): number;
  debit(n: number, ref: string): boolean;
  credit(n: number, ref: string): void;
  /** Move `amount` into an open escrow under `ref` (a table stack). Restored on the next start if the page closed. */
  escrow(ref: string, amount: number): void;
  /** Close the escrow under `ref`; returns the chips released back to the balance. */
  release(ref: string): number;
  /** Free refill to 10,000 when the balance is below `minBet`; true if it refilled. */
  refill(minBet: number): boolean;
  onChange(cb: (bal: number) => void): () => void;
}

