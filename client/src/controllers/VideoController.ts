import Hls from 'hls.js';
import { config } from '@/config';
import { buildHlsUrlCandidates } from '@/utils/streaming';
import type { ScreenshareSessionEvent } from '@/types';
import type { VideoControllerDeps } from './types';

const STREAM_RETRY_DELAY_MS = 5000;
const SCREENSHARE_VIEWER_JOIN_THROTTLE_MS = 1500;
const DEFAULT_SCREENSHARE_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const normalizeTurnUrl = (url: string): string => {
  if (!url) {
    return '';
  }
  const trimmed = url.trim();
  if (!trimmed) {
    return '';
  }
  if (/^turns?:/i.test(trimmed)) {
    return trimmed;
  }
  return `turn:${trimmed}`;
};

const splitEnvList = (value: string | undefined): string[] => {
  if (!value) {
    return [];
  }
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const SCREENSHARE_ICE_SERVERS: RTCIceServer[] = (() => {
  const envValue = import.meta.env.VITE_SCREENSHARE_ICE_SERVERS;
  if (envValue) {
    try {
      const parsed = JSON.parse(envValue);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as RTCIceServer[];
      }
    } catch (error) {
      console.warn('[VideoController] Failed to parse VITE_SCREENSHARE_ICE_SERVERS:', error);
    }
  }

  const turnUrls = splitEnvList(import.meta.env.VITE_TURN_URL);
  if (turnUrls.length > 0) {
    const username = import.meta.env.VITE_TURN_USERNAME;
    const credential = import.meta.env.VITE_TURN_CREDENTIAL;
    const turnServers = turnUrls.map((entry) => ({
      urls: normalizeTurnUrl(entry),
      ...(username ? { username } : {}),
      ...(credential ? { credential } : {}),
    }));
    return [...DEFAULT_SCREENSHARE_ICE_SERVERS, ...turnServers];
  }

  return DEFAULT_SCREENSHARE_ICE_SERVERS;
})();

const readPositiveNumber = (value?: string): number | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return undefined;
};

const withFallback = (value: string | undefined, fallback: number): number => {
  const parsed = readPositiveNumber(value);
  return parsed ?? fallback;
};

const readBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === null) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
};

const SCREENSHARE_CAPTURE_CONFIG = {
  idealWidth: withFallback(import.meta.env.VITE_SCREENSHARE_IDEAL_WIDTH, 2560),
  idealHeight: withFallback(import.meta.env.VITE_SCREENSHARE_IDEAL_HEIGHT, 1440),
  maxWidth: readPositiveNumber(import.meta.env.VITE_SCREENSHARE_MAX_WIDTH),
  maxHeight: readPositiveNumber(import.meta.env.VITE_SCREENSHARE_MAX_HEIGHT),
  preferNativeResolution: readBoolean(import.meta.env.VITE_SCREENSHARE_PREFER_NATIVE_RESOLUTION, true),
  idealFps: withFallback(import.meta.env.VITE_SCREENSHARE_IDEAL_FPS, 60),
  maxFps: withFallback(import.meta.env.VITE_SCREENSHARE_MAX_FPS, 90),
  minFps: withFallback(import.meta.env.VITE_SCREENSHARE_MIN_FPS, 30),
  maxBitrateKbps: withFallback(config.SCREENSHARE_MAX_BITRATE_KBPS, 12000),
};

const SCREENSHARE_MAX_BITRATE_BPS = SCREENSHARE_CAPTURE_CONFIG.maxBitrateKbps
  ? Math.round(SCREENSHARE_CAPTURE_CONFIG.maxBitrateKbps * 1000)
  : undefined;

type ScreenshareSignalPayload = {
  from: string;
  data: {
    sdp?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
  };
  channelId?: string | null;
};

type DesktopScreenshareSource = {
  id: string;
  name: string;
  isScreen?: boolean;
  type?: 'screen' | 'window';
};

type DesktopScreensharePickResult = {
  success: boolean;
  source?: DesktopScreenshareSource;
  shareAudio?: boolean;
  error?: string;
};

type DesktopScreenshareBridge = {
  pickScreenshareSource?: (options?: { audio?: boolean }) => Promise<DesktopScreensharePickResult>;
};

type ScreenshareDimensions = {
  width?: number;
  height?: number;
};

export class VideoController {
  private deps: VideoControllerDeps;
  private inlineHls: any = null;
  private streamRetryTimer: number | null = null;
  private isDragging = false;
  private dragOffset = { x: 0, y: 0 };
  private isMinimized = false;
  private popoutPipVideo: HTMLVideoElement | null = null;
  private popoutPipContainer: HTMLElement | null = null;
  private mobileStreamMode = false;
  private mobileChatOpen = false;
  private nativeFullscreenActive = false;
  private orientationLocked = false;
  private currentVideoMode: 'idle' | 'stream' | 'screenshare' = 'idle';
  private screenshareStream: MediaStream | null = null;
  private screenshareStreamOrigin: 'local' | 'remote' | null = null;
  private screenshareChannelId: string | null = null;
  private screenshareHostId: string | null = null;
  private screenshareRole: 'idle' | 'host' | 'viewer' = 'idle';
  private screenshareViewerActive = false;
  private screensharePeers: Map<string, RTCPeerConnection> = new Map();
  private desktopBridge: DesktopScreenshareBridge | null = null;
  private screenshareCandidateQueue: Map<string, RTCIceCandidateInit[]> = new Map();
  private screenshareTrackCleanup: Array<() => void> = [];
  private screensharePlaybackCleanup: Array<() => void> = [];
  private screensharePaused = false;
  private screenshareStatusBeforePause: string | null = null;
  private lastScreenshareStatusMessage: string | null = null;
  private lastViewerJoinAttempt = 0;
  private externalPopoutWindow: Window | null = null;
  private externalPopoutVideo: HTMLVideoElement | null = null;
  private externalPopoutStage: HTMLElement | null = null;
  private externalPopoutTitleLabel: HTMLElement | null = null;
  private externalPopoutOverlay: HTMLElement | null = null;
  private playerRetargetedExternally = false;
  private externalPopoutClosing = false;
  private isResizing = false;
  private resizeStart = { width: 0, height: 0, x: 0, y: 0 };

  constructor(deps: VideoControllerDeps) {
    this.deps = deps;

    if (typeof window !== 'undefined') {
      const bridge = (window as typeof window & { desktopAPI?: DesktopScreenshareBridge }).desktopAPI;
      if (bridge) {
        this.desktopBridge = bridge;
      }
    }
  }

  initialize(): void {
    this.registerDomListeners();
    if (!this.shouldUseExternalPopout()) {
      this.setupVideoPopoutDrag();
      this.setupVideoPopoutResize();
    } else {
      const minimizeBtn = this.deps.elements['minimize-video'];
      minimizeBtn?.classList.add('hidden');
    }
    this.updateVolumeDisplay();
    this.syncFullscreenButton(false);
    this.updateMobileChatToggleUI();
    this.registerScreenshareEventHandlers();

    document.addEventListener('fullscreenchange', this.handleNativeFullscreenChange);
    document.addEventListener('webkitfullscreenchange', this.handleNativeFullscreenChange as EventListener);
    this.deps.registerCleanup(() => {
      document.removeEventListener('fullscreenchange', this.handleNativeFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', this.handleNativeFullscreenChange as EventListener);
    });
  }

  handlePlaybackShortcut(event: KeyboardEvent): boolean {
    const container = this.deps.elements.inlineVideoContainer as HTMLElement | undefined;
    if (!container || container.classList.contains('hidden')) {
      return false;
    }

    switch (event.code) {
      case 'Space':
      case 'KeyK':
        event.preventDefault();
        this.togglePlayPause();
        return true;
      case 'KeyF':
        event.preventDefault();
        void this.toggleFullscreen();
        return true;
      case 'KeyM':
        event.preventDefault();
        this.toggleMuteVideo();
        return true;
      case 'ArrowUp':
        event.preventDefault();
        this.adjustVolume(10);
        return true;
      case 'ArrowDown':
        event.preventDefault();
        this.adjustVolume(-10);
        return true;
      default:
        return false;
    }
  }

  handleMobileBreakpointChange(event: MediaQueryListEvent): void {
    if (!event.matches && this.mobileStreamMode) {
      this.setMobileStreamMode(false);
    }
  }

  handleMobileChannelSwitch(type: 'text' | 'voice' | 'stream' | 'screenshare'): void {
    if (!this.isMobileLayout()) {
      return;
    }

    if (type === 'stream' || type === 'screenshare') {
      this.setMobileStreamMode(true);
    } else {
      this.setMobileStreamMode(false);
      this.closeInlineVideo();
    }
  }

  handleTextChannelSelected(_options: { voiceConnected: boolean }): void {
    this.closeInlineVideo();
    if (this.screenshareChannelId) {
      this.resetScreenshareContext();
    }

    if (this.deps.state.get('streamingMode')) {
      this.deps.state.setStreamingMode(false);
      this.closePopout();

      const toggleBtn = this.deps.elements['toggle-video-popout'];
      if (toggleBtn) {
        toggleBtn.textContent = '📺';
      }

      this.deps.notifications.info('Streaming mode disabled');
      return;
    }

    this.closePopout();
  }

  handleVoiceChannelSelected(): void {
    this.closeInlineVideo();
    if (this.screenshareChannelId) {
      this.resetScreenshareContext();
    }
    this.closePopout();
  }

  handleStreamChannelSelected(channelId: string, channelName: string): void {
    if (this.screenshareChannelId) {
      this.resetScreenshareContext();
    }
    this.closePopout();
    void this.showInlineVideo(channelId, channelName);
    this.updateStreamWatchingIndicator();
  }

  handleScreenshareChannelSelected(channelId: string, channelName: string): void {
    this.closePopout();
    if (this.screenshareChannelId && this.screenshareChannelId !== channelId) {
      this.teardownScreenshareSession('channel-switch');
    }
    this.screenshareChannelId = channelId;
    this.prepareScreenshareSurface(channelName);
    this.requestScreenshareViewerJoin('channel-selected');
    this.updateStreamWatchingIndicator();
  }

  toggleVideoPopout(): void {
    if (this.isMobileLayout()) {
      const video = this.deps.elements.video as HTMLVideoElement;
      if (video) {
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        } else {
          video.requestFullscreen().catch(() => {});
        }
      }
      return;
    }

    const streamingMode = this.deps.state.toggleStreamingMode();

    if (streamingMode) {
      const opened = this.openStreamPopout();
      if (opened) {
        this.deps.notifications.info('Streaming mode enabled');
      } else {
        this.deps.state.setStreamingMode(false);
        this.deps.notifications.error('Unable to open stream popout');
      }
      return;
    }

    this.closePopout();
    this.deps.notifications.info('Streaming mode disabled');
  }

