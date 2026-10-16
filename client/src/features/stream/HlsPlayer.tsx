import { useEffect, useRef, useState } from 'preact/hooks';
import Hls from 'hls.js';
import { Maximize, Minimize, Pause, Play, Volume2, VolumeX } from 'lucide-preact';
import { IconButton } from '@/components';
import { cn } from '@/lib/cn';
import { buildHlsUrlCandidates } from '@/lib/hlsUrls';
import { runtimeUrls } from '@/lib/runtimeConfig';
import { serverConfig } from '@/services/ServerConfigService';
import { Storage } from '@/lib/storage';

type PlayerStatus = 'idle' | 'connecting' | 'playing' | 'buffering' | 'offline' | 'error';

const VOLUME_KEY = 'datasetto.playerVolume';

interface HlsPlayerProps {
  channelName: string;
  live: boolean;
  className?: string;
}

/** HLS playback with retries and minimal custom controls. */
export const HlsPlayer = ({ channelName, live, className }: HlsPlayerProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const retryRef = useRef<number | null>(null);
  const [status, setStatus] = useState<PlayerStatus>('idle');
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(() => Storage.get<number>(VOLUME_KEY, 0.8));
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !live) {
      setStatus('offline');
      return;
    }
    const base = serverConfig.get()?.urls.hls ?? runtimeUrls.hlsBaseUrl;
    const candidates = buildHlsUrlCandidates(base, channelName);
    let disposed = false;
    let attempt = 0;

    const destroy = () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };

    const scheduleRetry = () => {
      if (disposed) return;
      retryRef.current = window.setTimeout(() => load(0), 4000);
    };

    const load = (index: number) => {
      if (disposed) return;
      if (index >= candidates.length) {
        setStatus('offline');
        scheduleRetry();
        return;
      }
      destroy();
      setStatus('connecting');
      const source = candidates[index];

      if (Hls.isSupported()) {
        const hls = new Hls({
          lowLatencyMode: true,
          liveSyncDurationCount: 2,
          liveMaxLatencyDurationCount: 5,
          maxBufferLength: 10,
          backBufferLength: 30,
          enableWorker: true,
          manifestLoadingMaxRetry: 2,
          levelLoadingMaxRetry: 2,
          fragLoadingMaxRetry: 3,
        });
        hlsRef.current = hls;
        hls.loadSource(source);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(() => setPaused(true));
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
            return;
          }
          attempt += 1;
          load(index + 1);
        });
        return;
      }
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = source;
        video.play().catch(() => setPaused(true));
        return;
      }
      setStatus('error');
    };

    load(0);
    return () => {
      disposed = true;
      if (retryRef.current !== null) window.clearTimeout(retryRef.current);
      destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [channelName, live]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume;
    video.muted = muted;
    Storage.set(VOLUME_KEY, volume);
  }, [volume, muted]);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => undefined);
    else video.pause();
  };

  const toggleFullscreen = async () => {
    const node = containerRef.current;
    if (!node) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await node.requestFullscreen();
    } catch {
      /* unsupported */
    }
  };

  const overlay =
    status === 'offline'
      ? live
        ? 'Waiting for stream…'
        : 'Stream is offline'
      : status === 'connecting'
        ? 'Connecting…'
        : status === 'buffering'
          ? 'Buffering…'
          : status === 'error'
            ? 'This browser cannot play HLS'
            : null;

  return (
    <div ref={containerRef} className={cn('group relative flex flex-col overflow-hidden bg-black', className)}>
      <video
        ref={videoRef}
        className="h-full w-full flex-1 object-contain"
        playsInline
        autoPlay
        muted
        onPlaying={() => {
          setStatus('playing');
          setPaused(false);
        }}
        onPause={() => setPaused(true)}
        onWaiting={() => setStatus('buffering')}
        onClick={togglePlay}
      />
      {overlay && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50 text-sm font-medium text-white">{overlay}</div>
      )}
      {live && (
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/80 to-transparent px-2 pt-6 pb-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <IconButton label={paused ? 'Play' : 'Pause'} size="sm" className="text-white hover:bg-white/15" onClick={togglePlay}>
            {paused ? <Play size={18} /> : <Pause size={18} />}
          </IconButton>
          <IconButton label={muted ? 'Unmute' : 'Mute'} size="sm" className="text-white hover:bg-white/15" onClick={() => setMuted((value) => !value)}>
            {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </IconButton>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            aria-label="Volume"
            className="range-input w-24"
            onInput={(event) => {
              setVolume(Number((event.target as HTMLInputElement).value));
              setMuted(false);
            }}
          />
          <span className="live-dot ml-2 text-xs font-bold text-white uppercase">Live</span>
          <span className="flex-1" />
          <IconButton label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} size="sm" className="text-white hover:bg-white/15" onClick={() => void toggleFullscreen()}>
            {fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
          </IconButton>
        </div>
      )}
    </div>
  );
};
