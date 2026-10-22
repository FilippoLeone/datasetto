/**
 * Bellwick's sound (bellwick.md §11): synthesized effects pre-rendered on the first in-game gesture,
 * and one music loop per area, rendered once and looped (no timers). Effects play at 70 % of the
 * Arcade master; music defaults on in Solo Tale and off in Party Tale.
 */
import { MUSIC } from '@arcade/core/bellwick/content/music';
import { createGameAudio, type GameAudio, type MusicSeq } from '@/arcade/runtime/audio';
import { SOUNDS, type SoundId } from './sounds';

export type TrackId = keyof typeof MUSIC;

export interface BwAudio {
  /** From a gesture: creates the context and renders the effects. */
  unlock(): void;
  play(id: SoundId, gain?: number): void;
  /** The area track (null: silence). Jingles interrupt it and it comes back after them. */
  track(id: TrackId | null): void;
  jingle(id: TrackId): void;
  setMusic(on: boolean): void;
  setEffects(on: boolean): void;
  suspend(): void;
  resume(): void;
  close(): void;
  /** Once per tick: brings the area track back after a jingle. */
  advance(): void;
}

export const createBwAudio = (master: number, musicOn: boolean, effectsOn: boolean): BwAudio => {
  const audio: GameAudio = createGameAudio({ master });
  let unlocked = false;
  let music = musicOn;
  let effects = effectsOn;
  let area: TrackId | null = null;
  let jingleUntil = 0;
  let clock = 0;
  const seq = (id: TrackId): MusicSeq => MUSIC[id] as unknown as MusicSeq;
  const apply = (): void => audio.music(music && area ? seq(area) : null);
  return {
    unlock() {
      if (unlocked) {
        void audio.unlock();
        return;
      }
      unlocked = true;
      void audio.unlock().then(() => audio.prerender(SOUNDS)).then(apply);
    },
    play(id, gain = 0.7) {
      if (effects) audio.play(id, { gain });
    },
    track(id) {
      if (id === area) return;
      area = id;
      if (clock >= jingleUntil) apply();
    },
    jingle(id) {
      if (!music) return;
      audio.music(seq(id));
      const m = MUSIC[id];
      let steps = 0;
      for (const t of m.tracks) steps = Math.max(steps, t.notes.length);
      jingleUntil = clock + Math.ceil(((steps * 60) / (m.bpm * m.stepsPerBeat)) * 30) + 20;
    },
    setMusic(on) {
      music = on;
      apply();
    },
    setEffects(on) {
      effects = on;
    },
    suspend: () => audio.suspend(),
    resume: () => audio.resume(),
    close: () => void audio.close(),
    advance() {
      const was = clock < jingleUntil;
      clock += 1;
      if (was && clock >= jingleUntil) apply();
    },
  };
};
