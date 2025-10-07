import type { ChatControllerDeps } from './types';
import type { ChatMessage } from '@/types';
import { formatTime } from '@/utils';

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

    this.deps.socket.sendMessage(message);
    this.deps.soundFX.play('messageSent', 0.6);
  }

  handleChatMessage(message: ChatMessage): void {
    this.appendChatMessage(message);
  }

  handleChatHistory(messages: ChatMessage[]): void {
    messages.forEach((message) => {
      this.appendChatMessage(message);
    });
  }

  toggleEmojiPicker(): void {
    const picker = this.deps.elements.emojiPicker;
    if (!picker) return;

    const isVisible = picker.style.display === 'block';
    picker.style.display = isVisible ? 'none' : 'block';
  }

  hideEmojiPicker(): void {
    const picker = this.deps.elements.emojiPicker;
    if (picker) picker.style.display = 'none';
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
    
    // Hide picker
    this.hideEmojiPicker();
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

  private appendChatMessage(message: ChatMessage): void {
    const msgsContainer = this.deps.elements.msgs;
    if (!msgsContainer) return;

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';
    
    // Avatar
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = message.from.charAt(0).toUpperCase();
    
    // Content
    const content = document.createElement('div');
    content.className = 'message-content';
    
    // Header
    const header = document.createElement('div');
    header.className = 'message-header';
    
    const author = document.createElement('span');
    author.className = 'message-author';
    author.textContent = message.from;
    
    const timestamp = document.createElement('span');
    timestamp.className = 'message-timestamp';
    timestamp.textContent = formatTime(message.ts);
    
    header.appendChild(author);
    header.appendChild(timestamp);
    
    // Text
    const text = document.createElement('div');
    text.className = 'message-text';
    text.textContent = message.text;
    
    content.appendChild(header);
    content.appendChild(text);
    
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(content);
    
    msgsContainer.appendChild(messageDiv);
    
    // Add animation and sound effect
    this.deps.animator.animateMessage(messageDiv);
    this.deps.soundFX.play('message', 0.5);
    
    msgsContainer.scrollTop = msgsContainer.scrollHeight;
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
