/**
 * The background blur worker: reads camera frames, blurs their background (blurPipeline.ts)
 * and hands them back, off the page's main thread. Insertable path: frames arrive on a
 * ReadableStream from a MediaStreamTrackProcessor and leave on the WritableStream of a
 * MediaStreamTrackGenerator. Canvas path: frames arrive as ImageBitmaps and go back as
 * ImageBitmaps.
 */
import { WindowMeter, type BlurTier } from './backgroundBlur';
import { BlurPipeline, type BlurAssets } from './blurPipeline';
import type { FromBlurWorker, ToBlurWorker } from './blurProtocol';

interface WorkerScope {
  postMessage(message: FromBlurWorker, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToBlurWorker>) => void) | null;
  close(): void;
}

const scope = self as unknown as WorkerScope;

let pipeline: BlurPipeline | null = null;
let writer: WritableStreamDefaultWriter<VideoFrame> | null = null;
let readToken = 0;
let ticker: ReturnType<typeof setInterval> | null = null;
const meter = new WindowMeter();
let segmentTotal = 0;
let segmentCount = 0;
let composeTotal = 0;
let composeCount = 0;

const post = (message: FromBlurWorker, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

const fail = (error: unknown) => {
  post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
};

const ensurePipeline = (assets: BlurAssets, tier: BlurTier, width: number, height: number): BlurPipeline => {
  if (pipeline) {
    pipeline.tier = tier;
    return pipeline;
  }
  const created = new BlurPipeline(new OffscreenCanvas(Math.max(2, width), Math.max(2, height)), assets, tier);
  created.onModelState = (state) => {
    if (state.ready) post({ type: 'model-ready' });
    else fail(state.error);
  };
  pipeline = created;
  void created.prepare(width, height).catch(() => undefined);
  return created;
};

const record = (timestampUs: number | null, startedMs: number, segmentMs: number, composeMs: number) => {
  if (segmentMs > 0) {
    segmentTotal += segmentMs;
    segmentCount += 1;
  }
  composeTotal += composeMs;
  composeCount += 1;
  const window = meter.frame({ timestampUs, startedMs, doneMs: performance.now(), costMs: segmentMs + composeMs });
  if (window) {
    post({ type: 'stats', window, segmentMs: segmentCount ? segmentTotal / segmentCount : 0, composeMs: composeCount ? composeTotal / composeCount : 0 });
    segmentTotal = segmentCount = composeTotal = composeCount = 0;
  }
};

/** Reads one camera's frames until the stream ends or another camera takes over. */
const pump = async (readable: ReadableStream<VideoFrame>) => {
  const token = ++readToken;
  const reader = readable.getReader();
  meter.resetSource();
  pipeline?.resetMask();
  try {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      if (token !== readToken || !pipeline || !writer) {
        frame.close();
        break;
      }
      const startedMs = performance.now();
      let out: VideoFrame | null = null;
      let result = { segmented: false, segmentMs: 0, composeMs: 0 };
      try {
        result = pipeline.process(frame, frame.displayWidth, frame.displayHeight);
        out = new VideoFrame(pipeline.canvas, { timestamp: frame.timestamp, ...(frame.duration ? { duration: frame.duration } : {}) });
      } catch (error) {
        frame.close();
        fail(error);
        break;
      }
      const timestamp = frame.timestamp;
      frame.close();
      if (pipeline.contextLost) {
        out.close();
        fail(new Error('The graphics context was lost'));
        break;
      }
      await writer.write(out);
      record(timestamp, startedMs, result.segmentMs, result.composeMs);
    }
  } catch (error) {
    if (token === readToken) fail(error);
  } finally {
    reader.cancel().catch(() => undefined);
  }
};

const stop = () => {
  readToken += 1;
  if (ticker !== null) clearInterval(ticker);
  ticker = null;
  writer?.close().catch(() => undefined);
  writer = null;
  pipeline?.dispose();
  pipeline = null;
};

scope.onmessage = (event: MessageEvent<ToBlurWorker>) => {
  const message = event.data;
  try {
    switch (message.type) {
      case 'start': {
        ensurePipeline(message.assets, message.tier, message.width, message.height);
        if (message.writable) {
          writer?.close().catch(() => undefined);
          writer = message.writable.getWriter();
        }
        if (message.readable) void pump(message.readable);
        post({ type: 'started' });
        break;
      }
      case 'source':
        void pipeline?.prepare(message.width, message.height).catch(() => undefined);
        void pump(message.readable);
        break;
      case 'tier':
        if (pipeline) pipeline.tier = message.tier;
        break;
      case 'frame': {
        const bitmap = message.bitmap;
        if (!pipeline) {
          bitmap.close();
          break;
        }
        const result = pipeline.process(bitmap, bitmap.width, bitmap.height);
        bitmap.close();
        const out = pipeline.canvas.transferToImageBitmap();
        const costMs = result.segmentMs + result.composeMs;
        post({ type: 'frame', id: message.id, bitmap: out, costMs }, [out]);
        if (pipeline.contextLost) fail(new Error('The graphics context was lost'));
        break;
      }
      case 'ticks':
        if (ticker !== null) clearInterval(ticker);
        ticker = message.intervalMs ? setInterval(() => post({ type: 'tick' }), message.intervalMs) : null;
        break;
      case 'view':
        if (pipeline) pipeline.view = message.view;
        break;
      case 'stop':
        stop();
        scope.close();
        break;
    }
  } catch (error) {
    fail(error);
  }
};
