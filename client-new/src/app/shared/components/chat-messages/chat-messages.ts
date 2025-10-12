import { Component, Input, Output, EventEmitter, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Message } from '../../../core/services/data.service';

interface EmojiData {
  slug: string;
  character: string;
  unicodeName: string;
  codePoint: string;
  group: string;
  subGroup: string;
}

interface EmojiGroup {
  [category: string]: EmojiData[];
}

interface MessageReaction {
  emoji: string;
  count: number;
  users: string[];
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
  isLoadingEmojis: boolean = false;
  messageReactions: { [messageId: string]: MessageReaction[] } = {};

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    this.loadQuickReactions();
  }

  loadQuickReactions(): void {
    this.isLoadingEmojis = true;
    const API_KEY = '4a29e28a5ef023f5a6076750dcdcd7b9e1336cc6';
    
    // Load emojis and pick popular ones for quick reactions
    this.http.get<EmojiData[]>(`https://emoji-api.com/emojis?access_key=${API_KEY}`)
      .subscribe({
        next: (emojis) => {
          // Select popular reaction emojis
          const popularReactionChars = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🎉', '🔥'];
          
          this.quickReactions = emojis.filter(emoji => 
            popularReactionChars.includes(emoji.character)
          ).slice(0, 8);
          
          this.isLoadingEmojis = false;
        },
        error: (error) => {
          console.error('Failed to load reactions:', error);
          this.isLoadingEmojis = false;
        }
      });
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
      r => r.emoji === emoji.character
    );

    if (existingReaction) {
      // Increment count if already exists
      existingReaction.count++;
      existingReaction.users.push('You'); // In real app, use actual user name
    } else {
      // Add new reaction
      this.messageReactions[messageId].push({
        emoji: emoji.character,
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
