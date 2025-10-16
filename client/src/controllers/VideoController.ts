import Hls from 'hls.js';
import { buildHlsUrlCandidates } from '@/utils/streaming';
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
  private mobileChatOpen = false;
  private nativeFullscreenActive = false;
  private orientationLocked = false;

  constructor(deps: VideoControllerDeps) {
    this.deps = deps;
  }

  initialize(): void {
    this.registerDomListeners();
    this.setupVideoPopoutDrag();
    this.updateVolumeDisplay();
    this.syncFullscreenButton(false);
  this.updateMobileChatToggleUI();

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

  handleTextChannelSelected(_options: { voiceConnected: boolean }): void {
    this.closeInlineVideo();

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

    if (this.deps.state.get('streamingMode')) {
      this.deps.state.setStreamingMode(false);

      const toggleBtn = this.deps.elements['toggle-video-popout'];
      if (toggleBtn) {
        toggleBtn.textContent = '📺';
      }

      this.deps.notifications.info('Streaming mode disabled');
    }

    this.closePopout();
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
    const playerColumn = this.deps.elements['streamPlayerColumn'] as HTMLElement | undefined;

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

    const streamCandidates = buildHlsUrlCandidates(this.deps.hlsBaseUrl, channelName);

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

      const overlay = this.deps.elements['mobile-overlay'];
      if (overlay) {
        overlay.classList.remove('visible');
        overlay.setAttribute('aria-hidden', 'true');
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
