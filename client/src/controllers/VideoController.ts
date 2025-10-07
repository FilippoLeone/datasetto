import type { VideoControllerDeps } from './types';

const STREAM_RETRY_DELAY_MS = 5000;

export class VideoController {
  private deps: VideoControllerDeps;
  private inlineHls: any = null;
  private streamRetryTimer: number | null = null;
  private isDragging = false;
  private dragOffset = { x: 0, y: 0 };
  private isMinimized = false;
  private mobileStreamMode = false;

  constructor(deps: VideoControllerDeps) {
    this.deps = deps;
  }

  initialize(): void {
    this.registerDomListeners();
    this.setupVideoPopoutDrag();
    this.updateVolumeDisplay();
    this.syncFullscreenButton(false);
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
        this.toggleFullscreen();
        return true;
      case 'KeyM':
        event.preventDefault();
        this.toggleMuteVideo();
        return true;
      case 'KeyC':
        event.preventDefault();
        this.toggleChatVisibility();
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

  handleMobileChannelSwitch(type: 'text' | 'voice' | 'stream'): void {
    if (!this.isMobileLayout()) {
      return;
    }

    if (type === 'stream') {
      this.setMobileStreamMode(true);
    } else {
      this.setMobileStreamMode(false);
      this.closeInlineVideo();
    }
  }

  handleTextChannelSelected(options: { voiceConnected: boolean }): void {
    if (!options.voiceConnected) {
      this.closeInlineVideo();
    }

    if (!this.deps.state.get('streamingMode')) {
      this.closePopout();
    }
  }

  handleVoiceChannelSelected(): void {
    if (!this.deps.state.get('streamingMode')) {
      this.closePopout();
    }
  }

  handleStreamChannelSelected(channelName: string): void {
    this.closePopout();
    void this.showInlineVideo(channelName);
    this.updateStreamWatchingIndicator();
  }

  toggleVideoPopout(): void {
    const popout = this.deps.elements['video-popout'];
    const btn = this.deps.elements['toggle-video-popout'];

    if (!popout) {
      return;
    }

    const streamingMode = this.deps.state.toggleStreamingMode();

    if (streamingMode) {
      popout.classList.remove('hidden');
      if (btn) {
        btn.textContent = '📺';
      }
      this.deps.notifications.info('Streaming mode enabled');

      const channelType = this.deps.state.get('currentChannelType');
      const channelId = this.deps.state.get('currentChannel');
      if (channelType === 'stream' && channelId) {
        const channels = this.deps.state.get('channels') ?? [];
        const match = channels.find((channel) => channel.id === channelId);
        if (match) {
          this.deps.player.loadChannel(match.name);
        }
      }
    } else {
      const channelType = this.deps.state.get('currentChannelType');
      if (channelType !== 'stream') {
        popout.classList.add('hidden');
      }
      if (btn) {
        btn.textContent = '📺';
      }
      this.deps.notifications.info('Streaming mode disabled');
    }
  }

  minimizeVideo(): void {
    const popout = this.deps.elements['video-popout'];
    if (!popout) {
      return;
    }

    this.isMinimized = !this.isMinimized;
    popout.classList.toggle('minimized', this.isMinimized);

    const btn = this.deps.elements['minimize-video'];
    if (btn) {
      btn.textContent = this.isMinimized ? '□' : '—';
      btn.setAttribute('title', this.isMinimized ? 'Restore' : 'Minimize');
    }
  }

  closePopout(): void {
    const popout = this.deps.elements['video-popout'];
    if (!popout) {
      return;
    }

    popout.classList.add('hidden');
    this.isMinimized = false;
    popout.classList.remove('minimized');
  }

  async showInlineVideo(channelName: string): Promise<void> {
    const container = this.deps.elements.inlineVideoContainer as HTMLElement | undefined;
    const video = this.deps.elements.inlineVideo as HTMLVideoElement | undefined;
    const overlay = this.deps.elements.inlinePlayerOverlay as HTMLElement | undefined;

    if (!container || !video) {
      console.error('Inline video elements not found');
      return;
    }

    const mobileTitle = this.deps.elements.mobileStreamTitle as HTMLElement | undefined;
    if (mobileTitle) {
      mobileTitle.textContent = `Live: ${channelName}`;
    }

    if (this.isMobileLayout() && !this.mobileStreamMode) {
      this.setMobileStreamMode(true);
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

    const streamUrl = `${this.deps.hlsBaseUrl}/${channelName}/index.m3u8`;

    if (import.meta.env.DEV) {
      console.log('Loading inline stream:', streamUrl);
    }

    const HlsConstructor = (window as unknown as { Hls?: any }).Hls;
    if (!HlsConstructor) {
      console.error('HLS.js not loaded! Make sure the script tag is in index.html');
      if (overlay) {
        const message = overlay.querySelector('.message');
        if (message) {
          message.textContent = 'HLS.js not loaded';
        }
      }
      return;
    }

    if (HlsConstructor.isSupported()) {
      if (this.inlineHls) {
        this.inlineHls.destroy();
      }

      this.inlineHls = new HlsConstructor({
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

      this.inlineHls.loadSource(streamUrl);
      this.inlineHls.attachMedia(video);

      this.inlineHls.on(HlsConstructor.Events.MANIFEST_PARSED, () => {
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

      this.inlineHls.on(HlsConstructor.Events.ERROR, (_event: unknown, data: any) => {
        console.error('❌ HLS error:', data);
        if (!data?.fatal) {
          return;
        }

        if (overlay) {
          overlay.classList.add('visible');
          const message = overlay.querySelector('.message');
          if (message) {
            if (data.type === HlsConstructor.ErrorTypes.NETWORK_ERROR) {
              message.textContent = 'Stream Offline - Waiting for stream...';
              if (this.streamRetryTimer) {
                clearTimeout(this.streamRetryTimer);
              }
              this.streamRetryTimer = window.setTimeout(() => {
                if (this.inlineHls && this.deps.state.get('currentChannelType') === 'stream') {
                  console.log('🔄 Retrying stream connection...');
                  this.inlineHls.loadSource(streamUrl);
                }
                this.streamRetryTimer = null;
              }, STREAM_RETRY_DELAY_MS);
            } else if (data.type === HlsConstructor.ErrorTypes.MEDIA_ERROR) {
              message.textContent = 'Media error - Recovering...';
              this.inlineHls?.recoverMediaError();
            } else {
              message.textContent = 'Stream error';
            }
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
  }

  closeInlineVideo(): void {
    const container = this.deps.elements.inlineVideoContainer as HTMLElement | undefined;
    const video = this.deps.elements.inlineVideo as HTMLVideoElement | undefined;

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

    if (container) {
      if (container.classList.contains('fullscreen')) {
        container.classList.remove('fullscreen');
        document.body.classList.remove('stream-fullscreen-active', 'stream-chat-hidden');
        this.syncFullscreenButton(false);
      }
      container.classList.add('hidden');
    }

    document.body.classList.remove('stream-inline-active', 'stream-chat-hidden');
    this.updateLiveIndicator('hidden');

    const overlay = this.deps.elements.inlinePlayerOverlay as HTMLElement | undefined;
    if (overlay) {
      const message = overlay.querySelector('.message');
      if (message) {
        message.textContent = 'No stream';
      }
    }

    if (video) {
      video.pause();
      video.src = '';
      video.load();
    }

    this.updateStreamWatchingIndicator();
    this.deps.refreshChannels();

    if (this.mobileStreamMode && this.isMobileLayout()) {
      this.mobileStreamMode = false;
      const app = this.deps.elements.app;
      app?.classList.remove('mobile-stream-mode');
    }
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

  toggleFullscreen(): void {
    const container = this.deps.elements.inlineVideoContainer as HTMLElement | undefined;
    if (!container) {
      return;
    }

    const willEnable = !container.classList.contains('fullscreen');

    container.classList.toggle('fullscreen', willEnable);
    document.body.classList.toggle('stream-fullscreen-active', willEnable);

    if (willEnable) {
      this.ensureDockedChatVisible();
    } else {
      document.body.classList.remove('stream-chat-hidden');
    }

    this.syncFullscreenButton(willEnable);
  }

  toggleChatVisibility(): void {
    const chatMessages = this.deps.elements.msgs;
    const chatInput = this.deps.elements['chat-input-container'];
    const membersList = this.deps.elements['members-list'];

    if (!chatMessages) {
      return;
    }

    const isHidden = chatMessages.classList.contains('hidden-in-fullscreen');

    if (isHidden) {
      chatMessages.classList.remove('hidden-in-fullscreen');
      chatInput?.classList.remove('hidden-in-fullscreen');
      membersList?.classList.remove('hidden-in-fullscreen');
      document.body.classList.remove('stream-chat-hidden');
      this.deps.notifications.info('Chat shown');
    } else {
      chatMessages.classList.add('hidden-in-fullscreen');
      chatInput?.classList.add('hidden-in-fullscreen');
      membersList?.classList.add('hidden-in-fullscreen');
      document.body.classList.add('stream-chat-hidden');
      this.deps.notifications.info('Chat hidden');
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

      if (currentChannelType === 'stream' && currentChannelName) {
        indicator.textContent = `📺 ${currentChannelName}`;
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
      app.classList.remove('mobile-stream-mode');
      return;
    }

    this.mobileStreamMode = enabled;
    app.classList.toggle('mobile-stream-mode', enabled);

    if (enabled) {
      app.classList.remove('sidebar-open', 'members-open');
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
  addListener(elements.volumeSlider, 'input', (event: Event) => this.handleVolumeChange(event));
    addListener(elements.fullscreenBtn, 'click', () => this.toggleFullscreen());
    addListener(elements.toggleChatBtn, 'click', () => this.toggleChatVisibility());

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
    return window.matchMedia('(max-width: 768px)').matches;
  }

  private ensureDockedChatVisible(): void {
    const chatMessages = this.deps.elements.msgs;
    const chatInput = this.deps.elements['chat-input-container'];
    const membersList = this.deps.elements['members-list'];

    chatMessages?.classList.remove('hidden-in-fullscreen');
    chatInput?.classList.remove('hidden-in-fullscreen');
    membersList?.classList.remove('hidden-in-fullscreen');
    document.body.classList.remove('stream-chat-hidden');
  }

  private syncFullscreenButton(isFullscreen: boolean): void {
    const btn = this.deps.elements.fullscreenBtn;
    if (!btn) {
      return;
    }

    const icon = btn.querySelector('.icon');
    if (icon) {
      icon.textContent = isFullscreen ? '🗗' : '🗖';
    }

    const label = isFullscreen ? 'Exit docked fullscreen' : 'Enter docked fullscreen';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
  }
}
