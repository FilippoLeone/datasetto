import { createAction, props } from '@ngrx/store';
import { ChatMessage } from '../../core/models';

export const loadChatHistory = createAction(
  '[Chat] Load Chat History',
  props<{ channelId: string }>()
);

export const loadChatHistorySuccess = createAction(
  '[Chat] Load Chat History Success',
  props<{ channelId: string; messages: ChatMessage[] }>()
);

export const loadChatHistoryFailure = createAction(
  '[Chat] Load Chat History Failure',
  props<{ error: string }>()
);

export const sendMessage = createAction(
  '[Chat] Send Message',
  props<{ channelId: string; text: string }>()
);

export const sendMessageSuccess = createAction(
  '[Chat] Send Message Success',
  props<{ message: ChatMessage }>()
);

export const sendMessageFailure = createAction(
  '[Chat] Send Message Failure',
  props<{ error: string }>()
);

export const receiveMessage = createAction(
  '[Chat] Receive Message',
  props<{ message: ChatMessage }>()
);

export const deleteMessage = createAction(
  '[Chat] Delete Message',
  props<{ messageId: string; channelId: string }>()
);

export const deleteMessageSuccess = createAction(
  '[Chat] Delete Message Success',
  props<{ messageId: string; channelId: string }>()
);

export const clearChannelMessages = createAction(
  '[Chat] Clear Channel Messages',
  props<{ channelId: string }>()
);
