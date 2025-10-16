/**
 * HLS Video Player Service
 */
import Hls from 'hls.js';
import { buildHlsUrlCandidates } from '@/utils/streaming';
import type { Channel } from '@/types';

export class PlayerService {
  private hls: Hls | null = null;
  private videoElement: HTMLVideoElement;
  private baseUrl: string;
  private currentChannelId: string | null = null;
  private overlayElement: HTMLElement | null = null;
  private candidateUrls: string[] = [];

  constructor(videoElement: HTMLVideoElement, baseUrl: string, overlayElement?: HTMLElement) {
    this.videoElement = videoElement;
    this.baseUrl = baseUrl;
    this.overlayElement = overlayElement || null;

    this.videoElement.playsInline = true;
    this.videoElement.autoplay = true;
    this.videoElement.muted = true;
    this.videoElement.setAttribute('playsinline', '');
    this.videoElement.setAttribute('webkit-playsinline', 'true');
    
    this.setupVideoEvents();
  }

  /**
   * Setup video element event listeners
   */
  private setupVideoEvents(): void {
    this.videoElement.onplaying = () => {
      this.hideOverlay();
    };

    this.videoElement.onerror = () => {
      this.showOverlay('Error loading stream');
    };

    this.videoElement.onwaiting = () => {
      this.showOverlay('Buffering...');
    };
  }

  /**
   * Load and play a channel stream
   */
  loadChannel(channel: Channel): void {
    if (this.currentChannelId === channel.id && this.hls) {
      return; // Already playing this channel
    }

    this.currentChannelId = channel.id;
    this.candidateUrls = buildHlsUrlCandidates(this.baseUrl, channel.name, channel.streamKey);

    if (this.candidateUrls.length === 0) {
      this.showOverlay('Unable to resolve stream path');
      return;
    }

    const tryCandidate = (index: number): void => {
      if (index >= this.candidateUrls.length) {
        this.showOverlay('Stream unavailable');
        return;
      }

  const source = this.candidateUrls[index];
      this.showOverlay('Connecting to stream...');

      if (this.hls) {
        this.hls.destroy();
        this.hls = null;
      }

      if (Hls.isSupported()) {
        const hls = new Hls({
          lowLatencyMode: true,
          backBufferLength: 90,
          liveSyncDurationCount: 2,
          liveMaxLatencyDurationCount: 4,
          liveDurationInfinity: true,
          highBufferWatchdogPeriod: 1,
          maxLiveSyncPlaybackRate: 1.5,
          maxMaxBufferLength: 20,
          maxBufferSize: 30 * 1000 * 1000,
          maxBufferLength: 10,
          enableWorker: true,
          maxFragLookUpTolerance: 0.1,
          manifestLoadingTimeOut: 10000,
          manifestLoadingMaxRetry: 3,
          levelLoadingTimeOut: 10000,
          fragLoadingTimeOut: 20000,
          startPosition: -1,
        });

        this.hls = hls;
        hls.loadSource(source);
        hls.attachMedia(this.videoElement);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          this.videoElement.play().catch((error) => {
            console.error('Error auto-playing video:', error);
          });
        });

        hls.on(Hls.Events.ERROR, (_event: string, data: any) => {
          console.error('HLS error:', data);

          if (!data?.fatal) {
            return;
          }

          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            this.showOverlay('Retrying stream path...');
            hls.destroy();
            this.hls = null;
            tryCandidate(index + 1);
            return;
          }

          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            this.showOverlay('Media error. Recovering...');
            this.hls?.recoverMediaError();
            return;
          }

          this.showOverlay('Fatal error loading stream');
          this.hls?.destroy();
          this.hls = null;
        });
        return;
      }

      if (this.videoElement.canPlayType('application/vnd.apple.mpegurl')) {
        const handleError = (): void => {
          this.videoElement.removeEventListener('error', handleError);
          this.showOverlay('Retrying stream path...');
          tryCandidate(index + 1);
        };

        this.videoElement.addEventListener('error', handleError, { once: true });
        this.videoElement.src = source;
        this.videoElement.play().catch((error) => {
          console.error('Error auto-playing video:', error);
        });
        return;
      }

      this.showOverlay('HLS not supported in this browser');
    };

    tryCandidate(0);
  }

  /**
   * Show overlay with message
   */
  private showOverlay(message?: string): void {
    if (this.overlayElement) {
      this.overlayElement.classList.add('visible');
      if (message) {
        const textElement = this.overlayElement.querySelector('.message');
        if (textElement) {
          textElement.textContent = message;
        } else {
          this.overlayElement.textContent = message;
        }
      }
    }
  }

  /**
   * Hide overlay
   */
  private hideOverlay(): void {
    if (this.overlayElement) {
      this.overlayElement.classList.remove('visible');
    }
  }

  /**
   * Cleanup
   */
  dispose(): void {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.videoElement.pause();
    this.videoElement.removeAttribute('src');
    try {
      this.videoElement.srcObject = null;
    } catch {
      // Some browsers may throw if srcObject isn't set; ignore safely.
    }
    this.videoElement.load();
  }
}
