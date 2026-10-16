import { useEffect, useRef, useState } from 'preact/hooks';
import Hls from 'hls.js';
import { Maximize, Minimize, Pause, Play, Volume2, VolumeX } from 'lucide-preact';
import { IconButton } from '@/components';
import { cn } from '@/lib/cn';
import { buildHlsUrlCandidates } from '@/lib/hlsUrls';
import { runtimeUrls } from '@/lib/runtimeConfig';
import { serverConfig } from '@/services/ServerConfigService';
import { Storage } from '@/lib/storage';
import { isTouchPrimary } from '@/lib/device';
import { fetchHlsTicket, HlsTicketError } from './hlsTicket';

type PlayerStatus = 'idle' | 'connecting' | 'playing' | 'buffering' | 'offline' | 'error' | 'denied';

const VOLUME_KEY = 'datasetto.playerVolume';
/** Renew the viewer ticket this long before it expires. */
const TICKET_RENEW_MARGIN_MS = 60_000;
/** After a 401/403 from the HLS endpoint, wait at least this long before asking for another ticket. */
const RETICKET_MIN_INTERVAL_MS = 15_000;

interface HlsPlayerProps {
  channelName: string;
  live: boolean;
  className?: string;
}

/** HLS playback with retries, viewer tickets and minimal custom controls. */
export const HlsPlayer = ({ channelName, live, className }: HlsPlayerProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const retryRef = useRef<number | null>(null);
  const ticketRef = useRef<string | null>(null);
  const [status, setStatus] = useState<PlayerStatus>('idle');
  const [deniedReason, setDeniedReason] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(() => Storage.get<number>(VOLUME_KEY, 0.8));
  const [fullscreen, setFullscreen] = useState(false);
  // Touch screens have no hover: a tap shows the control bar, which hides again after a few seconds.
  const touch = isTouchPrimary();
  const [controlsShown, setControlsShown] = useState(true);
  const [controlsTick, setControlsTick] = useState(0);
  const revealControls = () => {
    setControlsShown(true);
    setControlsTick((value) => value + 1);
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !live) {
      setStatus('offline');
      return;
    }
    const base = serverConfig.get()?.urls.hls ?? runtimeUrls.hlsBaseUrl;
    const candidates = buildHlsUrlCandidates(base, channelName);
    let disposed = false;
    let renewTimer: number | null = null;
    let lastReticket = 0;

    const destroy = () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };

    const scheduleRetry = (delay = 4000) => {
      if (disposed) return;
      retryRef.current = window.setTimeout(() => void start(), delay);
    };

    /** Gets (or renews) the viewer ticket; false when the server refused us. */
    const obtainTicket = async (): Promise<boolean> => {
      try {
        const issued = await fetchHlsTicket(channelName);
        if (disposed) return false;
        ticketRef.current = issued.ticket;
        setDeniedReason(null);
        if (renewTimer !== null) window.clearTimeout(renewTimer);
        const delay = Math.max(15_000, issued.expiresAt - Date.now() - TICKET_RENEW_MARGIN_MS);
        renewTimer = window.setTimeout(() => void obtainTicket(), delay);
        return true;
      } catch (error) {
        if (disposed) return false;
        ticketRef.current = null;
        if (error instanceof HlsTicketError && (error.status === 403 || error.status === 429)) {
          setStatus('denied');
          setDeniedReason(error.message);
          scheduleRetry(30_000);
        } else {
          setStatus('connecting');
          scheduleRetry();
        }
        return false;
      }
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
          // Every playlist and segment request carries the viewer ticket; Caddy checks it with the app.
          xhrSetup: (xhr) => {
            if (ticketRef.current) xhr.setRequestHeader('X-Hls-Ticket', ticketRef.current);
          },
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
          const httpStatus = (data.response as { code?: number } | undefined)?.code;
          if ((httpStatus === 401 || httpStatus === 403) && Date.now() - lastReticket > RETICKET_MIN_INTERVAL_MS) {
            // Ticket expired or was revoked: get a new one and start over (at most once per interval,
            // so a rejected fallback URL cannot turn into a ticket request storm).
            lastReticket = Date.now();
            destroy();
            void start();
            return;
          }
          load(index + 1);
        });
        return;
      }
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS (Safari) cannot add headers; it relies on the ticket cookie the server set.
        video.src = source;
        video.play().catch(() => setPaused(true));
        return;
      }
      setStatus('error');
    };

    const start = async () => {
      if (disposed) return;
      setStatus('connecting');
      if (await obtainTicket()) load(0);
    };

    void start();
    return () => {
      disposed = true;
      if (retryRef.current !== null) window.clearTimeout(retryRef.current);
      if (renewTimer !== null) window.clearTimeout(renewTimer);
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

  useEffect(() => {
    if (!touch || !controlsShown || status !== 'playing') return;
    const timer = window.setTimeout(() => setControlsShown(false), 3000);
    return () => window.clearTimeout(timer);
  }, [touch, controlsShown, controlsTick, status]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => undefined);
    else video.pause();
  };

  const toggleFullscreen = async () => {
    const node = containerRef.current;
    const video = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (!node) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (typeof node.requestFullscreen === 'function') await node.requestFullscreen();
      // iPhone: only the <video> itself can go fullscreen, through WebKit's native player.
      else if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
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
          : status === 'denied'
            ? (deniedReason ?? 'Playback is not available right now')
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
        onClick={() => (touch ? (controlsShown ? setControlsShown(false) : revealControls()) : togglePlay())}
      />
      {overlay && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50 px-6 text-center text-sm font-medium text-white">{overlay}</div>
      )}
      {live && (
        <div
          className={cn(
            'absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/80 to-transparent px-2 pt-6 pb-1 transition-opacity focus-within:opacity-100',
            touch ? (controlsShown ? 'opacity-100' : 'pointer-events-none opacity-0') : 'opacity-0 group-hover:opacity-100',
          )}
          onPointerDown={() => touch && revealControls()}
        >
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
