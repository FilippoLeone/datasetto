import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChatMessagesComponent } from '../chat-messages/chat-messages';
import { ChatInputComponent } from '../chat-input/chat-input';
import { Message } from '../../../core/services/data.service';

interface MessageWithReply {
  content: string;
  replyTo?: {
    id: string;
    author: string;
    content: string;
  };
}

@Component({
  selector: 'app-chat-panel',
  standalone: true,
  imports: [CommonModule, ChatMessagesComponent, ChatInputComponent],
  templateUrl: './chat-panel.html',
  styleUrl: './chat-panel.scss'
})
export class ChatPanelComponent {
  @Input() messages: Message[] = [];
  @Input() channelName: string = '';
  @Output() messageSent = new EventEmitter<MessageWithReply>();

  replyingTo: Message | null = null;

  onMessageSent(messageData: MessageWithReply): void {
    // Emit the message to parent component
    this.messageSent.emit(messageData);
    // Clear reply after sending
    this.replyingTo = null;
  }

  onReplyToMessage(message: Message): void {
    this.replyingTo = message;
  }

  cancelReply(): void {
    this.replyingTo = null;
  }
}
