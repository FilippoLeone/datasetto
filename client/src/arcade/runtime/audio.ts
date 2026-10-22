/**
 * Game audio (docs/arcade/platform.md §10.5): one AudioContext per open game, created on the first
 * in-game gesture (`unlock`), suspended while hidden, closed on unmount.
 *
 * Effects are synthesized (oscillators with optional FM, seeded noise, biquad filters, gain
 * envelopes) and pre-rendered once into mono 22,050 Hz AudioBuffers with an OfflineAudioContext,
 * which needs no gesture. Music renders one pass of a step sequence the same way and plays it with
 * `loop = true`, so it costs no timers. The master gain (default 40 %, below voice, because speaker
 * audio leaks into the mic) drops to 0 while the user is deafened. Without Web Audio every method
 * is a no-op.
 */
import { effect, signal } from '@preact/signals';
import { localDeafened } from '@/state/voice';

export type Wave = 'square' | 'triangle' | 'sawtooth' | 'sine' | 'noise';

export interface ToneLayer {
  wave: Wave;
  /** Hz: a tone's pitch; for noise, the filter cutoff. A tone's filter cutoff starts here too. */
  freq: number;
  /** Exponential slide to this frequency over the layer (for noise: the cutoff slides). */
  freqEnd?: number;
  /** Default 'lowpass' for noise, none for tones. */
  filter?: 'lowpass' | 'bandpass' | 'highpass';
  /** Filter Q (the Web Audio default, 1, when unset). */
  q?: number;
  /** Exponential cutoff slide target over the layer (default: follows `freqEnd`). */
  filterEnd?: number;
  /** Tones only, for bells: a sine at freq × ratio with gain depth × freq into the carrier frequency. */
  fm?: { ratio: number; depth: number };
  /** Seconds before this layer starts. */
  delay?: number;
  /** Seconds (default 0.005). */
  attack?: number;
  /** Seconds from peak to silence. */
  decay: number;
  /** 0..1 (default 1). */
  gain?: number;
}

export interface SoundRecipe {
  layers: readonly ToneLayer[];
  gain?: number;
}

export interface MusicSeq {
  bpm: number;
  stepsPerBeat: number;
  loop: boolean;
  tracks: readonly {
    wave: Wave;
    gain: number;
    /** Seconds per note (default one step). */
    decay?: number;
    /** MIDI note per step; null = rest. For noise the note sets the low-pass cutoff. */
    notes: readonly (number | null)[];
  }[];
}

export interface GameAudio {
  /** Creates or resumes the context; call it from the first in-game gesture (and freely after). */
  unlock(): Promise<void>;
  /** Renders each recipe id once (later calls skip ids already rendered). */
  prerender(r: Readonly<Record<string, SoundRecipe>>): Promise<void>;
  /** No-op until unlocked, while suspended, or for an unknown id. `detune` is in cents. */
  play(id: string, o?: { gain?: number; detune?: number }): void;
  /** Renders the sequence once and loops it (starts on unlock if asked earlier); null stops. */
  music(seq: MusicSeq | null): void;
  /** 0–1, applies at once (still silent while deafened). */
  setVolume(master: number): void;
  suspend(): void;
  resume(): void;
  close(): Promise<void>;
}

type OfflineCtor = typeof OfflineAudioContext;
/** Schedules one layer at `t0` (its delay already added) with envelope peak `peak`. */
type Voice = (l: ToneLayer, t0: number, peak: number) => void;

const RATE = 22050;
/** Effect voices playing at once; more are dropped. */
const MAX_VOICES = 24;
/** Silence between effects in the shared offline render, in samples. */
const GAP = 64;

const noop = (): void => {};
/** 0–1; NaN and negatives are 0. */
const clamp = (v: number): number => (v >= 0 ? Math.min(1, v) : 0);

/** Seconds a recipe lasts. */
const seconds = (r: SoundRecipe): number => {
  let d = 0.01;
  for (const l of r.layers)
    d = Math.max(d, (l.delay ?? 0) + (l.attack ?? 0.005) + Math.max(l.decay, 0.001));
  return d + 0.01;
};

