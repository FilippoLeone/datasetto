/**
 * The neural noise suppressor behind the "Strong" level: loads DeepFilterNet3 or RNNoise into an
 * AudioWorklet, keeps one node per AudioContext so the microphone never restarts when the
 * strength changes, watches the worklet's load reports and steps down when the machine cannot
 * keep up. Nothing here touches playback; see neuralEngine.ts for the decisions and
 * audio/worklets/parts/ for the processors.
 */
import { EventEmitter } from '@/lib/EventEmitter';
import { isCapacitor, isTouchPrimary } from '@/lib/device';
import { chooseInitialEngine, clampStrength, OverloadMonitor, stepDown, type EngineBenchmark, type NeuralEngine, type SuppressionTier } from './neuralEngine';

const DEEPFILTER_WORKLET_URL = new URL('../../audio/worklets/deepfilter-processor.js', import.meta.url);
const RNNOISE_WORKLET_URL = new URL('../../audio/worklets/rnnoise-processor.js', import.meta.url);
const DEEPFILTER_WASM_URL = new URL('../../audio/neural/deepfilternet3.wasm', import.meta.url);
const DEEPFILTER_MODEL_URL = new URL('../../audio/neural/deepfilternet3.model', import.meta.url);
const RNNOISE_WASM_URL = new URL('../../audio/neural/rnnoise.wasm', import.meta.url);

/** Both models run at 48 kHz on 480-sample frames. */
export const NEURAL_SAMPLE_RATE = 48000;
const READY_TIMEOUT_MS = 30_000;

/**
 * Speech gate after the model (see ActivityGate in audio/worklets/parts/common.js). Tuned on the
 * harness: opens on one frame of speech the model kept, holds 200 ms, 20 ms of lookahead so word
 * attacks are not cut, and takes the pauses down to -30 dB.
 */
export const GATE_OPTIONS = { openThreshold: 0.6, closeThreshold: 0.35, openFrames: 1, holdFrames: 20, lookaheadFrames: 2, releaseFrames: 5, closedGain: 0.03, keptWithinDb: 15 } as const;
/** DeepFilterNet3's local SNR estimate (dB) mapped to a speech probability through a logistic curve. */
const LSNR_MID_DB = 8;
const LSNR_SLOPE_DB = 4;
/** Run both model stages on every frame; libDF's own thresholds lose speech energy (see audio/neural/libdf/README.md). */
const DEEPFILTER_THRESHOLDS = [-1e9, 1e9, 1e9] as const;

export interface NeuralStatus {
  /** What the chain runs now; `standard` after the last step-down. */
  tier: SuppressionTier;
  state: 'idle' | 'loading' | 'ready' | 'failed';
  /** Why the engine changed or failed, in plain words, for the settings dialog. */
  notice: string | null;
  /** Last reported share of real time the model uses (0..1). */
  load: number | null;
}

interface WorkletReady {
  frameSamples: number;
  lookaheadFrames: number;
  gateFrames: number;
}

const assetCache = new Map<string, Promise<ArrayBuffer>>();
const moduleCache = new Map<string, Promise<WebAssembly.Module>>();

const fetchBytes = (url: URL): Promise<ArrayBuffer> => {
  const key = url.href;
  let pending = assetCache.get(key);
  if (!pending) {
    pending = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`Could not download ${url.pathname.split('/').pop()} (${response.status})`);
        return response.arrayBuffer();
      })
      .catch((error) => {
        assetCache.delete(key);
        throw error;
      });
    assetCache.set(key, pending);
  }
  return pending;
};

/** Compiles once per page; a compiled module can be handed to any number of worklets and workers. */
const compileModule = (url: URL): Promise<WebAssembly.Module> => {
  const key = url.href;
  let pending = moduleCache.get(key);
  if (!pending) {
    pending = fetchBytes(url)
      .then((bytes) => WebAssembly.compile(bytes))
      .catch((error) => {
        moduleCache.delete(key);
        throw error;
      });
    moduleCache.set(key, pending);
  }
  return pending;
};

export const supportsNeuralSuppression = (): boolean =>
  typeof AudioWorkletNode === 'function' && typeof WebAssembly === 'object' && typeof WebAssembly.compile === 'function';

/** Phones and tablets start on the lighter engine. */
export const isPhoneLike = (): boolean => isCapacitor() || isTouchPrimary();

/** Downloads and compiles the assets of an engine ahead of time (when the user picks Strong). */
export const preloadEngine = async (engine: NeuralEngine): Promise<void> => {
  if (engine === 'deepfilternet3') await Promise.all([compileModule(DEEPFILTER_WASM_URL), fetchBytes(DEEPFILTER_MODEL_URL)]);
  else await compileModule(RNNOISE_WASM_URL);
};

let benchmarkPromise: Promise<EngineBenchmark | null> | null = null;

/**
 * Measures DeepFilterNet3's cost per frame in a worker (never on the audio thread), once per page.
 * Phones use it to decide whether they can afford the better model.
 */
