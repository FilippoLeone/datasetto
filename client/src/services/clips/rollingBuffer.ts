/**
 * The rolling buffer behind the Clip button: the last N seconds of a MediaStream,
 * kept in memory, nothing on disk and nothing on the server.
 *
 * A MediaRecorder's chunks after the first are not files of their own (they only
 * continue the stream the first chunk opened), so cutting the last N seconds out
 * of one long recording is not possible without re-muxing. Two recorders run
 * instead, each started afresh every N seconds and offset by N/2: at any moment one
 * of them has between N/2 and N seconds of history, and all of its chunks together
 * are one complete file. "Clip" picks that one. The clip is therefore between N/2
 * and N seconds long (shorter right after the buffer started); the caller shows the
 * real length.
 *
 * Memory is bounded by two recordings of at most N seconds at the recorder's bitrate:
 * the chunks of a recorder are dropped the moment it restarts.
 *
 * The recorder behind each slot is injected (`ChunkRecorder`), so the scheduling is
 * unit tested with fake recorders and a fake clock; `mediaRecorderFactory` is the
 * real one.
 */

export interface ChunkRecorder {
  /** Begins producing chunks (`onChunk`) until `stop()`. */
  start(): void;
  /** Ends the recording; the recorder flushes its last chunk and then calls `onStop`. */
  stop(): void;
  /** Asks for the data recorded so far as a chunk, without stopping. */
  requestData(): void;
  onChunk: ((chunk: Blob) => void) | null;
  onStop: (() => void) | null;
  onError: ((error: unknown) => void) | null;
  /** MIME type of the file the chunks form. */
  readonly mimeType: string;
}

export type ChunkRecorderFactory = () => ChunkRecorder;

export interface RollingBufferOptions {
  /** How many milliseconds of history to keep (each recorder's lifetime). */
  windowMs: number;
  createRecorder: ChunkRecorderFactory;
  now?: () => number;
  /** Called when a recorder fails or stops on its own (its track ended). The buffer is then stopped. */
  onEnded?: (error: unknown | null) => void;
}

export interface ClipResult {
  blob: Blob;
  /** Real length of the clip in milliseconds (what the chosen recorder had). */
  durationMs: number;
  mimeType: string;
}

interface Slot {
  recorder: ChunkRecorder | null;
  startedAt: number;
  chunks: Blob[];
  bytes: number;
}

/** How long `clip()` waits for the flushed chunk after `requestData()` before using what it has. */
const FLUSH_TIMEOUT_MS = 700;

/**
 * Which slot to clip from: the one with the longest history, i.e. started earliest.
 * Pure, so the selection rule is testable on its own.
 */
export const pickLongestSlot = <T extends { startedAt: number }>(slots: readonly (T | null)[]): T | null => {
  let best: T | null = null;
  for (const slot of slots) {
    if (slot && (best === null || slot.startedAt < best.startedAt)) best = slot;
  }
  return best;
};

/**
 * The schedule of the two slots: slot 0 (re)starts at every multiple of the window,
 * slot 1 half a window later. Returns the slots due for a (re)start at `elapsed`
 * milliseconds since the buffer began, given when each slot last started (relative
 * to the beginning as well, -1 for never).
 */
export const slotsDueForRestart = (elapsed: number, windowMs: number, startedAt: readonly [number, number]): number[] => {
  const due: number[] = [];
  const half = windowMs / 2;
  for (let index = 0; index < 2; index += 1) {
    const offset = index === 0 ? 0 : half;
    if (elapsed < offset) continue;
    // The most recent scheduled start for this slot at or before `elapsed`.
    const scheduled = offset + Math.floor((elapsed - offset) / windowMs) * windowMs;
    if (startedAt[index] < scheduled) due.push(index);
  }
  return due;
};

export class RollingBuffer {
  private readonly windowMs: number;
  private readonly createRecorder: ChunkRecorderFactory;
  private readonly now: () => number;
  private readonly onEnded: ((error: unknown | null) => void) | null;
  private slots: [Slot | null, Slot | null] = [null, null];
  /** When each slot last started, relative to `beganAt` (-1: never). */
  private slotStarts: [number, number] = [-1, -1];
  private beganAt = 0;
  private running = false;
  private stopping = false;

  constructor(options: RollingBufferOptions) {
    this.windowMs = Math.max(1000, options.windowMs);
    this.createRecorder = options.createRecorder;
    this.now = options.now ?? (() => Date.now());
    this.onEnded = options.onEnded ?? null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Begin buffering. `tick()` has to be called regularly (every few hundred ms) to run the schedule. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.beganAt = this.now();
    this.slotStarts = [-1, -1];
    this.tick();
  }

  /** Run the schedule: start slots that are due, restarting the one whose window is full. */
  tick(): void {
    if (!this.running) return;
    const elapsed = this.now() - this.beganAt;
    for (const index of slotsDueForRestart(elapsed, this.windowMs, this.slotStarts)) {
      this.restartSlot(index as 0 | 1, elapsed);
    }
  }

  /** Stop both recorders and drop everything held. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.stopping = true;
    for (const index of [0, 1] as const) this.discardSlot(index);
    this.stopping = false;
  }

  /** Milliseconds of history available right now (0 while nothing recorded yet). */
  availableMs(): number {
    const slot = pickLongestSlot(this.slots);
    if (!slot || !this.running) return 0;
    return Math.max(0, this.now() - slot.startedAt);
  }

