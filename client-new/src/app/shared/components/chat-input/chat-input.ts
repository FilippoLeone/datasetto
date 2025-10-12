import { Component, Input, Output, EventEmitter, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import emojisData from '../../../../assets/emojis.json';

interface Message {
  id: string;
  content: string;
  author: {
    name: string;
    avatarUrl: string;
  };
  timestamp: Date;
}

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

interface EmojiCategory {
  name: string;
  emojis: EmojiData[];
}

interface MessageWithReply {
  content: string;
  replyTo?: {
    id: string;
    author: string;
    content: string;
  };
}

@Component({
  selector: 'app-chat-input',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat-input.html',
  styleUrl: './chat-input.scss'
})
export class ChatInputComponent implements OnInit {
  @Input() channelName: string = '';
  @Input() replyingTo: Message | null = null;
  @Output() messageSent = new EventEmitter<MessageWithReply>();
  @Output() cancelReply = new EventEmitter<void>();

  messageText: string = '';
  showEmojiPicker: boolean = false;
  emojiCategories: EmojiCategory[] = [];
  selectedCategory: string = 'Smileys & Emotion';

  constructor() {}

  ngOnInit(): void {
    this.loadEmojis();
  }

  loadEmojis(): void {
    // Load emojis from local JSON file
    const data = emojisData as EmojisJson;
    
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

  onSubmit(): void {
    if (this.messageText.trim()) {
      const messageData: MessageWithReply = {
        content: this.messageText.trim()
      };

      // Include reply information if replying to a message
      if (this.replyingTo) {
        messageData.replyTo = {
          id: this.replyingTo.id,
          author: this.replyingTo.author.name,
          content: this.replyingTo.content
        };
      }

      this.messageSent.emit(messageData);
      this.messageText = '';
    }
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.onSubmit();
    }
  }

  toggleEmojiPicker(): void {
    this.showEmojiPicker = !this.showEmojiPicker;
  }

  insertEmoji(emojiData: EmojiData): void {
    this.messageText += emojiData.emoji;
    this.showEmojiPicker = false;
  }

  onCancelReply(): void {
    this.cancelReply.emit();
  }
}
