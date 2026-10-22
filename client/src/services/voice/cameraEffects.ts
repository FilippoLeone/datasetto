/**
 * Background blur for a camera track, on the page side. `apply(source, level)` returns the
 * track to send: the camera itself (blur off, or done by the system's own camera effects) or
 * a blurred copy made in a worker (blur.worker.ts). The caller swaps it into the peer
 * connections with replaceTrack, so turning blur on or off never renegotiates the call or
 * restarts the camera.
 *
 * Privacy first: while the model loads, the copy is blurred everywhere (no person known
 * yet), never the sharp room. When the device cannot keep up, the governor steps down
 * (backgroundBlur.ts); after the last step, or when blur fails, the status says so and the
 * `fallback` event asks the caller to send the camera as it is.
 */
import wasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url';
import wasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url';
import landscapeModelUrl from '@/video/segmentation/selfie_segmenter_landscape.tflite?url';
import squareModelUrl from '@/video/segmentation/selfie_segmenter.tflite?url';
import { EventEmitter } from '@/lib/EventEmitter';
import { isCapacitor, isTouchPrimary } from '@/lib/device';
import {
  BlurGovernor,
  WindowMeter,
  chooseBlurPath,
  initialTier,
  platformBlurMode,
  stepDownTier,
  type BlurPath,
  type BlurSupport,
  type BlurTier,
  type BlurWindow,
  type CameraBlurLevel,
  type CameraBlurStatus,
  OFF_STATUS,
} from './backgroundBlur';

export { OFF_STATUS, type CameraBlurStatus };
import type { BlurAssets } from './blurPipeline';
import type { FromBlurWorker, ToBlurWorker } from './blurProtocol';

type Events = { status: CameraBlurStatus; fallback: void; [key: string]: unknown };

// ------------------------------------------------------------------ what this browser offers

interface ProcessorCtor {
  new (init: { track: MediaStreamTrack; maxBufferSize?: number }): { readable: ReadableStream<VideoFrame> };
}
interface GeneratorCtor {
  new (init: { kind: 'video' }): MediaStreamTrack & { writable: WritableStream<VideoFrame> };
}

const globals = globalThis as unknown as { MediaStreamTrackProcessor?: ProcessorCtor; MediaStreamTrackGenerator?: GeneratorCtor };

let offscreenWebgl2: boolean | null = null;
const hasOffscreenWebgl2 = (): boolean => {
  if (offscreenWebgl2 !== null) return offscreenWebgl2;
  try {
    const gl = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1).getContext('webgl2') : null;
    offscreenWebgl2 = Boolean(gl);
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    offscreenWebgl2 = false;
  }
  return offscreenWebgl2;
};

/** Where blur can run in this browser (cached after the first WebGL probe). */
export const cameraBlurSupport = (): BlurSupport =>
  chooseBlurPath({
    worker: typeof Worker === 'function',
    wasm: typeof WebAssembly === 'object',
    offscreenWebgl2: hasOffscreenWebgl2(),
    trackProcessor: typeof globals.MediaStreamTrackProcessor === 'function',
    trackGenerator: typeof globals.MediaStreamTrackGenerator === 'function',
    canvasCapture: typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function',
    imageBitmap: typeof createImageBitmap === 'function',
  });

/** Phones and tablets: blur costs battery there, and starts at half the segmentation rate. */
export const blurIsCostly = (): boolean => isCapacitor() || isTouchPrimary();

const absolute = (url: string): string => new URL(url, globalThis.location?.href).href;

export const blurAssets = (): BlurAssets => ({
  wasmLoaderUrl: absolute(wasmLoaderUrl),
  wasmBinaryUrl: absolute(wasmBinaryUrl),
  landscapeModelUrl: absolute(landscapeModelUrl),
  squareModelUrl: absolute(squareModelUrl),
  delegate: (globalThis.localStorage?.getItem('datasetto.blurDelegate') as 'CPU' | 'GPU' | null) ?? undefined,
});

