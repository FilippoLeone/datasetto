/**
 * The on-device background blur for one camera: MediaPipe's selfie segmenter finds the
 * person (every Nth frame, see BlurTier) and BlurCompositor draws the frame with the rest
 * blurred. Lives in blur.worker.ts; nothing here touches the page.
 *
 * The segmenter runs on the CPU (XNNPACK in WebAssembly) at its own small input size
 * (256x144 for 16:9 cameras, 256x256 otherwise); MediaPipe scales the frame down itself.
 * The compositor runs on the GPU at the camera's size.
 */
import { ImageSegmenter } from '@mediapipe/tasks-vision';
import { BLUR_LOOK, chooseSegmenterModel, type BlurTier } from './backgroundBlur';
import { BlurCompositor, type CompositorView } from './blurCompositor';

export interface BlurAssets {
  wasmLoaderUrl: string;
  wasmBinaryUrl: string;
  landscapeModelUrl: string;
  squareModelUrl: string;
  /** Where the segmenter runs: XNNPACK on the CPU, or WebGL on the GPU. */
  delegate?: 'CPU' | 'GPU';
}

type ModelKey = 'landscape' | 'square';

export interface FrameResult {
  segmented: boolean;
  /** Time spent in the segmenter, when it ran. */
  segmentMs: number;
  /** Time spent compositing. */
  composeMs: number;
}

const fetchModel = async (url: string): Promise<Uint8Array> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Could not download the segmentation model (' + response.status + ')');
  return new Uint8Array(await response.arrayBuffer());
};

export class BlurPipeline {
  private readonly segmenters = new Map<ModelKey, Promise<ImageSegmenter>>();
  private segmenter: ImageSegmenter | null = null;
  private wanted: ModelKey | null = null;
  private frameIndex = 0;
  private lastTimestamp = 0;
  private failure: Error | null = null;
  private readonly compositor: BlurCompositor;
  /** Called once the first segmenter is loaded, or with the error when it cannot load. */
  onModelState: ((state: { ready: true } | { ready: false; error: Error }) => void) | null = null;

  constructor(
    readonly canvas: OffscreenCanvas,
    private readonly assets: BlurAssets,
    public tier: BlurTier,
  ) {
    this.compositor = new BlurCompositor(canvas);
  }

  set view(view: CompositorView) {
    this.compositor.view = view;
  }

  get contextLost(): boolean {
    return this.compositor.lost;
  }

  get modelError(): Error | null {
    return this.failure;
  }

  private load(key: ModelKey): Promise<ImageSegmenter> {
    let pending = this.segmenters.get(key);
    if (!pending) {
      pending = (async () => {
        const model = await fetchModel(key === 'landscape' ? this.assets.landscapeModelUrl : this.assets.squareModelUrl);
        return ImageSegmenter.createFromOptions(
          { wasmLoaderPath: this.assets.wasmLoaderUrl, wasmBinaryPath: this.assets.wasmBinaryUrl },
          { baseOptions: { modelAssetBuffer: model, delegate: this.assets.delegate ?? 'CPU' }, runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false },
        );
      })();
      this.segmenters.set(key, pending);
      pending.then(
        (segmenter) => {
          // Switch when this is still the model the camera's shape asks for.
          if (this.wanted !== key) return;
          const first = this.segmenter === null;
          this.segmenter = segmenter;
          if (first) this.onModelState?.({ ready: true });
        },
        (error: unknown) => {
          this.segmenters.delete(key);
          this.failure = error instanceof Error ? error : new Error(String(error));
          this.onModelState?.({ ready: false, error: this.failure });
        },
      );
    }
    return pending;
  }

  /** Loads the model for a camera of this shape ahead of the first frame. */
  prepare(width: number, height: number): Promise<ImageSegmenter> {
    const key = chooseSegmenterModel(width, height);
    this.wanted = key;
    return this.load(key);
  }

  /** A new camera: forget the old person mask, so nothing of the new room shows sharp by mistake. */
  resetMask(): void {
    this.compositor.resetMask();
    this.frameIndex = 0;
  }

  /** Blurs one frame into the canvas. */
  process(frame: VideoFrame | ImageBitmap, width: number, height: number): FrameResult {
    const key = chooseSegmenterModel(width, height);
    if (this.wanted !== key) void this.prepare(width, height).catch(() => undefined);
    let segmented = false;
    let segmentMs = 0;
    // Until a newly wanted model (another camera shape) has loaded, the old one keeps going.
    const segmenter = this.segmenter;
    if (segmenter && this.frameIndex % this.tier.segmentEvery === 0) {
      const started = performance.now();
      let timestamp = Math.round(started);
      if (timestamp <= this.lastTimestamp) timestamp = this.lastTimestamp + 1;
      this.lastTimestamp = timestamp;
      segmenter.segmentForVideo(frame, timestamp, (result) => {
        const mask = result.confidenceMasks?.[result.confidenceMasks.length - 1];
        if (mask) this.compositor.updateMask(mask.getAsFloat32Array(), mask.width, mask.height);
      });
      segmented = true;
      segmentMs = performance.now() - started;
    }
    this.frameIndex += 1;
    const composeStarted = performance.now();
    this.compositor.render(frame, width, height, BLUR_LOOK[this.tier.level]);
    return { segmented, segmentMs, composeMs: performance.now() - composeStarted };
  }

  dispose(): void {
    for (const pending of this.segmenters.values()) void pending.then((segmenter) => segmenter.close()).catch(() => undefined);
    this.segmenters.clear();
    this.segmenter = null;
    this.compositor.dispose();
  }
}
