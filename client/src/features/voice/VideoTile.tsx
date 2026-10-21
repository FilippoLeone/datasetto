import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { CircleDot, Scissors, Volume2, VolumeX } from 'lucide-preact';
import { Menu, VolumeSlider, type MenuItem } from '@/components';
import { cn } from '@/lib/cn';
import { isTouchPrimary } from '@/lib/device';
import type { PresenceState } from '@/lib/motion';

/**
 * Viewer-side mute and volume shown on a tile: a shared screen's sound, or the voice of the
 * person on a camera tile. The values are what the tile shows; the owner of the controls
 * applies them (video element volume, or the person's gain node in the voice service).
 */
export interface TileAudioControls {
  muted: boolean;
  /** 0..max multiplier. */
  volume: number;
  /** 1 for a stream that cannot play louder than it is, 2 for a person (boost up to 200 %). */
  max?: 1 | 2;
  onMutedChange: (muted: boolean) => void;
  onVolumeChange: (volume: number) => void;
  /** Accessible names; the defaults speak of a stream. */
  sliderLabel?: string;
  muteLabel?: string;
  unmuteLabel?: string;
  /** Show the controls only while the stream carries sound (screen shares). */
  onlyWithAudio?: boolean;
  /** Full controls behind the percentage: a dropdown with a mouse, a sheet on a phone (slider, mute switch, reset). */
  panel?: ComponentChildren;
  /** Heading of that sheet. */
  panelTitle?: string;
}

/**
 * The Clip controls of a tile (a shared screen): the "Clips on" switch that keeps the
 * last N seconds in memory on this device, and the Clip button that saves them. The
 * state is the clip manager's; the tile only shows it (features/clips/tileClip.ts).
 */
export interface TileClipControls {
  /** Clips on: the rolling buffer should run for this source. */
  on: boolean;
  /** The buffer actually runs. */
  recording: boolean;
  availableMs: number;
  saving: boolean;
  /** Why it is on but not recording. */
  error: string | null;
  /** The window length from the settings. */
  seconds: number;
  onToggle: () => void;
  onClip: () => void;
}

interface VideoTileProps {
  stream: MediaStream;
  label: string;
  mirror?: boolean;
  muted?: boolean;
  /** 0..1 effective playback volume for an unmuted tile. */
  volume?: number;
  /** Output device for an unmuted tile, where the browser supports setSinkId. */
  sinkId?: string;
  /** Show whether the stream carries sound (screen shares). */
  audioIndicator?: boolean;
  /** Mute button, volume slider and percentage in the bottom bar. */
  audioControls?: TileAudioControls;
  /** Show the resolution and frame rate the stream actually plays at (screen shares). */
  stats?: boolean;
  /** Clips on/off and the Clip button, top right (screen shares that may be clipped). */
  clip?: TileClipControls;
  className?: string;
  onClick?: () => void;
  /** From useListPresence: scales the tile in on mount and out while it leaves. */
  state?: PresenceState;
}

/** "1920×1080 · 60 fps" from the playing video; frame rate measured when the track does not report it. */
export const formatVideoStats = (width: number, height: number, fps: number | null): string => {
  if (!width || !height) return '';
  return width + '×' + height + (fps ? ' · ' + Math.round(fps) + ' fps' : '');
};

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/** Effective resolution and frame rate of the stream shown in `ref`, refreshed every second. */
const useVideoStats = (ref: { current: HTMLVideoElement | null }, stream: MediaStream, enabled: boolean): string => {
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (!enabled) return;
    const node = ref.current as FrameCallbackVideo | null;
    if (!node) return;
    let frames = 0;
    let handle: number | null = null;
    const count = () => {
      frames += 1;
      handle = node.requestVideoFrameCallback ? node.requestVideoFrameCallback(count) : null;
    };
    if (node.requestVideoFrameCallback) handle = node.requestVideoFrameCallback(count);
    let lastTick = performance.now();
    const tick = () => {
      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings() ?? {};
      const now = performance.now();
      const measured = frames > 0 ? (frames * 1000) / Math.max(1, now - lastTick) : null;
      frames = 0;
      lastTick = now;
      const fps = typeof settings.frameRate === 'number' && settings.frameRate > 0 ? settings.frameRate : measured;
      setLabel(formatVideoStats(node.videoWidth || settings.width || 0, node.videoHeight || settings.height || 0, fps));
    };
    const timer = window.setInterval(tick, 1000);
    tick();
    return () => {
      window.clearInterval(timer);
      if (handle !== null && node.cancelVideoFrameCallback) node.cancelVideoFrameCallback(handle);
    };
  }, [ref, stream, enabled]);
  return label;
};