/** Schedules `plan` in an offline context `samples` long and renders it. */
const render = (
  Ctor: OfflineCtor,
  samples: number,
  plan: (v: Voice) => void
): Promise<[OfflineAudioContext, AudioBuffer]> => {
  const oc = new Ctor(1, Math.max(1, samples), RATE);
  let noise: AudioBuffer | undefined;
  plan((l, t0, peak) => {
    const a = l.attack ?? 0.005;
    const end = t0 + a + Math.max(l.decay, 0.001);
    const f1 = l.freqEnd;
    const slide = (p: AudioParam, from: number, to: number | undefined): void => {
      p.setValueAtTime(from, t0);
      if (to) p.exponentialRampToValueAtTime(Math.max(to, 1), end);
    };
    const env = oc.createGain();
    const g = env.gain;
    g.setValueAtTime(0, t0);
    g.linearRampToValueAtTime(peak, t0 + a);
    g.exponentialRampToValueAtTime(1e-4, end);
    g.setValueAtTime(0, end);
    let src: AudioScheduledSourceNode;
    if (l.wave === 'noise') {
      if (!noise) {
        // One second of seeded white noise, looped: every render sounds the same.
        noise = oc.createBuffer(1, RATE, RATE);
        const d = noise.getChannelData(0);
        for (let i = 0, s = 0x2545f491; i < RATE; i++)
          d[i] = (s = (Math.imul(s, 1664525) + 1013904223) | 0) / 2 ** 31;
      }
      const n = (src = oc.createBufferSource());
      n.buffer = noise;
      n.loop = true;
    } else {
      const o = (src = oc.createOscillator());
      o.type = l.wave;
      slide(o.frequency, l.freq, f1);
      if (l.fm) {
        // The modulator keeps its ratio and index through a pitch slide.
        const { ratio, depth } = l.fm;
        const m = oc.createOscillator();
        const mg = oc.createGain();
        slide(m.frequency, l.freq * ratio, f1 && f1 * ratio);
        slide(mg.gain, l.freq * depth, f1 && f1 * depth);
        m.connect(mg);
        mg.connect(o.frequency);
        m.start(t0);
        m.stop(end);
      }
    }
    let out: AudioNode = src;
    const type = l.filter ?? (l.wave === 'noise' ? 'lowpass' : undefined);
    if (type) {
      const bq = oc.createBiquadFilter();
      bq.type = type;
      if (l.q != null) bq.Q.value = l.q;
      slide(bq.frequency, l.freq, l.filterEnd ?? f1);
      src.connect(bq);
      out = bq;
    }
    out.connect(env);
    env.connect(oc.destination);
    src.start(t0);
    src.stop(end);
  });
  return new Promise((res, rej) => {
    // Old WebKit only fires oncomplete; current engines resolve the promise (both is harmless).
    oc.oncomplete = (e) => res([oc, e.renderedBuffer]);
    oc.startRendering()?.then((b) => res([oc, b]), rej);
  });
};

/** One pass of the sequence; a looping one gets the notes ringing past its end folded onto its start. */
const renderMusic = async (Ctor: OfflineCtor, s: MusicSeq): Promise<[AudioBuffer, number]> => {
  const step = 60 / (s.bpm * s.stepsPerBeat);
  let steps = 1;
  let tail = step;
  for (const t of s.tracks) {
    steps = Math.max(steps, t.notes.length);
    tail = Math.max(tail, t.decay ?? step);
  }
  const loop = Math.round(steps * step * RATE);
  const [, buf] = await render(Ctor, loop + Math.ceil((tail + 0.01) * RATE), (v) => {
    for (const t of s.tracks) {
      t.notes.forEach((n, i) => {
        if (n == null) return;
        v(
          { wave: t.wave, freq: 440 * 2 ** ((n - 69) / 12), decay: t.decay ?? step },
          i * step,
          t.gain
        );
      });
    }
  });
  if (s.loop) {
    const d = buf.getChannelData(0);
    for (let i = loop; i < d.length; i++) d[i % loop] += d[i];
  }
  return [buf, loop / RATE];
};

