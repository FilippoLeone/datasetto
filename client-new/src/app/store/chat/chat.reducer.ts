import { createReducer, on } from '@ngrx/store';
import { ChatMessage } from '../../core/models';
import * as ChatActions from './chat.actions';

export interface ChatState {
  messagesByChannel: Record<string, ChatMessage[]>;
  loading: boolean;
  error: string | null;
}

export const initialState: ChatState = {
  messagesByChannel: {},
  loading: false,
  error: null,
};

export const chatReducer = createReducer(
  initialState,
  
  on(ChatActions.loadChatHistory, (state) => ({
    ...state,
    loading: true,
    error: null,
  })),
  
  on(ChatActions.loadChatHistorySuccess, (state, { channelId, messages }) => ({
    ...state,
    messagesByChannel: {
      ...state.messagesByChannel,
      [channelId]: messages,
    },
    loading: false,
    error: null,
  })),
  
  on(ChatActions.loadChatHistoryFailure, (state, { error }) => ({
    ...state,
    loading: false,
    error,
  })),

  on(ChatActions.receiveMessage, (state, { message }) => {
    const channelMessages = state.messagesByChannel[message.channelId] || [];
    return {
      ...state,
      messagesByChannel: {
        ...state.messagesByChannel,
        [message.channelId]: [...channelMessages, message],
      },
    };
  }),

  on(ChatActions.sendMessageSuccess, (state, { message }) => {
    const channelMessages = state.messagesByChannel[message.channelId] || [];
    return {
      ...state,
      messagesByChannel: {
        ...state.messagesByChannel,
        [message.channelId]: [...channelMessages, message],
      },
    };
  }),

  on(ChatActions.deleteMessageSuccess, (state, { messageId, channelId }) => {
    const channelMessages = state.messagesByChannel[channelId] || [];
    return {
      ...state,
      messagesByChannel: {
        ...state.messagesByChannel,
        [channelId]: channelMessages.filter((m) => m.id !== messageId),
      },
    };
  }),

  on(ChatActions.clearChannelMessages, (state, { channelId }) => {
    const { [channelId]: _, ...rest } = state.messagesByChannel;
    return {
      ...state,
      messagesByChannel: rest,
    };
  })
);
