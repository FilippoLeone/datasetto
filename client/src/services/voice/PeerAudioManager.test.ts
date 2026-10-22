import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerAudioManager, playbackModeFor, SPEAKING_CHECK_MS, speakingClock } from './PeerAudioManager';

/** A Web Audio graph that records what was built and the values set on it. */
const mockContext = (options: { sinkId?: boolean; ramps?: boolean } = {}) => {
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const gains: Array<{ gain: Record<string, unknown> & { value: number }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  const sources: ReturnType<typeof node>[] = [];
  const analysers: Array<ReturnType<typeof node> & { fftSize: number; smoothingTimeConstant: number; frequencyBinCount: number; getByteFrequencyData: ReturnType<typeof vi.fn> }> = [];
  const destination = { kind: 'destination' };
  const context = {
    currentTime: 1,
    destination,
    createMediaStreamSource: vi.fn(() => {
      const source = node();
      sources.push(source);
      return source;
    }),
    createGain: vi.fn(() => {
      const gain: Record<string, unknown> & { value: number } = { value: 1 };
      if (options.ramps) {
        gain.cancelScheduledValues = vi.fn();
        gain.setValueAtTime = vi.fn();
        gain.linearRampToValueAtTime = vi.fn((target: number) => {
          gain.value = target;
        });
      }
      const created = { gain, ...node() };
      gains.push(created);
      return created;
    }),
    createAnalyser: vi.fn(() => {
      const analyser = { ...node(), fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 128, getByteFrequencyData: vi.fn() };
      analysers.push(analyser);
      return analyser;
    }),
  } as Record<string, unknown>;
  if (options.sinkId) context.setSinkId = vi.fn(() => Promise.resolve());
  return { context: context as unknown as AudioContext, gains, sources, analysers, destination };
};

const stream = {} as MediaStream;

/** Every manager a test creates, disposed after it (the speaking clock is shared across the file). */
const created: PeerAudioManager[] = [];
const track = (manager: PeerAudioManager): PeerAudioManager => {
  created.push(manager);
  return manager;
};

describe('PeerAudioManager', () => {
  let play: ReturnType<typeof vi.fn>;
  let pause: ReturnType<typeof vi.fn>;
  let setSinkId: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // jsdom has no media playback; the manager only needs play() to return a promise.
    play = vi.fn(() => Promise.resolve());
    pause = vi.fn();
    setSinkId = vi.fn(() => Promise.resolve());
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: play });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: pause });
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', { configurable: true, value: setSinkId });
  });

  afterEach(() => {
    for (const manager of created.splice(0)) manager.dispose();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('picks Web Audio playback where the output device can be set on the context, the element elsewhere', () => {
    expect(playbackModeFor(mockContext({ sinkId: true }).context)).toBe('webaudio');
    expect(playbackModeFor(mockContext().context)).toBe('element');
  });

  it('web audio: builds source -> gain -> destination with a muted element keeping the stream alive, and an analyser on the raw signal', () => {
    const { context, gains, sources, analysers, destination } = mockContext({ sinkId: true });
    const manager = track(new PeerAudioManager('peer-1', context, () => undefined, 0.07));
    expect(manager.mode).toBe('webaudio');
    manager.attachStream(stream, null);

    const element = document.querySelector('audio[data-peer-id="peer-1"]') as HTMLAudioElement;
    expect(element).not.toBeNull();
    expect(element.muted).toBe(true);
    expect(element.dataset.playback).toBe('webaudio');
    expect(play).toHaveBeenCalled();
    expect(gains).toHaveLength(1);
    expect(sources[0].connect).toHaveBeenCalledWith(analysers[0]);
    expect(sources[0].connect).toHaveBeenCalledWith(gains[0]);
    expect(gains[0].connect).toHaveBeenCalledWith(destination);
    expect(analysers[0].connect).not.toHaveBeenCalled();
    expect(setSinkId).not.toHaveBeenCalled();
  });

  it('web audio: the gain is volume x output volume, 0 when muted for me or deafened, and allows a boost above 1', () => {
    const { context, gains } = mockContext({ sinkId: true });
    const manager = track(new PeerAudioManager('peer-1', context, () => undefined, 0.07));
    manager.attachStream(stream, null);
    const element = document.querySelector('audio[data-peer-id="peer-1"]') as HTMLAudioElement;

    manager.applyState(false, false, 1, 1);
    expect(gains[0].gain.value).toBe(1);
    manager.applyState(false, false, 0.4, 1);
    expect(gains[0].gain.value).toBeCloseTo(0.4);
    expect(manager.gain()).toBeCloseTo(0.4);
    expect(element.dataset.gain).toBe('0.4');
    manager.applyState(false, false, 1.5, 1);
    expect(gains[0].gain.value).toBe(1.5);
    manager.applyState(false, false, 2, 0.5);
    expect(gains[0].gain.value).toBe(1);
    manager.applyState(false, true, 1.5, 1);
    expect(gains[0].gain.value).toBe(0);
    expect(element.dataset.gain).toBe('0');
    manager.applyState(true, false, 1.5, 1);
    expect(gains[0].gain.value).toBe(0);
    manager.applyState(false, false, 1.5, 1);
    expect(gains[0].gain.value).toBe(1.5);
    // The element stays muted throughout: the graph plays, not the element.
    expect(element.muted).toBe(true);
  });

  it('web audio: a volume set before the stream arrives is applied when it does', () => {
    const { context, gains } = mockContext({ sinkId: true });
    const manager = track(new PeerAudioManager('peer-1', context, () => undefined, 0.07));
    manager.applyState(false, false, 0.25, 1);
    manager.attachStream(stream, null);
    expect(gains[0].gain.value).toBe(0.25);
  });

  it('web audio: volume changes ramp on the AudioParam when the engine offers automation', () => {
    const { context, gains } = mockContext({ sinkId: true, ramps: true });
    const manager = track(new PeerAudioManager('peer-1', context, () => undefined, 0.07));
    manager.attachStream(stream, null);
    manager.applyState(false, false, 1.2, 1);
    const gain = gains[0].gain;
    expect(gain.cancelScheduledValues).toHaveBeenCalledWith(1);
    expect(gain.setValueAtTime).toHaveBeenCalledWith(1, 1);
    expect(gain.linearRampToValueAtTime).toHaveBeenCalledWith(1.2, 1.03);
    expect(gain.value).toBe(1.2);
  });

  it('element playback: the element plays with volume capped at 1 and muted when muted for me; the device goes on the element', () => {
    const { context, gains } = mockContext();
    const manager = track(new PeerAudioManager('peer-2', context, () => undefined, 0.07));
    expect(manager.mode).toBe('element');
    manager.attachStream(stream, 'speaker-7');
    const element = document.querySelector('audio[data-peer-id="peer-2"]') as HTMLAudioElement;
    expect(element.muted).toBe(false);
    expect(gains).toHaveLength(0);
    expect(setSinkId).toHaveBeenCalledWith('speaker-7');

    manager.applyState(false, false, 1.5, 1);
    expect(element.volume).toBe(1);
    expect(element.dataset.gain).toBe('1.5');
    manager.applyState(false, false, 0.3, 1);
    expect(element.volume).toBeCloseTo(0.3);
    manager.applyState(false, true, 0.3, 1);
    expect(element.muted).toBe(true);
    manager.applyState(false, false, 0.3, 1);
    expect(element.muted).toBe(false);

    void manager.setSinkId('speaker-8');
    expect(setSinkId).toHaveBeenLastCalledWith('speaker-8');
  });

  it('web audio: the output device is not set on the element (the context owns it)', () => {
    const { context } = mockContext({ sinkId: true });
    const manager = track(new PeerAudioManager('peer-1', context, () => undefined, 0.07));
    manager.attachStream(stream, 'speaker-7');
    void manager.setSinkId('speaker-8');
    expect(setSinkId).not.toHaveBeenCalled();
  });

  it('rename keeps playing under the new socket id; dispose tears the graph and the element down', () => {
    const { context, gains, sources, analysers } = mockContext({ sinkId: true });
    const manager = track(new PeerAudioManager('peer-1', context, () => undefined, 0.07));
    manager.attachStream(stream, null);
    manager.rename('peer-9');
    expect(document.querySelector('audio[data-peer-id="peer-9"]')).not.toBeNull();
    expect(document.querySelector('audio[data-peer-id="peer-1"]')).toBeNull();
    manager.dispose();
    expect(document.querySelector('audio')).toBeNull();
    expect(gains[0].disconnect).toHaveBeenCalled();
    expect(sources[0].disconnect).toHaveBeenCalled();
    expect(analysers[0].disconnect).toHaveBeenCalled();
    expect(pause).toHaveBeenCalled();
  });
});

