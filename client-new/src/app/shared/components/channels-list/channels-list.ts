import { Component, Input, Output, EventEmitter, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChannelCategory, DiscordChannel } from '../../../core/services/data.service';
import { AvatarService } from '../../../core/services/avatar.service';

interface VoiceParticipant {
  userId: string;
  username: string;
  isSpeaking?: boolean;
}

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
  @Input() voiceParticipants: { [channelId: string]: VoiceParticipant[] } = {};
  @Output() channelSelected = new EventEmitter<{ channel: DiscordChannel; type: 'text' | 'voice' | 'stream' }>();

  private avatarService = inject(AvatarService);

  onChannelClick(channel: DiscordChannel): void {
    // Emit channel with type information
    this.channelSelected.emit({ 
      channel, 
      type: channel.type as 'text' | 'voice' | 'stream'
    });
  }

  isActive(channelId: string): boolean {
    return this.activeChannelId === channelId;
  }

  getVoiceParticipants(channelId: string): VoiceParticipant[] {
    return this.voiceParticipants[channelId] || [];
  }

  getParticipantCount(channelId: string): number {
    return this.getVoiceParticipants(channelId).length;
  }

  getAvatarUrl(username: string): string {
    return this.avatarService.getAvatarUrl(username, 20);
  }

  hasVoiceParticipants(channelId: string): boolean {
    return this.getParticipantCount(channelId) > 0;
  }
}
