import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ServersListComponent } from '../servers-list/servers-list';
import { ChannelsListComponent } from '../channels-list/channels-list';
import { ChatPanelComponent } from '../chat-panel/chat-panel';
import { UserListComponent } from '../user-list/user-list';
import { DataService, Server, ChannelCategory, Message, UserGroup } from '../../../core/services/data.service';

@Component({
  selector: 'app-discord-layout',
  standalone: true,
  imports: [
    CommonModule,
    ServersListComponent,
    ChannelsListComponent,
    ChatPanelComponent,
    UserListComponent
  ],
  templateUrl: './discord-layout.html',
  styleUrl: './discord-layout.scss'
})
export class DiscordLayoutComponent implements OnInit {
  servers: Server[] = [];
  categories: ChannelCategory[] = [];
  messages: Message[] = [];
  userGroups: UserGroup[] = [];
  
  activeServerId: string | null = null;
  activeChannelId: string | null = null;
  activeChannelName: string = 'general';

  constructor(private dataService: DataService) {}

  ngOnInit(): void {
    this.loadMockData();
  }

  private loadMockData(): void {
    // Load servers
    this.dataService.getServers().subscribe(servers => {
      this.servers = servers;
      if (servers.length > 0) {
        this.activeServerId = servers[0].id;
        this.onServerSelected(servers[0].id);
      }
    });
  }

  onServerSelected(serverId: string): void {
    this.activeServerId = serverId;
    
    // Load channels for selected server
    this.dataService.getChannels(serverId).subscribe(categories => {
      this.categories = categories;
      
      // Auto-select first text channel
      const firstCategory = categories.find(cat => cat.channels.length > 0);
      if (firstCategory && firstCategory.channels.length > 0) {
        const firstChannel = firstCategory.channels[0];
        this.activeChannelId = firstChannel.id;
        this.activeChannelName = firstChannel.name;
        this.onChannelSelected(firstChannel.id);
      }
    });
  }

  onChannelSelected(channelId: string): void {
    this.activeChannelId = channelId;
    
    // Find channel name
    for (const category of this.categories) {
      const channel = category.channels.find(ch => ch.id === channelId);
      if (channel) {
        this.activeChannelName = channel.name;
        break;
      }
    }
    
    // Load messages for selected channel
    this.dataService.getMessages(channelId).subscribe(messages => {
      this.messages = messages;
    });
    
    // Load users for selected channel
    this.dataService.getUsers(channelId).subscribe(userGroups => {
      this.userGroups = userGroups;
    });
  }
}