  private openStreamPopout(): boolean {
    const btn = this.deps.elements['toggle-video-popout'];

    const video = this.preparePopoutDisplay('Stream');
    if (!video) {
      return false;
    }

    if (btn) {
      btn.textContent = '📺';
    }

    this.detachPopoutMediaStream();
    this.detachPictureInPicture();
    this.maybeRetargetPlayerToExternal(video);

    const channelType = this.deps.state.get('currentChannelType');
    const channelId = this.deps.state.get('currentChannel');
    if (channelType === 'stream' && channelId) {
      const channels = this.deps.state.get('channels') ?? [];
      const match = channels.find((channel) => channel.id === channelId);
      if (match) {
        this.deps.player.loadChannel(match);
      }
    } else {
      this.deps.player.dispose();
    }

    return true;
  }

  showVoicePopout(stream: MediaStream, options?: { label?: string; pipStream?: MediaStream | null; pipLabel?: string }): void {
    const video = this.preparePopoutDisplay(options?.label ?? 'Voice Video');
    if (!video) {
      this.deps.notifications.error('Unable to open voice video popout');
      return;
    }

    if (!stream) {
      this.deps.notifications.warning('Video stream is not available yet');
      return;
    }

    this.detachPopoutMediaStream();
    this.deps.player.dispose();

    try {
      video.srcObject = stream;
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[VideoController] Failed to attach voice stream, retrying:', error);
      }
      video.srcObject = null;
      video.srcObject = stream;
    }

    video.muted = true;
    const playAttempt = video.play();
    if (playAttempt instanceof Promise) {
      playAttempt.catch((error) => {
        if (import.meta.env.DEV) {
          console.warn('[VideoController] Voice popout playback blocked:', error);
        }
      });
    }

    const overlay = this.deps.elements.playerOverlay;
    overlay?.classList.remove('visible');

    if (!this.deps.state.get('streamingMode')) {
      this.deps.state.setStreamingMode(true);
    }