/** True while the stream has an audio track that is still playing. */
export const streamHasAudio = (stream: MediaStream): boolean => stream.getAudioTracks().some((track) => track.readyState === 'live');

/** Follows the audio tracks of a stream, including ones added or ended after it was attached. */
const useStreamHasAudio = (stream: MediaStream, enabled: boolean): boolean => {
  const [hasAudio, setHasAudio] = useState(() => enabled && streamHasAudio(stream));
  useEffect(() => {
    if (!enabled) return;
    const watched = new Set<MediaStreamTrack>();
    const update = () => setHasAudio(streamHasAudio(stream));
    const watch = () => {
      for (const track of stream.getAudioTracks()) {
        if (watched.has(track)) continue;
        watched.add(track);
        track.addEventListener('ended', update);
      }
    };
    const onTracksChanged = () => {
      watch();
      update();
    };
    onTracksChanged();
    stream.addEventListener('addtrack', onTracksChanged);
    stream.addEventListener('removetrack', onTracksChanged);
    return () => {
      stream.removeEventListener('addtrack', onTracksChanged);
      stream.removeEventListener('removetrack', onTracksChanged);
      for (const track of watched) track.removeEventListener('ended', update);
    };
  }, [stream, enabled]);
  return hasAudio;
};

const stop = (event: Event) => event.stopPropagation();

/**
 * The sound controls in a tile's bottom bar: mute button, slider (where the tile is wide
 * enough, container queries) and the percentage, which opens the full panel when one is
 * given, so the volume can be set on a narrow tile and on a phone too.
 */