  /** Bytes currently held across both recorders (the memory the buffer costs). */
  bytes(): number {
    return (this.slots[0]?.bytes ?? 0) + (this.slots[1]?.bytes ?? 0);
  }

  /**
   * The last N/2..N seconds as one file. Flushes the chosen recorder first so the
   * clip ends at "now" rather than at the last timeslice.
   */
  async clip(): Promise<ClipResult | null> {
    const slot = pickLongestSlot(this.slots);
    if (!slot || !slot.recorder || !this.running) return null;
    const recorder = slot.recorder;
    await new Promise<void>((resolve) => {
      let settled = false;
      const previous = recorder.onChunk;
      const finish = () => {
        if (settled) return;
        settled = true;
        recorder.onChunk = previous;
        window.clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(finish, FLUSH_TIMEOUT_MS);
      recorder.onChunk = (chunk) => {
        previous?.(chunk);
        finish();
      };
      try {
        recorder.requestData();
      } catch {
        finish();
      }
    });
    // The slot may have been restarted or dropped while we waited.
    if (slot.recorder !== recorder || slot.chunks.length === 0) return null;
    const durationMs = Math.max(0, this.now() - slot.startedAt);
    return { blob: new Blob(slot.chunks, { type: recorder.mimeType }), durationMs, mimeType: recorder.mimeType };
  }

  private restartSlot(index: 0 | 1, elapsed: number): void {
    // Start the new recorder before the old one is dropped so the buffer never has a hole.
    const startedAt = this.now();
    const slot: Slot = { recorder: null, startedAt, chunks: [], bytes: 0 };
    let recorder: ChunkRecorder;
    try {
      recorder = this.createRecorder();
    } catch (error) {
      this.fail(error);
      return;
    }
    slot.recorder = recorder;
    recorder.onChunk = (chunk) => {
      if (slot.recorder !== recorder || chunk.size === 0) return;
      slot.chunks.push(chunk);
      slot.bytes += chunk.size;
    };
    recorder.onStop = () => {
      // A planned restart stopped it; anything else means the source ended.
      if (slot.recorder === recorder && this.running && !this.stopping) this.fail(null);
    };
    recorder.onError = (error) => {
      if (slot.recorder === recorder && this.running) this.fail(error);
    };
    const previous = this.slots[index];
    this.slots[index] = slot;
    const half = this.windowMs / 2;
    const offset = index === 0 ? 0 : half;
    this.slotStarts[index] = offset + Math.floor((elapsed - offset) / this.windowMs) * this.windowMs;
    try {
      recorder.start();
    } catch (error) {
      this.slots[index] = previous;
      this.fail(error);
      return;
    }
    if (previous) this.discard(previous);
  }

  private discardSlot(index: 0 | 1): void {
    const slot = this.slots[index];
    this.slots[index] = null;
    if (slot) this.discard(slot);
  }

  private discard(slot: Slot): void {
    const recorder = slot.recorder;
    slot.recorder = null;
    slot.chunks = [];
    slot.bytes = 0;
    if (!recorder) return;
    recorder.onChunk = null;
    recorder.onError = null;
    recorder.onStop = null;
    try {
      recorder.stop();
    } catch {
      /* already inactive */
    }
  }

  private fail(error: unknown | null): void {
    if (!this.running) return;
    this.stop();
    this.onEnded?.(error);
  }
}

/** The MIME types tried for a clip, best first; the first one the engine records is used. */
export const CLIP_MIME_CANDIDATES = {
  /** VP9 compresses better; desktops encode it in real time. */
  desktop: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'],
  /** Phones have hardware VP8 encoders far more often than VP9 ones. */
  mobile: ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'],
};

/** The first MIME type MediaRecorder here accepts, or null when it cannot record WebM at all. */
export const pickClipMimeType = (candidates: readonly string[], isTypeSupported: (type: string) => boolean): string | null => {
  for (const type of candidates) {
    try {
      if (isTypeSupported(type)) return type;
    } catch {
      /* an engine that throws on unknown types */
    }
  }
  return null;
};

export interface MediaRecorderFactoryOptions {
  mimeType: string;
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
  /** How often the recorder hands over a chunk. */
  timesliceMs?: number;
}

/** A ChunkRecorder over the browser's MediaRecorder for one stream. */
export const mediaRecorderFactory =
  (stream: MediaStream, options: MediaRecorderFactoryOptions): ChunkRecorderFactory =>
  () => {
    const recorder = new MediaRecorder(stream, {
      mimeType: options.mimeType,
      videoBitsPerSecond: options.videoBitsPerSecond,
      audioBitsPerSecond: options.audioBitsPerSecond,
    });
    const adapter: ChunkRecorder = {
      mimeType: recorder.mimeType || options.mimeType,
      onChunk: null,
      onStop: null,
      onError: null,
      start: () => recorder.start(options.timesliceMs ?? 1000),
      stop: () => {
        if (recorder.state !== 'inactive') recorder.stop();
      },
      requestData: () => {
        if (recorder.state === 'recording') recorder.requestData();
      },
    };
    recorder.ondataavailable = (event) => adapter.onChunk?.(event.data);
    recorder.onstop = () => adapter.onStop?.();
    recorder.onerror = (event) => adapter.onError?.((event as unknown as { error?: unknown }).error ?? event);
    return adapter;
  };
