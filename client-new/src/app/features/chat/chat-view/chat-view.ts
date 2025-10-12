import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewChecked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Store } from '@ngrx/store';
import { Observable, Subject, takeUntil, switchMap, of, map } from 'rxjs';
import { Channel, ChatMessage } from '../../../core/models';
import { selectCurrentChannel, selectCurrentChannelId } from '../../../store/channel/channel.selectors';
import { selectMessagesForChannel } from '../../../store/chat/chat.selectors';
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
  messageText = '';
  private destroy$ = new Subject<void>();
  private shouldScrollToBottom = false;

  constructor(
    private route: ActivatedRoute,
    private store: Store,
    private socketService: SocketService
  ) {
    this.currentChannel$ = this.store.select(selectCurrentChannel);
    
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

    // Send message through socket
    this.socketService.sendMessage(this.messageText.trim());
    
    // Clear input
    this.messageText = '';
    this.shouldScrollToBottom = true;
  }

  /**
   * Handle message sent from Discord chat-panel component
   */
  onMessageSent(content: string): void {
    if (!content.trim()) {
      return;
    }

    // Send message through socket
    this.socketService.sendMessage(content.trim());
    this.shouldScrollToBottom = true;
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
   */
  private getAvatarUrl(username: string): string {
    const colors = ['FF6B6B', '4ECDC4', 'FFE66D', '95E1D3', 'A8E6CF', 'FFDAC1', 'B4A7D6', '9AD1D4'];
    let hash = 0;
    for (let i = 0; i < username.length; i++) {
      hash = username.charCodeAt(i) + ((hash << 5) - hash);
    }
    const color = colors[Math.abs(hash) % colors.length];
    const initial = username.charAt(0).toUpperCase();
    return `https://via.placeholder.com/40/${color}/ffffff?text=${initial}`;
  }
}
