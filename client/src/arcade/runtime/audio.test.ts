import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localDeafened } from '@/state/voice';
import { createGameAudio, type MusicSeq, type SoundRecipe } from './audio';

// jsdom has no Web Audio: fakes that record the graph each context builds.
class FakeParam {
  events: [string, number, number][] = [];
  writes = 0;
  private v: number;
  constructor(v: number) {
    this.v = v;
  }
  get value(): number {
    return this.v;
  }
  set value(v: number) {
    this.v = v;
    this.writes++;
  }
  setValueAtTime(v: number, t: number): this {
    this.events.push(['set', v, t]);
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.events.push(['lin', v, t]);
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    this.events.push(['exp', v, t]);
    return this;
  }
}

class FakeNode {
  out: unknown[] = [];
  connect<T>(n: T): T {
    this.out.push(n);
    return n;
  }
  disconnect(): void {
    this.out = [];
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}

class FakeOsc extends FakeNode {
  type = 'sine';
  frequency = new FakeParam(440);
  start = vi.fn();
  stop = vi.fn();
}

class FakeFilter extends FakeNode {
  type = 'lowpass';
  frequency = new FakeParam(350);
  Q = new FakeParam(1);
}

class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  loop = false;
  loopEnd = 0;
  playbackRate = new FakeParam(1);
  onended: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
}

class FakeBuffer {
  readonly data: Float32Array;
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number
  ) {
    this.data = new Float32Array(length);
  }
  getChannelData(): Float32Array {
    return this.data;
  }
}

class FakeBase {
  nodes: FakeNode[] = [];
  destination = new FakeNode();
  private add<T extends FakeNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }
  createGain(): FakeGain {
    return this.add(new FakeGain());
  }
  createOscillator(): FakeOsc {
    return this.add(new FakeOsc());
  }
  createBiquadFilter(): FakeFilter {
    return this.add(new FakeFilter());
  }
  createBufferSource(): FakeSource {
    return this.add(new FakeSource());
  }
  createBuffer(channels: number, length: number, rate: number): FakeBuffer {
    return new FakeBuffer(channels, length, rate);
  }
  of<T extends FakeNode>(type: new () => T): T[] {
    return this.nodes.filter((n): n is T => n instanceof type);
  }
}

const offline: FakeOffline[] = [];
const live: FakeLive[] = [];

class FakeOffline extends FakeBase {
  oncomplete: unknown = null;
  constructor(
    readonly channels: number,
    readonly length: number,
    readonly sampleRate: number
  ) {
    super();
    offline.push(this);
  }
  /** The "rendered" samples are a ramp, data[i] = i, so slices and folds can be checked. */
  startRendering = vi.fn(async () => {
    const b = new FakeBuffer(1, this.length, this.sampleRate);
    b.data.forEach((_, i) => (b.data[i] = i));
    return b;
  });
}

class FakeLive extends FakeBase {
  state = 'suspended';
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  suspend = vi.fn(async () => {
    this.state = 'suspended';
  });
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  constructor() {
    super();
    live.push(this);
  }
  /** The master gain: the first node, wired to the destination. */
  get master(): FakeGain {
    return this.nodes[0] as FakeGain;
  }
}

