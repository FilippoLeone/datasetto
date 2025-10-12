import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Message } from '../../../core/services/data.service';

@Component({
  selector: 'app-chat-messages',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './chat-messages.html',
  styleUrl: './chat-messages.scss'
})
export class ChatMessagesComponent {
  @Input() messages: Message[] = [];
  @Input() channelName: string = '';

  getInitials(name: string): string {
    return name.charAt(0).toUpperCase();
  }
}