describe('speaking detection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: vi.fn(() => Promise.resolve()) });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    for (const manager of created.splice(0)) manager.dispose();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('checks every remote voice on one 100 ms timer, and leaves no timer once they are gone', () => {
    expect(speakingClock.size).toBe(0);
    const started = vi.spyOn(window, 'setInterval');
    const { context, analysers } = mockContext({ sinkId: true });
    const managers = ['peer-a', 'peer-b', 'peer-c', 'peer-d'].map((id) => track(new PeerAudioManager(id, context, () => undefined, 0.07)));
    for (const manager of managers) manager.attachStream(stream, null);

    expect(started).toHaveBeenCalledTimes(1);
    expect(started.mock.calls[0][1]).toBe(SPEAKING_CHECK_MS);
    expect(SPEAKING_CHECK_MS).toBe(100);
    expect(vi.getTimerCount()).toBe(1);
    expect(speakingClock.size).toBe(4);

    vi.advanceTimersByTime(1000);
    for (const analyser of analysers) expect(analyser.getByteFrequencyData).toHaveBeenCalledTimes(10);

    managers[0].dispose();
    managers[1].dispose();
    managers[2].dispose();
    expect(vi.getTimerCount()).toBe(1);
    managers[3].dispose();
    expect(speakingClock.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restarting a stream keeps one timer', () => {
    const { context } = mockContext({ sinkId: true });
    const manager = track(new PeerAudioManager('peer-1', context, () => undefined, 0.07));
    manager.attachStream(stream, null);
    manager.attachStream(stream, null);
    expect(speakingClock.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('reports speaking on the first loud reading and silence about 0.9 s after the voice stops, as before', () => {
    const { context, analysers } = mockContext({ sinkId: true });
    const changes: Array<[boolean, number]> = [];
    const manager = track(new PeerAudioManager('peer-1', context, (speaking) => changes.push([speaking, Date.now()]), 0.07));
    manager.attachStream(stream, null);
    let level = 0;
    analysers[0].getByteFrequencyData.mockImplementation((data: Uint8Array) => data.fill(level));
    const t0 = Date.now();

    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([]);

    level = 200;
    vi.advanceTimersByTime(SPEAKING_CHECK_MS);
    expect(changes.map(([speaking]) => speaking)).toEqual([true]);
    expect(changes[0][1] - t0).toBe(1000 + SPEAKING_CHECK_MS);

    vi.advanceTimersByTime(2000); // still talking: no repeats
    expect(changes).toHaveLength(1);

    level = 0;
    const stopped = Date.now();
    vi.advanceTimersByTime(1500);
    expect(changes.map(([speaking]) => speaking)).toEqual([true, false]);
    // 500 ms for the smoothing window to empty, then the 350 ms hold (the 50 ms detector took the same).
    const after = changes[1][1] - stopped;
    expect(after).toBeGreaterThanOrEqual(800);
    expect(after).toBeLessThanOrEqual(1000);
  });

  it('reuses one buffer for its readings', () => {
    const { context, analysers } = mockContext({ sinkId: true });
    track(new PeerAudioManager('peer-1', context, () => undefined, 0.07)).attachStream(stream, null);
    vi.advanceTimersByTime(500);
    const buffers = new Set(analysers[0].getByteFrequencyData.mock.calls.map(([data]) => data));
    expect(buffers.size).toBe(1);
  });
});
