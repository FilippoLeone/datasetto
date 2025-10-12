/**
 * HLS Video Player Service
 */
import Hls from 'hls.js';

export class PlayerService {
  private hls: Hls | null = null;
  private videoElement: HTMLVideoElement;
  private baseUrl: string;
  private currentChannel = '';
  private overlayElement: HTMLElement | null = null;

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
  loadChannel(channel: string): void {
    if (this.currentChannel === channel && this.hls) {
      return; // Already playing this channel
    }

    this.currentChannel = channel;
    this.showOverlay('Connecting to stream...');

    const m3u8Url = `${this.baseUrl}/${encodeURIComponent(channel)}/index.m3u8`;

    // Clean up existing HLS instance
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }

    // Check if HLS.js is supported
    if (Hls.isSupported()) {
      this.hls = new Hls({
        // Low-latency configuration
        lowLatencyMode: true,
        backBufferLength: 90,             // Keep minimal back buffer (90s)
        
        // Live sync configuration
        liveSyncDurationCount: 2,         // Target 2 segments from live edge (was 3 default)
        liveMaxLatencyDurationCount: 4,   // Max 4 segments behind (was 10 default)
        liveDurationInfinity: true,       // Handle infinite live streams
        highBufferWatchdogPeriod: 1,      // Check buffer every 1s (was 2s)
        
        // Playback optimization
        maxLiveSyncPlaybackRate: 1.5,     // Allow 1.5x speed to catch up
        maxMaxBufferLength: 20,           // Max buffer 20s (was 600s)
        maxBufferSize: 30 * 1000 * 1000,  // 30MB buffer limit
        maxBufferLength: 10,              // Target 10s buffer (was 30s)
        
        // Network optimization
        enableWorker: true,
        maxFragLookUpTolerance: 0.1,      // Tight fragment lookup
        manifestLoadingTimeOut: 10000,    // 10s manifest timeout
        manifestLoadingMaxRetry: 3,
        levelLoadingTimeOut: 10000,       // 10s level timeout
        fragLoadingTimeOut: 20000,        // 20s fragment timeout
        
        // Start position
        startPosition: -1,                // Start from live edge
      });

      this.hls.loadSource(m3u8Url);
      this.hls.attachMedia(this.videoElement);

      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.videoElement.play().catch((error) => {
          console.error('Error auto-playing video:', error);
        });
      });

      this.hls.on(Hls.Events.ERROR, (_event: string, data: any) => {
        console.error('HLS error:', data);
        
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              this.showOverlay('Network error. Retrying...');
              setTimeout(() => this.hls?.startLoad(), 3000);
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              this.showOverlay('Media error. Recovering...');
              this.hls?.recoverMediaError();
              break;
            default:
              this.showOverlay('Fatal error loading stream');
              this.hls?.destroy();
              break;
          }
        }
      });
    } else if (this.videoElement.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      this.videoElement.src = m3u8Url;
      this.videoElement.play().catch((error) => {
        console.error('Error auto-playing video:', error);
      });
    } else {
      this.showOverlay('HLS not supported in this browser');
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
