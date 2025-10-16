import type { NavigationControllerDeps } from './types';

/**
 * NavigationController
 * 
 * Manages channel navigation and switching between text, voice, and stream channels.
 * Coordinates UI updates across multiple controllers when switching channels.
 */
export class NavigationController {
  private deps: NavigationControllerDeps;

  constructor(deps: NavigationControllerDeps) {
    this.deps = deps;
  }

  /**
   * Initialize the controller
   */
  initialize(): void {
    this.setupChannelListeners();
    
    if (import.meta.env.DEV) {
      console.log('🧭 NavigationController initialized');
    }
  }

  /**
   * Setup listeners for channel selection events
   */
  private setupChannelListeners(): void {
    // Listen for channel selection events from ChannelController
    const handleChannelSelect = (e: Event) => {
      const customEvent = e as CustomEvent;
      const { channelId, channelName, type } = customEvent.detail;
      
      if (type === 'voice') {
        // Voice channels - just update visual state and socket, don't connect voice yet
        this.handleVoiceChannelSelect(channelId, channelName);
      } else {
        // Text and stream channels - full switch with animation
        this.switchChannel(channelId, channelName, type);
      }
    };

    // Add event listeners to channel containers
    this.deps.addListener(this.deps.elements['text-channels'], 'channel-select', handleChannelSelect);
    this.deps.addListener(this.deps.elements.channelsList, 'channel-select', handleChannelSelect);
    this.deps.addListener(this.deps.elements['stream-channels'], 'channel-select', handleChannelSelect);
  }

  /**
   * Handle voice channel selection (viewing only, not connecting to voice)
   */
  private handleVoiceChannelSelect(channelId: string, channelName: string): void {
    void this.deps.voiceJoinChannel(channelId, channelName);
    this.deps.socketJoinChannel(channelId);
    
    // Remove active class from all voice channels
    document.querySelectorAll('#channelsList .channel-item').forEach(item => {
      item.classList.remove('active');
    });
    
    // Add active class to clicked channel
    const selectedChannel = document.querySelector(`[data-channel-id="${channelId}"]`);
    selectedChannel?.classList.add('active');
    
    // Update current channel in state (for UI purposes)
    this.deps.stateSetChannelWithType(channelId, 'voice');
    this.updateStreamLayoutMode('voice', channelName);
    
    // Hide chat for voice channels
    this.deps.chatHideChatUI();
  this.deps.videoHandleVoiceChannelSelected();

    this.deps.soundFX.play('channelVoice', 0.55);
    
    if (import.meta.env.DEV) {
      console.log('📍 Voice channel selected (viewing, not voice connected):', channelName);
    }
  }

  /**
   * Switch to a different channel with animation
   */
  private switchChannel(channelId: string, channelName: string, type: 'text' | 'voice' | 'stream'): void {
    // Play channel switch sound (skip text channels)
    if (type === 'stream') {
      this.deps.soundFX.play('channelStream', 0.65);
    } else if (type === 'voice') {
      this.deps.soundFX.play('channelVoice', 0.55);
    }
    
    // Animate channel switch
    const chatContent = document.querySelector('.chat-content');
    if (chatContent) {
      this.deps.animator.animateChannelSwitch(chatContent as HTMLElement, () => {
        this.performChannelSwitch(channelId, channelName, type);
      });
    } else {
      this.performChannelSwitch(channelId, channelName, type);
    }
  }
  
