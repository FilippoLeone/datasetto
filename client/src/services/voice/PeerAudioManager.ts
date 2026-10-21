/**
 * Playback of one remote participant's voice: a gain node per person (their volume and
 * "mute for me"), speaking detection on the raw signal, and the output device.
 */
import { isCapacitor, isElectron } from '@/lib/device';

/** What I hear of one person: their volume (0..2, above 1 a boost) and a mute on my side only. */
export interface PeerAudioPreference {
  muted: boolean;
  volume: number;
}

/**
 * How a remote voice reaches the speakers. `webaudio`: a muted <audio> element keeps the
 * stream flowing (Chromium feeds remote WebRTC audio to Web Audio only while a media
 * element consumes it) and a MediaStreamSource -> GainNode -> destination graph plays it,
 * which allows a boost above 100 % and picks the output device on the AudioContext.
 * `element`: the <audio> element plays by itself (volume tops out at 100 %, the device is
 * picked on the element); for engines without AudioContext.setSinkId (Firefox, Safari),
 * where the element is the only way to choose an output device.
 */
export type PlaybackMode = 'webaudio' | 'element';

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };
type SinkElement = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

export const playbackModeFor = (context: AudioContext): PlaybackMode => {
  if (isElectron() || isCapacitor()) return 'webaudio';
  return typeof (context as SinkContext).setSinkId === 'function' ? 'webaudio' : 'element';
};

/** Seconds a volume change takes to settle; long enough to avoid clicks, short enough to feel instant. */
const GAIN_RAMP_S = 0.03;

export class SpeakingMonitor {
  private interval: number | null = null;
  private history: number[] = [];
  private readonly historySize = 10;
  private isSpeaking = false;
  private speakingStartTime = 0;
  private silenceStartTime = 0;
  private readonly silenceHoldMs = 350;
  private hysteresisLow: number;
  private hysteresisHigh: number;

  constructor(
    private analyser: AnalyserNode,
    private onSpeakingChange: (speaking: boolean) => void,
    threshold: number,
  ) {
    this.hysteresisHigh = threshold;
    this.hysteresisLow = threshold * 0.6;
  }

  start(): void {
    if (this.interval) return;
    this.interval = window.setInterval(() => this.check(), 50);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isSpeaking = false;
    this.history = [];
  }

  setThreshold(threshold: number): void {
    this.hysteresisHigh = threshold;
    this.hysteresisLow = threshold * 0.6;
  }

  private check(): void {
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);

    const voiceBins = Math.min(18, data.length);
    let sum = 0;
    for (let i = 0; i < voiceBins; i++) {
      sum += data[i];
    }
    const average = sum / voiceBins / 255;

    this.history.push(average);
    if (this.history.length > this.historySize) {
      this.history.shift();
    }

    const smoothed = this.history.reduce((a, b) => a + b, 0) / this.history.length;
    const now = performance.now();

    if (this.isSpeaking) {
      if (smoothed < this.hysteresisLow) {
        if (this.silenceStartTime === 0) {
          this.silenceStartTime = now;
        }
        if (now - this.silenceStartTime >= this.silenceHoldMs) {
          this.isSpeaking = false;
          this.onSpeakingChange(false);
          this.speakingStartTime = 0;
        }
      } else {
        this.silenceStartTime = 0;
      }
    } else {
      if (smoothed > this.hysteresisHigh) {
        if (this.speakingStartTime === 0) {
          this.speakingStartTime = now;
        }
        this.isSpeaking = true;
        this.onSpeakingChange(true);
        this.silenceStartTime = 0;
      }
    }
  }
}

export class PeerAudioManager {
  private audioElement: HTMLAudioElement | null = null;
  private sourceNode: AudioNode | null = null;
  private gainNode: GainNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private speakingMonitor: SpeakingMonitor | null = null;
  private currentGain = 1;
  readonly mode: PlaybackMode;

  constructor(
    private peerId: string,
    private context: AudioContext,
    private onSpeaking: (speaking: boolean) => void,
    private vadThreshold: number,
    mode: PlaybackMode = playbackModeFor(context),
  ) {
    this.mode = mode;
  }

