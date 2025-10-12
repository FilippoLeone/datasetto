import { ActionReducerMap, MetaReducer } from '@ngrx/store';
import { authReducer, AuthState } from './auth/auth.reducer';
import { channelReducer, ChannelState } from './channel/channel.reducer';
import { chatReducer, ChatState } from './chat/chat.reducer';
import { voiceReducer, VoiceState } from './voice/voice.reducer';
import { uiReducer, UIState } from './ui/ui.reducer';

export interface RootState {
  auth: AuthState;
  channel: ChannelState;
  chat: ChatState;
  voice: VoiceState;
  ui: UIState;
}

export const reducers: ActionReducerMap<RootState> = {
  auth: authReducer,
  channel: channelReducer,
  chat: chatReducer,
  voice: voiceReducer,
  ui: uiReducer,
};

export const metaReducers: MetaReducer<RootState>[] = [];
