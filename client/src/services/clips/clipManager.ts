import { effect } from '@preact/signals';
import { isMobileDevice } from '@/lib/device';
import { formatSeconds } from '@/lib/format';
import { audioSettings } from '@/state/settings';
import { toast } from '@/state/ui';
import { activeClipKey, clipLibrary, clipStatuses, clipsOn, isClipsOn, setClipsOn, type ClipStatus } from '@/state/clips';
import { ClipMixer } from './clipMixer';
import { captureThumbnail } from './clipThumbnail';
import { CLIP_STORAGE_CAP_BYTES, ClipTooBigError, deleteClip, listClips, newClipId, saveClip, supportsClipStorage, type ClipRecord, type ClipSourceKind } from './clipStore';
import { CLIP_MIME_CANDIDATES, mediaRecorderFactory, pickClipMimeType, RollingBuffer } from './rollingBuffer';
import { fixWebmDuration } from './webmDuration';

/** Something that can be clipped: a stream being watched, a shared screen (someone's or yours). */
export interface ClipSource {
  /** See state/clips.ts for the key scheme. */
  key: string;
  kind: ClipSourceKind;
  /** Shown in toasts, the library and the file name. */
  name: string;
}

interface Entry {
  source: ClipSource;
  /** The stream to record; may become available later (a player that is still connecting). */
  getStream: () => MediaStream | null;
  stream: MediaStream | null;
  buffer: RollingBuffer | null;
  mixer: ClipMixer | null;
  recorded: MediaStream | null;
  windowMs: number;
  includeVoice: boolean;
  saving: boolean;
  error: string | null;
  onTracksChanged: (() => void) | null;
}

/** Encoder caps: a desktop keeps 1080p60 sharp enough at 6 Mbit/s; phones encode less. */
export const CLIP_VIDEO_BITRATE = { desktop: 6_000_000, mobile: 2_500_000 } as const;
export const CLIP_AUDIO_BITRATE = 128_000;
/** The schedule runs this often; statuses are published once a second. */
const TICK_MS = 250;
/** Shorter than this and the buffer just started: nothing worth saving. */
const MIN_CLIP_MS = 1000;

const bitrateFor = (): number => (isMobileDevice() ? CLIP_VIDEO_BITRATE.mobile : CLIP_VIDEO_BITRATE.desktop);

/**
 * Runs the rolling buffers behind the Clip buttons. Sources register themselves
 * while their picture is around (a player while it plays, a share while it is
 * received); the buffer of a source runs while it is registered and its "Clips on"
 * switch is on, with the window length from the settings. "Clip" takes what the
 * buffer has, fixes the file's duration, grabs a thumbnail, stores it in IndexedDB
 * and says how long the clip is.
 */
class ClipManager {
  private entries = new Map<string, Entry>();
  private voiceStreams: MediaStream[] = [];
  private ticker: number | null = null;
  private lastPublish = 0;
  private installed = false;
  private mimeType: string | null | undefined;