const TileAudioBar = ({ controls }: { controls: TileAudioControls }) => {
  const max = controls.max ?? 1;
  const percent = Math.round(controls.volume * 100);
  const sliderLabel = controls.sliderLabel ?? 'Stream volume';
  return (
    <div
      className="pointer-events-auto flex shrink-0 cursor-default items-center gap-0.5 rounded-sm bg-black/60 px-1 py-0.5 text-white"
      data-audio="on"
      data-audio-controls
      data-muted={controls.muted ? 'true' : undefined}
      onClick={stop}
      onDblClick={stop}
    >
      <button
        type="button"
        aria-label={controls.muted ? (controls.unmuteLabel ?? 'Unmute stream') : (controls.muteLabel ?? 'Mute stream')}
        title={controls.muted ? (controls.unmuteLabel ?? 'Unmute this stream') : (controls.muteLabel ?? 'Mute this stream')}
        aria-pressed={controls.muted}
        onClick={() => controls.onMutedChange(!controls.muted)}
        className={cn('flex items-center justify-center rounded-sm p-1 transition-colors duration-150 hover:bg-white/15 pointer-coarse:min-h-10 pointer-coarse:min-w-10', controls.muted && 'text-live')}
        data-tile-mute
      >
        {controls.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
      </button>
      <VolumeSlider
        label={sliderLabel}
        value={percent}
        max={max === 2 ? 200 : 100}
        step={5}
        className="hidden @min-[260px]:flex"
        trackClassName="w-16 @min-[360px]:w-24"
        onChange={(value) => controls.onVolumeChange(value / 100)}
      />
      {controls.panel ? (
        <Menu items={[]} header={controls.panel} title={controls.panelTitle} align="right" className="shrink-0">
          <span
            className="flex min-w-8 items-center justify-end rounded-sm px-1 py-0.5 text-[10px] tabular-nums transition-colors duration-150 hover:bg-white/15 pointer-coarse:min-h-10 pointer-coarse:px-2 pointer-coarse:text-xs"
            title="Volume options"
            data-volume-options
          >
            {percent}%
          </span>
        </Menu>
      ) : (
        <span className="hidden w-8 text-right text-[10px] tabular-nums @min-[320px]:inline">{percent}%</span>
      )}
    </div>
  );
};

/** What the Clip button says: the seconds it would save, or why it cannot yet. */
export const clipButtonLabel = (clip: TileClipControls): string => {
  if (clip.saving) return 'Saving the clip…';
  if (clip.recording) return 'Clip the last ' + Math.max(1, Math.round(clip.availableMs / 1000)) + ' s';
  if (clip.on) return 'Clips are not recording yet' + (clip.error ? ': ' + clip.error : '');
  return 'Turn Clips on first to clip';
};

export const clipToggleLabel = (clip: TileClipControls): string => (clip.on ? 'Turn clips off' : 'Turn clips on (keeps the last ' + clip.seconds + ' s on this device)');

/**
 * Clip controls in a tile's top right corner. With a mouse they show on hover (and
 * stay while Clips is on, as the recording indicator); on a phone one button opens a
 * sheet with the two actions. Visible to nobody else: the indicator is this viewer's own.
 */
const TileClipBar = ({ clip }: { clip: TileClipControls }) => {
  const touch = isTouchPrimary();
  const canClip = clip.recording && !clip.saving;
  if (touch) {
    const items: MenuItem[] = [
      { label: clipToggleLabel(clip), icon: <CircleDot size={16} className={clip.on ? 'text-live' : undefined} />, onSelect: clip.onToggle },
      { label: clipButtonLabel(clip), icon: <Scissors size={16} />, disabled: !canClip, onSelect: clip.onClip },
    ];
    return (
      <Menu items={items} title="Clips" align="right" className="pointer-events-auto">
        <span
          className={cn('flex h-10 w-10 items-center justify-center rounded-sm bg-black/60 text-white', clip.on && 'text-live')}
          title="Clips"
          aria-label={clip.on ? (clip.recording ? 'Clips on, recording' : 'Clips on') : 'Clips'}
          data-tile-clips
          data-clips-on={clip.on ? 'true' : undefined}
          data-clips-recording={clip.recording ? 'true' : undefined}
        >
          {clip.on ? <CircleDot size={18} className={clip.recording ? 'animate-pulse' : undefined} /> : <Scissors size={18} />}
        </span>
      </Menu>
    );
  }
  return (
    <div
      className={cn(
        'pointer-events-auto flex cursor-default items-center gap-0.5 rounded-sm bg-black/60 px-0.5 py-0.5 text-white transition-opacity duration-150',
        clip.on ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
      )}
      onClick={stop}
      onDblClick={stop}
      data-tile-clips
      data-clips-on={clip.on ? 'true' : undefined}
      data-clips-recording={clip.recording ? 'true' : undefined}
    >
      <button
        type="button"
        aria-label={clipToggleLabel(clip)}
        title={clipToggleLabel(clip) + (clip.on && clip.error ? ' · ' + clip.error : '')}
        aria-pressed={clip.on}
        onClick={clip.onToggle}
        className={cn('flex items-center gap-1 rounded-sm p-1 text-[11px] font-semibold transition-colors duration-150 hover:bg-white/15', clip.on && 'text-live')}
        data-tile-clips-toggle
      >
        <CircleDot size={14} className={clip.recording ? 'animate-pulse' : undefined} />
        {clip.on && <span className="hidden pr-0.5 @min-[200px]:inline">{clip.recording ? 'Clips on' : 'Clips…'}</span>}
      </button>
      <button
        type="button"
        aria-label={clipButtonLabel(clip)}
        title={clipButtonLabel(clip)}
        disabled={!canClip}
        onClick={clip.onClip}
        className="flex items-center justify-center rounded-sm p-1 transition-colors duration-150 hover:bg-white/15 disabled:opacity-40 disabled:hover:bg-transparent"
        data-tile-clip
      >
        <Scissors size={14} />
      </button>
    </div>
  );
};

/** Plays a MediaStream in a <video>, re-attaching when the stream changes. */
export const VideoTile = ({ stream, label, mirror, muted = true, volume, sinkId, audioIndicator, audioControls, stats, clip, className, onClick, state }: VideoTileProps) => {
  const ref = useRef<HTMLVideoElement>(null);
  const hasAudio = useStreamHasAudio(stream, Boolean(audioIndicator || audioControls?.onlyWithAudio));
  const statsLabel = useVideoStats(ref, stream, Boolean(stats));

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.srcObject = stream;
    node.muted = muted;
    const play = () => node.play().catch(() => undefined);
    play();
    const onLoaded = () => play();
    node.addEventListener('loadedmetadata', onLoaded);
    return () => {
      node.removeEventListener('loadedmetadata', onLoaded);
      node.srcObject = null;
    };
  }, [stream, muted]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.volume = Math.min(1, Math.max(0, volume ?? 1));
  }, [volume]);

  useEffect(() => {
    const node = ref.current as (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!node?.setSinkId || muted) return;
    node.setSinkId(sinkId ?? '').catch(() => undefined);
  }, [sinkId, muted]);

  const controls = audioControls && (!audioControls.onlyWithAudio || hasAudio) ? audioControls : null;

  return (
    <div data-state={state} className={cn('motion-tile group @container relative overflow-hidden rounded-lg bg-black', onClick && 'cursor-pointer', className)} onClick={onClick}>
      <video ref={ref} autoPlay playsInline className={cn('h-full w-full object-contain', mirror && 'mirror')} />
      {/* Top left: the resolution label and the clip controls (the top right corner is where toasts stack). */}
      {(statsLabel || clip) && (
        <div className="pointer-events-none absolute top-2 left-2 flex items-start gap-1">
          {statsLabel && (
            <span className="rounded-sm bg-black/60 px-1.5 py-0.5 text-[11px] text-white/90 tabular-nums" title="Resolution and frame rate as played here" data-video-stats>
              {statsLabel}
            </span>
          )}
          {clip && <TileClipBar clip={clip} />}
        </div>
      )}
      {/* Bottom bar: the label truncates, the sound controls keep their place; on small tiles
          (container queries) the slider makes way and the percentage opens the full panel. */}
      <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-end justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1 truncate rounded-sm bg-black/60 px-1.5 py-0.5 text-xs font-medium text-white">
          {controls?.muted && controls.max === 2 && <VolumeX size={12} className="shrink-0 text-live" aria-label="Muted for you" data-muted-for-me />}
          <span className="truncate">{label}</span>
        </span>
        {controls ? (
          <TileAudioBar controls={controls} />
        ) : (
          audioIndicator && (
            <span
              className={cn('flex shrink-0 items-center gap-1 rounded-sm bg-black/60 px-1.5 py-0.5 text-xs font-medium', hasAudio ? 'text-success' : 'text-text-muted')}
              title={hasAudio ? 'This share includes sound' : 'This share has no sound'}
              data-audio={hasAudio ? 'on' : 'off'}
            >
              {hasAudio ? <Volume2 size={12} /> : <VolumeX size={12} />}
              <span className="hidden @min-[200px]:inline">{hasAudio ? 'Audio on' : 'No audio'}</span>
            </span>
          )
        )}
      </div>
    </div>
  );
};
