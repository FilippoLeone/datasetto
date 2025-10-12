import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';

/**
 * Mock data interfaces for Discord-like UI
 */
export interface Server {
  id: string;
  name: string;
  imageUrl: string;
}

export interface ChannelCategory {
  id: string;
  name: string;
  channels: DiscordChannel[];
}

export interface DiscordChannel {
  id: string;
  name: string;
  type: 'text' | 'voice';
}

export interface Message {
  id: string;
  author: {
    name: string;
    avatarUrl: string;
  };
  timestamp: Date;
  content: string;
}

export interface DiscordUser {
  id: string;
  name: string;
  status: 'online' | 'idle' | 'offline';
  avatarUrl: string;
  role?: string;
}

export interface UserGroup {
  role: string;
  users: DiscordUser[];
}

/**
 * DataService provides mock data for the Discord-like UI clone
 * Uses RxJS Observables to simulate async data fetching
 */
@Injectable({
  providedIn: 'root'
})
export class DataService {
  /**
   * Get list of servers
   */
  getServers(): Observable<Server[]> {
    const servers: Server[] = [
      {
        id: '1',
        name: 'Datasetto',
        imageUrl: 'https://via.placeholder.com/48/5865F2/ffffff?text=D'
      },
      {
        id: '2',
        name: 'Gaming Hub',
        imageUrl: 'https://via.placeholder.com/48/7289DA/ffffff?text=G'
      },
      {
        id: '3',
        name: 'Dev Community',
        imageUrl: 'https://via.placeholder.com/48/43B581/ffffff?text=DC'
      },
      {
        id: '4',
        name: 'Art & Design',
        imageUrl: 'https://via.placeholder.com/48/FAA61A/ffffff?text=AD'
      }
    ];

    return of(servers);
  }

  /**
   * Get channels for a specific server
   */
  getChannels(serverId: string): Observable<ChannelCategory[]> {
    const categories: ChannelCategory[] = [
      {
        id: 'cat-1',
        name: 'TEXT CHANNELS',
        channels: [
          { id: 'ch-1', name: 'general', type: 'text' },
          { id: 'ch-2', name: 'announcements', type: 'text' },
          { id: 'ch-3', name: 'random', type: 'text' },
          { id: 'ch-4', name: 'dev-talk', type: 'text' }
        ]
      },
      {
        id: 'cat-2',
        name: 'VOICE CHANNELS',
        channels: [
          { id: 'vc-1', name: 'General Voice', type: 'voice' },
          { id: 'vc-2', name: 'Gaming', type: 'voice' },
          { id: 'vc-3', name: 'Music', type: 'voice' },
          { id: 'vc-4', name: 'Study Room', type: 'voice' }
        ]
      }
    ];

    return of(categories);
  }

  /**
   * Get messages for a specific channel
   */
  getMessages(channelId: string): Observable<Message[]> {
    const messages: Message[] = [
      {
        id: 'msg-1',
        author: {
          name: 'Alice',
          avatarUrl: 'https://via.placeholder.com/40/FF6B6B/ffffff?text=A'
        },
        timestamp: new Date(Date.now() - 3600000),
        content: 'Hey everyone! Welcome to the channel 👋'
      },
      {
        id: 'msg-2',
        author: {
          name: 'Bob',
          avatarUrl: 'https://via.placeholder.com/40/4ECDC4/ffffff?text=B'
        },
        timestamp: new Date(Date.now() - 3000000),
        content: 'Thanks! Excited to be here. Has anyone tried the new features yet?'
      },
      {
        id: 'msg-3',
        author: {
          name: 'Charlie',
          avatarUrl: 'https://via.placeholder.com/40/FFE66D/333333?text=C'
        },
        timestamp: new Date(Date.now() - 2400000),
        content: 'Yeah, I tested them yesterday. The voice quality is amazing!'
      },
      {
        id: 'msg-4',
        author: {
          name: 'Diana',
          avatarUrl: 'https://via.placeholder.com/40/95E1D3/333333?text=D'
        },
        timestamp: new Date(Date.now() - 1800000),
        content: 'We should organize a gaming session this weekend 🎮'
      },
      {
        id: 'msg-5',
        author: {
          name: 'Alice',
          avatarUrl: 'https://via.placeholder.com/40/FF6B6B/ffffff?text=A'
        },
        timestamp: new Date(Date.now() - 600000),
        content: 'Great idea! Let\'s coordinate in the #gaming channel'
      },
      {
        id: 'msg-6',
        author: {
          name: 'Eve',
          avatarUrl: 'https://via.placeholder.com/40/A8E6CF/333333?text=E'
        },
        timestamp: new Date(Date.now() - 300000),
        content: 'Count me in! What games are we thinking?'
      },
      {
        id: 'msg-7',
        author: {
          name: 'Bob',
          avatarUrl: 'https://via.placeholder.com/40/4ECDC4/ffffff?text=B'
        },
        timestamp: new Date(Date.now() - 120000),
        content: 'Maybe we could try some multiplayer co-op games? 🤔'
      },
      {
        id: 'msg-8',
        author: {
          name: 'Charlie',
          avatarUrl: 'https://via.placeholder.com/40/FFE66D/333333?text=C'
        },
        timestamp: new Date(Date.now() - 60000),
        content: 'Sounds perfect! I\'ll create a poll in the gaming channel 📊'
      }
    ];

    return of(messages);
  }

  /**
   * Get users in a channel, grouped by role
   */
  getUsers(channelId: string): Observable<UserGroup[]> {
    const userGroups: UserGroup[] = [
      {
        role: 'Admins',
        users: [
          {
            id: 'u-1',
            name: 'Alice',
            status: 'online',
            avatarUrl: 'https://via.placeholder.com/32/FF6B6B/ffffff?text=A',
            role: 'Admin'
          },
          {
            id: 'u-2',
            name: 'Bob',
            status: 'online',
            avatarUrl: 'https://via.placeholder.com/32/4ECDC4/ffffff?text=B',
            role: 'Admin'
          }
        ]
      },
      {
        role: 'Members',
        users: [
          {
            id: 'u-3',
            name: 'Charlie',
            status: 'online',
            avatarUrl: 'https://via.placeholder.com/32/FFE66D/333333?text=C'
          },
          {
            id: 'u-4',
            name: 'Diana',
            status: 'idle',
            avatarUrl: 'https://via.placeholder.com/32/95E1D3/333333?text=D'
          },
          {
            id: 'u-5',
            name: 'Eve',
            status: 'online',
            avatarUrl: 'https://via.placeholder.com/32/A8E6CF/333333?text=E'
          },
          {
            id: 'u-6',
            name: 'Frank',
            status: 'offline',
            avatarUrl: 'https://via.placeholder.com/32/FFDAC1/333333?text=F'
          },
          {
            id: 'u-7',
            name: 'Grace',
            status: 'online',
            avatarUrl: 'https://via.placeholder.com/32/B4A7D6/ffffff?text=G'
          },
          {
            id: 'u-8',
            name: 'Henry',
            status: 'idle',
            avatarUrl: 'https://via.placeholder.com/32/9AD1D4/333333?text=H'
          }
        ]
      }
    ];

    return of(userGroups);
  }
}
