import { createFeatureSelector, createSelector } from '@ngrx/store';
import { ChatState } from './chat.reducer';

export const selectChatState = createFeatureSelector<ChatState>('chat');

export const selectAllMessagesByChannel = createSelector(
  selectChatState,
  (state) => state.messagesByChannel
);

export const selectMessagesForChannel = (channelId: string) =>
  createSelector(selectAllMessagesByChannel, (messagesByChannel) =>
    messagesByChannel[channelId] || []
  );

export const selectChatLoading = createSelector(
  selectChatState,
  (state) => state.loading
);

export const selectChatError = createSelector(
  selectChatState,
  (state) => state.error
);
