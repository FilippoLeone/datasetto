import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-chat-input',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat-input.html',
  styleUrl: './chat-input.scss'
})
export class ChatInputComponent {
  @Input() channelName: string = '';
  @Output() messageSent = new EventEmitter<string>();

  messageText: string = '';

  onSubmit(): void {
    if (this.messageText.trim()) {
      this.messageSent.emit(this.messageText.trim());
      this.messageText = '';
    }
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.onSubmit();
    }
  }
}
