import { Component, Input, Output, EventEmitter, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';

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
  slug: string;
  character: string;
  unicodeName: string;
  codePoint: string;
  group: string;
  subGroup: string;
}

interface CategoryData {
  slug: string;
  name: string;
}

interface EmojiGroup {
  [category: string]: EmojiData[];
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
  emojis: EmojiGroup = {};
  emojiCategories: string[] = [];
  isLoadingEmojis: boolean = false;

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    this.loadEmojis();
  }

  loadEmojis(): void {
    this.isLoadingEmojis = true;
    const API_KEY = '4a29e28a5ef023f5a6076750dcdcd7b9e1336cc6';
    
    // First, load categories
    this.http.get<CategoryData[]>(`https://emoji-api.com/categories?access_key=${API_KEY}`)
      .subscribe({
        next: (categories) => {
          // Filter to popular categories (first 8)
          const popularCategories = categories.slice(0, 8);
          
          // Load all emojis
          this.http.get<EmojiData[]>(`https://emoji-api.com/emojis?access_key=${API_KEY}`)
            .subscribe({
              next: (emojis) => {
                // Group emojis by their group (category)
                this.emojis = emojis.reduce((acc: EmojiGroup, emoji: EmojiData) => {
                  const category = emoji.group;
                  
                  // Only include emojis from popular categories
                  const isPopular = popularCategories.some(cat => cat.slug === category);
                  
                  if (isPopular) {
                    if (!acc[category]) {
                      acc[category] = [];
                    }
                    // Limit to 45 emojis per category for better performance
                    if (acc[category].length < 45) {
                      acc[category].push(emoji);
                    }
                  }
                  return acc;
                }, {});

                this.emojiCategories = Object.keys(this.emojis);
                this.isLoadingEmojis = false;
              },
              error: (error) => {
                console.error('Failed to load emojis:', error);
                this.isLoadingEmojis = false;
              }
            });
        },
        error: (error) => {
          console.error('Failed to load categories:', error);
          this.isLoadingEmojis = false;
        }
      });
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
    this.messageText += emojiData.character;
  }

  getEmojisForCategory(category: string): EmojiData[] {
    return this.emojis[category] || [];
  }

  onCancelReply(): void {
    this.cancelReply.emit();
  }
}
