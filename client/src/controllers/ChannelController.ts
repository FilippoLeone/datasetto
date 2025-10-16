/**
 * ChannelController
 * Manages channel list rendering, channel switching, and channel creation
 */

import type { Channel, RolePermissions } from '@/types';
import type { SocketService, AudioNotificationService } from '@/services';
import type { StateManager, AnimationController } from '@/utils';
import type { NotificationManager } from '@/components/NotificationManager';

export interface ChannelControllerDeps {
  elements: Record<string, HTMLElement | null>;
  socket: SocketService;
  state: StateManager;
  animator: AnimationController;
  soundFX: AudioNotificationService;
  notifications: NotificationManager;
  registerCleanup: (cleanup: () => void) => void;
  isAuthenticated: () => boolean;
  hasPermission: (permissions: RolePermissions | null | undefined, permission: keyof RolePermissions) => boolean;
  getRolePermissions: () => RolePermissions | null;
}

export class ChannelController {
  private deps: ChannelControllerDeps;
  private unreadCounts: Map<string, number> = new Map();

  constructor(deps: ChannelControllerDeps) {
    this.deps = deps;
  }

  dispose(): void {
    // No specific cleanup needed for this controller
  }

  /**
   * Handle channels update from server
   */
  handleChannelsUpdate(data: Channel[] | { channels: Channel[]; groups?: unknown[] }): void {
    const channels = Array.isArray(data) ? data : data.channels;
    if (import.meta.env.DEV) {
      console.log('📋 ChannelController.handleChannelsUpdate - Received channels:', channels);
    }
    this.deps.state.setChannels(channels);
    this.pruneUnreadCounts(channels);
    this.updateChannelsUI(channels);
  }

  /**
   * Handle join channel action
   */
  handleJoinChannel(): void {
    const channelInput = this.deps.elements.channel as HTMLInputElement;
    const channel = channelInput?.value?.trim() || 'lobby';
    
    this.deps.state.setChannel(channel);
    this.deps.socket.joinChannel(channel);
    
    const streamChannelNameEl = this.deps.elements.streamChannelName as HTMLElement | undefined;
    if (streamChannelNameEl) {
      streamChannelNameEl.textContent = channel;
    }

    const streamKeyDisplayEl = this.deps.elements.streamKeyDisplay as HTMLElement | undefined;
    if (streamKeyDisplayEl) {
      streamKeyDisplayEl.textContent = 'Tap 🔑 to fetch key';
    }
  }

  /**
   * Show create channel modal
   */
  showCreateChannelModal(type: 'text' | 'voice' | 'stream'): void {
    const modal = this.deps.elements.createChannelModal;
    const typeInput = this.deps.elements.newChannelType as HTMLInputElement;
    const nameInput = this.deps.elements.newChannelName as HTMLInputElement;
    const errorEl = this.deps.elements.createChannelError;
    const title = document.getElementById('create-channel-title');

    if (!modal) return;

    // Set type
    if (typeInput) typeInput.value = type;
    
    // Update title
    if (title) {
      const typeLabel = type === 'text' ? 'Text' : type === 'voice' ? 'Voice' : 'Stream';
      title.textContent = `Create ${typeLabel} Channel`;
    }

    // Clear inputs
    if (nameInput) {
      nameInput.value = '';
      nameInput.focus();
    }
    if (errorEl) errorEl.textContent = '';

    this.deps.animator.openModal(modal);
    this.deps.soundFX.play('click', 0.4);
  }

  /**
   * Hide create channel modal
   */
  hideCreateChannelModal(): void {
    const modal = this.deps.elements.createChannelModal;
    if (!modal) return;
    
    this.deps.animator.closeModal(modal);
  }

  /**
   * Handle create channel
   */
  handleCreateChannel(): void {
    if (!this.deps.isAuthenticated()) {
      this.deps.notifications.warning('Please log in to create channels');
      this.hideCreateChannelModal();
      return;
    }

    const rolePermissions = this.deps.getRolePermissions();
    if (!this.deps.hasPermission(rolePermissions, 'canCreateChannels')) {
      this.deps.notifications.warning("You don't have permission to create channels");
      this.hideCreateChannelModal();
      return;
    }

    const nameInput = this.deps.elements.newChannelName as HTMLInputElement;
    const typeInput = this.deps.elements.newChannelType as HTMLInputElement;
    const errorEl = this.deps.elements.createChannelError;

    const name = nameInput?.value?.trim();
    const type = typeInput?.value as 'text' | 'voice' | 'stream';
    
    if (!name) {
      if (errorEl) errorEl.textContent = 'Channel name is required';
      this.deps.soundFX.play('error', 0.5);
      return;
    }

    if (name.length < 3 || name.length > 32) {
      if (errorEl) errorEl.textContent = 'Channel name must be 3-32 characters';
      this.deps.soundFX.play('error', 0.5);
      return;
    }

    // Validate name format
    if (!/^[a-z0-9-]+$/i.test(name)) {
      if (errorEl) errorEl.textContent = 'Only letters, numbers, and hyphens allowed';
      this.deps.soundFX.play('error', 0.5);
      return;
    }

    // Send create request to server
    this.deps.socket.createChannel({ name, type, groupId: null });
    
    this.hideCreateChannelModal();
    this.deps.soundFX.play('success', 0.6);
    this.deps.notifications.info(`Creating ${type} channel: ${name}`);
  }

