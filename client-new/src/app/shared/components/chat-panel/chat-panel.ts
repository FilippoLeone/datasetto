import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChatMessagesComponent } from '../chat-messages/chat-messages';
import { ChatInputComponent } from '../chat-input/chat-input';
import { Message } from '../../../core/services/data.service';

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
  @Output() messageSent = new EventEmitter<string>();

  onMessageSent(content: string): void {
    // Emit the message to parent component
    this.messageSent.emit(content);
  }
}
