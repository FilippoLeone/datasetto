import { describe, expect, it } from 'vitest';
import { CLIP_MIME_CANDIDATES, pickClipMimeType, pickLongestSlot, RollingBuffer, slotsDueForRestart, type ChunkRecorder } from './rollingBuffer';

/** A recorder that produces one chunk per `tick` of the fake clock (1 KB per second). */
class FakeRecorder implements ChunkRecorder {
  static all: FakeRecorder[] = [];
  readonly mimeType = 'video/webm;codecs=vp9,opus';
  onChunk: ((chunk: Blob) => void) | null = null;
  onStop: (() => void) | null = null;
  onError: ((error: unknown) => void) | null = null;
  started = false;
  stopped = false;
  requests = 0;
  constructor(readonly startedAt: number) {
    FakeRecorder.all.push(this);
  }
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
    this.onStop?.();
  }
  requestData(): void {
    this.requests += 1;
    this.onChunk?.(new Blob([new Uint8Array(100)]));
  }
  /** One second of recording passed. */
  feed(seconds = 1): void {
    if (this.started && !this.stopped) this.onChunk?.(new Blob([new Uint8Array(1024 * seconds)]));
  }
}

const setup = (windowMs = 30_000) => {
  let now = 1_000_000;
  FakeRecorder.all = [];
  const ended: Array<unknown | null> = [];
  const buffer = new RollingBuffer({ windowMs, now: () => now, createRecorder: () => new FakeRecorder(now), onEnded: (error) => ended.push(error) });
  /** Advance the clock by whole seconds, ticking the schedule and feeding every live recorder once per second. */
  const advance = (seconds: number) => {
    for (let index = 0; index < seconds; index += 1) {
      now += 1000;
      buffer.tick();
      for (const recorder of FakeRecorder.all) recorder.feed();
    }
  };
  return { buffer, advance, ended, live: () => FakeRecorder.all.filter((recorder) => recorder.started && !recorder.stopped) };
};

describe('slotsDueForRestart', () => {
  it('starts slot 0 at once, slot 1 half a window later, and each again every window', () => {
    expect(slotsDueForRestart(0, 30_000, [-1, -1])).toEqual([0]);
    expect(slotsDueForRestart(14_999, 30_000, [0, -1])).toEqual([]);
    expect(slotsDueForRestart(15_000, 30_000, [0, -1])).toEqual([1]);
    expect(slotsDueForRestart(29_999, 30_000, [0, 15_000])).toEqual([]);
    expect(slotsDueForRestart(30_000, 30_000, [0, 15_000])).toEqual([0]);
    expect(slotsDueForRestart(45_000, 30_000, [30_000, 15_000])).toEqual([1]);
    // A late tick restarts both when both are overdue.
    expect(slotsDueForRestart(46_000, 30_000, [0, 15_000])).toEqual([0, 1]);
  });
});

describe('pickLongestSlot', () => {
  it('takes the slot that started earliest and ignores empty ones', () => {
    expect(pickLongestSlot([null, null])).toBeNull();
    expect(pickLongestSlot([{ startedAt: 50 }, null])).toEqual({ startedAt: 50 });
    expect(pickLongestSlot([{ startedAt: 50 }, { startedAt: 20 }])).toEqual({ startedAt: 20 });
  });
});