const START_TIMEOUT_MS = 10_000;

const trackSize = (track: MediaStreamTrack): { width: number; height: number } => {
  const settings = track.getSettings?.() ?? {};
  return { width: settings.width ?? 1280, height: settings.height ?? 720 };
};

// ------------------------------------------------------------------------- one blur session

export interface SessionEvents {
  'model-ready': void;
  stats: { window: BlurWindow; segmentMs: number; composeMs: number };
  error: string;
  [key: string]: unknown;
}

/** What the controller needs of a blur session (a fake one in the tests). */
export interface BlurSessionLike {
  readonly path: Exclude<BlurPath, 'none'>;
  readonly track: MediaStreamTrack;
  use(source: MediaStreamTrack): Promise<void>;
  setTier(tier: BlurTier): void;
  close(): void;
  on<K extends keyof SessionEvents>(event: K, callback: (data: SessionEvents[K]) => void): () => void;
}

/** The parts of the environment the controller depends on; the tests pass their own. */
export interface EffectsEnvironment {
  support: () => BlurSupport;
  /** Phones and tablets (start at half the segmentation rate). */
  costly: () => boolean;
  createSession: (path: Exclude<BlurPath, 'none'>, tier: BlurTier) => BlurSessionLike;
}

/**
 * A worker blurring one camera at a time, and the track it produces. The track stays the
 * same when the camera changes (a flip), so nothing needs replacing in the call then.
 */
class BlurSession extends EventEmitter<SessionEvents> implements BlurSessionLike {
  readonly track: MediaStreamTrack;
  private readonly worker: Worker;
  private started: Promise<void> | null = null;
  private generator: (MediaStreamTrack & { writable: WritableStream<VideoFrame> }) | null = null;
  private pumpStop: (() => void) | null = null;
  private outputCanvas: HTMLCanvasElement | null = null;
  private closed = false;