export const benchmarkDeepFilter = (): Promise<EngineBenchmark | null> => {
  if (!benchmarkPromise) {
    benchmarkPromise = (async () => {
      const [wasmModule, modelBytes] = await Promise.all([compileModule(DEEPFILTER_WASM_URL), fetchBytes(DEEPFILTER_MODEL_URL)]);
      const worker = new Worker(new URL('./neuralBench.worker.ts', import.meta.url), { type: 'module' });
      try {
        return await new Promise<EngineBenchmark | null>((resolve) => {
          const timer = window.setTimeout(() => resolve(null), 20_000);
          worker.onmessage = (event: MessageEvent<EngineBenchmark | { error: string }>) => {
            window.clearTimeout(timer);
            resolve('error' in event.data ? null : event.data);
          };
          worker.onerror = () => {
            window.clearTimeout(timer);
            resolve(null);
          };
          worker.postMessage({ wasmModule, modelBytes, frames: 200 });
        });
      } finally {
        worker.terminate();
      }
    })().catch(() => null);
  }
  return benchmarkPromise;
};

/**
 * One neural suppressor per AudioService. `attach(ctx)` returns the worklet node to put between
 * the microphone source and the rest of the chain; it is created once per AudioContext and kept
 * (its WebAssembly memory is only freed when the context closes). Emits `status` (NeuralStatus)
 * and `stepdown` (the new tier) when the engine changes.
 */
export class NeuralSuppressor extends EventEmitter {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private nodeEngine: NeuralEngine | null = null;
  private tier: SuppressionTier;
  private monitor = new OverloadMonitor();
  private strengthDb = clampStrength(undefined);
  private enabled = true;
  private attaching: Promise<AudioWorkletNode | null> | null = null;
  private readonly modulesLoaded = new WeakMap<AudioContext, Set<NeuralEngine>>();
  status: NeuralStatus;

  constructor() {
    super();
    this.tier = chooseInitialEngine({ phone: isPhoneLike(), simd: true });
    this.status = { tier: this.tier, state: 'idle', notice: null, load: null };
  }

  /** Current tier: a neural engine, or `standard` once the chain fell back to the browser's suppression. */
  get currentTier(): SuppressionTier {
    return this.tier;
  }

  setStrength(db: number): void {
    this.strengthDb = clampStrength(db);
    this.node?.port.postMessage({ type: 'configure', attenLimDb: this.strengthDb });
  }

  /** Bypasses the model inside the worklet (audio passes through) without touching the graph. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.node?.port.postMessage({ type: 'configure', enabled });
  }

  /**
   * Makes sure a node for the current tier exists in `ctx` and returns it, or null when the tier
   * is `standard`. On a load failure the next tier is tried before giving up.
   */
  attach(ctx: AudioContext): Promise<AudioWorkletNode | null> {
    if (this.attaching) return this.attaching;
    this.attaching = this.attachInner(ctx).finally(() => {
      this.attaching = null;
    });
    return this.attaching;
  }

  private async attachInner(ctx: AudioContext): Promise<AudioWorkletNode | null> {
    if (this.ctx !== ctx) {
      this.releaseNode();
      this.ctx = ctx;
    }
    if (ctx.sampleRate !== NEURAL_SAMPLE_RATE) {
      this.fallBackToStandard(`The audio device runs at ${ctx.sampleRate} Hz; the neural suppressor needs 48 kHz.`);
      return null;
    }
    // A phone that measured headroom for DeepFilterNet3 moves up before the node is created.
    if (this.tier === 'rnnoise' && isPhoneLike() && !this.node) {
      this.update({ state: 'loading', notice: null });
      const benchmark = await benchmarkDeepFilter();
      const better = chooseInitialEngine({ phone: true, simd: true, benchmark });
      if (better === 'deepfilternet3') this.tier = 'deepfilternet3';
      else if (benchmark) {
        this.update({ notice: `DeepFilterNet3 needs ${benchmark.meanMs.toFixed(1)} ms per 10 ms frame on this device (${benchmark.p95Ms.toFixed(1)} ms at the 95th percentile); RNNoise is used instead.` });
      } else {
        this.update({ notice: 'DeepFilterNet3 could not be measured on this device; RNNoise is used instead.' });
      }
    }
    while (this.tier !== 'standard') {
      const engine = this.tier;
      if (this.node && this.nodeEngine === engine) return this.node;
      this.releaseNode();
      // The notice (why a phone stays on RNNoise, or an earlier step-down) stays until the tier is reset.
      this.update({ state: 'loading' });
      try {
        this.node = await this.createNode(ctx, engine);
        this.nodeEngine = engine;
        this.monitor.reset();
        this.update({ state: 'ready' });
        return this.node;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (import.meta.env.DEV) console.warn(`[neural] ${engine} unavailable:`, error);
        this.tier = stepDown(engine);
        this.update({ tier: this.tier, state: this.tier === 'standard' ? 'failed' : 'loading', notice: `${label(engine)} could not start (${message}); using ${label(this.tier)}.` });
        this.emit('stepdown', this.tier);
      }
    }
    return null;
  }

