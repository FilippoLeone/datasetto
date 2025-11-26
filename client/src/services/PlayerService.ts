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
  private handleVideoPlaying = (): void => {
    this.hideOverlay();
  };
  private handleVideoError = (): void => {
    this.showOverlay('Error loading stream');
  };
  private handleVideoWaiting = (): void => {
    this.showOverlay('Buffering...');
  };

  constructor(videoElement: HTMLVideoElement, baseUrl: string, overlayElement?: HTMLElement) {
    this.videoElement = videoElement;
    this.baseUrl = baseUrl;
    this.overlayElement = overlayElement || null;

    this.initializeVideoElement(this.videoElement);
    this.setupVideoEvents();
  }

  /**
   * Setup video element event listeners
   */
  private setupVideoEvents(): void {
    this.videoElement.addEventListener('playing', this.handleVideoPlaying);
    this.videoElement.addEventListener('error', this.handleVideoError);
    this.videoElement.addEventListener('waiting', this.handleVideoWaiting);
  }

  private detachVideoEvents(): void {
    this.videoElement.removeEventListener('playing', this.handleVideoPlaying);
    this.videoElement.removeEventListener('error', this.handleVideoError);
    this.videoElement.removeEventListener('waiting', this.handleVideoWaiting);
  }

  private initializeVideoElement(element: HTMLVideoElement): void {
    element.playsInline = true;
    element.autoplay = true;
    element.muted = true;
    element.setAttribute('playsinline', '');
    element.setAttribute('webkit-playsinline', 'true');
  }

  private resetVideoElement(element: HTMLVideoElement): void {
    try {
      element.pause();
    } catch {
      // ignore
    }
    element.removeAttribute('src');
    try {
      element.srcObject = null;
    } catch {
      // ignore
    }
    element.load();
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

  setVideoElement(videoElement: HTMLVideoElement, overlayElement?: HTMLElement | null): void {
    if (this.videoElement === videoElement) {
      if (overlayElement !== undefined) {
        this.overlayElement = overlayElement ?? null;
      }
      return;
    }

    this.detachVideoEvents();
    this.resetVideoElement(this.videoElement);

    this.videoElement = videoElement;
    if (overlayElement !== undefined) {
      this.overlayElement = overlayElement ?? null;
    }

    this.initializeVideoElement(this.videoElement);
    this.setupVideoEvents();

    if (this.hls) {
      try {
        this.hls.detachMedia();
        this.hls.attachMedia(this.videoElement);
        this.videoElement.play().catch((error) => {
          console.error('Error auto-playing video after HLS retarget:', error);
        });
      } catch (error) {
        console.error('Failed to reattach HLS media element:', error);
      }
      return;
    }

    if (this.candidateUrls.length > 0 && this.currentChannelId) {
      const source = this.candidateUrls[0];
      this.videoElement.src = source;
      this.videoElement.play().catch((error) => {
        console.error('Error auto-playing video after retarget:', error);
      });
    }
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
    this.detachVideoEvents();
    this.resetVideoElement(this.videoElement);
  }
}