/** Drains the promise chains (no timers: the music test counts them). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

const RATE = 22050;
const blip: SoundRecipe = {
  gain: 0.5,
  layers: [
    { wave: 'square', freq: 880, freqEnd: 220, decay: 0.1, gain: 0.8 },
    { wave: 'noise', freq: 2000, freqEnd: 200, attack: 0.01, decay: 0.2 },
  ],
};
const knock: SoundRecipe = { layers: [{ wave: 'sine', freq: 180, delay: 0.05, decay: 0.06 }] };
const chime: SoundRecipe = { layers: [{ wave: 'triangle', freq: 660, decay: 0.25 }] };

// 120 bpm, 2 steps per beat: 0.25 s per step, 4 steps = 1 s.
const tune: MusicSeq = {
  bpm: 120,
  stepsPerBeat: 2,
  loop: true,
  tracks: [
    { wave: 'square', gain: 0.3, notes: [69, null, 81, null] },
    { wave: 'triangle', gain: 0.4, decay: 0.5, notes: [57, 57] },
    { wave: 'noise', gain: 0.2, decay: 0.05, notes: [null, 100, null, 100] },
  ],
};
const jingle: MusicSeq = {
  bpm: 240,
  stepsPerBeat: 1,
  loop: false,
  tracks: [{ wave: 'sine', gain: 1, notes: [72, 76, 79] }],
};

beforeEach(() => {
  offline.length = 0;
  live.length = 0;
  vi.stubGlobal('AudioContext', FakeLive);
  vi.stubGlobal('webkitAudioContext', undefined);
  vi.stubGlobal('OfflineAudioContext', FakeOffline);
});

afterEach(() => {
  localDeafened.value = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('createGameAudio', () => {
  it('creates nothing live before unlock; only offline renders run', async () => {
    const audio = createGameAudio();
    audio.play('blip');
    audio.suspend();
    audio.resume();
    audio.music(null);
    await audio.prerender({ blip });
    audio.play('blip');
    expect(live).toHaveLength(0);
    expect(offline).toHaveLength(1);
    await audio.close();
  });

  it('renders each recipe once, all in one mono 22,050 Hz offline pass, and slices it', async () => {
    const audio = createGameAudio();
    await audio.prerender({ blip, knock });
    expect(offline).toHaveLength(1);
    const oc = offline[0];
    expect([oc.channels, oc.sampleRate]).toEqual([1, RATE]);
    expect(oc.startRendering).toHaveBeenCalledTimes(1);

    const [square, sine] = oc.of(FakeOsc);
    expect([square.type, sine.type]).toEqual(['square', 'sine']);
    const end = 0.005 + 0.1;
    expect(square.frequency.events).toEqual([
      ['set', 880, 0],
      ['exp', 220, end],
    ]);
    const env = square.out[0] as FakeGain;
    expect(env.gain.events).toEqual([
      ['set', 0, 0],
      ['lin', 0.8 * 0.5, 0.005],
      ['exp', 1e-4, end],
      ['set', 0, end],
    ]);
    expect(env.out).toEqual([oc.destination]);
    expect(square.start).toHaveBeenCalledWith(0);
    expect(square.stop).toHaveBeenCalledWith(end);

    // Noise: a looped seeded buffer through a low-pass whose cutoff slides.
    const [noise] = oc.of(FakeSource);
    const [lp] = oc.of(FakeFilter);
    expect(noise.loop).toBe(true);
    expect(noise.buffer!.data.some((v) => v !== 0)).toBe(true);
    expect(noise.out).toEqual([lp]);
    expect(lp.type).toBe('lowpass');
    expect(lp.frequency.events).toEqual([
      ['set', 2000, 0],
      ['exp', 200, 0.01 + 0.2],
    ]);

    // The knock sits after the blip, on its own span, starting on a whole sample.
    const knockAt = (sine.start.mock.calls[0][0] as number) - 0.05;
    expect(knockAt).toBeGreaterThan(0.2 + 0.01);
    expect(knockAt * RATE).toBeCloseTo(Math.round(knockAt * RATE), 3);

    await audio.prerender({ blip, chime });
    expect(offline).toHaveLength(2);
    expect(offline[1].of(FakeOsc).map((o) => o.type)).toEqual(['triangle']);
    await audio.prerender({ blip, knock, chime });
    expect(offline).toHaveLength(2);
    await audio.close();
  });

  it('plays a rendered effect through its own gain into the master after unlock', async () => {
    const audio = createGameAudio();
    await audio.prerender({ blip, knock });
    await audio.unlock();
    expect(live).toHaveLength(1);
    const ctx = live[0];
    expect(ctx.resume).toHaveBeenCalled();
    expect(ctx.master.out).toEqual([ctx.destination]);
    expect(ctx.master.gain.value).toBe(0.4);

    audio.play('knock', { gain: 0.5, detune: 1200 });
    const [src] = ctx.of(FakeSource);
    expect(src.start).toHaveBeenCalledTimes(1);
    expect(src.playbackRate.value).toBe(2);
    const g = src.out[0] as FakeGain;
    expect(g.gain.value).toBe(0.5);
    expect(g.out).toEqual([ctx.master]);
    // The knock's slice starts where its span starts in the shared render (data[i] = i).
    const knockStart = Math.round(
      ((offline[0].of(FakeOsc)[1].start.mock.calls[0][0] as number) - 0.05) * RATE
    );
    expect(src.buffer!.data[0]).toBe(knockStart);
    expect(src.buffer!.length).toBe(Math.ceil((0.05 + 0.005 + 0.06 + 0.01) * RATE));

    audio.play('unknown');
    expect(ctx.of(FakeSource)).toHaveLength(1);
    src.onended?.();
    expect(src.out).toEqual([]);
    await audio.close();
  });

  it('follows the deafen state and the master volume', async () => {
    const audio = createGameAudio({ master: 0.25 });
    await audio.unlock();
    const { gain } = live[0].master;
    expect(gain.value).toBe(0.25);
    localDeafened.value = true;
    expect(gain.value).toBe(0);
    localDeafened.value = false;
    expect(gain.value).toBe(0.25);
    await audio.close();

    localDeafened.value = true;
    const loud = createGameAudio({ master: 3 });
    await loud.unlock();
    expect(live[1].master.gain.value).toBe(0); // deafened from the start
    localDeafened.value = false;
    expect(live[1].master.gain.value).toBe(1); // clamped
    await loud.close();
  });

  it('setVolume applies at once and stays silent while deafened', async () => {
    const audio = createGameAudio();
    audio.setVolume(0.7); // before unlock: used once the master exists
    await audio.unlock();
    const { gain } = live[0].master;
    expect(gain.value).toBe(0.7);
    audio.setVolume(0.2);
    expect(gain.value).toBe(0.2);
    localDeafened.value = true;
    audio.setVolume(0.9);
    expect(gain.value).toBe(0);
    localDeafened.value = false;
    expect(gain.value).toBe(0.9);
    audio.setVolume(5);
    expect(gain.value).toBe(1);
    audio.setVolume(-1);
    expect(gain.value).toBe(0);
    audio.setVolume(Number.NaN);
    expect(gain.value).toBe(0);
    await audio.close();
    const writes = gain.writes;
    audio.setVolume(0.5);
    expect(gain.writes).toBe(writes);
  });

  it('filters noise and tones, and frequency-modulates bells', async () => {
    const audio = createGameAudio();
    await audio.prerender({
      crumble: { layers: [{ wave: 'noise', freq: 900, filter: 'bandpass', q: 4, decay: 0.12 }] },
      kick: { layers: [{ wave: 'noise', freq: 400, freqEnd: 300, filterEnd: 1600, decay: 0.09 }] },
      wah: {
        layers: [{ wave: 'sawtooth', freq: 220, filter: 'highpass', filterEnd: 2000, decay: 0.3 }],
      },
      bell: {
        layers: [
          { wave: 'sine', freq: 660, freqEnd: 330, fm: { ratio: 3.5, depth: 2 }, decay: 0.8 },
        ],
      },
    });
    const oc = offline[0];
    const [crumble, kick, wah] = oc.of(FakeFilter);
    expect([crumble.type, crumble.Q.value, crumble.Q.writes]).toEqual(['bandpass', 4, 1]);
    expect(crumble.frequency.events).toEqual([['set', 900, expect.any(Number)]]);
    expect([kick.type, kick.Q.writes]).toEqual(['lowpass', 0]); // noise defaults to a low-pass
    expect(kick.frequency.events.map((e) => e.slice(0, 2))).toEqual([
      ['set', 400],
      ['exp', 1600], // filterEnd wins over freqEnd
    ]);
    expect(wah.type).toBe('highpass');
    expect(wah.frequency.events.map((e) => e.slice(0, 2))).toEqual([
      ['set', 220],
      ['exp', 2000],
    ]);

    const [saw, carrier, mod] = oc.of(FakeOsc);
    expect(saw.out).toEqual([wah]); // tone → filter → envelope
    expect(carrier.out[0]).toBeInstanceOf(FakeGain); // no filter on a tone unless asked
    expect(oc.of(FakeFilter)).toHaveLength(3);
    expect(mod.type).toBe('sine');
    expect(mod.frequency.events.map((e) => e.slice(0, 2))).toEqual([
      ['set', 660 * 3.5],
      ['exp', 330 * 3.5],
    ]);
    const depth = mod.out[0] as FakeGain;
    expect(depth.gain.events.map((e) => e.slice(0, 2))).toEqual([
      ['set', 660 * 2],
      ['exp', 330 * 2],
    ]);
    expect(depth.out).toEqual([carrier.frequency]);
    expect(mod.start.mock.calls[0]).toEqual(carrier.start.mock.calls[0]);
    expect(mod.stop.mock.calls[0]).toEqual(carrier.stop.mock.calls[0]);
    await audio.close();
  });

  it('suspends and resumes the context, dropping effects while suspended', async () => {
    const audio = createGameAudio();
    await audio.prerender({ chime });
    await audio.unlock();
    const ctx = live[0];
    audio.suspend();
    expect(ctx.suspend).toHaveBeenCalledTimes(1);
    audio.play('chime');
    expect(ctx.of(FakeSource)).toHaveLength(0);
    await audio.unlock(); // a gesture while hidden does not wake it
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    audio.resume();
    expect(ctx.resume).toHaveBeenCalledTimes(2);
    audio.play('chime');
    expect(ctx.of(FakeSource)).toHaveLength(1);
    await audio.close();
  });

  it('renders music once and loops it with no timers', async () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const interval = vi.spyOn(globalThis, 'setInterval');
    const audio = createGameAudio();
    await audio.unlock();
    audio.music(tune);
    await flush();

    expect(offline).toHaveLength(1);
    const oc = offline[0];
    const loop = RATE; // 4 steps × 0.25 s
    expect(oc.length).toBe(loop + Math.ceil((0.5 + 0.01) * RATE));
    expect(oc.of(FakeOsc).map((o) => [o.type, Math.round(o.frequency.events[0][1])])).toEqual([
      ['square', 440],
      ['square', 880],
      ['triangle', 220],
      ['triangle', 220],
    ]);
    expect(oc.of(FakeFilter)).toHaveLength(2);

    const ctx = live[0];
    const [src] = ctx.of(FakeSource);
    expect(src.loop).toBe(true);
    expect(src.loopEnd).toBe(1);
    expect(src.out).toEqual([ctx.master]);
    expect(src.start).toHaveBeenCalledTimes(1);
    // Notes ringing past the end are folded onto the start (data[i] = i before the fold).
    expect(src.buffer!.data[0]).toBe(loop);
    expect(src.buffer!.data[1]).toBe(1 + loop + 1);

    audio.music(tune); // already playing: no restart
    expect(ctx.of(FakeSource)).toHaveLength(1);
    audio.music(null);
    expect(src.stop).toHaveBeenCalledTimes(1);
    expect(src.out).toEqual([]);
    audio.music(tune); // cached: no second render
    await flush();
    expect(offline).toHaveLength(1);
    expect(ctx.of(FakeSource)).toHaveLength(2);

    expect(timeout).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    await audio.close();
  });

  it('starts music asked for before unlock once unlocked, and plays a jingle once', async () => {
    const audio = createGameAudio();
    audio.music(jingle);
    await flush();
    expect(offline).toHaveLength(1);
    await audio.unlock();
    const ctx = live[0];
    const [src] = ctx.of(FakeSource);
    expect(src.loop).toBe(false);
    expect(src.start).toHaveBeenCalledTimes(1);
    src.onended?.();
    audio.music(jingle); // ran out: plays again, from the cached render
    await flush();
    expect(ctx.of(FakeSource)).toHaveLength(2);
    expect(offline).toHaveLength(1);
    await audio.close();
  });

  it('close stops everything, closes the context and stops following deafen', async () => {
    const audio = createGameAudio();
    await audio.prerender({ chime });
    await audio.unlock();
    audio.music(tune);
    await flush();
    const ctx = live[0];
    const [song] = ctx.of(FakeSource);
    const writes = ctx.master.gain.writes;

    await audio.close();
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(song.stop).toHaveBeenCalledTimes(1);
    localDeafened.value = true;
    localDeafened.value = false;
    expect(ctx.master.gain.writes).toBe(writes);

    audio.play('chime');
    audio.music(jingle);
    await audio.unlock();
    await audio.prerender({ knock });
    await flush();
    expect(ctx.of(FakeSource)).toHaveLength(1);
    expect(live).toHaveLength(1);
    expect(offline).toHaveLength(2); // the chime and the tune, nothing after close
    await audio.close();
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it('is a no-op everywhere without Web Audio', async () => {
    vi.stubGlobal('AudioContext', undefined);
    const audio = createGameAudio();
    await audio.prerender({ blip }); // an offline context alone is never used
    await audio.unlock();
    audio.play('blip');
    audio.music(tune);
    audio.suspend();
    audio.resume();
    await flush();
    await audio.close();
    expect(offline).toHaveLength(0);
    expect(live).toHaveLength(0);
  });

  it('falls back to the prefixed constructor', async () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', FakeLive);
    const audio = createGameAudio();
    await audio.unlock();
    expect(live).toHaveLength(1);
    await audio.close();
  });
});
