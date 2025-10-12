import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterOutlet, ActivatedRoute } from '@angular/router';
import { Store } from '@ngrx/store';
import { Observable, map, filter, take, combineLatest } from 'rxjs';
import { User, Channel } from '../../../core/models';
import { selectUser } from '../../../store/auth/auth.selectors';
import { selectAllChannels, selectCurrentChannelId } from '../../../store/channel/channel.selectors';
import * as ChannelActions from '../../../store/channel/channel.actions';
import { ChannelsListComponent } from '../channels-list/channels-list';
import { VoicePanel } from '../../../features/voice/voice-panel/voice-panel';
import { ChannelCategory, DiscordChannel, UserGroup, DiscordUser } from '../../../core/services/data.service';
import { VoiceController } from '../../../core/controllers/voice.controller';
import { AvatarService } from '../../../core/services/avatar.service';

@Component({
  selector: 'app-main-layout',
  imports: [CommonModule, RouterOutlet, ChannelsListComponent, VoicePanel],
  templateUrl: './main-layout.html',
  styleUrl: './main-layout.css'
})
export class MainLayout implements OnInit {
  user$: Observable<User | null>;
  channels$: Observable<Channel[]>;
  currentChannelId$: Observable<string | null>;
  categories$: Observable<ChannelCategory[]>;
  userGroups$: Observable<UserGroup[]>;
  voiceState$: Observable<any>;
  voiceParticipants$: Observable<{ [channelId: string]: any[] }>;
  sidebarOpen = true;

  private avatarService = inject(AvatarService);

  constructor(
    private store: Store,
    private router: Router,
    private route: ActivatedRoute,
    private voiceController: VoiceController
  ) {
    this.user$ = this.store.select(selectUser);
    this.channels$ = this.store.select(selectAllChannels);
    this.currentChannelId$ = this.store.select(selectCurrentChannelId);
    
    // Transform channels into Discord categories format
    this.categories$ = this.channels$.pipe(
      map(channels => this.transformChannelsToCategories(channels))
    );
    
    // Create user groups from current user (can be expanded with real users list)
    this.userGroups$ = this.user$.pipe(
      map(user => this.createUserGroups(user))
    );
    
    // Get voice state for voice panel visibility
    this.voiceState$ = this.voiceController.getVoiceState();
    
    // Map voice state to participants by channel
    this.voiceParticipants$ = this.voiceState$.pipe(
      map(state => {
        if (!state.isConnected || !state.channelId) {
          return {};
        }
        // Return participants mapped by channel ID
        return {
          [state.channelId]: state.connectedUsers || []
        };
      })
    );
  }

  ngOnInit(): void {
    // Load channels on init
    this.store.dispatch(ChannelActions.loadChannels());
    
    // Auto-select first channel when channels load and no channel is selected
    combineLatest([
      this.channels$.pipe(filter(channels => channels.length > 0)),
      this.currentChannelId$
    ]).pipe(
      take(1),
      filter(([channels, currentId]) => !currentId && channels.length > 0)
    ).subscribe(([channels]) => {
      // Find first text channel
      const firstTextChannel = channels.find(c => c.type === 'text');
      if (firstTextChannel) {
        this.selectChannel(firstTextChannel.id, 'text');
      }
    });
  }

  toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen;
  }

  getChannelsByType(channels: Channel[] | null, type: 'text' | 'voice' | 'stream'): Channel[] {
    return channels?.filter(c => c.type === type) || [];
  }

  selectChannel(channelId: string, channelType: 'text' | 'voice' | 'stream'): void {
    // Update the store with the selected channel
    this.store.dispatch(ChannelActions.setCurrentChannel({ channelId, channelType }));
    
    // Navigate to the appropriate route
    if (channelType === 'text') {
      this.router.navigate(['/chat', channelId]);
    } else if (channelType === 'voice') {
      // For voice channels, join the voice channel using VoiceController
      console.log('[MainLayout] Joining voice channel:', channelId);
      this.voiceController.joinVoiceChannel(channelId).catch(error => {
        console.error('[MainLayout] Failed to join voice channel:', error);
        // Could show error notification here
      });
      // Don't navigate away - voice channels work alongside current view
    } else if (channelType === 'stream') {
      this.router.navigate(['/stream', channelId]);
    }
  }

  isChannelActive(channelId: string): boolean {
    let currentId: string | null = null;
    this.currentChannelId$.subscribe(id => currentId = id).unsubscribe();
    return currentId === channelId;
  }

  /**
   * Get user avatar URL
   */
  getUserAvatarUrl(user: User): string {
    // If user has a custom avatar URL, use it
    if (user.avatarUrl) {
      return user.avatarUrl;
    }

    // Use avatar service for consistent avatars
    const username = user.displayName || user.username;
    return this.avatarService.getAvatarUrl(username, 32);
  }

  /**
   * Transform existing Channel[] into Discord ChannelCategory[] format
   */
  private transformChannelsToCategories(channels: Channel[]): ChannelCategory[] {
    const textChannels = channels
      .filter(c => c.type === 'text')
      .map(c => ({
        id: c.id,
        name: c.name,
        type: 'text' as const
      }));

    const voiceChannels = channels
      .filter(c => c.type === 'voice')
      .map(c => ({
        id: c.id,
        name: c.name,
        type: 'voice' as const
      }));

    const streamChannels = channels
      .filter(c => c.type === 'stream')
      .map(c => ({
        id: c.id,
        name: c.name,
        type: 'voice' as const // Treat streams as voice for UI purposes
      }));

    const categories: ChannelCategory[] = [];

    if (textChannels.length > 0) {
      categories.push({
        id: 'cat-text',
        name: 'TEXT CHANNELS',
        channels: textChannels
      });
    }

    if (voiceChannels.length > 0) {
      categories.push({
        id: 'cat-voice',
        name: 'VOICE CHANNELS',
        channels: voiceChannels
      });
    }

    if (streamChannels.length > 0) {
      categories.push({
        id: 'cat-streams',
        name: 'LIVE STREAMS',
        channels: streamChannels
      });
    }

    return categories;
  }

  /**
   * Create user groups from current user (placeholder for real users list)
   */
  private createUserGroups(user: User | null): UserGroup[] {
    if (!user) return [];

    // Use same name format as everywhere else for consistency
    const displayName = user.displayName || user.username;
    
    const currentUserData: DiscordUser = {
      id: user.id,
      name: displayName,
      status: 'online',
      avatarUrl: user.avatarUrl || this.avatarService.getAvatarUrl(displayName, 32),
      role: user.isSuperuser ? 'Admin' : undefined
    };

    if (user.isSuperuser) {
      return [
        {
          role: 'Admins',
          users: [currentUserData]
        },
        {
          role: 'Members',
          users: [] // Will be populated when we have real users list
        }
      ];
    } else {
      return [
        {
          role: 'Members',
          users: [currentUserData]
        }
      ];
    }
  }

  /**
   * Generate a color from username for avatar placeholder
   */
  private getColorFromName(name: string): string {
    const colors = ['FF6B6B', '4ECDC4', 'FFE66D', '95E1D3', 'A8E6CF', 'FFDAC1', 'B4A7D6', '9AD1D4'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  }

  /**
   * Handle channel selection from channels-list component
   */
  onChannelSelected(event: { channel: any; type: 'text' | 'voice' | 'stream' } | string): void {
    // Handle both new format (object with channel and type) and old format (just channelId string)
    if (typeof event === 'string') {
      // Old format - assume text channel
      this.selectChannel(event, 'text');
    } else {
      // New format - use provided type
      const { channel, type } = event;
      this.selectChannel(channel.id, type);
    }
  }
}
