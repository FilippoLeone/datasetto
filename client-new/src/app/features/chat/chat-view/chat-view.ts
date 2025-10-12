import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewChecked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Store } from '@ngrx/store';
import { Observable, Subject, takeUntil, switchMap, of, map, combineLatest, take } from 'rxjs';
import { Channel, ChatMessage, User } from '../../../core/models';
import { selectCurrentChannel, selectCurrentChannelId } from '../../../store/channel/channel.selectors';
import { selectMessagesForChannel } from '../../../store/chat/chat.selectors';
import { selectUser } from '../../../store/auth/auth.selectors';
import { SocketService } from '../../../core/services/socket.service';
import * as ChannelActions from '../../../store/channel/channel.actions';
import * as ChatActions from '../../../store/chat/chat.actions';
import { ChatPanelComponent } from '../../../shared/components/chat-panel/chat-panel';
import { Message } from '../../../core/services/data.service';

@Component({
  selector: 'app-chat-view',
  imports: [CommonModule, FormsModule, ChatPanelComponent],
  templateUrl: './chat-view.html',
  styleUrl: './chat-view.css'
})
export class ChatView implements OnInit, OnDestroy, AfterViewChecked {
  @ViewChild('messagesScroller') messagesScroller?: ElementRef;
  
  currentChannel$: Observable<Channel | null>;
  messages$: Observable<ChatMessage[]>;
  discordMessages$: Observable<Message[]>;
  channelName$: Observable<string>;
  currentUser$: Observable<User | null>;
  messageText = '';
  private destroy$ = new Subject<void>();
  private shouldScrollToBottom = false;

  constructor(
    private route: ActivatedRoute,
    private store: Store,
    private socketService: SocketService
  ) {
    this.currentChannel$ = this.store.select(selectCurrentChannel);
    this.currentUser$ = this.store.select(selectUser);
    
    // Get messages for current channel using switchMap to handle the selector factory
    this.messages$ = this.store.select(selectCurrentChannelId).pipe(
      switchMap(channelId => 
        channelId ? this.store.select(selectMessagesForChannel(channelId)) : of([])
      )
    );

    // Transform ChatMessage[] to Discord Message[] format
    this.discordMessages$ = this.messages$.pipe(
      map(messages => this.transformMessages(messages))
    );

    // Extract channel name from current channel
    this.channelName$ = this.currentChannel$.pipe(
      map(channel => channel?.name || 'channel')
    );
  }

  ngOnInit(): void {
    this.route.params.pipe(takeUntil(this.destroy$)).subscribe(params => {
      const channelId = params['id'];
      if (channelId) {
        this.store.dispatch(ChannelActions.setCurrentChannel({ channelId, channelType: 'text' }));
        this.shouldScrollToBottom = true;
      }
    });

    // Subscribe to new messages from socket
    this.socketService.onChatMessage().pipe(
      takeUntil(this.destroy$)
    ).subscribe(message => {
      this.store.dispatch(ChatActions.receiveMessage({ message }));
      this.shouldScrollToBottom = true;
    });

    // Add some sample messages for testing
    setTimeout(() => {
      this.addSampleMessages();
    }, 1000);
  }

