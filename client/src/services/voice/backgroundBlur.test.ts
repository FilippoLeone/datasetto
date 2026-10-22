import { describe, expect, it } from 'vitest';
import {
  BlurGovernor,
  WindowMeter,
  chooseBlurPath,
  chooseSegmenterModel,
  describeBlurStats,
  initialTier,
  judgeWindow,
  normalizeBlurLevel,
  platformBlurMode,
  stepDownTier,
  type BlurEnvironment,
  type BlurTier,
  type BlurWindow,
} from './backgroundBlur';
import { normalizeAudioSettings } from '@/state/settings';

const chromium: BlurEnvironment = { worker: true, wasm: true, offscreenWebgl2: true, trackProcessor: true, trackGenerator: true, canvasCapture: true, imageBitmap: true };

/** A one-second window: `out` of `input` frames sent, with this p95 delay. */
const win = (input: number, out: number, p95LatencyMs = 15): BlurWindow => ({ inputFrames: input, outputFrames: out, durationMs: 1000, meanLatencyMs: p95LatencyMs * 0.7, p95LatencyMs, meanCostMs: 10 });

describe('blur level setting', () => {
  it('keeps the three levels and turns anything else into Off', () => {
    expect(normalizeBlurLevel('light')).toBe('light');
    expect(normalizeBlurLevel('strong')).toBe('strong');
    expect(normalizeBlurLevel('off')).toBe('off');
    expect(normalizeBlurLevel(undefined)).toBe('off');
    expect(normalizeBlurLevel('heavy')).toBe('off');
    expect(normalizeBlurLevel(true)).toBe('off');
  });

  it('migrates stored settings: older ones get Off, a saved level stays, garbage becomes Off', () => {
    expect(normalizeAudioSettings({}).cameraBlur).toBe('off');
    expect(normalizeAudioSettings({ screenQuality: '720p30' }).cameraBlur).toBe('off');
    expect(normalizeAudioSettings({ cameraBlur: 'strong' }).cameraBlur).toBe('strong');
    expect(normalizeAudioSettings({ cameraBlur: 'light' }).cameraBlur).toBe('light');
    expect(normalizeAudioSettings({ cameraBlur: 'max' as never }).cameraBlur).toBe('off');
    expect(normalizeAudioSettings(null).cameraBlur).toBe('off');
  });
});

describe('where blur can run', () => {
  it('prefers insertable streams, falls back to the canvas, and says why when neither works', () => {
    expect(chooseBlurPath(chromium)).toEqual({ path: 'insertable', reason: null });
    // Firefox: no track processor or generator on the page.
    expect(chooseBlurPath({ ...chromium, trackProcessor: false, trackGenerator: false })).toEqual({ path: 'canvas', reason: null });
    expect(chooseBlurPath({ ...chromium, trackGenerator: false }).path).toBe('canvas');
    const noGl = chooseBlurPath({ ...chromium, offscreenWebgl2: false });
    expect(noGl.path).toBe('none');
    expect(noGl.reason).toMatch(/WebGL 2/);
    expect(chooseBlurPath({ ...chromium, worker: false }).path).toBe('none');
    expect(chooseBlurPath({ ...chromium, trackProcessor: false, canvasCapture: false }).path).toBe('none');
  });

  it('reads the system camera effects from the track capabilities', () => {
    expect(platformBlurMode({ backgroundBlur: [false, true] })).toBe('controllable');
    expect(platformBlurMode({ backgroundBlur: [true] })).toBe('forced-on');
    expect(platformBlurMode({ backgroundBlur: [false] })).toBe('none');
    expect(platformBlurMode({ backgroundBlur: [] })).toBe('none');
    expect(platformBlurMode({ backgroundBlur: 'yes' })).toBe('none');
    expect(platformBlurMode({})).toBe('none');
    expect(platformBlurMode(undefined)).toBe('none');
  });

  it('picks the landscape model for wide cameras and the square one otherwise', () => {
    expect(chooseSegmenterModel(1280, 720)).toBe('landscape');
    expect(chooseSegmenterModel(640, 360)).toBe('landscape');
    expect(chooseSegmenterModel(640, 480)).toBe('square');
    expect(chooseSegmenterModel(720, 1280)).toBe('square');
    expect(chooseSegmenterModel(0, 0)).toBe('square');
  });
});

describe('step-down ladder', () => {
  it('starts at every frame on desktops and every 2nd frame on phones', () => {
    expect(initialTier('strong', false)).toEqual({ level: 'strong', segmentEvery: 1 });
    expect(initialTier('light', true)).toEqual({ level: 'light', segmentEvery: 2 });
  });

  it('segments less often first, then goes to Light, then off', () => {
    const ladder: Array<BlurTier | null> = [{ level: 'strong', segmentEvery: 1 }];
    while (ladder[ladder.length - 1] && ladder.length < 10) ladder.push(stepDownTier(ladder[ladder.length - 1]!));
    expect(ladder).toEqual([
      { level: 'strong', segmentEvery: 1 },
      { level: 'strong', segmentEvery: 2 },
      { level: 'light', segmentEvery: 2 },
      { level: 'light', segmentEvery: 3 },
      null,
    ]);
    expect(stepDownTier({ level: 'light', segmentEvery: 1 })).toEqual({ level: 'light', segmentEvery: 2 });
    // A phone that starts at every 2nd frame on Strong goes straight to Light.
    expect(stepDownTier({ level: 'strong', segmentEvery: 2 })).toEqual({ level: 'light', segmentEvery: 2 });
  });
});