  /**
   * Update channels UI - renders all channel lists
   */
  private updateChannelsUI(channels: Channel[]): void {
    const currentChannel = this.deps.state.get('currentChannel');
    
    // Separate channels by type
    const textChannels = channels.filter(ch => ch.type === 'text');
    const voiceChannels = channels.filter(ch => ch.type === 'voice');
    const streamChannels = channels.filter(ch => ch.type === 'stream');

    if (import.meta.env.DEV) {
      console.log('🔄 ChannelController.updateChannelsUI - Text:', textChannels.length, 'Voice:', voiceChannels.length, 'Stream:', streamChannels.length);
      console.log('🔍 Element checks - text-channels:', !!this.deps.elements['text-channels'], 'channelsList:', !!this.deps.elements.channelsList, 'stream-channels:', !!this.deps.elements['stream-channels']);
    }

    // Update text channels
    if (this.deps.elements['text-channels']) {
      this.renderChannelList(this.deps.elements['text-channels'], textChannels, currentChannel, 'text');
    }

    // Update voice channels
    if (this.deps.elements.channelsList) {
      this.renderChannelList(this.deps.elements.channelsList, voiceChannels, currentChannel, 'voice');
    }

    // Update stream channels
    if (this.deps.elements['stream-channels']) {
      this.renderChannelList(this.deps.elements['stream-channels'], streamChannels, currentChannel, 'stream');
    }
  }

