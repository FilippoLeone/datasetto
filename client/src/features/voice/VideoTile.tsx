import { useEffect, useRef, useState } from 'preact/hooks';
import { Volume2, VolumeX } from 'lucide-preact';
import { cn } from '@/lib/cn';
import type { PresenceState } from '@/lib/motion';

/** Viewer-side mute and volume for a shared screen's sound (the values shown on the tile). */
export interface TileAudioControls {
  muted: boolean;
  /** 0..1 */
  volume: number;
  onMutedChange: (muted: boolean) => void;
  onVolumeChange: (volume: number) => void;
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
  /** Mute button and volume slider, shown while the stream carries sound. */
  audioControls?: TileAudioControls;
  className?: string;
  onClick?: () => void;
  /** From useListPresence: scales the tile in on mount and out while it leaves. */
  state?: PresenceState;
}

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

/** Plays a MediaStream in a <video>, re-attaching when the stream changes. */
export const VideoTile = ({ stream, label, mirror, muted = true, volume, sinkId, audioIndicator, audioControls, className, onClick, state }: VideoTileProps) => {
  const ref = useRef<HTMLVideoElement>(null);
  const hasAudio = useStreamHasAudio(stream, Boolean(audioIndicator || audioControls));

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

  const controls = hasAudio && audioControls ? audioControls : null;
  const percent = controls ? Math.round(controls.volume * 100) : 0;

  return (
    <div data-state={state} className={cn('motion-tile @container relative overflow-hidden rounded-lg bg-black', onClick && 'cursor-pointer', className)} onClick={onClick}>
      <video ref={ref} autoPlay playsInline className={cn('h-full w-full object-contain', mirror && 'mirror')} />
      {/* Bottom bar: the label truncates, the sound controls keep their place; on small tiles
          (container queries) the slider and the percentage make way. */}
      <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-end justify-between gap-2">
        <span className="min-w-0 truncate rounded-sm bg-black/60 px-1.5 py-0.5 text-xs font-medium text-white">{label}</span>
        {controls ? (
          <div
            className="pointer-events-auto flex shrink-0 cursor-default items-center gap-1.5 rounded-sm bg-black/60 px-1.5 py-1 text-white"
            data-audio="on"
            data-audio-controls
            onClick={stop}
            onDblClick={stop}
          >
            <button
              type="button"
              aria-label={controls.muted ? 'Unmute stream' : 'Mute stream'}
              title={controls.muted ? 'Unmute this stream' : 'Mute this stream'}
              aria-pressed={controls.muted}
              onClick={() => controls.onMutedChange(!controls.muted)}
              className={cn('rounded-sm p-0.5 transition-colors duration-150 hover:text-success', controls.muted && 'text-live')}
            >
              {controls.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
            <input
              type="range"
              aria-label="Stream volume"
              title="Stream volume"
              className="range-input hidden w-16 @min-[240px]:block @min-[360px]:w-20"
              min={0}
              max={100}
              step={5}
              value={percent}
              onInput={(event) => controls.onVolumeChange(Number((event.target as HTMLInputElement).value) / 100)}
            />
            <span className="hidden w-8 text-right text-[10px] tabular-nums @min-[320px]:inline">{percent}%</span>
          </div>
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
