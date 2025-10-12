import { Component, Input, Output, EventEmitter, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Message } from '../../../core/services/data.service';
import emojisData from '../../../../assets/emojis.json';

interface EmojiData {
  code: string[];
  emoji: string;
  name: string;
  image: string;
}

interface EmojisJson {
  '@version': string;
  '@author': string;
  '@copyright': string;
  '@see': string;
  '@license': string;
  emojis: {
    [category: string]: {
      [subCategory: string]: EmojiData[];
    };
  };
}

interface MessageReaction {
  emoji: string;
  count: number;
  users: string[];
}

interface EmojiCategory {
  name: string;
  emojis: EmojiData[];
}

@Component({
  selector: 'app-chat-messages',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './chat-messages.html',
  styleUrl: './chat-messages.scss'
})
export class ChatMessagesComponent implements OnInit {
  @Input() messages: Message[] = [];
  @Input() channelName: string = '';
  @Output() replyToMessage = new EventEmitter<Message>();

  showReactionPicker: { [messageId: string]: boolean } = {};
  quickReactions: EmojiData[] = [];
  emojiCategories: EmojiCategory[] = [];
  selectedCategory: string = 'Smileys & Emotion';
  messageReactions: { [messageId: string]: MessageReaction[] } = {};

  constructor() {}

  ngOnInit(): void {
    this.loadQuickReactions();
  }

  loadQuickReactions(): void {
    // Load emojis from local JSON file
    const data = emojisData as EmojisJson;
    
    // Flatten all emojis from all categories
    const allEmojis: EmojiData[] = [];
    for (const category in data.emojis) {
      for (const subCategory in data.emojis[category]) {
        allEmojis.push(...data.emojis[category][subCategory]);
      }
    }
    
    // Select popular reaction emojis
    const popularReactionChars = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🎉', '🔥'];
    
    this.quickReactions = allEmojis.filter(emoji => 
      popularReactionChars.includes(emoji.emoji)
    ).slice(0, 8);

    // Organize emojis by category
    for (const category in data.emojis) {
      const categoryEmojis: EmojiData[] = [];
      for (const subCategory in data.emojis[category]) {
        categoryEmojis.push(...data.emojis[category][subCategory]);
      }
      this.emojiCategories.push({
        name: category,
        emojis: categoryEmojis
      });
    }
  }

  selectCategory(categoryName: string): void {
    this.selectedCategory = categoryName;
  }

  getCategoryEmojis(categoryName: string): EmojiData[] {
    const category = this.emojiCategories.find(c => c.name === categoryName);
    return category ? category.emojis : [];
  }

  getInitials(name: string): string {
    return name.charAt(0).toUpperCase();
  }

  toggleReactionPicker(messageId: string, event: Event): void {
    event.stopPropagation();
    // Close all other pickers
    Object.keys(this.showReactionPicker).forEach(id => {
      if (id !== messageId) {
        this.showReactionPicker[id] = false;
      }
    });
    // Toggle current picker
    this.showReactionPicker[messageId] = !this.showReactionPicker[messageId];
  }

  addReaction(messageId: string, emoji: EmojiData, event: Event): void {
    event.stopPropagation();
    
    // Initialize reactions for this message if not exists
    if (!this.messageReactions[messageId]) {
      this.messageReactions[messageId] = [];
    }

    // Check if this emoji already exists
    const existingReaction = this.messageReactions[messageId].find(
      r => r.emoji === emoji.emoji
    );

    if (existingReaction) {
      // Increment count if already exists
      existingReaction.count++;
      existingReaction.users.push('You'); // In real app, use actual user name
    } else {
      // Add new reaction
      this.messageReactions[messageId].push({
        emoji: emoji.emoji,
        count: 1,
        users: ['You']
      });
    }

    this.showReactionPicker[messageId] = false;
  }

  getReactions(messageId: string): MessageReaction[] {
    return this.messageReactions[messageId] || [];
  }

  hasReactions(messageId: string): boolean {
    return this.messageReactions[messageId]?.length > 0;
  }

  closeReactionPicker(messageId: string): void {
    this.showReactionPicker[messageId] = false;
  }

  replyTo(message: Message, event: Event): void {
    event.stopPropagation();
    this.replyToMessage.emit(message);
  }

  parseQuotedMessage(content: string): { quoted: string | null; reply: string } {
    // Check if message contains a quote (format: @Author: "quoted text"\n\nReply)
    const quotePattern = /^@(.+?):\s*"(.+?)"\n\n(.+)$/s;
    const match = content.match(quotePattern);
    
    if (match) {
      return {
        quoted: `@${match[1]}: "${match[2]}"`,
        reply: match[3]
      };
    }
    
    return {
      quoted: null,
      reply: content
    };
  }

  hasQuotedMessage(content: string): boolean {
    return content.includes('\n\n') && content.startsWith('@');
  }
}