  ngAfterViewChecked(): void {
    if (this.shouldScrollToBottom) {
      this.scrollToBottom();
      this.shouldScrollToBottom = false;
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  sendMessage(): void {
    if (!this.messageText.trim()) {
      return;
    }

    // Use the same logic as onMessageSent
    this.onMessageSent({ content: this.messageText.trim() });
    
    // Clear input
    this.messageText = '';
  }

  /**
   * Handle message sent from Discord chat-panel component
   */
  onMessageSent(messageData: { content: string; replyTo?: { id: string; author: string; content: string } }): void {
    if (!messageData.content.trim()) {
      return;
    }

    // Get current channel ID
    this.store.select(selectCurrentChannelId).pipe(take(1)).subscribe(channelId => {
      if (!channelId) {
        console.error('Cannot send message: no channel selected');
        return;
      }

      // Get current user
      this.store.select(selectUser).pipe(take(1)).subscribe(user => {
        if (!user) {
          console.error('Cannot send message: no user logged in');
          return;
        }

        // Create message content with reply if exists
        let messageText = messageData.content.trim();
        if (messageData.replyTo) {
          // Prepend reply context to message (you can customize this format)
          messageText = `@${messageData.replyTo.author}: "${messageData.replyTo.content.substring(0, 50)}${messageData.replyTo.content.length > 50 ? '...' : ''}"\n\n${messageText}`;
        }

        // Create optimistic message for immediate display
        const optimisticMessage: ChatMessage = {
          id: `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          text: messageText,
          from: user.displayName || user.username,
          fromId: user.id,
          channelId: channelId,
          ts: Date.now(),
          edited: false
        };

        console.log('Adding message to store:', optimisticMessage);
        if (messageData.replyTo) {
          console.log('Replying to message:', messageData.replyTo);
        }

        // Add message to store immediately (optimistic update)
        this.store.dispatch(ChatActions.receiveMessage({ message: optimisticMessage }));

        // Send message through socket
        this.socketService.sendMessage(messageText);
        this.shouldScrollToBottom = true;
      });
    });
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  private scrollToBottom(): void {
    if (this.messagesScroller) {
      const element = this.messagesScroller.nativeElement;
      element.scrollTop = element.scrollHeight;
    }
  }

  /**
   * Transform ChatMessage[] to Discord Message[] format
   */
  private transformMessages(messages: ChatMessage[]): Message[] {
    return messages.map(msg => ({
      id: msg.id,
      author: {
        name: msg.from,
        avatarUrl: this.getAvatarUrl(msg.from)
      },
      timestamp: new Date(msg.ts),
      content: msg.text
    }));
  }

  /**
   * Generate avatar URL from username
   * Uses UI Avatars service for consistent, colorful placeholder avatars
   */
  private getAvatarUrl(username: string): string {
    // Use UI Avatars service for better-looking placeholder avatars
    // https://ui-avatars.com/
    const name = encodeURIComponent(username);
    
    // Generate a consistent background color based on username
    const colors = ['3498db', 'e74c3c', '2ecc71', 'f39c12', '9b59b6', '1abc9c', 'e67e22', '34495e'];
    let hash = 0;
    for (let i = 0; i < username.length; i++) {
      hash = username.charCodeAt(i) + ((hash << 5) - hash);
    }
    const bgColor = colors[Math.abs(hash) % colors.length];
    
    // UI Avatars parameters:
    // - name: The name to display
    // - background: Background color (hex without #)
    // - color: Text color (hex without #)
    // - size: Image size in pixels
    // - bold: Use bold text
    // - rounded: Rounded image
    return `https://ui-avatars.com/api/?name=${name}&background=${bgColor}&color=fff&size=40&bold=true&rounded=true`;
  }

  /**
   * Add sample messages for testing
   */
  private addSampleMessages(): void {
    this.store.select(selectCurrentChannelId).pipe(take(1)).subscribe(channelId => {
      if (!channelId) return;

      const sampleMessages: ChatMessage[] = [
        {
          id: 'sample-1',
          text: 'Welcome to the channel! 👋',
          from: 'System',
          fromId: 'system',
          channelId: channelId,
          ts: Date.now() - 3600000, // 1 hour ago
          edited: false
        },
        {
          id: 'sample-2',
          text: 'This is a sample message to test the chat display.',
          from: 'Alice',
          fromId: 'alice',
          channelId: channelId,
          ts: Date.now() - 1800000, // 30 minutes ago
          edited: false
        },
        {
          id: 'sample-3',
          text: 'Messages should appear here when you send them!',
          from: 'Bob',
          fromId: 'bob',
          channelId: channelId,
          ts: Date.now() - 600000, // 10 minutes ago
          edited: false
        }
      ];

      sampleMessages.forEach(message => {
        this.store.dispatch(ChatActions.receiveMessage({ message }));
      });
    });
  }
}
