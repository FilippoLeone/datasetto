import { Component, Input, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import Hls from 'hls.js';

@Component({
  selector: 'app-video-player',
  imports: [CommonModule],
  templateUrl: './video-player.html',
  styleUrl: './video-player.css'
})
export class VideoPlayer implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('videoElement', { static: false }) videoElement?: ElementRef<HTMLVideoElement>;
  
  @Input() streamUrl = '';
  @Input() channelName = '';
  @Input() autoplay = true;
  @Input() controls = true;
  @Input() muted = false;

  private hls?: Hls;
  isLive = false;
  isLoading = true;
  hasError = false;
  errorMessage = '';
  isPlaying = false;
  volume = 1;
  isFullscreen = false;

  ngOnInit(): void {
    // Initialize when stream URL is provided
  }

  ngAfterViewInit(): void {
    if (this.streamUrl && this.videoElement) {
      this.initializePlayer();
    }
  }

  ngOnDestroy(): void {
    this.destroyPlayer();
  }

  private initializePlayer(): void {
    const video = this.videoElement?.nativeElement;
    if (!video) return;

    if (Hls.isSupported()) {
      this.hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90
      });

      this.hls.loadSource(this.streamUrl);
      this.hls.attachMedia(video);

      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.isLoading = false;
        this.isLive = true;
        if (this.autoplay) {
          video.play().catch(err => {
            console.error('Autoplay failed:', err);
          });
        }
      });

      this.hls.on(Hls.Events.ERROR, (event, data) => {
        console.error('HLS error:', data);
        if (data.fatal) {
          this.hasError = true;
          this.errorMessage = 'Stream error. Please try refreshing.';
          this.isLoading = false;
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      video.src = this.streamUrl;
      video.addEventListener('loadedmetadata', () => {
        this.isLoading = false;
        this.isLive = true;
        if (this.autoplay) {
          video.play();
        }
      });
    } else {
      this.hasError = true;
      this.errorMessage = 'HLS not supported in this browser';
      this.isLoading = false;
    }

    // Video event listeners
    video.addEventListener('play', () => this.isPlaying = true);
    video.addEventListener('pause', () => this.isPlaying = false);
    video.addEventListener('volumechange', () => this.volume = video.volume);
  }

  private destroyPlayer(): void {
    if (this.hls) {
      this.hls.destroy();
      this.hls = undefined;
    }
  }

  togglePlay(): void {
    const video = this.videoElement?.nativeElement;
    if (!video) return;

    if (video.paused) {
      video.play();
    } else {
      video.pause();
    }
  }

  toggleMute(): void {
    const video = this.videoElement?.nativeElement;
    if (!video) return;
    video.muted = !video.muted;
  }

  setVolume(value: number): void {
    const video = this.videoElement?.nativeElement;
    if (!video) return;
    video.volume = value;
    this.volume = value;
  }

  toggleFullscreen(): void {
    const video = this.videoElement?.nativeElement;
    if (!video) return;

    if (!document.fullscreenElement) {
      video.requestFullscreen();
      this.isFullscreen = true;
    } else {
      document.exitFullscreen();
      this.isFullscreen = false;
    }
  }

  retry(): void {
    this.hasError = false;
    this.isLoading = true;
    this.destroyPlayer();
    setTimeout(() => this.initializePlayer(), 100);
  }
}