  private async createNode(ctx: AudioContext, engine: NeuralEngine): Promise<AudioWorkletNode> {
    const loaded = this.modulesLoaded.get(ctx) ?? new Set<NeuralEngine>();
    this.modulesLoaded.set(ctx, loaded);
    const workletUrl = engine === 'deepfilternet3' ? DEEPFILTER_WORKLET_URL : RNNOISE_WORKLET_URL;
    const [wasmModule, modelBytes] = await Promise.all([
      compileModule(engine === 'deepfilternet3' ? DEEPFILTER_WASM_URL : RNNOISE_WASM_URL),
      engine === 'deepfilternet3' ? fetchBytes(DEEPFILTER_MODEL_URL) : Promise.resolve(null),
      loaded.has(engine) ? Promise.resolve() : ctx.audioWorklet.addModule(workletUrl).then(() => loaded.add(engine)),
    ]);
    const processorOptions = {
      wasmModule,
      modelBytes,
      attenLimDb: this.strengthDb,
      thresholds: DEEPFILTER_THRESHOLDS,
      gate: GATE_OPTIONS,
      lsnrMidDb: LSNR_MID_DB,
      lsnrSlopeDb: LSNR_SLOPE_DB,
      enabled: this.enabled,
      bypassUntilReady: true,
      report: false,
    };
    const node = new AudioWorkletNode(ctx, engine === 'deepfilternet3' ? 'deepfilter-processor' : 'rnnoise-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      outputChannelCount: [1],
      processorOptions,
    });
    await this.waitForReady(node, engine);
    return node;
  }

  private waitForReady(node: AudioWorkletNode, engine: NeuralEngine): Promise<WorkletReady> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error('the worklet did not start in time'));
      }, READY_TIMEOUT_MS);
      const onMessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; message?: string } & Partial<WorkletReady> & { load?: number; maxFrameMs?: number };
        if (data.type === 'ready') {
          cleanup();
          node.port.onmessage = (later) => this.onNodeMessage(engine, later.data as { type?: string; load?: number; message?: string });
          resolve({ frameSamples: data.frameSamples ?? 480, lookaheadFrames: data.lookaheadFrames ?? 0, gateFrames: data.gateFrames ?? 0 });
        } else if (data.type === 'error') {
          cleanup();
          reject(new Error(data.message || 'the worklet failed'));
        }
      };
      const onProcessorError = () => {
        cleanup();
        reject(new Error('the worklet crashed'));
      };
      const cleanup = () => {
        window.clearTimeout(timer);
        node.port.removeEventListener('message', onMessage);
        node.removeEventListener('processorerror', onProcessorError);
      };
      node.port.addEventListener('message', onMessage);
      node.port.start();
      node.addEventListener('processorerror', onProcessorError);
    });
  }

  private onNodeMessage(engine: NeuralEngine, data: { type?: string; load?: number; message?: string }): void {
    if (data.type === 'load' && typeof data.load === 'number') {
      this.update({ load: data.load });
      if (this.monitor.record(data.load)) this.overloaded(engine, data.load);
      return;
    }
    if (data.type === 'error') {
      this.overloaded(engine, null, data.message || 'the worklet failed');
    }
  }

  /** The machine cannot keep up (or the worklet died): move to the next tier and tell the owner to rebuild the chain. */
  private overloaded(engine: NeuralEngine, load: number | null, failure?: string): void {
    if (this.nodeEngine !== engine) return;
    this.tier = stepDown(engine);
    const why = failure ? `${label(engine)} stopped (${failure})` : `${label(engine)} used ${Math.round((load ?? 0) * 100)}% of the audio thread`;
    this.update({ tier: this.tier, state: this.tier === 'standard' ? 'failed' : 'loading', notice: `${why}; switched to ${label(this.tier)}.` });
    this.emit('stepdown', this.tier);
  }

  private fallBackToStandard(reason: string): void {
    this.releaseNode();
    this.tier = 'standard';
    this.update({ tier: 'standard', state: 'failed', notice: `${reason} Using the browser’s suppression.` });
    this.emit('stepdown', this.tier);
  }

  /** Forget a step-down (the user re-selected Strong): start again from the device's first choice. */
  resetTier(): void {
    this.releaseNode();
    this.tier = chooseInitialEngine({ phone: isPhoneLike(), simd: true });
    this.monitor.reset();
    this.update({ tier: this.tier, state: 'idle', notice: null, load: null });
  }

  /** Detaches the node from the graph; the node itself stays for the next stream on the same context. */
  disconnect(): void {
    try {
      this.node?.disconnect();
    } catch {
      /* not connected */
    }
  }

  private releaseNode(): void {
    if (!this.node) return;
    try {
      this.node.port.postMessage({ type: 'dispose' });
      this.node.disconnect();
    } catch {
      /* already gone */
    }
    this.node = null;
    this.nodeEngine = null;
  }

  dispose(): void {
    this.releaseNode();
    this.ctx = null;
    this.update({ state: 'idle', load: null });
  }

  private update(patch: Partial<NeuralStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }
}

const label = (tier: SuppressionTier): string => (tier === 'deepfilternet3' ? 'DeepFilterNet3' : tier === 'rnnoise' ? 'RNNoise' : 'the browser’s suppression');
