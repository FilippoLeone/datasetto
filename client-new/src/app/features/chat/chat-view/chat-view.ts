import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewChecked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Store } from '@ngrx/store';
import { Observable, Subject, takeUntil, switchMap, of } from 'rxjs';
import { Channel, ChatMessage } from '../../../core/models';
import { selectCurrentChannel, selectCurrentChannelId } from '../../../store/channel/channel.selectors';
import { selectMessagesForChannel } from '../../../store/chat/chat.selectors';
import { SocketService } from '../../../core/services/socket.service';
import * as ChannelActions from '../../../store/channel/channel.actions';
import * as ChatActions from '../../../store/chat/chat.actions';

@Component({
  selector: 'app-chat-view',
  imports: [CommonModule, FormsModule],
  templateUrl: './chat-view.html',
  styleUrl: './chat-view.css'
})
export class ChatView implements OnInit, OnDestroy, AfterViewChecked {
  @ViewChild('messagesScroller') messagesScroller?: ElementRef;
  
  currentChannel$: Observable<Channel | null>;
  messages$: Observable<ChatMessage[]>;
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
}