  /**
   * Render a list of channels in a container
   */
  private renderChannelList(container: HTMLElement, channels: Channel[], currentChannelId: string, type: 'text' | 'voice' | 'stream'): void {
    if (import.meta.env.DEV) {
      console.log(`📝 ChannelController.renderChannelList - Type: ${type}, Channels: ${channels.length}, Container:`, container);
    }
    
    container.innerHTML = '';

    if (channels.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'channel-list-empty';
      empty.textContent = `No ${type} channels`;
      container.appendChild(empty);
      if (import.meta.env.DEV) {
        console.log(`ℹ️ No ${type} channels to display`);
      }
      return;
    }

    channels.forEach(ch => {
      const item = document.createElement('div');
      item.className = `channel-item${ch.id === currentChannelId ? ' active' : ''}`;
      
      // Add voice-connected class if user is connected to this voice channel
      const voiceConnected = this.deps.state.get('voiceConnected');
      const activeVoiceChannelId = this.deps.state.get('activeVoiceChannelId');
      if (type === 'voice' && voiceConnected && activeVoiceChannelId && ch.id === activeVoiceChannelId) {
        item.classList.add('voice-connected');
      }
      
      // Add watching-stream class if user is in voice AND currently viewing a stream
      const videoContainer = this.deps.elements.inlineVideoContainer as HTMLElement;
  const isWatchingStream = !!(videoContainer && !videoContainer.classList.contains('hidden'));
      const currentChannelType = this.deps.state.get('currentChannelType');
      if (type === 'voice' && voiceConnected && activeVoiceChannelId && ch.id === activeVoiceChannelId && isWatchingStream && currentChannelType === 'stream') {
        item.classList.add('watching-stream');
      }
      
      item.setAttribute('data-channel-id', ch.id);
      item.setAttribute('data-channel', ch.name);
      item.setAttribute('data-type', type);

      // Channel icon and name
      const icon = document.createElement('span');
      icon.className = 'channel-icon';
      icon.textContent = type === 'text' ? '#' : type === 'voice' ? '🔊' : '📺';

      const content = document.createElement('div');
      content.className = 'channel-content';

      const name = document.createElement('span');
      name.className = 'channel-name';
      name.textContent = ch.name;

      content.appendChild(name);

      item.appendChild(icon);
      item.appendChild(content);

      if (type === 'stream') {
        const isAuthenticated = this.deps.isAuthenticated();

        if (isAuthenticated) {
          const actions = document.createElement('div');
          actions.className = 'channel-actions';

          const streamKeyBtn = document.createElement('button');
          streamKeyBtn.type = 'button';
          streamKeyBtn.className = 'stream-key-button';
          streamKeyBtn.title = `Show stream key for ${ch.name}`;
          streamKeyBtn.setAttribute('aria-label', `Show stream key for ${ch.name}`);
          streamKeyBtn.textContent = '🔑';

          streamKeyBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            event.preventDefault();

            if (!this.deps.isAuthenticated()) {
              this.deps.notifications.warning('Please log in to view stream keys');
              this.deps.soundFX.play('error', 0.5);
              return;
            }

            this.deps.soundFX.play('click', 0.45);

            if (import.meta.env.DEV) {
              console.log('🔑 Requesting stream key for channel:', ch.name);
            }

            const streamChannelNameEl = this.deps.elements.streamChannelName as HTMLElement | undefined;
            if (streamChannelNameEl) {
              streamChannelNameEl.textContent = ch.name;
            }

            const streamKeyDisplayEl = this.deps.elements.streamKeyDisplay as HTMLElement | undefined;
            if (streamKeyDisplayEl) {
              streamKeyDisplayEl.textContent = 'Fetching key...';
            }

            this.deps.socket.requestStreamKey(ch.id, ch.name);
          });

          actions.appendChild(streamKeyBtn);
          item.appendChild(actions);
        }
      }

      // User count for voice channels
      if (type === 'voice' && ch.count > 0) {
        const count = document.createElement('span');
        count.className = 'channel-count';
        count.textContent = `🗣️ ${ch.count}`;
        count.title = `${ch.count} participant${ch.count !== 1 ? 's' : ''}`;
  count.setAttribute('aria-label', `${ch.count} voice participant${ch.count !== 1 ? 's' : ''}`);
        count.addEventListener('click', (event) => {
          event.stopPropagation();
          event.preventDefault();
        });
        count.addEventListener('pointerdown', (event) => {
          event.stopPropagation();
        });
        item.appendChild(count);
      }

      this.decorateChannelUnread(item, ch.id);

      container.appendChild(item);

      // Voice channel users (show underneath the channel item)
      if (type === 'voice' && ch.count > 0) {
        // User list in voice channels is now handled by VoiceController/VoicePanel
      }

      // Add click event handler for the channel item
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        // Emit a custom event that App.ts can listen to
        const event = new CustomEvent('channel-select', {
          detail: { channelId: ch.id, channelName: ch.name, type },
          bubbles: true,
          composed: true,
        });
        item.dispatchEvent(event);
      });
    });
  }

  /**
   * Switch to a different channel (called by App.ts)
   */
  switchChannel(channelId: string, channelName: string, type: 'text' | 'voice' | 'stream'): void {
    // Play channel switch sound
    this.deps.soundFX.play('click', 0.5);
    
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
   * Perform the actual channel switch
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

    if (type === 'stream') {
      const streamChannelNameEl = this.deps.elements.streamChannelName as HTMLElement | undefined;
      if (streamChannelNameEl) {
        streamChannelNameEl.textContent = channelName;
      }

      const streamKeyDisplayEl = this.deps.elements.streamKeyDisplay as HTMLElement | undefined;
      if (streamKeyDisplayEl) {
        streamKeyDisplayEl.textContent = 'Tap 🔑 to fetch key';
      }
    }

    // Update state
    this.deps.state.setChannelWithType(channelId, type);

    if (type === 'text' || type === 'stream') {
      this.clearChannelUnread(channelId);
    }
    
    // Join socket channel
    this.deps.socket.joinChannel(channelId);
    
    if (import.meta.env.DEV) {
      console.log(`📍 ChannelController: Switched to ${type} channel:`, channelName);
    }
  }

  markChannelUnread(channelId: string): void {
    const currentChannel = this.deps.state.get('currentChannel');
    if (currentChannel === channelId) {
      return;
    }

    const channels = this.deps.state.get('channels');
    const channel = channels.find((ch) => ch.id === channelId);
    if (!channel || channel.type !== 'text') {
      return;
    }

    const nextCount = (this.unreadCounts.get(channelId) ?? 0) + 1;
    this.unreadCounts.set(channelId, nextCount);
    this.applyUnreadState(channelId);
  }

  clearChannelUnread(channelId: string): void {
    if (!this.unreadCounts.has(channelId)) {
      return;
    }

    this.unreadCounts.delete(channelId);
    this.applyUnreadState(channelId);
  }

  private pruneUnreadCounts(channels: Channel[]): void {
    const validIds = new Set(
      channels
        .filter((ch) => ch.type === 'text')
        .map((ch) => ch.id)
    );

    for (const channelId of Array.from(this.unreadCounts.keys())) {
      if (!validIds.has(channelId)) {
        this.unreadCounts.delete(channelId);
      }
    }
  }

  private applyUnreadState(channelId: string): void {
    const item = document.querySelector(`[data-channel-id="${channelId}"]`) as HTMLElement | null;
    if (!item) {
      return;
    }

    this.decorateChannelUnread(item, channelId);
  }

  private decorateChannelUnread(item: HTMLElement, channelId: string): void {
    const channelType = item.getAttribute('data-type');
    const isTextChannel = channelType === 'text';
    const unread = this.unreadCounts.get(channelId) ?? 0;

    if (!isTextChannel) {
      item.classList.remove('has-unread');
      const existing = item.querySelector('.channel-unread-badge');
      existing?.remove();
      return;
    }

    item.classList.toggle('has-unread', unread > 0);

    let badge = item.querySelector('.channel-unread-badge') as HTMLElement | null;
    if (unread > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'channel-unread-badge';
        const content = item.querySelector('.channel-content');
        (content ?? item).appendChild(badge);
      }
      badge.textContent = unread > 99 ? '99+' : unread.toString();
    } else if (badge) {
      badge.remove();
    }
  }
}