    if (options?.pipStream) {
      this.attachPictureInPicture(options.pipStream, options.pipLabel);
    } else {
      this.detachPictureInPicture();
    }
  }

  private preparePopoutDisplay(title: string): HTMLVideoElement | null {
    if (this.shouldUseExternalPopout()) {
      return this.prepareExternalPopoutWindow(title);
    }

    const popout = this.deps.elements['video-popout'];
    const video = this.deps.elements.video as HTMLVideoElement | undefined;

    if (!popout || !video) {
      return null;
    }

    popout.classList.remove('hidden');
    popout.classList.remove('minimized');
    this.isMinimized = false;
    this.setPopoutTitle(title);
    return video;
  }

  private prepareExternalPopoutWindow(title: string): HTMLVideoElement | null {
    if (!this.externalPopoutWindow || this.externalPopoutWindow.closed) {
      const features = 'width=960,height=540,resizable=yes,scrollbars=no,toolbar=no,menubar=no,location=no,status=no';
      const win = window.open('', 'datasetto-video-popout', features);
      if (!win) {
        return null;
      }

      this.externalPopoutWindow = win;
      const doc = win.document;
      doc.open();
      doc.write('<!DOCTYPE html><html><head><meta charset="utf-8" /></head><body></body></html>');
      doc.close();

      const style = doc.createElement('style');
      style.textContent = `
        :root {
          color-scheme: dark;
          font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        * {
          box-sizing: border-box;
        }
        body {
          margin: 0;
          background: radial-gradient(120% 120% at 0% 0%, #111425, #05060b 65%);
          color: white;
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          padding: 1rem;
          overflow: hidden;
        }
        body.popout-fullscreen {
          padding: 0;
          background: #000;
        }
        body.popout-collapsed .popout-stage {
          max-height: 320px;
        }
        .popout-shell {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 0;
          width: 100%;
        }
        .popout-stage {
          position: relative;
          flex: 1;
          background: #000;
          min-height: 0;
          border-radius: 20px;
          overflow: hidden;
          box-shadow: 0 32px 64px rgba(0, 0, 0, 0.55);
        }
        body.popout-fullscreen .popout-stage {
          border-radius: 0;
          box-shadow: none;
        }
        .popout-video-element {
          width: 100%;
          height: 100%;
          object-fit: contain;
          background: #000;
        }
        .popout-controls {
          position: absolute;
          top: 0.75rem;
          right: 0.75rem;
          display: flex;
          gap: 0.4rem;
          z-index: 3;
        }
        .popout-control-btn {
          width: 34px;
          height: 34px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.25);
          background: rgba(8, 9, 15, 0.7);
          color: white;
          font-size: 0.7rem;
          font-weight: 600;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.2s ease, border-color 0.2s ease;
        }
        .popout-control-btn:hover {
          background: rgba(255, 255, 255, 0.18);
          border-color: rgba(255, 255, 255, 0.35);
        }
        .popout-control-btn.active {
          background: rgba(255, 255, 255, 0.35);
          color: #05060b;
        }
        .popout-pip-host {
          position: absolute;
          right: 1rem;
          bottom: 1rem;
          display: flex;
          flex-direction: column;
          gap: 0.6rem;
          pointer-events: none;
        }
        .popout-pip-tile {
          width: clamp(160px, 22vw, 320px);
          aspect-ratio: 16 / 9;
          border-radius: 14px;
          overflow: hidden;
          background: #000;
          border: 1px solid rgba(255, 255, 255, 0.18);
          box-shadow: 0 18px 36px rgba(0, 0, 0, 0.55);
          position: relative;
          pointer-events: auto;
        }
        .popout-pip-tile video {
          width: 100%;
          height: 100%;
          object-fit: cover;
          background: #000;
        }
        .popout-pip-label {
          position: absolute;
          top: 0.5rem;
          left: 0.5rem;
          padding: 0.2rem 0.55rem;
          border-radius: 999px;
          background: rgba(0, 0, 0, 0.65);
          font-size: 0.75rem;
          font-weight: 600;
        }
        .popout-overlay {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(180deg, rgba(8, 9, 15, 0.65), rgba(8, 9, 15, 0.8));
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.2s ease;
        }
        .popout-overlay.visible {
          opacity: 1;
        }
        .popout-overlay .overlay-content {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.8rem;
        }
        .popout-overlay .spinner {
          width: 44px;
          height: 44px;
          border-radius: 999px;
          border: 4px solid rgba(255, 255, 255, 0.12);
          border-top-color: rgba(255, 255, 255, 0.8);
          animation: popout-spin 1s linear infinite;
        }
        .popout-overlay .message {
          font-size: 0.9rem;
          font-weight: 600;
          letter-spacing: 0.02em;
        }
        @keyframes popout-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `;
      doc.head.appendChild(style);

      const shell = doc.createElement('div');
      shell.className = 'popout-shell';
      const stage = doc.createElement('div');
      stage.className = 'popout-stage';
      const video = doc.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.className = 'popout-video-element';
      const overlay = doc.createElement('div');
      overlay.className = 'popout-overlay visible';
      const overlayContent = doc.createElement('div');
      overlayContent.className = 'overlay-content';
      const spinner = doc.createElement('div');
      spinner.className = 'spinner';
      const message = doc.createElement('p');
      message.className = 'message';
      message.textContent = 'No stream';
      overlayContent.appendChild(spinner);
      overlayContent.appendChild(message);
      overlay.appendChild(overlayContent);
      const controls = doc.createElement('div');
      controls.className = 'popout-controls';
      const fullscreenBtn = doc.createElement('button');
      fullscreenBtn.type = 'button';
      fullscreenBtn.className = 'popout-control-btn popout-control-fullscreen';
      fullscreenBtn.title = 'Enter fullscreen';
      fullscreenBtn.textContent = 'FS';
      const closeBtn = doc.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'popout-control-btn popout-control-close';
      closeBtn.title = 'Close popout';
      closeBtn.textContent = 'X';
      controls.appendChild(fullscreenBtn);
      controls.appendChild(closeBtn);
      const inlineOverlay = this.deps.elements.playerOverlay as HTMLElement | undefined;
      if (inlineOverlay) {
        const inlineMessage = inlineOverlay.querySelector('.message');
        if (inlineMessage) {
          message.textContent = inlineMessage.textContent ?? 'No stream';
        }
        overlay.classList.toggle('visible', inlineOverlay.classList.contains('visible'));
      }
      stage.appendChild(video);
      stage.appendChild(overlay);
      stage.appendChild(controls);

      shell.appendChild(stage);
      doc.body.appendChild(shell);

      win.addEventListener('beforeunload', this.handleExternalPopoutClosed);

      closeBtn.addEventListener('click', () => {
        win.close();
      });

      const syncFullscreenState = (): void => {
        const isFullscreen = !!doc.fullscreenElement;
        fullscreenBtn.classList.toggle('active', isFullscreen);
        doc.body.classList.toggle('popout-fullscreen', isFullscreen);
        fullscreenBtn.textContent = isFullscreen ? 'EX' : 'FS';
        fullscreenBtn.title = isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen';
      };

      const toggleFullscreen = (): void => {
        if (doc.fullscreenElement) {
          if (doc.exitFullscreen) {
            doc.exitFullscreen().catch(() => {
              /* ignore fullscreen exit failures */
            });
          }
          return;
        }
        if (stage.requestFullscreen) {
          stage
            .requestFullscreen()
            .catch((error) => {
              if (import.meta.env.DEV) {
                console.warn('[VideoController] Failed to enter fullscreen', error);
              }
            });
        }
      };

      fullscreenBtn.addEventListener('click', toggleFullscreen);
      doc.addEventListener('fullscreenchange', syncFullscreenState);
      syncFullscreenState();

      this.externalPopoutVideo = video;
      this.externalPopoutStage = stage;
      this.externalPopoutOverlay = overlay;
      this.externalPopoutTitleLabel = null;
    }

    const activeWindow = this.externalPopoutWindow;
    if (activeWindow) {
      this.setPopoutTitle(title);
      activeWindow.focus();
    }

    return this.externalPopoutVideo;
  }

  private shouldUseExternalPopout(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }
    // Always use external popout (new window) for both web and desktop
    return true;
  }

  private getActivePopoutVideo(): HTMLVideoElement | null {
    if (this.shouldUseExternalPopout()) {
      return this.externalPopoutVideo;
    }
    return (this.deps.elements.video as HTMLVideoElement | undefined) ?? null;
  }

  private getPopoutStageElement(): HTMLElement | null {
    if (this.shouldUseExternalPopout()) {
      return this.externalPopoutStage;
    }
    return this.deps.elements['video-popout-stage'];
  }

  private destroyExternalPopoutWindow(): void {
    if (!this.externalPopoutWindow) {
      return;
    }

    this.externalPopoutClosing = true;
    try {
      this.externalPopoutWindow.close();
    } catch {
      // ignore
    }
    this.externalPopoutClosing = false;
    this.clearExternalPopoutRefs();
    this.restoreInlinePlayerTarget();
  }

  private clearExternalPopoutRefs(): void {
    if (this.externalPopoutWindow) {
      this.externalPopoutWindow.removeEventListener('beforeunload', this.handleExternalPopoutClosed);
    }
    this.externalPopoutWindow = null;
    this.externalPopoutVideo = null;
    this.externalPopoutStage = null;
    this.externalPopoutTitleLabel = null;
    this.externalPopoutOverlay = null;
  }

  private handleExternalPopoutClosed = (): void => {
    if (this.externalPopoutClosing) {
      this.clearExternalPopoutRefs();
      this.restoreInlinePlayerTarget();
      return;
    }

    this.clearExternalPopoutRefs();
    this.restoreInlinePlayerTarget();
    this.isMinimized = false;
    this.detachPopoutMediaStream();
    this.deps.player.dispose();
    if (this.deps.state.get('streamingMode')) {
      this.deps.state.setStreamingMode(false);
    }
    this.setPopoutTitle('Stream');
  };

  private restoreInlinePlayerTarget(): void {
    if (!this.playerRetargetedExternally) {
      return;
    }
    const inlineVideo = this.deps.elements.video as HTMLVideoElement | undefined;
    if (!inlineVideo) {
      return;
    }
    const overlay = this.deps.elements.playerOverlay as HTMLElement | undefined;
    this.deps.player.setVideoElement(inlineVideo, overlay ?? null);
    this.playerRetargetedExternally = false;
  }

  private maybeRetargetPlayerToExternal(video: HTMLVideoElement | null): void {
    if (!this.shouldUseExternalPopout() || !video || !this.externalPopoutOverlay) {
      return;
    }
    this.deps.player.setVideoElement(video, this.externalPopoutOverlay);
    this.playerRetargetedExternally = true;
  }

  private setPopoutTitle(title: string): void {
    if (this.shouldUseExternalPopout()) {
      if (this.externalPopoutTitleLabel) {
        this.externalPopoutTitleLabel.textContent = title;
      }
      if (this.externalPopoutWindow && !this.externalPopoutWindow.closed) {
        this.externalPopoutWindow.document.title = `Datasetto — ${title}`;
      }
      return;
    }

    const label = this.deps.elements['video-popout-title'];
    if (label) {
      label.textContent = title;
    }
  }

  private detachPopoutMediaStream(): void {
    const video = this.getActivePopoutVideo();
    if (video) {
      try {
        video.pause();
      } catch {
        // ignore pause errors
      }
      video.removeAttribute('src');
      try {
        video.srcObject = null;
      } catch {
        // Some browsers throw if srcObject was never set.
      }
      video.load();
    }
    this.detachPictureInPicture();
  }

  private attachPictureInPicture(stream: MediaStream, label?: string): void {
    const stage = this.getPopoutStageElement();
    if (!stage) {
      return;
    }

    this.detachPictureInPicture();

    const isExternal = stage.ownerDocument !== document;
    const container = stage.ownerDocument.createElement('div');
    container.className = isExternal ? 'popout-pip-host' : 'screen-share-pip-container';

    const tile = stage.ownerDocument.createElement('div');
    tile.className = isExternal ? 'popout-pip-tile' : 'video-tile pip-tile';

    const video = stage.ownerDocument.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;

    try {
      video.srcObject = stream;
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[VideoController] Failed to attach PiP stream, retrying:', error);
      }
      video.srcObject = null;
      video.srcObject = stream;
    }

    video.play().catch((error) => {
      if (import.meta.env.DEV) {
        console.warn('[VideoController] PiP playback blocked:', error);
      }
    });

    if (label) {
      const overlay = stage.ownerDocument.createElement('div');
      overlay.className = isExternal ? 'popout-pip-label' : 'video-tile-overlay';
      const name = stage.ownerDocument.createElement('span');
      name.className = isExternal ? '' : 'video-tile-name';
      name.textContent = label;
      overlay.appendChild(name);
      tile.appendChild(overlay);
    }

    tile.appendChild(video);
    container.appendChild(tile);
    stage.appendChild(container);

    this.popoutPipVideo = video;
    this.popoutPipContainer = container;
  }

  private detachPictureInPicture(): void {
    if (this.popoutPipVideo) {
      try {
        this.popoutPipVideo.pause();
      } catch {
        // ignore pause errors
      }
      try {
        this.popoutPipVideo.srcObject = null;
      } catch {
        // ignore cleanup issues
      }
    }

    if (this.popoutPipContainer?.parentElement) {
      this.popoutPipContainer.parentElement.removeChild(this.popoutPipContainer);
    }

    this.popoutPipVideo = null;
    this.popoutPipContainer = null;
  }

  minimizeVideo(): void {
    this.isMinimized = !this.isMinimized;

    if (this.shouldUseExternalPopout()) {
      if (this.externalPopoutWindow && !this.externalPopoutWindow.closed) {
        this.externalPopoutWindow.document.body.classList.toggle('popout-collapsed', this.isMinimized);
      }
      return;
    }

    const popout = this.deps.elements['video-popout'];
    if (!popout) {
      return;
    }

    popout.classList.toggle('minimized', this.isMinimized);

    const btn = this.deps.elements['minimize-video'];
    if (btn) {
      btn.textContent = this.isMinimized ? '□' : '—';
      btn.setAttribute('title', this.isMinimized ? 'Restore' : 'Minimize');
    }
  }

  closePopout(): void {
    if (this.shouldUseExternalPopout()) {
      this.detachPopoutMediaStream();
      this.destroyExternalPopoutWindow();
    } else {
      const popout = this.deps.elements['video-popout'];
      if (!popout) {
        return;
      }
      popout.classList.add('hidden');
      popout.classList.remove('minimized');
      this.detachPopoutMediaStream();
    }

    this.isMinimized = false;
    this.deps.player.dispose();
    if (this.deps.state.get('streamingMode')) {
      this.deps.state.setStreamingMode(false);
    }
    this.setPopoutTitle('Stream');
  }

  async showInlineVideo(channelId: string, channelName: string): Promise<void> {
    const container = this.deps.elements.inlineVideoContainer as HTMLElement | undefined;
    const video = this.deps.elements.inlineVideo as HTMLVideoElement | undefined;
    const overlay = this.deps.elements.inlinePlayerOverlay as HTMLElement | undefined;
    const playerColumn = this.deps.elements['streamPlayerColumn'] as HTMLElement | undefined;

    const channels = this.deps.state.get('channels') ?? [];
    const channel = channels.find((ch) => ch.id === channelId) || channels.find((ch) => ch.name === channelName);
    const streamKeyToken = channel?.streamKey;

    if (!container || !video) {
      console.error('Inline video elements not found');
      return;
    }

    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', 'true');

    playerColumn?.classList.remove('hidden');

    const resolvedName = channel?.name ?? channelName;

    const mobileTitle = this.deps.elements.mobileStreamTitle as HTMLElement | undefined;
    if (mobileTitle) {
      mobileTitle.textContent = `Live: ${resolvedName}`;
    }

    if (this.isMobileLayout() && !this.mobileStreamMode) {
      this.setMobileStreamMode(true);
    }

    this.resetInlineVideoSources();

    this.currentVideoMode = 'stream';
    this.screenshareStream = null;

    this.closePopout();

    container.classList.remove('hidden');
    document.body.classList.add('stream-inline-active');
    this.updateLiveIndicator('loading');

    if (overlay) {
      overlay.classList.add('visible');
      const message = overlay.querySelector('.message');
      if (message) {
        message.textContent = 'Connecting to stream...';
      }
    }

    const streamCandidates = buildHlsUrlCandidates(this.deps.hlsBaseUrl, resolvedName, streamKeyToken);

    if (streamCandidates.length === 0) {
      if (overlay) {
        overlay.classList.add('visible');
        const message = overlay.querySelector('.message');
        if (message) {
          message.textContent = 'Stream path unavailable';
        }
      }
      this.updateLiveIndicator('offline');
      return;
    }

    if (import.meta.env.DEV) {
      console.log('Loading inline stream candidates:', streamCandidates);
    }

    const tryCandidate = (index: number): void => {
      if (index >= streamCandidates.length) {
        if (overlay) {
          overlay.classList.add('visible');
          const message = overlay.querySelector('.message');
          if (message) {
            message.textContent = 'Stream unavailable';
          }
        }
        this.updateLiveIndicator('offline');
        return;
      }

      const streamUrl = streamCandidates[index];

      if (overlay) {
        overlay.classList.add('visible');
        const message = overlay.querySelector('.message');
        if (message) {
          message.textContent = 'Connecting to stream...';
        }
      }

      if (this.streamRetryTimer) {
        clearTimeout(this.streamRetryTimer);
        this.streamRetryTimer = null;
      }

      if (this.inlineHls) {
        try {
          this.inlineHls.destroy();
        } catch (error) {
          if (import.meta.env.DEV) {
            console.error('Error destroying HLS instance:', error);
          }
        } finally {
          this.inlineHls = null;
        }
      }

      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          debug: false,
          maxBufferLength: 10,
          maxMaxBufferLength: 30,
          maxBufferSize: 60 * 1000 * 1000,
          maxBufferHole: 0.5,
          highBufferWatchdogPeriod: 2,
          nudgeOffset: 0.1,
          nudgeMaxRetry: 5,
          liveSyncDuration: 3,
          liveMaxLatencyDuration: 10,
          liveDurationInfinity: true,
        });

        this.inlineHls = hls;
        hls.loadSource(streamUrl);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (overlay) {
            overlay.classList.remove('visible');
            overlay.style.cursor = '';
            overlay.onclick = null;
          }

          this.updateLiveIndicator('live');

          this.updateStreamWatchingIndicator();
          this.deps.refreshChannels();

          video.play().catch((err: Error) => {
            console.warn('Autoplay blocked:', err);
            if (overlay) {
              overlay.classList.add('visible');
              const message = overlay.querySelector('.message');
              if (message) {
                message.textContent = 'Click to play';
              }
              overlay.style.cursor = 'pointer';
              overlay.onclick = () => {
                video.play();
                overlay.classList.remove('visible');
                overlay.onclick = null;
                overlay.style.cursor = '';
              };
            }
          });
        });

        hls.on(Hls.Events.ERROR, (_event: unknown, data: any) => {
          console.error('❌ HLS error:', data);
          if (!data?.fatal) {
            return;
          }

          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            if (index + 1 < streamCandidates.length) {
              if (overlay) {
                const message = overlay.querySelector('.message');
                if (message) {
                  message.textContent = 'Retrying alternate stream path...';
                }
              }
              try {
                hls.destroy();
              } catch (destroyError) {
                if (import.meta.env.DEV) {
                  console.error('Error destroying HLS instance:', destroyError);
                }
              } finally {
                this.inlineHls = null;
              }
              window.setTimeout(() => tryCandidate(index + 1), 0);
              return;
            }

            if (overlay) {
              const message = overlay.querySelector('.message');
              if (message) {
                message.textContent = 'Stream Offline - Waiting for stream...';
              }
            }

            if (this.streamRetryTimer) {
              clearTimeout(this.streamRetryTimer);
            }
            try {
              hls.destroy();
            } catch (destroyError) {
              if (import.meta.env.DEV) {
                console.error('Error destroying HLS instance:', destroyError);
              }
            } finally {
              this.inlineHls = null;
            }
            this.streamRetryTimer = window.setTimeout(() => {
              if (this.deps.state.get('currentChannelType') === 'stream') {
                console.log('🔄 Retrying stream connection...');
                tryCandidate(0);
              }
              this.streamRetryTimer = null;
            }, STREAM_RETRY_DELAY_MS);
            this.updateLiveIndicator('offline');
            return;
          }

          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            if (overlay) {
              const message = overlay.querySelector('.message');
              if (message) {
                message.textContent = 'Media error - Recovering...';
              }
            }
            this.inlineHls?.recoverMediaError();
            return;
          }

          if (overlay) {
            const message = overlay.querySelector('.message');
            if (message) {
              message.textContent = 'Stream error';
            }
          }
          this.updateLiveIndicator('offline');
        });

        return;
      }

      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        if (import.meta.env.DEV) {
          console.log('Using native HLS support');
        }

        const handleError = () => {
          video.removeEventListener('error', handleError);
          tryCandidate(index + 1);
        };

        video.addEventListener('error', handleError, { once: true });
        video.src = streamUrl;
        video.addEventListener('loadeddata', () => {
          if (overlay) {
            overlay.classList.remove('visible');
            overlay.style.cursor = '';
            overlay.onclick = null;
          }
          this.updateLiveIndicator('live');
        }, { once: true });
        video.play().catch((err: Error) => {
          console.warn('Autoplay blocked:', err);
        });
        return;
      }

      console.error('HLS not supported in this browser');
      if (overlay) {
        const message = overlay.querySelector('.message');
        if (message) {
          message.textContent = 'HLS not supported';
        }
      }
      this.updateLiveIndicator('offline');
    };

    tryCandidate(0);
  }

  private prepareScreenshareSurface(channelName: string): void {
    const container = this.deps.elements.inlineVideoContainer as HTMLElement | undefined;
    const video = this.deps.elements.inlineVideo as HTMLVideoElement | undefined;
    const overlay = this.deps.elements.inlinePlayerOverlay as HTMLElement | undefined;
    const playerColumn = this.deps.elements['streamPlayerColumn'] as HTMLElement | undefined;
    const controls = this.deps.elements.screenshareControls as HTMLElement | undefined;

    if (!container || !video) {
      console.error('Inline video elements not found');
      return;
    }

    this.resetInlineVideoSources();
    this.currentVideoMode = 'screenshare';
    this.screenshareStream = null;
    this.screenshareStreamOrigin = null;

    video.playsInline = true;
    video.autoplay = true;
    video.muted = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', 'true');

    container.classList.remove('hidden');
    playerColumn?.classList.remove('hidden');
    controls?.classList.remove('hidden');
    document.body.classList.add('stream-inline-active');
    this.updateLiveIndicator('loading');
    this.updateScreenshareStatus('Checking for active screenshares…', { busy: true });
    this.updateScreenshareButtonsState();

    if (overlay) {
      overlay.classList.add('visible');
      const message = overlay.querySelector('.message');
      if (message) {
        message.textContent = 'Waiting for screenshare...';
      }
      overlay.style.cursor = 'default';
      overlay.onclick = null;
    }

    const mobileTitle = this.deps.elements.mobileStreamTitle as HTMLElement | undefined;
    if (mobileTitle) {
      mobileTitle.textContent = `Screenshare: ${channelName}`;
    }

    if (this.isMobileLayout() && !this.mobileStreamMode) {
      this.setMobileStreamMode(true);
    }
  }

  attachScreenshareStream(stream: MediaStream, options: { local?: boolean } = {}): void {
    const video = this.deps.elements.inlineVideo as HTMLVideoElement | undefined;

    if (!video) {
      return;
    }

    this.currentVideoMode = 'screenshare';
    this.screenshareStream = stream;
    this.screenshareStreamOrigin = options.local ? 'local' : 'remote';

    try {
      video.srcObject = stream;
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('Unable to attach screenshare stream:', error);
      }
      video.srcObject = null;
      video.srcObject = stream;
    }

    video.muted = Boolean(options.local);
    const playAttempt = video.play();
    if (playAttempt instanceof Promise) {
      playAttempt.catch((error) => {
        if (import.meta.env.DEV) {
          console.warn('Screenshare autoplay blocked:', error);
        }
      });
    }

    this.setScreenshareOverlay('hidden');
    this.bindScreensharePlaybackState(stream);
    this.updateLiveIndicator('live');
    this.updateStreamWatchingIndicator();
  }

  clearScreenshareStream(message = 'Screenshare offline'): void {
    if (this.currentVideoMode !== 'screenshare') {
      return;
    }

    this.screenshareStream = null;
    this.screenshareStreamOrigin = null;
    this.resetInlineVideoSources();
    this.setScreenshareOverlay('offline', message);

    this.updateLiveIndicator('offline');
    this.updateStreamWatchingIndicator();
    this.updateScreenshareStatus(message);
  }

  private bindScreensharePlaybackState(stream: MediaStream): void {
    this.clearScreensharePlaybackState();

    if (this.currentVideoMode !== 'screenshare') {
      return;
    }

    const [videoTrack] = stream.getVideoTracks();
    if (!videoTrack) {
      this.applyScreensharePauseState(false);
      return;
    }

    const handleMute = (): void => this.applyScreensharePauseState(true);
    const handleUnmute = (): void => this.applyScreensharePauseState(false);

    videoTrack.addEventListener('mute', handleMute);
    videoTrack.addEventListener('unmute', handleUnmute);
    this.screensharePlaybackCleanup.push(() => {
      videoTrack.removeEventListener('mute', handleMute);
      videoTrack.removeEventListener('unmute', handleUnmute);
    });

    if (videoTrack.muted) {
      this.applyScreensharePauseState(true);
    } else {
      this.applyScreensharePauseState(false);
    }
  }

  private clearScreensharePlaybackState(): void {
    for (const dispose of this.screensharePlaybackCleanup.splice(0)) {
      try {
        dispose();
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('[VideoController] Failed to dispose screenshare playback listener:', error);
        }
      }
    }
  }

  private applyScreensharePauseState(paused: boolean): void {
    if (this.currentVideoMode !== 'screenshare' || this.screensharePaused === paused) {
      return;
    }

    if (paused) {
      if (!this.screenshareStatusBeforePause) {
        this.screenshareStatusBeforePause = this.lastScreenshareStatusMessage;
      }
      this.screensharePaused = true;
      this.setScreenshareOverlay('paused', 'Screenshare paused — bring the shared window back on screen');
      this.updateScreenshareStatus('Screenshare paused — source hidden', { tone: 'warning' });
    } else {
      this.screensharePaused = false;
      this.setScreenshareOverlay('hidden');
      const resumeMessage = this.screenshareStatusBeforePause
        || (this.screenshareRole === 'host' ? 'You are sharing your screen' : 'Watching live screenshare');
      this.screenshareStatusBeforePause = null;
      this.updateScreenshareStatus(resumeMessage);
    }
  }

  private setScreenshareOverlay(state: 'hidden' | 'paused' | 'offline', message?: string): void {
    const overlay = this.deps.elements.inlinePlayerOverlay as HTMLElement | undefined;
    if (!overlay) {
      return;
    }

    if (state === 'hidden') {
      overlay.classList.remove('visible');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.dataset.state = 'hidden';
      return;
    }

    overlay.classList.add('visible');
    overlay.setAttribute('aria-hidden', 'false');
    overlay.dataset.state = state;
    const label = overlay.querySelector('.message');
    if (label && message) {
      label.textContent = message;
    }
  }

  private resetInlineVideoSources(): void {
    if (this.streamRetryTimer) {
      clearTimeout(this.streamRetryTimer);
      this.streamRetryTimer = null;
    }

    this.clearScreensharePlaybackState();
    this.screensharePaused = false;
    this.screenshareStatusBeforePause = null;
    this.setScreenshareOverlay('hidden');
    this.screenshareStreamOrigin = null;

    if (this.inlineHls) {
      try {
        this.inlineHls.destroy();
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error('Error destroying HLS instance:', error);
        }
      } finally {
        this.inlineHls = null;
      }
    }

    const video = this.deps.elements.inlineVideo as HTMLVideoElement | undefined;
    if (video) {
      try {
        video.pause();
      } catch {
        // noop
      }
      video.removeAttribute('src');
      try {
        video.srcObject = null;
      } catch {
        // Ignore potential errors when clearing srcObject
      }
      video.load();
    }
  }

  closeInlineVideo(): void {
    const container = this.deps.elements.inlineVideoContainer as HTMLElement | undefined;
    const video = this.deps.elements.inlineVideo as HTMLVideoElement | undefined;
    const playerColumn = this.deps.elements['streamPlayerColumn'] as HTMLElement | undefined;

    if (this.streamRetryTimer) {
      clearTimeout(this.streamRetryTimer);
      this.streamRetryTimer = null;
    }

    if (this.inlineHls) {
      try {
        this.inlineHls.destroy();
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error('Error destroying HLS instance:', error);
        }
      } finally {
        this.inlineHls = null;
      }
    }

    if (video) {
      video.pause();
      video.removeAttribute('src');
      try {
        video.srcObject = null;
      } catch {
        // Ignore; srcObject may already be null in some browsers.
      }
      video.load();
    }

    if (container) {
      if (container.classList.contains('fullscreen')) {
        container.classList.remove('fullscreen');
        document.body.classList.remove('stream-fullscreen-active');
        this.syncFullscreenButton(false);
      }
      container.classList.add('hidden');
    }

    playerColumn?.classList.add('hidden');

    this.syncChatDockState(false);
    document.body.classList.remove('stream-inline-active');
    this.updateLiveIndicator('hidden');

    this.currentVideoMode = 'idle';
    this.screenshareStream = null;
    if (this.screenshareChannelId) {
      this.hideScreenshareControls();
      this.teardownScreenshareSession('player-closed');
    }

    const overlay = this.deps.elements.inlinePlayerOverlay as HTMLElement | undefined;
    if (overlay) {
      const message = overlay.querySelector('.message');
      if (message) {
        message.textContent = 'No stream';
      }
    }

    this.updateStreamWatchingIndicator();
    this.deps.refreshChannels();

    if (this.mobileStreamMode && this.isMobileLayout()) {
      this.mobileStreamMode = false;
      this.mobileChatOpen = false;
      const app = this.deps.elements.app;
      app?.classList.remove('mobile-stream-mode', 'mobile-chat-open');
      document.body.classList.remove('mobile-chat-open');
      this.updateMobileChatToggleUI();
    }
  }

  private async startScreenshareCapture(): Promise<void> {
    if (!this.screenshareChannelId) {
      this.deps.notifications.warning('Select a screenshare room first');
      return;
    }

    const nativePickerSupported = Boolean(navigator.mediaDevices?.getDisplayMedia);
    const desktopBridgeAvailable = Boolean(this.desktopBridge?.pickScreenshareSource);

    if (!nativePickerSupported && !desktopBridgeAvailable) {
      this.deps.notifications.error('Screensharing is not supported in this browser');
      return;
    }

    if (this.screenshareRole === 'host') {
      this.deps.notifications.info('You are already sharing your screen');
      return;
    }

    const startBtn = this.deps.elements.screenshareStartBtn as HTMLButtonElement | undefined;
    try {
      startBtn?.setAttribute('disabled', 'true');
      this.updateScreenshareStatus('Select what to share…', { busy: true });

      const captureDimensions = this.resolveScreenshareDimensions();
      const videoConstraints = this.buildScreenshareVideoConstraints(captureDimensions);
      const constraints: MediaStreamConstraints = {
        video: videoConstraints,
        audio: true,
      };

      let stream: MediaStream | null = null;
      let desktopCancelled = false;

      if (desktopBridgeAvailable) {
        const desktopResult = await this.requestDesktopScreenshareStream(videoConstraints, Boolean(constraints.audio));
        stream = desktopResult.stream;
        desktopCancelled = desktopResult.cancelled;
      }

      if (!stream && desktopCancelled) {
        this.updateScreenshareStatus('Screenshare cancelled', { tone: 'warning' });
        return;
      }

      if (!stream && nativePickerSupported) {
        stream = await navigator.mediaDevices.getDisplayMedia(constraints);
      }

      if (!stream) {
        throw new Error('Screen capture stream unavailable');
      }

      await this.applyScreenshareTrackConfiguration(stream, videoConstraints);
      this.beginHostSession(stream);
    } catch (error) {
      const denied = error && typeof error === 'object' && 'name' in error && error.name === 'NotAllowedError';
      if (denied) {
        this.deps.notifications.warning('Screen capture was blocked. Please allow access and try again.');
        this.updateScreenshareStatus('Screenshare permission denied', { tone: 'warning' });
      } else {
        this.deps.notifications.error('Unable to start screenshare');
        this.updateScreenshareStatus('Screenshare cancelled', { tone: 'error' });
      }
      console.error('[VideoController] Screenshare capture failed:', error);
    } finally {
      startBtn?.removeAttribute('disabled');
      this.updateScreenshareButtonsState();
    }
  }

  private async requestDesktopScreenshareStream(
    videoConstraints: MediaTrackConstraints,
    wantsAudio: boolean
  ): Promise<{ stream: MediaStream | null; cancelled: boolean }> {
    if (!this.desktopBridge?.pickScreenshareSource) {
      return { stream: null, cancelled: false };
    }

    try {
      const selection = await this.desktopBridge.pickScreenshareSource({ audio: wantsAudio });
      if (!selection?.success || !selection.source) {
        const cancelled = selection?.error === 'cancelled';
        return { stream: null, cancelled };
      }

      const sourceId = selection.source.id;
      const resolvedWidth = this.extractConstraintNumber(videoConstraints.width as ConstrainULongRange | number | undefined);
      const resolvedHeight = this.extractConstraintNumber(videoConstraints.height as ConstrainULongRange | number | undefined);
      const frameRateConstraint = videoConstraints.frameRate as ConstrainDoubleRange | number | undefined;
      const minFrameRate = this.extractConstraintNumber(
        typeof frameRateConstraint === 'object' ? frameRateConstraint.min : frameRateConstraint
      );
      const maxFrameRate = this.extractConstraintNumber(
        typeof frameRateConstraint === 'object' ? frameRateConstraint.max : frameRateConstraint
      );

      const mandatoryVideo = {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        ...(resolvedWidth
          ? {
              minWidth: Math.round(resolvedWidth),
              maxWidth: Math.round(resolvedWidth),
            }
          : {}),
        ...(resolvedHeight
          ? {
              minHeight: Math.round(resolvedHeight),
              maxHeight: Math.round(resolvedHeight),
            }
          : {}),
        ...(typeof minFrameRate === 'number' ? { minFrameRate: Math.round(minFrameRate) } : {}),
        ...(typeof maxFrameRate === 'number' ? { maxFrameRate: Math.round(maxFrameRate) } : {}),
      };

      const isScreen = Boolean(selection.source.isScreen || selection.source.type === 'screen');
      const enableAudio = Boolean(wantsAudio && selection.shareAudio);
      const audioConstraints: MediaTrackConstraints | boolean = enableAudio
        ? ({
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
            },
          } as unknown as MediaTrackConstraints)
        : false;

      const desktopConstraints: MediaStreamConstraints = {
        video: { mandatory: mandatoryVideo } as unknown as MediaTrackConstraints,
        audio: audioConstraints,
      };

      const stream = await navigator.mediaDevices.getUserMedia(desktopConstraints);
      return { stream, cancelled: false };
    } catch (error) {
      console.error('[VideoController] Desktop capture fallback failed:', error);
      return { stream: null, cancelled: false };
    }
  }

  private beginHostSession(stream: MediaStream): void {
    if (!this.screenshareChannelId) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    this.teardownScreensharePeers();
    this.stopLocalScreenshareStream();

    this.screenshareStream = stream;
    this.screenshareStreamOrigin = 'local';
    this.screenshareRole = 'host';
    this.screenshareHostId = this.deps.socket.getId();
    this.attachScreenshareStream(stream, { local: true });
    this.updateScreenshareStatus('Starting screenshare…', { busy: true });
    this.updateScreenshareButtonsState();

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      const handleTrackEnded = (): void => {
        videoTrack.removeEventListener('ended', handleTrackEnded);
        this.stopScreenshare('track-ended');
      };
      videoTrack.addEventListener('ended', handleTrackEnded);
      this.screenshareTrackCleanup.push(() => videoTrack.removeEventListener('ended', handleTrackEnded));
    }

    this.deps.socket.startScreenshare(this.screenshareChannelId);
  }

  private stopScreenshare(reason: string, notifyServer = true): void {
    if (this.screenshareRole !== 'host') {
      return;
    }

    if (notifyServer && this.screenshareChannelId) {
      this.deps.socket.stopScreenshare(this.screenshareChannelId);
    }

    this.stopLocalScreenshareStream();
    this.teardownScreensharePeers();
    this.screenshareRole = 'idle';
    this.screenshareViewerActive = false;
    this.screenshareHostId = null;
    this.updateScreenshareButtonsState();
    this.clearScreenshareStream(reason === 'user-requested' ? 'Screenshare stopped' : 'Screenshare offline');
  }

  private registerScreenshareEventHandlers(): void {
    const subscriptions: Array<() => void> = [];
    subscriptions.push(this.deps.socket.on('screenshare:session', (event) => this.handleScreenshareSession(event)));
    subscriptions.push(this.deps.socket.on('screenshare:signal', (payload) => void this.handleScreenshareSignal(payload as ScreenshareSignalPayload)));
    subscriptions.push(this.deps.socket.on('screenshare:viewer:pending', (payload) => this.handleScreenshareViewerPending(payload)));
    subscriptions.push(this.deps.socket.on('screenshare:error', (payload) => this.handleScreenshareError(payload)));

    this.deps.registerCleanup(() => {
      subscriptions.forEach((unsubscribe) => unsubscribe?.());
    });
  }

  private handleScreenshareSession(event: ScreenshareSessionEvent): void {
    if (!this.screenshareChannelId || event.channelId !== this.screenshareChannelId) {
      return;
    }

    if (!event.active) {
      if (this.screenshareRole !== 'idle' || this.screenshareViewerActive) {
        this.teardownScreenshareSession('host-ended');
      }
      this.screenshareHostId = null;
      this.updateScreenshareButtonsState();
      this.updateScreenshareStatus('No one is sharing yet. Click start to go live.');
      return;
    }

    this.screenshareHostId = event.hostId;
    const socketId = this.deps.socket.getId();
    const isSelfHost = Boolean(socketId && event.hostId === socketId);

    if (isSelfHost) {
      this.screenshareRole = 'host';
      this.updateScreenshareButtonsState();
      this.updateScreenshareStatus('You are sharing your screen');
      return;
    }

    this.screenshareRole = 'viewer';
    this.updateScreenshareStatus(`Live now: ${event.hostName ?? 'Screenshare'}`);
    this.updateScreenshareButtonsState();
    this.requestScreenshareViewerJoin('session-active', true);
  }

  private async handleScreenshareSignal(payload: ScreenshareSignalPayload): Promise<void> {
    if (!this.screenshareChannelId || (payload.channelId && payload.channelId !== this.screenshareChannelId)) {
      return;
    }

    if (!payload.from || !payload.data) {
      return;
    }

    if (this.screenshareRole === 'host') {
      await this.handleHostSignal(payload);
    } else {
      await this.handleViewerSignal(payload);
    }
  }

  private async handleViewerSignal(payload: ScreenshareSignalPayload): Promise<void> {
    const hostId = payload.from;
    const { sdp, candidate } = payload.data ?? {};
    const peer = this.ensureViewerPeer(hostId);

    try {
      if (sdp && sdp.type === 'offer') {
        await peer.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        this.deps.socket.sendScreenshareSignal(hostId, { sdp: answer }, this.screenshareChannelId);
        this.screenshareViewerActive = true;
        this.flushCandidateQueue(hostId);
        this.updateScreenshareStatus('Watching live screenshare');
      } else if (candidate) {
        if (peer.remoteDescription) {
          await peer.addIceCandidate(candidate);
        } else {
          this.queueCandidate(hostId, candidate);
        }
      }
    } catch (error) {
      console.error('[VideoController] Viewer signal error:', error);
      this.teardownScreenshareSession('signal-error');
      this.deps.notifications.error('Screenshare connection failed. Please try again.');
    }
  }

  private async handleHostSignal(payload: ScreenshareSignalPayload): Promise<void> {
    const viewerId = payload.from;
    const { sdp, candidate } = payload.data ?? {};
    const peer = this.screensharePeers.get(viewerId);
    if (!peer) {
      return;
    }

    try {
      if (sdp && sdp.type === 'answer') {
        await peer.setRemoteDescription(new RTCSessionDescription(sdp));
        this.flushCandidateQueue(viewerId);
      } else if (candidate) {
        if (peer.remoteDescription) {
          await peer.addIceCandidate(candidate);
        } else {
          this.queueCandidate(viewerId, candidate);
        }
      }
    } catch (error) {
      console.error('[VideoController] Host signal error:', error);
    }
  }

  private handleScreenshareViewerPending(payload: { channelId: string; viewerId: string; viewerName: string }): void {
    if (!this.screenshareChannelId || payload.channelId !== this.screenshareChannelId) {
      return;
    }

    if (this.screenshareRole !== 'host') {
      return;
    }

    const peer = this.ensureHostPeer(payload.viewerId);
    if (!peer) {
      return;
    }

    void this.createOfferForViewer(payload.viewerId, peer, payload.viewerName);
  }

  private async createOfferForViewer(viewerId: string, peer: RTCPeerConnection, viewerName?: string): Promise<void> {
    try {
      const offer = await peer.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await peer.setLocalDescription(offer);
      this.deps.socket.sendScreenshareSignal(viewerId, { sdp: offer }, this.screenshareChannelId);
      this.flushCandidateQueue(viewerId);
      if (viewerName) {
        this.updateScreenshareStatus(`Sharing with ${viewerName}`);
      }
    } catch (error) {
      console.error('[VideoController] Failed to create viewer offer:', error);
    }
  }

  private handleScreenshareError(payload: { channelId?: string | null; message: string; code?: string }): void {
    if (payload?.channelId && this.screenshareChannelId && payload.channelId !== this.screenshareChannelId) {
      return;
    }

    if (payload?.message) {
      this.deps.notifications.error(payload.message);
    }

    if (payload?.code === 'SCREENSHARE_START_FAILED' && this.screenshareRole === 'host') {
      this.stopScreenshare('error', false);
    }
  }

  private ensureViewerPeer(hostId: string): RTCPeerConnection {
    let peer = this.screensharePeers.get(hostId);
    if (peer) {
      return peer;
    }

    peer = new RTCPeerConnection({ iceServers: SCREENSHARE_ICE_SERVERS });
    peer.onicecandidate = (event) => {
      if (event.candidate && this.screenshareChannelId) {
        const candidate = typeof event.candidate.toJSON === 'function'
          ? event.candidate.toJSON()
          : (event.candidate as RTCIceCandidateInit);
        this.deps.socket.sendScreenshareSignal(hostId, { candidate }, this.screenshareChannelId);
      }
    };
    peer.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (remoteStream) {
        this.attachScreenshareStream(remoteStream, { local: false });
      }
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected' || peer.connectionState === 'closed') {
        this.screensharePeers.delete(hostId);
        this.screenshareCandidateQueue.delete(hostId);
      }
    };

    this.screensharePeers.set(hostId, peer);
    this.screenshareCandidateQueue.set(hostId, []);
    return peer;
  }

  private ensureHostPeer(viewerId: string): RTCPeerConnection | null {
    const stream = this.screenshareStream;
    if (!stream) {
      return null;
    }

    let peer = this.screensharePeers.get(viewerId);
    if (peer) {
      return peer;
    }

    peer = new RTCPeerConnection({ iceServers: SCREENSHARE_ICE_SERVERS });
    stream.getTracks().forEach((track) => {
      try {
        peer!.addTrack(track, stream);
      } catch (error) {
        console.error('[VideoController] Failed to add track to screenshare peer:', error);
      }
    });
    this.applyScreenshareEncodingPreferences(peer);

    peer.onicecandidate = (event) => {
      if (event.candidate && this.screenshareChannelId) {
        const candidate = typeof event.candidate.toJSON === 'function'
          ? event.candidate.toJSON()
          : (event.candidate as RTCIceCandidateInit);
        this.deps.socket.sendScreenshareSignal(viewerId, { candidate }, this.screenshareChannelId);
      }
    };
    peer.onconnectionstatechange = () => {
      if (peer && (peer.connectionState === 'failed' || peer.connectionState === 'disconnected' || peer.connectionState === 'closed')) {
        this.screensharePeers.delete(viewerId);
        this.screenshareCandidateQueue.delete(viewerId);
      }
    };

    this.screensharePeers.set(viewerId, peer);
    this.screenshareCandidateQueue.set(viewerId, []);
    return peer;
  }

  private applyScreenshareEncodingPreferences(peer: RTCPeerConnection): void {
    peer.getSenders()
      .filter((sender) => sender.track?.kind === 'video')
      .forEach((sender) => {
        const parameters = sender.getParameters();
        if (!parameters.encodings || parameters.encodings.length === 0) {
          parameters.encodings = [{}];
        }
        const encoding = parameters.encodings[0] as RTCRtpEncodingParameters & {
          scalabilityMode?: string;
          priority?: string;
        };
        let dirty = false;

        if (SCREENSHARE_MAX_BITRATE_BPS && encoding.maxBitrate !== SCREENSHARE_MAX_BITRATE_BPS) {
          encoding.maxBitrate = SCREENSHARE_MAX_BITRATE_BPS;
          dirty = true;
        }

        if (SCREENSHARE_CAPTURE_CONFIG.maxFps && encoding.maxFramerate !== SCREENSHARE_CAPTURE_CONFIG.maxFps) {
          encoding.maxFramerate = SCREENSHARE_CAPTURE_CONFIG.maxFps;
          dirty = true;
        }

        if (!encoding.scalabilityMode) {
          encoding.scalabilityMode = 'L1T3';
          dirty = true;
        }

        if (encoding.priority !== 'high') {
          encoding.priority = 'high';
          dirty = true;
        }

        if (parameters.degradationPreference !== 'maintain-resolution') {
          parameters.degradationPreference = 'maintain-resolution';
          dirty = true;
        }

        if (dirty) {
          void sender.setParameters(parameters).catch((error) => {
            if (import.meta.env.DEV) {
              console.warn('[VideoController] Failed to apply screenshare encoding preferences:', error);
            }
          });
        }
      });
  }

  private resolveScreenshareDimensions(): ScreenshareDimensions {
    const fallback: ScreenshareDimensions = {
      width: SCREENSHARE_CAPTURE_CONFIG.idealWidth,
      height: SCREENSHARE_CAPTURE_CONFIG.idealHeight,
    };

    if (!SCREENSHARE_CAPTURE_CONFIG.preferNativeResolution || typeof window === 'undefined') {
      return fallback;
    }

    try {
      const dpr = window.devicePixelRatio || 1;
      const baseWidth = window.screen?.width ?? fallback.width ?? SCREENSHARE_CAPTURE_CONFIG.idealWidth;
      const baseHeight = window.screen?.height ?? fallback.height ?? SCREENSHARE_CAPTURE_CONFIG.idealHeight;
      const screenWidth = Math.round(baseWidth * dpr);
      const screenHeight = Math.round(baseHeight * dpr);

      const widthLimit = SCREENSHARE_CAPTURE_CONFIG.maxWidth ?? screenWidth;
      const heightLimit = SCREENSHARE_CAPTURE_CONFIG.maxHeight ?? screenHeight;

      return {
        width: Math.min(screenWidth, widthLimit) || fallback.width,
        height: Math.min(screenHeight, heightLimit) || fallback.height,
      };
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[VideoController] Failed to resolve native display dimensions:', error);
      }
      return fallback;
    }
  }

  private buildScreenshareVideoConstraints(dimensions: ScreenshareDimensions): MediaTrackConstraints {
    const constraints: MediaTrackConstraints & { cursor?: 'always' | 'motion' | 'never' } = {
      frameRate: {
        ideal: SCREENSHARE_CAPTURE_CONFIG.idealFps,
        max: SCREENSHARE_CAPTURE_CONFIG.maxFps,
      },
      cursor: 'always',
    };

    const resolvedWidth = dimensions.width ?? SCREENSHARE_CAPTURE_CONFIG.idealWidth;
    const resolvedHeight = dimensions.height ?? SCREENSHARE_CAPTURE_CONFIG.idealHeight;

    const maxWidth = SCREENSHARE_CAPTURE_CONFIG.maxWidth ?? resolvedWidth;
    const maxHeight = SCREENSHARE_CAPTURE_CONFIG.maxHeight ?? resolvedHeight;

    constraints.width = {
      ideal: resolvedWidth,
      max: Math.max(resolvedWidth, maxWidth),
    };

    constraints.height = {
      ideal: resolvedHeight,
      max: Math.max(resolvedHeight, maxHeight),
    };

    const aspectWidth = this.extractConstraintNumber(constraints.width as ConstrainULongRange | number | undefined);
    const aspectHeight = this.extractConstraintNumber(constraints.height as ConstrainULongRange | number | undefined);
    if (aspectWidth && aspectHeight && aspectHeight > 0) {
      constraints.aspectRatio = aspectWidth / aspectHeight;
    }

    return constraints;
  }

  private async applyScreenshareTrackConfiguration(stream: MediaStream, constraints: MediaTrackConstraints): Promise<void> {
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      return;
    }

    try {
      await videoTrack.applyConstraints(constraints);
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[VideoController] Failed to apply post-capture constraints:', error);
      }
    }

    try {
      videoTrack.contentHint = 'detail';
    } catch {
      // Ignore if the browser disallows custom content hints
    }
  }

  private extractConstraintNumber(value: ConstrainULongRange | ConstrainDoubleRange | number | undefined): number | undefined {
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'object' && value !== null) {
      if (typeof value.exact === 'number') {
        return value.exact;
      }
      if (typeof value.ideal === 'number') {
        return value.ideal;
      }
      if (typeof value.max === 'number') {
        return value.max;
      }
      if (typeof value.min === 'number') {
        return value.min;
      }
    }
    return undefined;
  }

  private queueCandidate(peerId: string, candidate: RTCIceCandidateInit): void {
    if (!this.screenshareCandidateQueue.has(peerId)) {
      this.screenshareCandidateQueue.set(peerId, []);
    }
    this.screenshareCandidateQueue.get(peerId)!.push(candidate);
  }

  private flushCandidateQueue(peerId: string): void {
    const queue = this.screenshareCandidateQueue.get(peerId);
    if (!queue?.length) {
      return;
    }

    const peer = this.screensharePeers.get(peerId);
    if (!peer || !peer.remoteDescription) {
      return;
    }

    while (queue.length > 0) {
      const candidate = queue.shift();
      if (candidate) {
        void peer.addIceCandidate(candidate).catch((error) => {
          console.warn('[VideoController] Failed to add queued ICE candidate:', error);
        });
      }
    }
  }

  private teardownScreensharePeers(): void {
    for (const peer of this.screensharePeers.values()) {
      try {
        peer.onicecandidate = null;
        peer.ontrack = null;
        peer.close();
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('[VideoController] Error closing screenshare peer:', error);
        }
      }
    }
    this.screensharePeers.clear();
    this.screenshareCandidateQueue.clear();
  }

  private stopLocalScreenshareStream(): void {
    if (this.screenshareStreamOrigin !== 'local' || !this.screenshareStream) {
      return;
    }

    this.screenshareTrackCleanup.forEach((cleanup) => cleanup());
    this.screenshareTrackCleanup = [];

    this.screenshareStream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        // Ignore
      }
    });

    this.screenshareStream = null;
    this.screenshareStreamOrigin = null;
  }

  private teardownScreenshareSession(reason: string, notifyServer = true): void {
    if (!this.screenshareChannelId) {
      return;
    }

    if (this.screenshareRole === 'host') {
      this.stopScreenshare(reason, notifyServer);
      return;
    }

    if (this.screenshareViewerActive && notifyServer) {
      this.deps.socket.leaveScreenshareChannel(this.screenshareChannelId);
    }

    this.screenshareViewerActive = false;
    this.screenshareRole = 'idle';
    this.lastViewerJoinAttempt = 0;
    this.teardownScreensharePeers();
    this.updateScreenshareButtonsState();

    if (this.currentVideoMode === 'screenshare') {
      this.clearScreenshareStream('Screenshare offline');
    }
  }

  private resetScreenshareContext(): void {
    if (!this.screenshareChannelId) {
      return;
    }

    this.teardownScreenshareSession('channel-exit');
    this.screenshareChannelId = null;
    this.screenshareHostId = null;
    this.lastViewerJoinAttempt = 0;
    this.hideScreenshareControls();
    this.updateScreenshareStatus('Select a screenshare room to get started.');
    this.updateScreenshareButtonsState();
  }

  private requestScreenshareViewerJoin(reason: string, force = false): void {
    if (!this.screenshareChannelId || this.screenshareRole === 'host') {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastViewerJoinAttempt < SCREENSHARE_VIEWER_JOIN_THROTTLE_MS) {
      return;
    }

    this.lastViewerJoinAttempt = now;
    this.deps.socket.joinScreenshareChannel(this.screenshareChannelId);

    if (import.meta.env.DEV) {
      console.log(`[VideoController] Screenshare viewer join requested (${reason})`);
    }
  }

  private updateScreenshareStatus(message: string, options?: { tone?: 'info' | 'warning' | 'success' | 'error'; busy?: boolean }): void {
    const label = this.deps.elements.screenshareStatusLabel as HTMLElement | undefined;
    if (!label) {
      return;
    }

    label.textContent = message;
    this.lastScreenshareStatusMessage = message;
    if (options?.tone) {
      label.dataset.tone = options.tone;
    } else {
      delete label.dataset.tone;
    }
    label.classList.toggle('is-busy', Boolean(options?.busy));
  }

  private updateScreenshareButtonsState(): void {
    const controls = this.deps.elements.screenshareControls as HTMLElement | undefined;
    const startBtn = this.deps.elements.screenshareStartBtn as HTMLButtonElement | undefined;
    const stopBtn = this.deps.elements.screenshareStopBtn as HTMLButtonElement | undefined;
    const visible = this.currentVideoMode === 'screenshare' && Boolean(this.screenshareChannelId);
    controls?.classList.toggle('hidden', !visible);

    if (!startBtn || !stopBtn) {
      return;
    }

    const socketId = this.deps.socket.getId();
    const otherHostActive = Boolean(this.screenshareHostId && socketId && this.screenshareHostId !== socketId);
    const isHost = this.screenshareRole === 'host';

    startBtn.classList.toggle('hidden', isHost);
    startBtn.disabled = otherHostActive || isHost;
    startBtn.textContent = otherHostActive ? 'Someone is sharing…' : 'Start Screenshare';

    stopBtn.classList.toggle('hidden', !isHost);
    stopBtn.disabled = !isHost;
  }

  private hideScreenshareControls(): void {
    const controls = this.deps.elements.screenshareControls as HTMLElement | undefined;
    controls?.classList.add('hidden');
  }

  toggleTheaterMode(): void {
    this.closeInlineVideo();
  }

  togglePlayPause(): void {
    const video = this.deps.elements.inlineVideo as HTMLVideoElement | undefined;
    if (!video) {
      return;
    }

    if (video.paused) {
      video.play().catch((err: Error) => {
        console.warn('Cannot play video:', err);
      });
    } else {
      video.pause();
    }
  }

  toggleMuteVideo(): void {
    const video = this.deps.elements.inlineVideo as HTMLVideoElement | undefined;
    if (!video) {
      return;
    }

    video.muted = !video.muted;
    this.updateVolumeDisplay();
  }

  handleVolumeChange(event: Event): void {
    const slider = event.target as HTMLInputElement | null;
    const video = this.deps.elements.inlineVideo as HTMLVideoElement | undefined;

    if (!video || !slider) {
      return;
    }

    const volume = parseInt(slider.value, 10) / 100;
    video.volume = volume;
    video.muted = volume === 0;
    this.updateVolumeDisplay();
  }

  updateVolumeDisplay(): void {
    const video = this.deps.elements.inlineVideo as HTMLVideoElement | undefined;
    const icon = this.deps.elements.volumeIcon;
    const slider = this.deps.elements.volumeSlider as HTMLInputElement | undefined;

    if (!video) {
      return;
    }

    if (slider) {
      slider.value = video.muted ? '0' : String(Math.round(video.volume * 100));
    }

    if (icon) {
      if (video.muted || video.volume === 0) {
        icon.textContent = '🔇';
      } else if (video.volume < 0.5) {
        icon.textContent = '🔉';
      } else {
        icon.textContent = '🔊';
      }
    }
  }

  async toggleFullscreen(): Promise<void> {
    const container = this.deps.elements.inlineVideoContainer as HTMLElement | undefined;
    if (!container) {
      return;
    }

    const isCurrentlyNative = this.getFullscreenElement() === container;

    if (isCurrentlyNative || this.nativeFullscreenActive) {
      try {
        await this.exitNativeFullscreen();
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('[VideoController] Failed to exit native fullscreen:', error);
        }
  this.toggleLegacyFullscreen(false);
      }
      return;
    }

    if (!this.supportsNativeFullscreen(container)) {
  this.toggleLegacyFullscreen(true);
      return;
    }

    try {
      await this.requestNativeFullscreen(container);
      await this.lockLandscapeOrientationIfNeeded();
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[VideoController] Native fullscreen failed, falling back:', error);
      }
  this.toggleLegacyFullscreen(!container.classList.contains('fullscreen'));
    }
  }

  adjustVolume(delta: number): void {
    const video = this.deps.elements.inlineVideo as HTMLVideoElement | undefined;
    const slider = this.deps.elements.volumeSlider as HTMLInputElement | undefined;

    if (!video || !slider) {
      return;
    }

    const currentVolume = video.muted ? 0 : Math.round(video.volume * 100);
    const newVolume = Math.max(0, Math.min(100, currentVolume + delta));

    video.volume = newVolume / 100;
    video.muted = newVolume === 0;
    slider.value = String(newVolume);

    this.updateVolumeDisplay();
  }

  updateStreamWatchingIndicator(): void {
    const indicator = document.getElementById('watching-stream-indicator');
    if (!indicator) {
      return;
    }

    const voiceConnected = this.deps.state.get('voiceConnected');
    const container = this.deps.elements.inlineVideoContainer as HTMLElement | undefined;
    const isWatchingStream = !!(container && !container.classList.contains('hidden'));

    if (voiceConnected && isWatchingStream) {
      const currentChannelType = this.deps.state.get('currentChannelType');
      const currentChannelName = this.deps.elements['current-channel-name']?.textContent ?? '';

      if ((currentChannelType === 'stream' || currentChannelType === 'screenshare') && currentChannelName) {
        const icon = currentChannelType === 'screenshare' ? '🖥️' : '📺';
        indicator.textContent = `${icon} ${currentChannelName}`;
        indicator.classList.remove('hidden');
      } else {
        indicator.classList.add('hidden');
      }
    } else {
      indicator.classList.add('hidden');
    }
  }

  setMobileStreamMode(enabled: boolean): void {
    const app = this.deps.elements.app;
    if (!app) {
      return;
    }

    if (!this.isMobileLayout()) {
      this.mobileStreamMode = false;
      this.mobileChatOpen = false;
      app.classList.remove('mobile-stream-mode', 'mobile-chat-open');
      document.body.classList.remove('mobile-chat-open');
      this.updateMobileChatToggleUI();
      return;
    }

    this.mobileStreamMode = enabled;
    app.classList.toggle('mobile-stream-mode', enabled);

    if (enabled) {
      app.classList.remove('sidebar-open', 'members-open', 'voice-panel-open');

      const channelsBtn = this.deps.elements['mobile-open-channels'];
      if (channelsBtn) {
        channelsBtn.setAttribute('aria-pressed', 'false');
      }

      this.mobileChatOpen = false;
    } else {
      this.mobileChatOpen = false;
      app.classList.remove('mobile-chat-open');
      document.body.classList.remove('mobile-chat-open');
    }

    this.updateMobileChatToggleUI();
  }

  toggleMobileChat(force?: boolean): void {
    if (!this.mobileStreamMode || !this.isMobileLayout()) {
      return;
    }

    const nextState = force ?? !this.mobileChatOpen;
    if (nextState === this.mobileChatOpen) {
      return;
    }

    this.mobileChatOpen = nextState;
    this.updateMobileChatToggleUI();

    if (nextState) {
      const chatInput = this.deps.elements.chatInput as HTMLInputElement | undefined;
      chatInput?.focus();
    }
  }

  private updateMobileChatToggleUI(): void {
    const app = this.deps.elements.app;
    const toggle = this.deps.elements.mobileStreamChatToggle as HTMLButtonElement | undefined;
    const chatDock = this.deps.elements.streamChatDock as HTMLElement | undefined;

    const isMobile = this.isMobileLayout();
    const isActive = isMobile && this.mobileStreamMode;
    const isOpen = isActive && this.mobileChatOpen;

    app?.classList.toggle('mobile-chat-open', isOpen);
    document.body.classList.toggle('mobile-chat-open', isOpen);

    if (toggle) {
      toggle.classList.toggle('hidden', !isActive);
      toggle.setAttribute('aria-hidden', isActive ? 'false' : 'true');
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      toggle.setAttribute('aria-label', isOpen ? 'Close live chat overlay' : 'Open live chat overlay');

      const label = toggle.querySelector('.mobile-stream-chat-toggle__label');
      if (label) {
        label.textContent = isOpen ? 'Close Chat' : 'Pop-out Chat';
      }

      const icon = toggle.querySelector('.mobile-stream-chat-toggle__icon');
      if (icon) {
        icon.textContent = isOpen ? '✕' : '💬';
      }
    }

    if (chatDock) {
      const overlayActive = isActive && isOpen;
      chatDock.classList.toggle('mobile-overlay-active', overlayActive);

      if (isActive) {
        chatDock.setAttribute('aria-hidden', 'false');
      } else {
        chatDock.setAttribute('aria-hidden', chatDock.classList.contains('hidden') ? 'true' : 'false');
        chatDock.classList.remove('mobile-overlay-active');
      }
    }
  }

  private updateLiveIndicator(state: 'hidden' | 'loading' | 'live' | 'offline'): void {
    const badge = document.querySelector('.live-indicator-badge') as HTMLElement | null;
    if (!badge) {
      return;
    }

    const text = badge.querySelector('.status-text') as HTMLElement | null;

    badge.classList.remove('is-live', 'is-offline', 'is-loading');
    badge.dataset.status = state;
    badge.classList.add('inline-flex');

    if (state === 'hidden') {
      badge.classList.add('hidden');
      badge.setAttribute('aria-hidden', 'true');
      if (text) {
        text.textContent = 'OFFLINE';
      }
      return;
    }

    if (text) {
      text.textContent = state === 'loading' ? 'CONNECTING' : state.toUpperCase();
    }

    badge.classList.remove('hidden');
    badge.setAttribute('aria-hidden', 'false');

    if (state === 'live') {
      badge.classList.add('is-live');
    } else if (state === 'offline') {
      badge.classList.add('is-offline');
    } else if (state === 'loading') {
      badge.classList.add('is-loading');
    }
  }

  private registerDomListeners(): void {
    const { elements, addListener } = this.deps;

    addListener(elements['toggle-video-popout'], 'click', () => this.toggleVideoPopout());
    addListener(elements['minimize-video'], 'click', () => this.minimizeVideo());
    addListener(elements['close-video'], 'click', () => this.closePopout());
    addListener(elements.theaterModeToggle, 'click', () => this.toggleTheaterMode());
  addListener(elements.playPauseBtn, 'click', () => this.togglePlayPause());
  addListener(elements.volumeBtn, 'click', () => this.toggleMuteVideo());
  addListener(elements.mobileStreamChatToggle, 'click', () => this.toggleMobileChat());
  addListener(elements.volumeSlider, 'input', (event: Event) => this.handleVolumeChange(event));
  addListener(elements.fullscreenBtn, 'click', () => this.toggleFullscreen());
    addListener(elements.screenshareStartBtn, 'click', () => void this.startScreenshareCapture());
    addListener(elements.screenshareStopBtn, 'click', () => this.stopScreenshare('user-requested'));

    const inlineVideo = elements.inlineVideo as HTMLVideoElement | undefined;
    if (inlineVideo) {
      addListener(inlineVideo, 'play', () => this.updatePlayPauseButton(false));
      addListener(inlineVideo, 'pause', () => this.updatePlayPauseButton(true));
      addListener(inlineVideo, 'volumechange', () => this.updateVolumeDisplay());
      addListener(inlineVideo, 'click', () => this.togglePlayPause());
    }

    addListener(document, 'keydown', (event: Event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key !== 'Escape') {
        return;
      }

      if (this.mobileChatOpen && this.mobileStreamMode && this.isMobileLayout()) {
        keyboardEvent.preventDefault();
        this.toggleMobileChat(false);
        return;
      }

      const container = this.deps.elements.inlineVideoContainer as HTMLElement | undefined;
      if (!container?.classList.contains('fullscreen')) {
        return;
      }

      keyboardEvent.preventDefault();
      this.toggleFullscreen();
    });
  }

  private setupVideoPopoutDrag(): void {
    const popout = this.deps.elements['video-popout'];
    const header = this.deps.elements['video-popout-header'];

    if (!popout || !header) {
      return;
    }

    this.deps.addListener(header, 'mousedown', (event: Event) => {
      const mouseEvent = event as MouseEvent;
      if ((mouseEvent.target as HTMLElement).tagName === 'BUTTON') {
        return;
      }

      this.isDragging = true;
      const rect = popout.getBoundingClientRect();
      this.dragOffset.x = mouseEvent.clientX - rect.left;
      this.dragOffset.y = mouseEvent.clientY - rect.top;
      popout.style.transition = 'none';
    });

    this.deps.addListener(document, 'mousemove', (event: Event) => {
      if (!this.isDragging) {
        return;
      }

      const mouseEvent = event as MouseEvent;
      const popoutEl = this.deps.elements['video-popout'];
      if (!popoutEl) {
        return;
      }

      const x = mouseEvent.clientX - this.dragOffset.x;
      const y = mouseEvent.clientY - this.dragOffset.y;

      popoutEl.style.left = `${x}px`;
      popoutEl.style.top = `${y}px`;
      popoutEl.style.right = 'auto';
      popoutEl.style.bottom = 'auto';
    });

    this.deps.addListener(document, 'mouseup', () => {
      if (!this.isDragging) {
        return;
      }

      this.isDragging = false;
      const popoutEl = this.deps.elements['video-popout'];
      if (popoutEl) {
        popoutEl.style.transition = '';
      }
    });
  }

  private setupVideoPopoutResize(): void {
    const popout = this.deps.elements['video-popout'];
    const handle = this.deps.elements['video-popout-resize'];

    if (!popout || !handle) {
      return;
    }

    this.deps.addListener(handle, 'mousedown', (event: Event) => {
      const mouseEvent = event as MouseEvent;
      mouseEvent.stopPropagation(); // Prevent drag
      
      this.isResizing = true;
      const rect = popout.getBoundingClientRect();
      this.resizeStart = {
        width: rect.width,
        height: rect.height,
        x: mouseEvent.clientX,
        y: mouseEvent.clientY
      };
      
      popout.style.transition = 'none';
    });

    this.deps.addListener(document, 'mousemove', (event: Event) => {
      if (!this.isResizing) {
        return;
      }

      const mouseEvent = event as MouseEvent;
      const popoutEl = this.deps.elements['video-popout'];
      if (!popoutEl) {
        return;
      }

      const dx = mouseEvent.clientX - this.resizeStart.x;
      const dy = mouseEvent.clientY - this.resizeStart.y;

      // Use the maximum relative change to drive resize while maintaining aspect ratio
      const scaleX = (this.resizeStart.width + dx) / this.resizeStart.width;
      const scaleY = (this.resizeStart.height + dy) / this.resizeStart.height;
      const scale = Math.max(scaleX, scaleY);
      
      const finalWidth = Math.max(320, this.resizeStart.width * scale);
      popoutEl.style.width = `${finalWidth}px`;
    });

    this.deps.addListener(document, 'mouseup', () => {
      if (!this.isResizing) {
        return;
      }

      this.isResizing = false;
      const popoutEl = this.deps.elements['video-popout'];
      if (popoutEl) {
        popoutEl.style.transition = '';
      }
    });
  }

  private updatePlayPauseButton(isPaused: boolean): void {
    const btn = this.deps.elements.playPauseBtn;
    if (!btn) {
      return;
    }

    const icon = btn.querySelector('.icon');
    if (icon) {
      icon.textContent = isPaused ? '▶️' : '⏸️';
    }

    btn.setAttribute('aria-label', isPaused ? 'Play' : 'Pause');
    btn.setAttribute('title', isPaused ? 'Play' : 'Pause');
  }

  private isMobileLayout(): boolean {
    return window.matchMedia('(max-width: 1024px)').matches;
  }

  private syncChatDockState(isHidden: boolean): void {
    const chatDock = this.deps.elements.streamChatDock;
    const streamLayout = this.deps.elements.streamLayout;
    const status = this.deps.elements.streamChatStatus;
    const chatMessages = this.deps.elements.msgs;
    const chatInput = this.deps.elements['chat-input-container'];
    const membersList = this.deps.elements['members-list'];

    chatDock?.classList.toggle('stream-chat-hidden', isHidden);
    streamLayout?.classList.toggle('stream-chat-collapsed', isHidden);
    document.body.classList.toggle('stream-chat-hidden', isHidden);

    chatMessages?.classList.toggle('hidden-in-fullscreen', isHidden);
    chatInput?.classList.toggle('hidden-in-fullscreen', isHidden);
    membersList?.classList.toggle('hidden-in-fullscreen', isHidden);

    if (status) {
      if (document.body.classList.contains('stream-inline-active')) {
        status.textContent = isHidden ? 'Chat hidden. Click to show.' : 'Chat docked';
      } else {
        status.textContent = '';
      }
    }
  }

  private toggleLegacyFullscreen(enable: boolean): void {
    this.nativeFullscreenActive = false;
    this.updateFullscreenClasses(enable, false);
    if (!enable) {
      this.unlockOrientation();
    }
  }

  private handleNativeFullscreenChange = (): void => {
    const container = this.deps.elements.inlineVideoContainer as HTMLElement | undefined;
    if (!container) {
      return;
    }

    const fullscreenElement = this.getFullscreenElement();
    const isActive = fullscreenElement === container;

    this.nativeFullscreenActive = isActive;
    this.updateFullscreenClasses(isActive, true);

    if (!isActive) {
      this.unlockOrientation();
    }
  };

  private updateFullscreenClasses(isActive: boolean, isNative: boolean): void {
    const container = this.deps.elements.inlineVideoContainer as HTMLElement | undefined;
    if (!container) {
      return;
    }

    container.classList.toggle('fullscreen', isActive);
    document.body.classList.toggle('stream-fullscreen-active', isActive);
    document.body.classList.toggle('native-fullscreen-active', isActive && isNative);

    this.syncChatDockState(isActive);
    this.syncFullscreenButton(isActive);

    if (!isActive) {
      document.body.classList.remove('native-fullscreen-active');
    }
  }

  private getFullscreenElement(): Element | null {
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      mozFullScreenElement?: Element | null;
      msFullscreenElement?: Element | null;
    };

    return doc.fullscreenElement
      ?? doc.webkitFullscreenElement
      ?? doc.mozFullScreenElement
      ?? doc.msFullscreenElement
      ?? null;
  }

  private supportsNativeFullscreen(element: HTMLElement): boolean {
    const anyElement = element as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
      mozRequestFullScreen?: () => Promise<void> | void;
      msRequestFullscreen?: () => Promise<void> | void;
    };

    return typeof element.requestFullscreen === 'function'
      || typeof anyElement.webkitRequestFullscreen === 'function'
      || typeof anyElement.mozRequestFullScreen === 'function'
      || typeof anyElement.msRequestFullscreen === 'function';
  }

  private async requestNativeFullscreen(element: HTMLElement): Promise<void> {
    const anyElement = element as HTMLElement & {
      webkitRequestFullscreen?: (options?: FullscreenOptions) => Promise<void> | void;
      mozRequestFullScreen?: () => Promise<void> | void;
      msRequestFullscreen?: () => Promise<void> | void;
    };

    const request = element.requestFullscreen?.bind(element)
      ?? anyElement.webkitRequestFullscreen?.bind(anyElement)
      ?? anyElement.mozRequestFullScreen?.bind(anyElement)
      ?? anyElement.msRequestFullscreen?.bind(anyElement);

    if (!request) {
      throw new Error('Fullscreen API is not supported');
    }

    const result = request.length > 0 ? request({ navigationUI: 'hide' }) : request();
    await Promise.resolve(result);
  }

  private async exitNativeFullscreen(): Promise<void> {
    const doc = document as Document & {
      webkitExitFullscreen?: () => Promise<void> | void;
      mozCancelFullScreen?: () => Promise<void> | void;
      msExitFullscreen?: () => Promise<void> | void;
    };

    const exit = doc.exitFullscreen?.bind(doc)
      ?? doc.webkitExitFullscreen?.bind(doc)
      ?? doc.mozCancelFullScreen?.bind(doc)
      ?? doc.msExitFullscreen?.bind(doc);

    if (!exit) {
      throw new Error('Fullscreen exit is not supported');
    }

    const result = exit();
    await Promise.resolve(result);
  }

  private async lockLandscapeOrientationIfNeeded(): Promise<void> {
    if (this.orientationLocked || !this.isMobileLayout()) {
      return;
    }

    const orientation = screen.orientation as ScreenOrientation | undefined;
    const lockOrientation = orientation && (orientation as unknown as { lock?: (type: string) => Promise<void> }).lock;

    if (!orientation || typeof lockOrientation !== 'function') {
      return;
    }

    try {
      await lockOrientation.call(orientation, 'landscape');
      this.orientationLocked = true;
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[VideoController] Unable to lock orientation:', error);
      }
    }
  }

  private unlockOrientation(): void {
    if (!this.orientationLocked) {
      return;
    }

    const orientation = screen.orientation as ScreenOrientation | undefined;
    const unlockOrientation = orientation && (orientation as unknown as { unlock?: () => void }).unlock;
    if (orientation && typeof unlockOrientation === 'function') {
      try {
        unlockOrientation.call(orientation);
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('[VideoController] Unable to unlock orientation:', error);
        }
      }
    }

    this.orientationLocked = false;
  }

  private syncFullscreenButton(isFullscreen: boolean): void {
    const btn = this.deps.elements.fullscreenBtn;
    if (!btn) {
      return;
    }

    const icon = btn.querySelector('.icon');
    if (icon) {
      icon.textContent = isFullscreen ? '🗗' : '⛶';
    }

    const label = isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
  }
}
