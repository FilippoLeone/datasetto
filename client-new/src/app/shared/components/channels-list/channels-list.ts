import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChannelCategory, DiscordChannel } from '../../../core/services/data.service';

@Component({
  selector: 'app-channels-list',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './channels-list.html',
  styleUrl: './channels-list.scss'
})
export class ChannelsListComponent {
  @Input() categories: ChannelCategory[] = [];
  @Input() activeChannelId: string | null = null;
  @Output() channelSelected = new EventEmitter<string>();

  onChannelClick(channel: DiscordChannel): void {
    if (channel.type === 'text') {
      this.channelSelected.emit(channel.id);
    }
  }

  isActive(channelId: string): boolean {
    return this.activeChannelId === channelId;
  }
}