describe('RollingBuffer', () => {
  it('keeps two recorders a half window apart so a clip is always between N/2 and N seconds after warm-up', async () => {
    const { buffer, advance, live } = setup(30_000);
    buffer.start();
    expect(live()).toHaveLength(1);
    expect(buffer.availableMs()).toBe(0);

    advance(10);
    expect(buffer.availableMs()).toBe(10_000);
    const early = await buffer.clip();
    expect(early?.durationMs).toBe(10_000);

    advance(5); // t = 15 s: the second recorder begins
    expect(live()).toHaveLength(2);
    advance(15); // t = 30 s: the first one restarts; the second has 15 s
    expect(live()).toHaveLength(2);
    expect(FakeRecorder.all[0].stopped).toBe(true);
    expect(buffer.availableMs()).toBe(15_000);

    // From here on, whenever we clip, the length is within [15, 30] s.
    for (let step = 0; step < 40; step += 1) {
      advance(1);
      const available = buffer.availableMs();
      expect(available).toBeGreaterThanOrEqual(15_000);
      expect(available).toBeLessThanOrEqual(30_000);
    }
    const clip = await buffer.clip();
    expect(clip).not.toBeNull();
    expect(clip!.durationMs).toBeGreaterThanOrEqual(15_000);
    expect(clip!.durationMs).toBeLessThanOrEqual(30_000);
    expect(clip!.mimeType).toBe('video/webm;codecs=vp9,opus');
  });

  it('reports the real length of the chosen recording and flushes it before assembling the file', async () => {
    const { buffer, advance } = setup(30_000);
    buffer.start();
    advance(40); // slot 0 restarted at 30 s (10 s of history), slot 1 started at 15 s (25 s)
    expect(buffer.availableMs()).toBe(25_000);
    const clip = await buffer.clip();
    expect(clip?.durationMs).toBe(25_000);
    const chosen = FakeRecorder.all.find((recorder) => recorder.startedAt === 1_000_000 + 15_000)!;
    expect(chosen.requests).toBe(1);
    // The fake feeds a chunk in the second a recorder starts and every second after: 26 chunks for 15..40 s, plus the flushed 100 bytes.
    expect(clip?.blob.size).toBe(26 * 1024 + 100);
  });

  it('bounds memory: a restarted recorder drops its chunks, so at most two windows are held', () => {
    const { buffer, advance } = setup(30_000);
    buffer.start();
    advance(30 * 20);
    // Slot 0 holds up to 30 s, slot 1 up to 30 s, each at 1 KB/s.
    expect(buffer.bytes()).toBeLessThanOrEqual(2 * 30 * 1024);
    expect(buffer.bytes()).toBeGreaterThan(0);
    buffer.stop();
    expect(buffer.bytes()).toBe(0);
    expect(buffer.availableMs()).toBe(0);
    expect(FakeRecorder.all.every((recorder) => recorder.stopped)).toBe(true);
  });

  it('stops and tells the owner when a recorder ends on its own or fails', () => {
    const { buffer, advance, ended, live } = setup(30_000);
    buffer.start();
    advance(20);
    const [first] = live();
    first.onStop?.(); // the track ended: the browser stopped it
    expect(buffer.isRunning).toBe(false);
    expect(ended).toEqual([null]);

    const again = setup(30_000);
    again.buffer.start();
    again.advance(2);
    again.live()[0].onError?.(new Error('encoder died'));
    expect(again.ended).toHaveLength(1);
    expect((again.ended[0] as Error).message).toBe('encoder died');
    expect(again.buffer.isRunning).toBe(false);
  });

  it('returns nothing before anything was recorded and after stop', async () => {
    const { buffer } = setup(30_000);
    expect(await buffer.clip()).toBeNull();
    buffer.start();
    buffer.stop();
    expect(await buffer.clip()).toBeNull();
  });
});

describe('pickClipMimeType', () => {
  it('takes the first type the engine records, preferring VP8 on phones', () => {
    const supports = (types: string[]) => (type: string) => types.includes(type);
    expect(pickClipMimeType(CLIP_MIME_CANDIDATES.desktop, supports(['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus']))).toBe('video/webm;codecs=vp9,opus');
    expect(pickClipMimeType(CLIP_MIME_CANDIDATES.mobile, supports(['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus']))).toBe('video/webm;codecs=vp8,opus');
    expect(pickClipMimeType(CLIP_MIME_CANDIDATES.desktop, supports(['video/webm']))).toBe('video/webm');
    expect(pickClipMimeType(CLIP_MIME_CANDIDATES.desktop, supports(['video/mp4']))).toBeNull();
    expect(
      pickClipMimeType(CLIP_MIME_CANDIDATES.desktop, () => {
        throw new Error('no');
      }),
    ).toBeNull();
  });
});
