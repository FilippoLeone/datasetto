import { createFeatureSelector, createSelector } from '@ngrx/store';
import { VoiceState } from './voice.reducer';

export const selectVoiceState = createFeatureSelector<VoiceState>('voice');

export const selectActiveVoiceChannelId = createSelector(
  selectVoiceState,
  (state) => state.activeChannelId
);

export const selectVoicePeers = createSelector(
  selectVoiceState,
  (state) => state.peers
);

export const selectVoiceConnected = createSelector(
  selectVoiceState,
  (state) => state.connected
);

export const selectMuted = createSelector(
  selectVoiceState,
  (state) => state.muted
);

export const selectDeafened = createSelector(
  selectVoiceState,
  (state) => state.deafened
);

export const selectSpeakingPeers = createSelector(
  selectVoiceState,
  (state) => Array.from(state.speakingPeers)
);

export const selectVoiceSessionId = createSelector(
  selectVoiceState,
  (state) => state.sessionId
);

export const selectVoiceStartedAt = createSelector(
  selectVoiceState,
  (state) => state.startedAt
);

export const selectVoiceLoading = createSelector(
  selectVoiceState,
  (state) => state.loading
);

export const selectVoiceError = createSelector(
  selectVoiceState,
  (state) => state.error
);
