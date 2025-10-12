import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterOutlet } from '@angular/router';
import { Store } from '@ngrx/store';
import { Observable } from 'rxjs';
import { User, Channel } from '../../../core/models';
import { selectUser } from '../../../store/auth/auth.selectors';
import { selectAllChannels, selectCurrentChannelId } from '../../../store/channel/channel.selectors';
import * as ChannelActions from '../../../store/channel/channel.actions';

@Component({
  selector: 'app-main-layout',
  imports: [CommonModule, RouterOutlet],
  templateUrl: './main-layout.html',
  styleUrl: './main-layout.css'
})
export class MainLayout implements OnInit {
  user$: Observable<User | null>;
  channels$: Observable<Channel[]>;
  currentChannelId$: Observable<string | null>;
  sidebarOpen = true;

  constructor(
    private store: Store,
    private router: Router
  ) {
    this.user$ = this.store.select(selectUser);
    this.channels$ = this.store.select(selectAllChannels);
    this.currentChannelId$ = this.store.select(selectCurrentChannelId);
  }

  ngOnInit(): void {
    // Load channels on init
    this.store.dispatch(ChannelActions.loadChannels());
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
      // For voice channels, stay on the same page but update the voice panel
      this.router.navigate(['/voice', channelId]);
    } else if (channelType === 'stream') {
      this.router.navigate(['/stream', channelId]);
    }
  }

  isChannelActive(channelId: string): boolean {
    let currentId: string | null = null;
    this.currentChannelId$.subscribe(id => currentId = id).unsubscribe();
    return currentId === channelId;
  }
}
