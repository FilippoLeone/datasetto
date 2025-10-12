import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import Hls from 'hls.js';

export interface PlayerState {
  isPlaying: boolean;
  isMuted: boolean;
  volume: number;
  currentTime: number;
  duration: number;
  isBuffering: boolean;
  error?: string;
}

export interface StreamQuality {
  level: number;
  height: number;
  bitrate: number;
  name: string;
}

@Injectable({
  providedIn: 'root'
})
export class PlayerService implements OnDestroy {
  private hls?: Hls;
  private videoElement?: HTMLVideoElement;
  private destroy$ = new Subject<void>();

  // State observables
  private stateSubject = new BehaviorSubject<PlayerState>({
    isPlaying: false,
    isMuted: false,
    volume: 1,
    currentTime: 0,
    duration: 0,
    isBuffering: false
  });
  state$ = this.stateSubject.asObservable();

  private qualitiesSubject = new BehaviorSubject<StreamQuality[]>([]);
  qualities$ = this.qualitiesSubject.asObservable();

  private currentQualitySubject = new BehaviorSubject<number>(-1);
  currentQuality$ = this.currentQualitySubject.asObservable();

  // Initialize player with video element and stream URL
  initialize(videoElement: HTMLVideoElement, streamUrl: string): void {
    this.cleanup();
    this.videoElement = videoElement;

    if (Hls.isSupported()) {
      this.initializeHls(streamUrl);
    } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      videoElement.src = streamUrl;
      this.setupVideoListeners();
    } else {
      this.updateState({ error: 'HLS is not supported in this browser' });
    }
  }

  // Initialize HLS.js
  private initializeHls(streamUrl: string): void {
    if (!this.videoElement) return;

    this.hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 90
    });

    // Load source
    this.hls.loadSource(streamUrl);
    this.hls.attachMedia(this.videoElement);

    // Setup HLS event listeners
    this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
      this.updateQualities();
      this.videoElement?.play().catch(err => {
        console.error('Auto-play failed:', err);
      });
    });

    this.hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
      this.currentQualitySubject.next(data.level);
    });

    this.hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        this.handleHlsError(data);
      }
    });

    this.setupVideoListeners();
  }

  // Setup video element event listeners
  private setupVideoListeners(): void {
    if (!this.videoElement) return;

    this.videoElement.addEventListener('play', () => {
      this.updateState({ isPlaying: true });
    });

    this.videoElement.addEventListener('pause', () => {
      this.updateState({ isPlaying: false });
    });

    this.videoElement.addEventListener('volumechange', () => {
      if (!this.videoElement) return;
      this.updateState({
        isMuted: this.videoElement.muted,
        volume: this.videoElement.volume
      });
    });

    this.videoElement.addEventListener('timeupdate', () => {
      if (!this.videoElement) return;
      this.updateState({
        currentTime: this.videoElement.currentTime,
        duration: this.videoElement.duration || 0
      });
    });

    this.videoElement.addEventListener('waiting', () => {
      this.updateState({ isBuffering: true });
    });

    this.videoElement.addEventListener('playing', () => {
      this.updateState({ isBuffering: false });
    });

    this.videoElement.addEventListener('error', () => {
      this.updateState({ error: 'Video playback error' });
    });
  }

  // Update available stream qualities
  private updateQualities(): void {
    if (!this.hls) return;

    const qualities: StreamQuality[] = this.hls.levels.map((level, index) => ({
      level: index,
      height: level.height,
      bitrate: level.bitrate,
      name: `${level.height}p`
    }));

    this.qualitiesSubject.next(qualities);
  }

  // Handle HLS fatal errors
  private handleHlsError(data: any): void {
    switch (data.type) {
      case Hls.ErrorTypes.NETWORK_ERROR:
        console.error('Network error:', data);
        this.hls?.startLoad();
        break;
      case Hls.ErrorTypes.MEDIA_ERROR:
        console.error('Media error:', data);
        this.hls?.recoverMediaError();
        break;
      default:
        console.error('Fatal error:', data);
        this.updateState({ error: 'Stream playback failed' });
        this.cleanup();
        break;
    }
  }

  // Playback controls
  play(): void {
    this.videoElement?.play().catch(err => {
      console.error('Play failed:', err);
    });
  }

  pause(): void {
    this.videoElement?.pause();
  }

  togglePlay(): void {
    if (this.stateSubject.value.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  setVolume(volume: number): void {
    if (this.videoElement) {
      this.videoElement.volume = Math.max(0, Math.min(1, volume));
    }
  }

  toggleMute(): void {
    if (this.videoElement) {
      this.videoElement.muted = !this.videoElement.muted;
    }
  }

  seek(time: number): void {
    if (this.videoElement) {
      this.videoElement.currentTime = time;
    }
  }

  // Quality control
  setQuality(level: number): void {
    if (this.hls) {
      this.hls.currentLevel = level;
    }
  }

  setAutoQuality(): void {
    if (this.hls) {
      this.hls.currentLevel = -1; // Auto mode
    }
  }

  // Get current state
  getState(): PlayerState {
    return this.stateSubject.value;
  }

  // Update state
  private updateState(partial: Partial<PlayerState>): void {
    this.stateSubject.next({
      ...this.stateSubject.value,
      ...partial
    });
  }

  // Cleanup resources
  private cleanup(): void {
    if (this.hls) {
      this.hls.destroy();
      this.hls = undefined;
    }

    if (this.videoElement) {
      this.videoElement.pause();
      this.videoElement.src = '';
      this.videoElement = undefined;
    }

    this.updateState({
      isPlaying: false,
      isMuted: false,
      volume: 1,
      currentTime: 0,
      duration: 0,
      isBuffering: false,
      error: undefined
    });

    this.qualitiesSubject.next([]);
    this.currentQualitySubject.next(-1);
  }

  ngOnDestroy(): void {
    this.cleanup();
    this.destroy$.next();
    this.destroy$.complete();
  }
}