  constructor(
    readonly path: Exclude<BlurPath, 'none'>,
    private tier: BlurTier,
  ) {
    super();
    this.worker = new Worker(new URL('./blur.worker.ts', import.meta.url), { type: 'module', name: 'background-blur' });
    this.worker.onmessage = (event: MessageEvent<FromBlurWorker>) => this.onMessage(event.data);
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.emit('error', event.message || 'The blur worker could not start');
    };
    if (path === 'insertable') {
      this.generator = new globals.MediaStreamTrackGenerator!({ kind: 'video' });
      this.track = this.generator;
    } else {
      this.outputCanvas = document.createElement('canvas');
      this.outputCanvas.width = 2;
      this.outputCanvas.height = 2;
      this.track = this.outputCanvas.captureStream().getVideoTracks()[0];
    }
    this.track.contentHint = 'motion';
  }

  private post(message: ToBlurWorker, transfer: Transferable[] = []): void {
    if (!this.closed) this.worker.postMessage(message, transfer);
  }

  private startedResolve: (() => void) | null = null;
  private frameHandler: ((message: Extract<FromBlurWorker, { type: 'frame' }>) => void) | null = null;
  private tickHandler: (() => void) | null = null;

  private onMessage(message: FromBlurWorker): void {
    switch (message.type) {
      case 'started':
        this.startedResolve?.();
        this.startedResolve = null;
        break;
      case 'model-ready':
        this.emit('model-ready', undefined);
        break;
      case 'stats':
        this.emit('stats', { window: message.window, segmentMs: message.segmentMs, composeMs: message.composeMs });
        break;
      case 'frame':
        this.frameHandler?.(message);
        break;
      case 'tick':
        this.tickHandler?.();
        break;
      case 'error':
        this.emit('error', message.message);
        break;
    }
  }

  /** Resolves on the worker's `started`, rejects on its first error or after the timeout. */
  private waitForStart(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        off();
        reject(new Error('the blur worker did not start in time'));
      }, START_TIMEOUT_MS);
      const off = this.on('error', (message) => {
        window.clearTimeout(timer);
        off();
        reject(new Error(message));
      });
      this.startedResolve = () => {
        window.clearTimeout(timer);
        off();
        resolve();
      };
    });
  }

  /** Blurs `source` (the first camera, or the next one after a flip). Resolves once frames flow. */
  async use(source: MediaStreamTrack): Promise<void> {
    const { width, height } = trackSize(source);
    if (this.path === 'insertable') {
      const processor = new globals.MediaStreamTrackProcessor!({ track: source, maxBufferSize: 1 });
      if (!this.started) {
        const writable = this.generator!.writable;
        this.started = this.waitForStart();
        this.post({ type: 'start', assets: blurAssets(), tier: this.tier, readable: processor.readable, writable, width, height }, [processor.readable, writable]);
      } else {
        this.post({ type: 'source', readable: processor.readable, width, height }, [processor.readable]);
      }
      return this.started;
    }
    if (!this.started) {
      this.started = this.waitForStart();
      this.post({ type: 'start', assets: blurAssets(), tier: this.tier, width, height });
    }
    await this.started;
    this.pumpCanvas(source);
  }

  /**
   * Canvas path: the page plays the camera in a hidden <video>, sends each new frame to the
   * worker as an ImageBitmap (one at a time; frames that arrive meanwhile are skipped and
   * counted) and draws what comes back into the canvas whose capture stream is the track.
   */
  private pumpCanvas(source: MediaStreamTrack): void {
    this.pumpStop?.();
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([source]);
    void video.play().catch(() => undefined);
    const canvas = this.outputCanvas!;
    const context = canvas.getContext('2d');
    const meter = new WindowMeter();
    let busy = false;
    let stopped = false;
    let nextId = 0;
    let sentAt = 0;
    let skipped = 0;
    let handle: number | null = null;
    type FrameVideo = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number; cancelVideoFrameCallback?: (id: number) => void };
    const frameVideo = video as FrameVideo;

    const grab = () => {
      if (stopped) return;
      if (busy) {
        skipped += 1;
      } else if (video.readyState >= 2 && video.videoWidth > 0) {
        busy = true;
        sentAt = performance.now();
        const id = ++nextId;
        createImageBitmap(video)
          .then((bitmap) => this.post({ type: 'frame', id, bitmap }, [bitmap]))
          .catch(() => {
            busy = false;
          });
      }
      schedule();
    };
    const schedule = () => {
      if (stopped || document.hidden) return;
      if (frameVideo.requestVideoFrameCallback) handle = frameVideo.requestVideoFrameCallback(grab);
      else handle = window.setTimeout(grab, 33);
    };
    // A hidden page gets no frame callbacks; the worker's timer keeps the camera going.
    const onVisibility = () => {
      this.post({ type: 'ticks', intervalMs: document.hidden ? 33 : null });
      if (!document.hidden) schedule();
    };
    this.tickHandler = () => grab();
    this.frameHandler = (message) => {
      busy = false;
      if (stopped || !context) {
        message.bitmap.close();
        return;
      }
      if (canvas.width !== message.bitmap.width || canvas.height !== message.bitmap.height) {
        canvas.width = message.bitmap.width;
        canvas.height = message.bitmap.height;
      }
      context.drawImage(message.bitmap, 0, 0);
      message.bitmap.close();
      meter.skipped(skipped);
      skipped = 0;
      const window = meter.frame({ timestampUs: null, startedMs: sentAt, doneMs: performance.now(), costMs: message.costMs });
      if (window) this.emit('stats', { window, segmentMs: 0, composeMs: 0 });
    };
    document.addEventListener('visibilitychange', onVisibility);
    onVisibility();
    this.pumpStop = () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (handle !== null) {
        if (frameVideo.cancelVideoFrameCallback) frameVideo.cancelVideoFrameCallback(handle);
        window.clearTimeout(handle);
      }
      this.post({ type: 'ticks', intervalMs: null });
      video.pause();
      video.srcObject = null;
    };
  }

  setTier(tier: BlurTier): void {
    this.tier = tier;
    this.post({ type: 'tier', tier });
  }

  close(): void {
    if (this.closed) return;
    this.pumpStop?.();
    this.pumpStop = null;
    this.post({ type: 'stop' });
    this.closed = true;
    // Give the worker a moment to release its GPU context, then make sure it is gone.
    window.setTimeout(() => this.worker.terminate(), 1000);
    this.track.stop();
    this.clear();
  }
}