  /** Hook the buffers up to the settings and the on/off switches. Called once at boot. */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    effect(() => {
      // Read what the buffers depend on, then reconcile outside the tracked scope.
      void clipsOn.value;
      void audioSettings.value.clipSeconds;
      void audioSettings.value.clipIncludeVoice;
      queueMicrotask(() => this.reconcile());
    });
    if (supportsClipStorage()) void this.refreshLibrary();
  }

  /** Whether this engine can record clips at all (MediaRecorder with WebM, and somewhere to keep them). */
  supported(): boolean {
    return this.clipMimeType() !== null && supportsClipStorage();
  }

  private clipMimeType(): string | null {
    if (this.mimeType !== undefined) return this.mimeType;
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
      this.mimeType = null;
      return null;
    }
    this.mimeType = pickClipMimeType(isMobileDevice() ? CLIP_MIME_CANDIDATES.mobile : CLIP_MIME_CANDIDATES.desktop, (type) => MediaRecorder.isTypeSupported(type));
    return this.mimeType;
  }

  /**
   * A source's picture is available: from now on its buffer may run. Registering
   * the same key again replaces the stream getter (a player that reconnected).
   */
  register(source: ClipSource, getStream: () => MediaStream | null): void {
    const existing = this.entries.get(source.key);
    if (existing) {
      existing.source = source;
      existing.getStream = getStream;
      // A new stream object behind the same key: record that one instead.
      if (existing.buffer && existing.stream !== getStream()) this.stopRecording(existing);
    } else {
      this.entries.set(source.key, { source, getStream, stream: null, buffer: null, mixer: null, recorded: null, windowMs: 0, includeVoice: false, saving: false, error: null, onTracksChanged: null });
    }
    this.reconcile();
  }

  /** The picture is gone (page left, share ended): stop the buffer and forget the source. The switch stays as it was. */
  unregister(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.stopRecording(entry);
    this.entries.delete(key);
    if (activeClipKey.value === key) activeClipKey.value = this.firstRecordingKey();
    this.publish(true);
  }

  isRegistered(key: string): boolean {
    return this.entries.has(key);
  }

  /** Turn the rolling buffer of a source on or off (remembered per source). */
  setOn(key: string, on: boolean): void {
    setClipsOn(key, on);
    if (on) activeClipKey.value = key;
    else if (activeClipKey.value === key) activeClipKey.value = this.firstRecordingKey();
    this.reconcile();
  }

  toggle(key: string): void {
    this.setOn(key, !isClipsOn(key));
  }

  /** The friends' voices to mix into clips when the setting asks for it (voiceManager keeps this current). */
  setVoiceStreams(streams: MediaStream[]): void {
    this.voiceStreams = streams;
    for (const entry of this.entries.values()) {
      if (entry.mixer && entry.stream) entry.mixer.setInputs([entry.stream, ...streams]);
    }
  }

  /** Save what the buffer of this source holds. Resolves with the saved clip, or null when there was nothing to save. */
  async clip(key: string): Promise<ClipRecord | null> {
    const entry = this.entries.get(key);
    if (!entry) {
      toast.info('Nothing to clip here');
      return null;
    }
    if (!entry.buffer || !entry.stream) {
      toast.info(isClipsOn(key) ? 'Clips are not recording yet: ' + (entry.error ?? 'waiting for the picture') : 'Turn Clips on first, then press Clip to save the last ' + audioSettings.value.clipSeconds + ' seconds');
      return null;
    }
    if (entry.saving) return null;
    activeClipKey.value = key;
    entry.saving = true;
    this.publish(true);
    try {
      const result = await entry.buffer.clip();
      if (!result || result.durationMs < MIN_CLIP_MS) {
        toast.info('Nothing to clip yet: the buffer just started');
        return null;
      }
      const [video, still] = await Promise.all([fixWebmDuration(result.blob, result.durationMs), captureThumbnail(entry.stream)]);
      const record: ClipRecord = {
        id: newClipId(),
        createdAt: Date.now(),
        sourceKind: entry.source.kind,
        sourceName: entry.source.name,
        durationMs: Math.round(result.durationMs),
        bytes: video.size,
        mimeType: result.mimeType,
        width: still.width,
        height: still.height,
        hasAudio: (entry.recorded?.getAudioTracks().length ?? 0) > 0,
        includesVoice: entry.includeVoice,
      };
      const saved = await saveClip(record, video, still.blob);
      clipLibrary.value = [record, ...(clipLibrary.value ?? []).filter((clip) => !saved.evicted.some((gone) => gone.id === clip.id))];
      toast.success('Saved a ' + formatSeconds(record.durationMs) + ' clip of ' + record.sourceName + ' (WebM, ' + Math.round(record.bytes / 1024 / 1024) + ' MB)');
      if (saved.evicted.length > 0) {
        toast.warning(
          saved.evicted.length === 1 ? 'The oldest clip was removed to stay under ' + Math.round(CLIP_STORAGE_CAP_BYTES / 1024 / 1024) + ' MB' : saved.evicted.length + ' oldest clips were removed to stay under ' + Math.round(CLIP_STORAGE_CAP_BYTES / 1024 / 1024) + ' MB',
          7000,
        );
      }
      return record;
    } catch (error) {
      if (error instanceof ClipTooBigError) toast.error('This clip is bigger than the whole clip storage (' + Math.round(CLIP_STORAGE_CAP_BYTES / 1024 / 1024) + ' MB)');
      else toast.error('Could not save the clip: ' + (error instanceof Error ? error.message : 'unknown error'));
      return null;
    } finally {
      entry.saving = false;
      this.publish(true);
    }
  }

  /** The clip shortcut: the source last turned on or clipped, else any recording one. */
  async clipActive(): Promise<ClipRecord | null> {
    const key = activeClipKey.value && this.entries.get(activeClipKey.value)?.buffer ? activeClipKey.value : this.firstRecordingKey();
    if (!key) {
      toast.info('Turn Clips on for a stream or a shared screen first; the shortcut then saves its last ' + audioSettings.value.clipSeconds + ' seconds');
      return null;
    }
    return this.clip(key);
  }

  async refreshLibrary(): Promise<ClipRecord[]> {
    try {
      const clips = await listClips();
      clipLibrary.value = clips;
      return clips;
    } catch (error) {
      toast.error('Could not read the clips library: ' + (error instanceof Error ? error.message : 'unknown error'));
      clipLibrary.value = clipLibrary.value ?? [];
      return clipLibrary.value;
    }
  }

  async remove(id: string): Promise<void> {
    await deleteClip(id);
    clipLibrary.value = (clipLibrary.value ?? []).filter((clip) => clip.id !== id);
  }

  /** Bytes held in memory by every running buffer (for the memory check and the UI). */
  bufferedBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.buffer?.bytes() ?? 0;
    return total;
  }

  // ------------------------------------------------------------- internals

  private firstRecordingKey(): string | null {
    for (const [key, entry] of this.entries) if (entry.buffer) return key;
    return null;
  }

  private reconcile(): void {
    const settings = audioSettings.value;
    const windowMs = settings.clipSeconds * 1000;
    const includeVoice = settings.clipIncludeVoice;
    for (const entry of this.entries.values()) {
      const want = isClipsOn(entry.source.key);
      if (!want) {
        if (entry.buffer) this.stopRecording(entry);
        entry.error = null;
        continue;
      }
      const stream = entry.getStream();
      const changed = entry.buffer && (entry.windowMs !== windowMs || entry.includeVoice !== includeVoice || entry.stream !== stream);
      if (changed) this.stopRecording(entry);
      if (!entry.buffer) this.startRecording(entry, stream, windowMs, includeVoice);
    }
    this.ensureTicker();
    this.publish(true);
  }

  private startRecording(entry: Entry, stream: MediaStream | null, windowMs: number, includeVoice: boolean): void {
    const mimeType = this.clipMimeType();
    if (!mimeType || !supportsClipStorage()) {
      entry.error = 'This browser cannot record clips';
      return;
    }
    if (!stream) {
      entry.error = 'waiting for the picture';
      return;
    }
    const video = stream.getVideoTracks().find((track) => track.readyState === 'live');
    if (!video) {
      entry.error = 'no video to record';
      return;
    }
    let mixer: ClipMixer | null = null;
    let recorded: MediaStream;
    try {
      if (includeVoice) {
        mixer = new ClipMixer();
        mixer.setInputs([stream, ...this.voiceStreams]);
        recorded = new MediaStream([video, mixer.track]);
      } else {
        const audio = stream.getAudioTracks().find((track) => track.readyState === 'live');
        recorded = new MediaStream(audio ? [video, audio] : [video]);
      }
    } catch (error) {
      mixer?.close();
      entry.error = 'could not set up the recorder: ' + (error instanceof Error ? error.message : String(error));
      return;
    }
    const buffer = new RollingBuffer({
      windowMs,
      createRecorder: mediaRecorderFactory(recorded, { mimeType, videoBitsPerSecond: bitrateFor(), audioBitsPerSecond: CLIP_AUDIO_BITRATE }),
      onEnded: (error) => {
        if (entry.buffer !== buffer) return;
        this.stopRecording(entry);
        entry.error = error ? 'the recorder stopped: ' + (error instanceof Error ? error.message : String(error)) : 'the picture ended';
        this.publish(true);
        // The source may come back (a player that reconnects) and registers again; until then the switch stays on.
      },
    });
    entry.stream = stream;
    entry.buffer = buffer;
    entry.mixer = mixer;
    entry.recorded = recorded;
    entry.windowMs = windowMs;
    entry.includeVoice = includeVoice;
    entry.error = null;
    // A track appearing or leaving the source (the share's sound arriving late) means a fresh recorder on the new set.
    entry.onTracksChanged = () => {
      if (entry.buffer !== buffer) return;
      this.stopRecording(entry);
      this.reconcile();
    };
    stream.addEventListener('addtrack', entry.onTracksChanged);
    stream.addEventListener('removetrack', entry.onTracksChanged);
    try {
      buffer.start();
    } catch (error) {
      this.stopRecording(entry);
      entry.error = 'could not start the recorder: ' + (error instanceof Error ? error.message : String(error));
    }
  }

  private stopRecording(entry: Entry): void {
    entry.buffer?.stop();
    entry.buffer = null;
    entry.mixer?.close();
    entry.mixer = null;
    if (entry.stream && entry.onTracksChanged) {
      entry.stream.removeEventListener('addtrack', entry.onTracksChanged);
      entry.stream.removeEventListener('removetrack', entry.onTracksChanged);
    }
    entry.onTracksChanged = null;
    entry.recorded = null;
    entry.stream = null;
  }

  private ensureTicker(): void {
    const anyRunning = Array.from(this.entries.values()).some((entry) => entry.buffer);
    if (anyRunning && this.ticker === null) {
      this.ticker = window.setInterval(() => this.tick(), TICK_MS);
    } else if (!anyRunning && this.ticker !== null) {
      window.clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private tick(): void {
    for (const entry of this.entries.values()) entry.buffer?.tick();
    this.publish(false);
  }

  /** Push the statuses into the signal (at most once a second unless forced). */
  private publish(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastPublish < 1000) return;
    this.lastPublish = now;
    const next: Record<string, ClipStatus> = {};
    for (const [key, entry] of this.entries) {
      next[key] = { recording: Boolean(entry.buffer), availableMs: entry.buffer?.availableMs() ?? 0, saving: entry.saving, error: entry.error };
    }
    clipStatuses.value = next;
  }
}

export const clipManager = new ClipManager();
