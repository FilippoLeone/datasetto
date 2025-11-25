/**
 * ChannelController
 * Manages channel list rendering, channel switching, and channel creation
 */

import type { Channel, RolePermissions } from '@/types';
import type { SocketService, AudioNotificationService } from '@/services';
import type { StateManager, AnimationController } from '@/utils';
import type { NotificationManager } from '@/components/NotificationManager';
import { escapeHtml, createSvgIcon } from '@/utils';

// SVG icon templates (trusted, hardcoded strings)
const CHANNEL_ICONS = {
  text: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"></line><line x1="4" y1="15" x2="20" y2="15"></line><line x1="10" y1="3" x2="8" y2="21"></line><line x1="16" y1="3" x2="14" y2="21"></line></svg>`,
  voice: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`,
  stream: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`,
  screenshare: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`,
  key: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path></svg>`,
  users: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`,
} as const;

const HIDDEN_CHANNEL_NAMES = new Set(['team-share', 'main-stream']);

const normalizeChannelKey = (value?: string | null): string => {
  if (!value) {
    return '';
  }

  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '-');
};

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
  showCreateChannelModal(type: 'text' | 'voice' | 'stream' | 'screenshare'): void {
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
      const typeLabel = type === 'text'
        ? 'Text'
        : type === 'voice'
          ? 'Voice'
          : type === 'stream'
            ? 'Stream'
            : 'Screenshare';
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
    const type = typeInput?.value as 'text' | 'voice' | 'stream' | 'screenshare';

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
    const visibleChannels = channels.filter((ch) => {
      const normalizedName = normalizeChannelKey(ch.name);
      const normalizedId = normalizeChannelKey(ch.id);
      return !HIDDEN_CHANNEL_NAMES.has(normalizedName) && !HIDDEN_CHANNEL_NAMES.has(normalizedId);
    });

    const currentChannel = this.deps.state.get('currentChannel');

    // Separate channels by type
    const textChannels = visibleChannels.filter(ch => ch.type === 'text');
    const voiceChannels = visibleChannels.filter(ch => ch.type === 'voice');
    const streamChannels = visibleChannels.filter(ch => ch.type === 'stream');
    const screenshareChannels = visibleChannels.filter(ch => ch.type === 'screenshare');

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

    if (this.deps.elements['screenshare-channels']) {
      this.renderChannelList(this.deps.elements['screenshare-channels'], screenshareChannels, currentChannel, 'screenshare');
    }
  }

  /**
   * Render a list of channels in a container
   */
  private renderChannelList(
    container: HTMLElement,
    channels: Channel[],
    currentChannelId: string,
    type: 'text' | 'voice' | 'stream' | 'screenshare',
  ): void {
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

      // SVG Icons
      const icons = {
        text: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"></line><line x1="4" y1="15" x2="20" y2="15"></line><line x1="10" y1="3" x2="8" y2="21"></line><line x1="16" y1="3" x2="14" y2="21"></line></svg>`,
        voice: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`,
        stream: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`,
        screenshare: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`
      };

      icon.innerHTML = type === 'text'
        ? icons.text
        : type === 'voice'
          ? icons.voice
          : type === 'stream'
            ? icons.stream
            : icons.screenshare;

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
          streamKeyBtn.setAttribute('aria-label', `Show stream key for ${escapeHtml(ch.name)}`);
          // Key icon - safely insert SVG
          const keyIconSvg = createSvgIcon(CHANNEL_ICONS.key);
          if (keyIconSvg) {
            streamKeyBtn.appendChild(keyIconSvg);
          }

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

      if (type === 'screenshare') {
        const sessionBadge = document.createElement('span');
        sessionBadge.className = 'channel-meta';
        const hostActive = Boolean(ch.screenshareHostName);
        // Safely escape user-provided hostname
        const safeHostName = escapeHtml(ch.screenshareHostName ?? 'Host');
        sessionBadge.textContent = hostActive
          ? `LIVE – ${safeHostName}`
          : 'Idle';
        sessionBadge.setAttribute('aria-label', hostActive ? 'Screenshare live' : 'Screenshare idle');
        sessionBadge.dataset.state = hostActive ? 'live' : 'idle';
        content.appendChild(sessionBadge);

        const viewerCount = document.createElement('span');
        viewerCount.className = 'channel-count';
        const countValue = ch.screenshareViewerCount ?? 0;
        // Safely insert users icon SVG
        const usersIconSvg = createSvgIcon(CHANNEL_ICONS.users);
        if (usersIconSvg) {
          viewerCount.appendChild(usersIconSvg);
        }
        viewerCount.appendChild(document.createTextNode(` ${countValue}`));
        viewerCount.title = `${countValue} viewer${countValue === 1 ? '' : 's'}`;
        viewerCount.setAttribute('aria-label', `${countValue} viewer${countValue === 1 ? '' : 's'}`);
        item.appendChild(viewerCount);
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
  switchChannel(channelId: string, channelName: string, type: 'text' | 'voice' | 'stream' | 'screenshare'): void {
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
  private performChannelSwitch(channelId: string, channelName: string, type: 'text' | 'voice' | 'stream' | 'screenshare'): void {
    // Remove active class from all channels
    document.querySelectorAll('.channel-item').forEach(item => {
      item.classList.remove('active');
    });

    // Add active class to selected channel
    const selectedChannel = document.querySelector(`[data-channel-id="${channelId}"]`);
    selectedChannel?.classList.add('active');

    // Update channel name in header
    const icons = {
      text: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"></line><line x1="4" y1="15" x2="20" y2="15"></line><line x1="10" y1="3" x2="8" y2="21"></line><line x1="16" y1="3" x2="14" y2="21"></line></svg>`,
      voice: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`,
      stream: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`,
      screenshare: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`
    };

    const channelIcon = icons[type];

    if (this.deps.elements['current-channel-name']) {
      this.deps.elements['current-channel-name'].textContent = channelName;
    }

    // Update channel icon in header
    const headerIcon = document.querySelector('.chat-header .channel-icon');
    if (headerIcon) {
      headerIcon.innerHTML = channelIcon;
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

    if (type === 'screenshare') {
      const streamChannelNameEl = this.deps.elements.streamChannelName as HTMLElement | undefined;
      if (streamChannelNameEl) {
        streamChannelNameEl.textContent = channelName;
      }
    }

    // Update state
    this.deps.state.setChannelWithType(channelId, type);

    if (type === 'text' || type === 'stream' || type === 'screenshare') {
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
