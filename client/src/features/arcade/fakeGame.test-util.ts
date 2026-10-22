/**
 * A fake action game for the shell tests: it uses every runtime piece a real game uses (loop,
 * stage canvas, input, audio, host callbacks) so "nothing is left after unmount" means something.
 */
import type { GameMeta } from '@/arcade/catalog';
import { createGameAudio } from '@/arcade/runtime/audio';
import { createStageCanvas, type StageCanvas } from '@/arcade/runtime/canvas';
import { createInput, DEFAULT_KEYS, DEFAULT_TOUCH } from '@/arcade/runtime/input';
import { createLoop } from '@/arcade/runtime/loop';
import { createProbeCore } from '@/arcade/runtime/testing';
import type { GameChunk, GameModule, MatchHost } from '@/arcade/runtime/types';

export interface FakeGameLog {
  mounted: number;
  unmounted: number;
  frames: number;
  paused: number;
  resumed: number;
  canvases: StageCanvas[];
}

export const fakeLog: FakeGameLog = { mounted: 0, unmounted: 0, frames: 0, paused: 0, resumed: 0, canvases: [] };

export const fakeModule: GameModule<MatchHost> = {
  mount(el, host, opts) {
    fakeLog.mounted += 1;
    const stage = createStageCanvas(el, { logicalW: 240, logicalH: 224, mode: 'pixelated' });
    fakeLog.canvases.push(stage);
    const input = createInput(el, { keys: DEFAULT_KEYS, ptt: opts.ptt, reserved: opts.reserved, touch: DEFAULT_TOUCH, gamepad: true });
    const audio = createGameAudio({ master: opts.prefs.volume });
    void audio.unlock();
    const loop = createLoop({ draw: () => undefined });
    loop.animate(true);
    host.onFrame(() => {
      fakeLog.frames += 1;
      input.sample();
      host.sendUp(new Uint8Array([1]));
    });
    host.onWelcome(() => opts.shell.status('live'));
    return {
      pause() {
        fakeLog.paused += 1;
        loop.setVisible(false);
        audio.suspend();
      },
      resume() {
        fakeLog.resumed += 1;
        loop.setVisible(true);
        audio.resume();
      },
      unmount() {
        fakeLog.unmounted += 1;
        loop.dispose();
        input.dispose();
        void audio.close();
        stage.dispose();
      },
    };
  },
};

export const fakeChunk: GameChunk = { module: fakeModule, local: () => createProbeCore() };

export const fakeMeta: GameMeta = {
  id: 'fuseyard',
  name: 'Test Game',
  tagline: 'A fake game for tests',
  icon: 'bomb',
  lane: 'action',
  ready: { offline: true, online: false },
  modes: [{ id: 'brawl', label: 'Brawl', online: false, offline: true }],
  seats: [2, 4],
  watch: false,
  options: [{ key: 'fighters', label: 'Fighters', kind: 'choice', choices: [{ value: 2, label: '2' }, { value: 4, label: '4' }], default: 4 }],
  load: async () => fakeChunk,
};

/** A Web Audio stand-in: every node accepts any call; `closed` counts closed contexts. */
export const installFakeAudio = (): { contexts: number; closed: number; restore(): void } => {
  const state = { contexts: 0, closed: 0 };
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} });
  const node = (): unknown =>
    new Proxy({} as Record<string | symbol, unknown>, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === 'then') return undefined;
        if (prop === 'gain' || prop === 'frequency' || prop === 'detune' || prop === 'playbackRate' || prop === 'Q') return (target[prop] = param());
        return () => node();
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    });
  class FakeContext {
    state: string = 'running';
    currentTime = 0;
    sampleRate = 22050;
    destination = node();
    constructor() {
      state.contexts += 1;
    }
    createGain() {
      return node();
    }
    createBufferSource() {
      return node();
    }
    createOscillator() {
      return node();
    }
    createBiquadFilter() {
      return node();
    }
    createBuffer(_channels: number, length: number) {
      return { length, duration: length / 22050, getChannelData: () => new Float32Array(length), copyToChannel() {} };
    }
    async resume() {
      this.state = 'running';
    }
    async suspend() {
      this.state = 'suspended';
    }
    async close() {
      if (this.state !== 'closed') state.closed += 1;
      this.state = 'closed';
    }
  }
  class FakeOffline extends FakeContext {
    length: number;
    constructor(_channels: number, length: number) {
      super();
      state.contexts -= 1;
      this.length = length;
    }
    async startRendering() {
      return this.createBuffer(1, this.length);
    }
  }
  const w = window as unknown as Record<string, unknown>;
  const saved = { AudioContext: w.AudioContext, OfflineAudioContext: w.OfflineAudioContext };
  w.AudioContext = FakeContext;
  w.OfflineAudioContext = FakeOffline;
  return {
    get contexts() {
      return state.contexts;
    },
    get closed() {
      return state.closed;
    },
    restore() {
      w.AudioContext = saved.AudioContext;
      w.OfflineAudioContext = saved.OfflineAudioContext;
    },
  };
};