describe('governor', () => {
  it('judges a window by the frame rate it keeps and the delay it adds', () => {
    expect(judgeWindow(win(30, 30))).toBe('ok');
    expect(judgeWindow(win(30, 25))).toBe('ok');
    // Below 24 fps while the camera gives 30.
    expect(judgeWindow(win(30, 20))).toBe('slow');
    // A camera that only gives 15 fps (a dark room) is fine when (almost) all of them go out.
    expect(judgeWindow(win(15, 14))).toBe('ok');
    expect(judgeWindow(win(15, 10))).toBe('slow');
    // More than 40 ms of added delay.
    expect(judgeWindow(win(30, 30, 55))).toBe('slow');
    // An empty window says nothing.
    expect(judgeWindow({ ...win(0, 0), durationMs: 0 })).toBe('ok');
  });

  it('steps down after three slow seconds in a row, not counting the warm-up', () => {
    const governor = new BlurGovernor();
    // Two warm-up windows are ignored even when slow.
    expect(governor.record(win(30, 5))).toBe(false);
    expect(governor.record(win(30, 5))).toBe(false);
    expect(governor.record(win(30, 10))).toBe(false);
    expect(governor.record(win(30, 10))).toBe(false);
    // A good second resets the count.
    expect(governor.record(win(30, 30))).toBe(false);
    expect(governor.record(win(30, 10))).toBe(false);
    expect(governor.record(win(30, 10))).toBe(false);
    expect(governor.record(win(30, 10))).toBe(true);
    // After a step-down the new tier warms up first.
    expect(governor.record(win(30, 10))).toBe(false);
    expect(governor.record(win(30, 10))).toBe(false);
    expect(governor.record(win(30, 10))).toBe(false);
  });
});

describe('window meter', () => {
  it('counts the frames the camera delivered, including the ones dropped while busy', () => {
    const meter = new WindowMeter();
    let result: BlurWindow | null = null;
    let t = 1000;
    let ts = 5_000_000;
    // 10 frames at 30 fps, then 10 frames where every other camera frame was dropped.
    for (let i = 0; i < 10; i++) {
      result = meter.frame({ timestampUs: ts, startedMs: t, doneMs: t + 8, costMs: 8 }) ?? result;
      ts += 33_333;
      t += 33.333;
    }
    for (let i = 0; i < 10; i++) {
      result = meter.frame({ timestampUs: ts, startedMs: t, doneMs: t + 8, costMs: 8 }) ?? result;
      ts += 66_667;
      t += 66.667;
    }
    for (let i = 0; i < 3; i++) {
      result = meter.frame({ timestampUs: ts, startedMs: t, doneMs: t + 8, costMs: 8 }) ?? result;
      ts += 66_667;
      t += 66.667;
    }
    expect(result).not.toBeNull();
    expect(result!.outputFrames).toBeLessThan(result!.inputFrames);
    expect(result!.inputFrames - result!.outputFrames).toBeGreaterThanOrEqual(9);
    expect(result!.meanCostMs).toBeCloseTo(8);
  });

  it('adds the time a frame waited in the queue to its delay', () => {
    const meter = new WindowMeter(100);
    let t = 0;
    let ts = 0;
    let last: BlurWindow | null = null;
    // Fresh frames first (read as soon as they exist), then frames that waited 20 ms.
    for (let i = 0; i < 4; i++) {
      last = meter.frame({ timestampUs: ts, startedMs: t, doneMs: t + 5, costMs: 5 }) ?? last;
      ts += 33_333;
      t += 33.333;
    }
    meter.frame({ timestampUs: ts, startedMs: t + 20, doneMs: t + 25, costMs: 5 });
    ts += 33_333;
    t += 33.333;
    const done = meter.frame({ timestampUs: ts, startedMs: t + 20, doneMs: t + 125, costMs: 5 });
    expect(done).not.toBeNull();
    expect(done!.p95LatencyMs).toBeGreaterThanOrEqual(24);
  });

  it('counts frames the page skipped on the canvas path', () => {
    const meter = new WindowMeter(100);
    meter.skipped(3);
    const done = meter.frame({ timestampUs: null, startedMs: 0, doneMs: 150, costMs: 10 });
    expect(done).toMatchObject({ inputFrames: 4, outputFrames: 1 });
  });
});

describe('status line', () => {
  it('says the frame rate, the added delay and a reduced segmentation rate', () => {
    expect(describeBlurStats({ fps: 29.6, inputFps: 30, latencyMs: 12.4, costMs: 11, segmentEvery: 1 })).toBe('30 fps · 12 ms added');
    expect(describeBlurStats({ fps: 24, inputFps: 30, latencyMs: 0.2, costMs: 11, segmentEvery: 2 })).toBe('24 fps · 1 ms added · person found every 2nd frame');
  });
});
