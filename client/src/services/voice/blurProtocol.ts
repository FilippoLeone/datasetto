/** Messages between cameraEffects.ts (the page) and blur.worker.ts. */
import type { BlurTier, BlurWindow } from './backgroundBlur';
import type { BlurAssets } from './blurPipeline';

export type ToBlurWorker =
  /** Insertable path: camera frames come in on `readable`, blurred frames go out on `writable`. */
  | { type: 'start'; assets: BlurAssets; tier: BlurTier; readable?: ReadableStream<VideoFrame>; writable?: WritableStream<VideoFrame>; width: number; height: number }
  /** Another camera (a flip), or the same camera after a restart: the output track stays. */
  | { type: 'source'; readable: ReadableStream<VideoFrame>; width: number; height: number }
  | { type: 'tier'; tier: BlurTier }
  /** Canvas path: one camera frame to blur; it comes back as a `frame` message with the same id. */
  | { type: 'frame'; id: number; bitmap: ImageBitmap }
  /** Canvas path while the page is hidden (its frame callbacks stop): send a `tick` this often. */
  | { type: 'ticks'; intervalMs: number | null }
  /** Tuning aid: show the person mask instead of the result. */
  | { type: 'view'; view: 'result' | 'mask' }
  | { type: 'stop' };

export type FromBlurWorker =
  /** The compositor runs (frames flow, fully blurred until the model is ready). */
  | { type: 'started' }
  /** The segmentation model is loaded and finding the person. */
  | { type: 'model-ready' }
  | { type: 'stats'; window: BlurWindow; segmentMs: number; composeMs: number }
  | { type: 'frame'; id: number; bitmap: ImageBitmap; costMs: number }
  | { type: 'tick' }
  /** Blur cannot run (no WebGL 2, the model would not load, the GPU context was lost). */
  | { type: 'error'; message: string };