// ---------------------------------------------------------------------------- the controller

const describeTierChange = (from: BlurTier, to: BlurTier): string | null => {
  if (from.level === 'strong' && to.level === 'light') return 'Strong blur was too slow on this device, so Light is used.';
  return null;
};

const browserEnvironment: EffectsEnvironment = {
  support: cameraBlurSupport,
  costly: blurIsCostly,
  createSession: (path, tier) => new BlurSession(path, tier),
};

export class CameraEffects extends EventEmitter<Events> {
  private readonly env: EffectsEnvironment;
  private session: BlurSessionLike | null = null;
  private source: MediaStreamTrack | null = null;
  private level: CameraBlurLevel = 'off';
  private tier: BlurTier | null = null;
  /** The level the current tier's ladder started from (Strong stays Strong's ladder after a step to Light). */
  private tierLevel: CameraBlurLevel | null = null;
  private governor = new BlurGovernor();
  /** We switched the system's camera blur on (and switch it off again). */
  private platformOn = false;
  /** Blur failed or stepped down to off: send the camera as is until the level or the camera changes. */
  private gaveUp = false;
  private applying: Promise<MediaStreamTrack> = Promise.resolve(null as unknown as MediaStreamTrack);
  status: CameraBlurStatus = OFF_STATUS;

  constructor(env: Partial<EffectsEnvironment> = {}) {
    super();
    this.env = { ...browserEnvironment, ...env };
  }