export function createGameAudio(o?: { master?: number }): GameAudio {
  const G = globalThis as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
    OfflineAudioContext?: OfflineCtor;
    webkitOfflineAudioContext?: OfflineCtor;
  };
  const Live = G.AudioContext ?? G.webkitAudioContext;
  // Nothing rendered offline could ever be heard without a realtime context.
  const Offline = Live && (G.OfflineAudioContext ?? G.webkitOfflineAudioContext);
  const volume = signal(clamp(o?.master ?? 0.4));
  const buffers = new Map<string, AudioBuffer>();
  const seen = new Set<string>();
  const loops = new WeakMap<MusicSeq, Promise<[AudioBuffer, number] | null>>();
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let undeafen: (() => void) | null = null;
  let hidden = false;
  let closed = false;
  let voices = 0;
  let want: MusicSeq | null = null;
  let track: [AudioBuffer, number] | null = null;
  let playing: AudioBufferSourceNode | null = null;

  const startMusic = (): void => {
    if (!ctx || !master || !want || !track || playing) return;
    const seq = want;
    const s = (playing = ctx.createBufferSource());
    s.buffer = track[0];
    s.loop = seq.loop;
    s.loopEnd = track[1];
    s.connect(master);
    s.onended = () => {
      // A jingle (loop: false) that ran out.
      if (playing === s) playing = want = track = null;
      s.disconnect();
    };
    s.start();
  };

  const stopMusic = (): void => {
    const s = playing;
    playing = track = want = null;
    if (!s) return;
    s.onended = null;
    try {
      s.stop();
    } catch {
      // Not started yet.
    }
    s.disconnect();
  };

  return {
    async unlock() {
      if (closed || !Live) return;
      if (!ctx) {
        ctx = new Live();
        const m = (master = ctx.createGain());
        m.connect(ctx.destination);
        undeafen = effect(() => {
          m.gain.value = localDeafened.value ? 0 : volume.value;
        });
        startMusic();
      }
      if (hidden) await ctx.suspend().catch(noop);
      else if (ctx.state !== 'running') await ctx.resume().catch(noop);
    },

    async prerender(r) {
      const ids = Object.keys(r).filter((id) => !seen.has(id));
      if (!Offline || closed || !ids.length) return;
      const spans: [string, number, number][] = [];
      let at = 0;
      for (const id of ids) {
        seen.add(id);
        const n = Math.ceil(seconds(r[id]) * RATE);
        spans.push([id, at, n]);
        at += n + GAP;
      }
      const failed = new Set<string>();
      try {
        const [oc, out] = await render(Offline, at, (v) => {
          for (const [id, start] of spans) {
            try {
              const rec = r[id];
              for (const l of rec.layers) {
                v(l, start / RATE + (l.delay ?? 0), (l.gain ?? 1) * (rec.gain ?? 1));
              }
            } catch {
              failed.add(id); // a broken recipe stays silent
            }
          }
        });
        if (closed) return;
        const d = out.getChannelData(0);
        for (const [id, start, n] of spans) {
          if (failed.has(id)) continue;
          const b = oc.createBuffer(1, n, RATE);
          b.getChannelData(0).set(d.subarray(start, start + n));
          buffers.set(id, b);
        }
      } catch {
        // Rendering failed: these effects stay silent.
      }
    },

    play(id, p) {
      const b = buffers.get(id);
      if (!ctx || !master || hidden || !b || voices >= MAX_VOICES) return;
      const s = ctx.createBufferSource();
      const g = ctx.createGain();
      s.buffer = b;
      if (p?.detune) s.playbackRate.value = 2 ** (p.detune / 1200);
      g.gain.value = p?.gain ?? 1;
      s.connect(g);
      g.connect(master);
      voices++;
      s.onended = () => {
        voices--;
        s.disconnect();
        g.disconnect();
      };
      s.start();
    },

    music(seq) {
      if (closed || seq === want) return;
      stopMusic();
      if (!seq || !Offline) return;
      want = seq;
      let p = loops.get(seq);
      if (!p) loops.set(seq, (p = renderMusic(Offline, seq).catch(() => null)));
      void p.then((t) => {
        if (want !== seq || !t) return;
        track = t;
        startMusic();
      });
    },

    setVolume(v) {
      volume.value = clamp(v);
    },

    suspend() {
      hidden = true;
      void ctx?.suspend().catch(noop);
    },

    resume() {
      hidden = false;
      void ctx?.resume().catch(noop);
    },

    async close() {
      if (closed) return;
      closed = true;
      undeafen?.();
      undeafen = null;
      stopMusic();
      buffers.clear();
      const c = ctx;
      ctx = master = null;
      await c?.close().catch(noop);
    },
  };
}
