import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CameraBlurLevel } from './backgroundBlur';

/** The blur controller as the service sees it: the camera itself when off, a blurred copy otherwise. */
const blurred = { kind: 'video', id: 'blurred', readyState: 'live', stop: vi.fn(), contentHint: '' } as unknown as MediaStreamTrack;
const effects = vi.hoisted(() => ({ instances: [] as Array<{ apply: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; emit: (event: string) => void }>, giveUp: false }));

vi.mock('./cameraEffects', async () => {
  const { EventEmitter } = await import('@/lib/EventEmitter');
  class FakeEffects extends EventEmitter<Record<string, unknown>> {
    status = { level: 'off', state: 'off', engine: null, tier: null, modelReady: false, stats: null, notice: null };
    apply = vi.fn(async (source: MediaStreamTrack, level: CameraBlurLevel) => (level === 'off' || effects.giveUp ? source : blurred));
    stop = vi.fn();
    constructor() {
      super();
      effects.instances.push(this as never);
    }
  }
  return { CameraEffects: FakeEffects };
});

const { VoiceService } = await import('./VoiceService');

class FakeStream {
  private tracks: MediaStreamTrack[];
  readonly id = 'stream-' + Math.random().toString(36).slice(2);
  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks = [...tracks];
  }
  getTracks() {
    return [...this.tracks];
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === 'video');
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio');
  }
  addTrack(track: MediaStreamTrack) {
    this.tracks.push(track);
  }
  removeTrack(track: MediaStreamTrack) {
    this.tracks = this.tracks.filter((t) => t !== track);
  }
}

const cameraTrack = () =>
  ({
    kind: 'video',
    id: 'camera',
    readyState: 'live',
    contentHint: '',
    stop: vi.fn(),
    addEventListener: vi.fn(),
    getSettings: () => ({ deviceId: 'cam-1', width: 1280, height: 720 }),
  }) as unknown as MediaStreamTrack;

describe('VoiceService camera blur', () => {
  let camera: MediaStreamTrack;

  beforeEach(() => {
    effects.instances.length = 0;
    effects.giveUp = false;
    camera = cameraTrack();
    vi.stubGlobal('MediaStream', FakeStream);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => new FakeStream([camera])), enumerateDevices: vi.fn(async () => []) },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const withPeer = (service: InstanceType<typeof VoiceService>) => {
    const sender = { replaceTrack: vi.fn(async () => undefined) };
    const pc = { addTrack: vi.fn(() => sender), removeTrack: vi.fn(), close: vi.fn(), getSenders: () => [] };
    const internals = service as unknown as { peers: Map<string, unknown>; createAndSendOffer: (...args: unknown[]) => Promise<void> };
    internals.peers.set('peer-1', pc);
    const offers = vi.fn(async () => undefined);
    internals.createAndSendOffer = offers;
    return { sender, pc, offers };
  };

  it('sends the blurred copy from the first frame and switches with replaceTrack only', async () => {
    const service = new VoiceService();
    await service.setCameraBlur('strong');
    const { sender, pc, offers } = withPeer(service);
    const previews: MediaStream[] = [];
    service.on('video:camera:track', ({ stream }) => previews.push(stream as MediaStream));

    const stream = await service.startCamera();
    expect(stream.getVideoTracks()).toEqual([blurred]);
    expect(pc.addTrack).toHaveBeenCalledWith(blurred, stream);
    expect(offers).toHaveBeenCalledTimes(1);
    expect(service.getCameraDeviceId()).toBe('cam-1');

    await service.setCameraBlur('off');
    expect(sender.replaceTrack).toHaveBeenLastCalledWith(camera);
    expect(stream.getVideoTracks()).toEqual([camera]);
    expect(previews.at(-1)?.getVideoTracks()).toEqual([camera]);

    await service.setCameraBlur('light');
    expect(sender.replaceTrack).toHaveBeenLastCalledWith(blurred);
    // Nothing was renegotiated after the camera started.
    expect(offers).toHaveBeenCalledTimes(1);
    expect(pc.addTrack).toHaveBeenCalledTimes(1);

    service.stopCamera();
    expect(effects.instances[0].stop).toHaveBeenCalled();
    expect(camera.stop).toHaveBeenCalled();
    service.dispose();
  });

  it('sends the camera as it is when the blur gives up', async () => {
    const service = new VoiceService();
    await service.setCameraBlur('strong');
    const { sender } = withPeer(service);
    await service.startCamera();
    effects.giveUp = true;
    effects.instances[0].emit('fallback');
    await vi.waitFor(() => expect(sender.replaceTrack).toHaveBeenLastCalledWith(camera));
    service.dispose();
  });

  it('opens the camera once when it is turned on twice while the blur starts', async () => {
    const service = new VoiceService();
    await service.setCameraBlur('strong');
    withPeer(service);
    const [a, b] = await Promise.all([service.startCamera(), service.startCamera()]);
    expect(a).toBe(b);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    service.dispose();
  });
});