  attachStream(stream: MediaStream, outputDeviceId: string | null) {
    this.dispose();

    const element = document.createElement('audio') as SinkElement;
    this.audioElement = element;
    element.id = `audio-${this.peerId}`;
    element.autoplay = true;
    element.setAttribute('playsinline', 'true');
    element.dataset.peerId = this.peerId;
    element.dataset.playback = this.mode;
    element.srcObject = stream;

    // The analyser listens to the signal as it arrives, before my volume for this person,
    // so the speaking ring keeps working for someone I turned down or muted for me.
    this.sourceNode = this.context.createMediaStreamSource(stream);
    this.analyserNode = this.context.createAnalyser();
    this.sourceNode.connect(this.analyserNode);

    if (this.mode === 'webaudio') {
      // createMediaElementSource on an element playing a MediaStream yields silence in
      // Chromium (measured in Electron 44), hence the MediaStreamSource with the element muted.
      element.muted = true;
      this.gainNode = this.context.createGain();
      this.gainNode.gain.value = this.currentGain;
      this.sourceNode.connect(this.gainNode);
      this.gainNode.connect(this.context.destination);
    } else {
      element.muted = false;
      if (outputDeviceId && typeof element.setSinkId === 'function') {
        element.setSinkId(outputDeviceId).catch(console.error);
      }
    }
    element.play()?.catch(() => {});

    this.analyserNode.fftSize = 256;
    this.analyserNode.smoothingTimeConstant = 0.8;
    this.speakingMonitor = new SpeakingMonitor(this.analyserNode, this.onSpeaking, this.vadThreshold);
    this.speakingMonitor.start();

    document.body.appendChild(element);
  }

  /**
   * What I hear of this person: nothing while I am deafened or muted them for me, otherwise
   * their volume (0..2) scaled by my output volume. Takes effect at once, on the gain node.
   */
  applyState(deafened: boolean, localMuted: boolean, localVolume: number, masterVolume: number = 1) {
    const effectiveMuted = deafened || localMuted;
    const gain = effectiveMuted ? 0 : Math.max(0, localVolume * masterVolume);
    this.currentGain = gain;

    if (this.mode === 'webaudio') {
      if (this.gainNode) this.rampGain(this.gainNode.gain, gain);
    } else if (this.audioElement) {
      // HTMLMediaElement volume stops at 1: no boost on this path.
      this.audioElement.volume = Math.min(gain, 1);
      this.audioElement.muted = effectiveMuted;
    }
    // Readable from the DOM (tests, support): the gain this person plays at for me.
    if (this.audioElement) this.audioElement.dataset.gain = String(gain);
  }

  /** The gain this person currently plays at for me (0 while muted or deafened). */
  gain(): number {
    return this.currentGain;
  }

  private rampGain(param: AudioParam, target: number): void {
    if (typeof param.linearRampToValueAtTime === 'function' && typeof param.cancelScheduledValues === 'function' && typeof param.setValueAtTime === 'function') {
      const now = this.context.currentTime;
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(target, now + GAIN_RAMP_S);
    } else {
      param.value = target;
    }
  }

  async setSinkId(deviceId: string): Promise<void> {
    const element = this.audioElement as SinkElement | null;
    if (this.mode === 'element' && element && typeof element.setSinkId === 'function') {
      return element.setSinkId(deviceId).catch(console.error);
    }
  }

  setThreshold(threshold: number) {
    this.vadThreshold = threshold;
    if (this.speakingMonitor) {
      this.speakingMonitor.setThreshold(threshold);
    }
  }

  /** The peer came back on a new socket id: keep playing, relabel the element. */
  rename(peerId: string) {
    this.peerId = peerId;
    if (this.audioElement) {
      this.audioElement.id = `audio-${peerId}`;
      this.audioElement.dataset.peerId = peerId;
    }
  }

  resume() {
    if (this.audioElement && this.audioElement.paused && this.audioElement.srcObject) {
      this.audioElement.play()?.catch(() => {});
    }
  }

  dispose() {
    if (this.speakingMonitor) {
      this.speakingMonitor.stop();
      this.speakingMonitor = null;
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        /* already disconnected */
      }
      this.sourceNode = null;
    }

    if (this.gainNode) {
      try {
        this.gainNode.disconnect();
      } catch {
        /* already disconnected */
      }
      this.gainNode = null;
    }

    if (this.analyserNode) {
      try {
        this.analyserNode.disconnect();
      } catch {
        /* already disconnected */
      }
      this.analyserNode = null;
    }

    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.srcObject = null;
      this.audioElement.remove();
      this.audioElement = null;
    }
  }
}