  /**
   * Perform the actual channel switch (after animation)
   */
  private performChannelSwitch(channelId: string, channelName: string, type: 'text' | 'voice' | 'stream'): void {
    // Remove active class from all channels
    document.querySelectorAll('.channel-item').forEach(item => {
      item.classList.remove('active');
    });
    
    // Add active class to selected channel
    const selectedChannel = document.querySelector(`[data-channel-id="${channelId}"]`);
    selectedChannel?.classList.add('active');
    
    // Update channel name in header
    const channelIcon = type === 'text' ? '#' : type === 'voice' ? '🔊' : '📺';
    if (this.deps.elements['current-channel-name']) {
      this.deps.elements['current-channel-name'].textContent = channelName;
    }
    
    // Update channel icon in header
    const headerIcon = document.querySelector('.chat-header .channel-icon');
    if (headerIcon) {
      headerIcon.textContent = channelIcon;
    }

    this.updateStreamLayoutMode(type, channelName);
    
    // Update chat visibility and input placeholder based on channel type
    const chatInput = this.deps.elements.chatInput as HTMLInputElement;
    
    if (type === 'voice') {
      // Hide chat for voice channels
      this.deps.chatHideChatUI();
    } else {
      // Show chat for text and stream channels
      this.deps.chatShowChatUI();
      
      if (chatInput) {
        if (type === 'text') {
          chatInput.placeholder = `Message #${channelName}`;
          chatInput.disabled = false;
        } else if (type === 'stream') {
          chatInput.placeholder = `Chat in 📺${channelName}`;
          chatInput.disabled = false;
        }
      }
    }
    
    // Update state
    this.deps.stateSetChannelWithType(channelId, type);
    
    // Clear chat messages when switching channels
    this.deps.chatClearMessages();

    this.deps.videoHandleMobileChannelSwitch(type);
    
    // Handle differently based on type
    if (type === 'text') {
      // Text channel: join for chat
      this.deps.socketJoinChannel(channelId);

      const voiceConnected = this.deps.stateGetVoiceConnected();
      this.deps.videoHandleTextChannelSelected({ voiceConnected });
    } else if (type === 'voice') {
      // Voice channel: just navigate, keep inline video if watching stream
      this.deps.socketJoinChannel(channelId);

      this.deps.videoHandleVoiceChannelSelected();
      this.deps.voiceRefreshInterface?.();
    } else if (type === 'stream') {
      // Stream channel: load video stream in inline player by default (theater mode)
      // This works seamlessly with voice - users can be in voice and watch streams
      this.deps.socketJoinChannel(channelId);

      this.deps.videoHandleStreamChannelSelected(channelName);
    }

    this.deps.mobileClosePanels?.();
  }

  private updateStreamLayoutMode(type: 'text' | 'voice' | 'stream', channelName: string): void {
    const streamLayout = this.deps.elements.streamLayout as HTMLElement | undefined;
    const chatDock = this.deps.elements.streamChatDock as HTMLElement | undefined;
  const chatStatus = this.deps.elements.streamChatStatus as HTMLElement | undefined;
  const chatTitle = chatDock?.querySelector('.stream-chat-title') as HTMLElement | null;
  const playerColumn = this.deps.elements.streamPlayerColumn as HTMLElement | undefined;

    const isStreamMode = type === 'stream';

    streamLayout?.classList.toggle('is-stream-mode', isStreamMode);
    streamLayout?.classList.toggle('is-text-mode', type === 'text');
    streamLayout?.classList.toggle('is-voice-mode', type === 'voice');
    if (streamLayout) {
      streamLayout.dataset.mode = type;
    }

    playerColumn?.classList.toggle('hidden', !isStreamMode);

    if (type === 'voice') {
      chatDock?.classList.add('hidden');
      chatDock?.setAttribute('aria-hidden', 'true');
      chatDock?.classList.remove('stream-chat-hidden');
    } else {
      chatDock?.classList.remove('hidden');
      chatDock?.classList.remove('stream-chat-hidden');
      chatDock?.setAttribute('aria-hidden', 'false');
    }

    if (chatTitle) {
      if (isStreamMode) {
        chatTitle.textContent = 'Live Chat';
        chatTitle.classList.remove('text-channel-title');
      } else {
        chatTitle.textContent = type === 'text' ? `#${channelName}` : channelName;
        chatTitle.classList.add('text-channel-title');
      }
    }

    if (chatStatus) {
      if (isStreamMode) {
        chatStatus.textContent = document.body.classList.contains('stream-inline-active') ? 'Chat docked' : 'Chat ready';
      } else if (type === 'text') {
        chatStatus.textContent = '';
      } else {
        chatStatus.textContent = '';
      }
    }
  }
}