  private setStatus(patch: Partial<CameraBlurStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  /** The track to send for `source` at `level` (calls are queued, so the last one wins). */
  apply(source: MediaStreamTrack, level: CameraBlurLevel): Promise<MediaStreamTrack> {
    const run = () => this.applyNow(source, level);
    this.applying = this.applying.then(run, run);
    return this.applying;
  }

  private async applyNow(source: MediaStreamTrack, level: CameraBlurLevel): Promise<MediaStreamTrack> {
    if (level !== this.level) this.gaveUp = false;
    const newSource = source !== this.source;
    this.level = level;
    this.source = source;

    if (level === 'off') {
      this.closeSession();
      this.tier = null;
      this.tierLevel = null;
      await this.platformBlur(source, false);
      const forced = platformBlurMode(source.getCapabilities?.() as { backgroundBlur?: unknown }) === 'forced-on';
      this.status = { ...OFF_STATUS, notice: forced ? 'Your system’s camera effects blur the background; turn them off in the system settings.' : null };
      this.emit('status', this.status);
      return source;
    }
    if (this.gaveUp) return source;

    const platform = platformBlurMode(source.getCapabilities?.() as { backgroundBlur?: unknown });
    if (platform === 'forced-on' || (platform === 'controllable' && (await this.platformBlur(source, true)))) {
      this.closeSession();
      this.status = {
        ...OFF_STATUS,
        level,
        state: 'running',
        engine: 'system',
        notice: platform === 'forced-on' ? 'Your system’s camera effects already blur the background.' : 'Your system’s camera effects blur the background (one strength for Light and Strong).',
      };
      this.emit('status', this.status);
      return source;
    }

    const support = this.env.support();
    if (support.path === 'none') {
      this.closeSession();
      this.status = { ...OFF_STATUS, level, state: 'failed', notice: support.reason };
      this.emit('status', this.status);
      return source;
    }

    // A new pick, or a camera turned on again, starts at the top of the ladder; a flip keeps
    // what the governor stepped down to.
    if (!this.tier || this.tierLevel !== level) {
      this.tier = initialTier(level, this.env.costly());
      this.tierLevel = level;
    }
    const tier = this.tier;
    try {
      if (!this.session || this.session.path !== support.path) {
        this.closeSession();
        this.session = this.createSession(support.path, tier);
        this.setStatus({ level, state: 'starting', engine: 'device', tier, modelReady: false, stats: null, notice: null });
        this.governor.restart();
        await this.session.use(source);
        this.setStatus({ state: 'running' });
      } else {
        this.session.setTier(tier);
        this.setStatus({ level, engine: 'device', tier });
        if (newSource) {
          this.governor.restart();
          await this.session.use(source);
        }
      }
      return this.session.track;
    } catch (error) {
      this.closeSession();
      this.gaveUp = true;
      this.status = { ...OFF_STATUS, level, state: 'failed', notice: 'Background blur could not start: ' + (error instanceof Error ? error.message : String(error)) + '.' };
      this.emit('status', this.status);
      return source;
    }
  }

  private createSession(path: Exclude<BlurPath, 'none'>, tier: BlurTier): BlurSessionLike {
    const session = this.env.createSession(path, tier);
    session.on('model-ready', () => {
      if (this.session === session) this.setStatus({ modelReady: true });
    });
    session.on('stats', ({ window, segmentMs, composeMs }) => {
      if (this.session !== session || !this.tier) return;
      const seconds = window.durationMs / 1000;
      this.setStatus({
        stats: {
          fps: window.outputFrames / seconds,
          inputFps: window.inputFrames / seconds,
          latencyMs: window.p95LatencyMs,
          costMs: window.meanCostMs,
          segmentEvery: this.tier.segmentEvery,
          segmentMs,
          composeMs,
        },
      });
      // Only a loaded model counts: before that the worker does far less per frame.
      if (!this.status.modelReady || !this.governor.record(window)) return;
      const next = stepDownTier(this.tier);
      if (next) {
        const notice = describeTierChange(this.tier, next) ?? this.status.notice;
        this.tier = next;
        session.setTier(next);
        this.setStatus({ tier: next, notice });
      } else {
        this.giveUp('Background blur turned off: this device could not keep up.');
      }
    });
    session.on('error', (message) => {
      if (this.session === session) this.giveUp('Background blur stopped: ' + message + '.');
    });
    return session;
  }

  /** Stops the blur and asks the caller to send the camera as it is. */
  private giveUp(notice: string): void {
    this.closeSession();
    this.gaveUp = true;
    this.status = { ...OFF_STATUS, level: this.level, state: 'failed', notice };
    this.emit('status', this.status);
    this.emit('fallback', undefined);
  }

  /** Switches the system's camera blur; false when it refused. */
  private async platformBlur(source: MediaStreamTrack, on: boolean): Promise<boolean> {
    if (!on && !this.platformOn) return true;
    try {
      const constraints = { ...source.getConstraints(), backgroundBlur: on } as MediaTrackConstraints;
      await source.applyConstraints(constraints);
      this.platformOn = on;
      return true;
    } catch {
      return false;
    }
  }

  private closeSession(): void {
    this.session?.close();
    this.session = null;
  }

  /** The camera went off: stop everything; the next camera starts from the top of the ladder. */
  stop(): void {
    this.closeSession();
    this.source = null;
    this.tier = null;
    this.tierLevel = null;
    this.gaveUp = false;
    this.platformOn = false;
    this.governor.restart();
    this.status = { ...OFF_STATUS, level: this.level };
    this.emit('status', this.status);
  }
}
