import type { ChatControllerDeps } from './types';
import type { ChatMessage } from '@/types';
import { formatTime, sanitizeUrl } from '@/utils';

const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;

export class ChatController {
  private deps: ChatControllerDeps;
  private disposers: Array<() => void> = [];

  constructor(deps: ChatControllerDeps) {
    this.deps = deps;
  }

  initialize(): void {
    this.initializeEmojiPicker();
    this.registerSocketListeners();
    this.deps.registerCleanup(() => this.dispose());
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error('[ChatController] Error during dispose:', error);
        }
      }
    }
  }

  sendMessage(message: string): void {
    if (!message.trim()) return;
    console.log('[ChatController] sendMessage:', message);

    this.deps.socket.sendMessage(message);
    this.deps.soundFX.play('messageSent', 0.6);
  }

  handleChatMessage(message: ChatMessage, options?: { muteSound?: boolean }): void {
    console.log('[ChatController] handleChatMessage:', message);
    this.appendChatMessage(message, options);
  }

  handleChatHistory(messages: ChatMessage[]): void {
    console.log('[ChatController] handleChatHistory:', messages.length, 'messages');
    messages.forEach((message) => {
      this.appendChatMessage(message, { muteSound: true });
    });
  }

  toggleEmojiPicker(): void {
    const picker = this.deps.elements.emojiPicker;
    const button = this.deps.elements.emojiPickerBtn;
    if (!picker) return;

    const isVisible = !picker.classList.contains('hidden');
    picker.classList.toggle('hidden', isVisible);
    picker.setAttribute('aria-hidden', String(isVisible));
    if (button) {
      button.setAttribute('aria-expanded', String(!isVisible));
    }
  }

  hideEmojiPicker(): void {
    const picker = this.deps.elements.emojiPicker;
    if (picker) {
      picker.classList.add('hidden');
      picker.setAttribute('aria-hidden', 'true');
    }

    const button = this.deps.elements.emojiPickerBtn;
    if (button) {
      button.setAttribute('aria-expanded', 'false');
    }
  }

  insertEmoji(emoji: string): void {
    const input = this.deps.elements.chatInput as HTMLInputElement;
    if (!input) return;

    const start = input.selectionStart || 0;
    const end = input.selectionEnd || 0;
    const text = input.value;

    // Insert emoji at cursor position
    input.value = text.substring(0, start) + emoji + text.substring(end);
    
    // Move cursor after emoji
    const newPosition = start + emoji.length;
    input.selectionStart = newPosition;
    input.selectionEnd = newPosition;
    
    // Focus input
    input.focus();
  }

  private registerSocketListeners(): void {
    // Socket listeners are registered in App.ts to avoid duplication
    // This controller is called by App.ts when messages arrive
  }

  private initializeEmojiPicker(): void {
    const emojis = [
      '😀', '😂', '😍', '🥰', '😎', '🤔', '😊', '😢',
      '😭', '😡', '🥺', '😱', '🤗', '🙄', '😴', '🤤',
      '🎉', '🎊', '🎈', '🎁', '🎂', '🏆', '⭐', '✨',
      '👍', '👎', '👏', '🙌', '👋', '🤝', '💪', '🙏',
      '❤️', '💔', '💕', '💖', '💗', '💙', '💚', '💛',
      '🔥', '💯', '⚡', '💥', '💫', '✅', '❌', '❓',
      '💬', '📺', '🎵', '🎮', '🎬', '📱', '💻', '⌨️',
      '🍕', '🍔', '🍟', '🌮', '🍦', '🍰', '☕', '🍺',
    ];

    const grid = this.deps.elements.emojiGrid;
    if (!grid) return;

    grid.innerHTML = '';
    emojis.forEach(emoji => {
      const button = document.createElement('button');
      button.className = 'emoji-btn';
      button.textContent = emoji;
      button.type = 'button';
      button.addEventListener('click', () => this.insertEmoji(emoji));
      grid.appendChild(button);
    });
  }

  private appendChatMessage(message: ChatMessage, options?: { muteSound?: boolean }): void {
    const msgsContainer = this.deps.elements.msgs;
    console.log('[ChatController] appendChatMessage - msgsContainer:', msgsContainer, 'message:', message);
    if (!msgsContainer) {
      console.error('[ChatController] appendChatMessage - NO msgs container found!');
      return;
    }

    const previousMessage = msgsContainer.lastElementChild as HTMLElement | null;
    const previousTimestamp = previousMessage?.dataset.timestamp ? Number(previousMessage.dataset.timestamp) : null;
    const sameAuthorAsPrevious = previousMessage?.dataset.author === message.from;
    const withinGroupWindow = previousTimestamp ? message.ts - previousTimestamp <= MESSAGE_GROUP_WINDOW_MS : false;
    const isGroupedWithPrevious = Boolean(previousMessage && sameAuthorAsPrevious && withinGroupWindow);

    if (previousMessage) {
      previousMessage.classList.toggle('message--has-follow', isGroupedWithPrevious);
    }

  const messageDiv = document.createElement('div');
  messageDiv.className = 'message';
  messageDiv.dataset.author = message.from;
  messageDiv.dataset.timestamp = String(message.ts);
  messageDiv.dataset.messageId = message.id;
  messageDiv.dataset.channelId = message.channelId;

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = message.from.charAt(0).toUpperCase();

    const bubble = document.createElement('div');
    bubble.className = 'message-content message-bubble';

    const header = document.createElement('div');
    header.className = 'message-header';

    const author = document.createElement('span');
    author.className = 'message-author';
    author.textContent = message.from;

    const roleBadge = this.createRoleBadge(message);

    const timestamp = document.createElement('time');
    timestamp.className = 'message-timestamp';
    timestamp.textContent = formatTime(message.ts);
    timestamp.dateTime = new Date(message.ts).toISOString();
    timestamp.title = new Date(message.ts).toLocaleString();

    header.appendChild(author);
    if (roleBadge) {
      header.appendChild(roleBadge);
    }
    header.appendChild(timestamp);

    const text = this.buildMessageBody(message.text);

    bubble.appendChild(header);
    bubble.appendChild(text);

    if (isGroupedWithPrevious) {
      messageDiv.classList.add('message--grouped');
      bubble.classList.add('message-bubble--grouped');
      avatar.classList.add('message-avatar--hidden');
      author.classList.add('message-author--hidden');
      header.classList.add('message-header--grouped');
      if (roleBadge) {
        roleBadge.classList.add('message-role-badge--hidden');
      }
    }

    messageDiv.appendChild(avatar);
    messageDiv.appendChild(bubble);

    msgsContainer.appendChild(messageDiv);

    this.deps.animator.animateMessage(messageDiv);
    if (!options?.muteSound) {
      this.deps.soundFX.play('message', 0.5);
    }

    msgsContainer.scrollTop = msgsContainer.scrollHeight;
  }

  private createRoleBadge(message: ChatMessage): HTMLSpanElement | null {
    if (message.isSuperuser) {
      return this.buildRoleBadge('Superuser', 'superuser');
    }

    if (Array.isArray(message.roles) && message.roles.length > 0) {
      const label = this.formatRoleLabel(message.roles[0]);
      return this.buildRoleBadge(label, 'default');
    }

    return null;
  }

  private buildRoleBadge(label: string, variant: 'default' | 'superuser'): HTMLSpanElement {
    const badge = document.createElement('span');
    badge.className = 'message-role-badge';
    badge.textContent = label;

    if (variant === 'superuser') {
      badge.dataset.variant = 'superuser';
    }

    return badge;
  }

  private formatRoleLabel(role: string): string {
    return role
      .split(/[_\s]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  private buildMessageBody(rawText: string): HTMLElement {
    const body = document.createElement('div');
    body.className = 'message-text';

    const lines = rawText.split(/\r?\n/);
    lines.forEach((line) => {
      const lineEl = this.createMessageLine(line);
      body.appendChild(lineEl);
    });

    return body;
  }

  private createMessageLine(line: string): HTMLElement {
    const lineElement = document.createElement('p');
    const urlPattern = /(https?:\/\/[^\s]+)/gi;

    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = urlPattern.exec(line)) !== null) {
      const preceding = line.slice(lastIndex, match.index);
      if (preceding) {
        this.appendTextWithMentions(lineElement, preceding);
      }

      this.appendLink(lineElement, match[0]);
      lastIndex = match.index + match[0].length;
    }

    const remaining = line.slice(lastIndex);
    if (remaining || lineElement.childNodes.length === 0) {
      this.appendTextWithMentions(lineElement, remaining);
    }

    if (lineElement.childNodes.length === 0) {
      lineElement.appendChild(document.createTextNode('\u00A0'));
    }

    return lineElement;
  }

  private appendTextWithMentions(container: HTMLElement, text: string): void {
    if (!text) return;

    const mentionPattern = /@[A-Za-z0-9_\-]+/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = mentionPattern.exec(text)) !== null) {
      const before = text.slice(lastIndex, match.index);
      if (before) {
        container.appendChild(document.createTextNode(before));
      }

      const mention = document.createElement('span');
      mention.className = 'message-mention';
      mention.textContent = match[0];
      container.appendChild(mention);

      lastIndex = match.index + match[0].length;
    }

    const rest = text.slice(lastIndex);
    if (rest) {
      container.appendChild(document.createTextNode(rest));
    }
  }

  private appendLink(container: HTMLElement, url: string): void {
    const safeUrl = sanitizeUrl(url);
    
    if (!safeUrl) {
      // Unsafe URL - render as plain text instead
      container.appendChild(document.createTextNode(url));
      return;
    }
    
    const anchor = document.createElement('a');
    anchor.href = safeUrl;
    anchor.textContent = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    container.appendChild(anchor);
  }

  /**
   * Hide chat UI (for voice channels)
   */
  hideChatUI(): void {
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
      mainContent.classList.add('voice-mode');
    }
  }

  /**
   * Show chat UI (for text/stream channels)
   */
  showChatUI(): void {
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
      mainContent.classList.remove('voice-mode');
    }
  }

  /**
   * Clear chat messages (when switching channels)
   */
  clearMessages(): void {
    const msgsContainer = this.deps.elements.msgs;
    if (msgsContainer) {
      msgsContainer.innerHTML = '';
    }
  }
}
