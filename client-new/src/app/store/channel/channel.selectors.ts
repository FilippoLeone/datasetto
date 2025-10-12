import { createFeatureSelector, createSelector } from '@ngrx/store';
import { ChannelState } from './channel.reducer';

export const selectChannelState = createFeatureSelector<ChannelState>('channel');

export const selectAllChannels = createSelector(
  selectChannelState,
  (state) => state.channels
);

export const selectChannelGroups = createSelector(
  selectChannelState,
  (state) => state.channelGroups
);

export const selectCurrentChannelId = createSelector(
  selectChannelState,
  (state) => state.currentChannelId
);

export const selectCurrentChannelType = createSelector(
  selectChannelState,
  (state) => state.currentChannelType
);

export const selectCurrentChannel = createSelector(
  selectAllChannels,
  selectCurrentChannelId,
  (channels, currentId) => channels.find((c) => c.id === currentId) || null
);

export const selectChannelsByType = (type: 'text' | 'voice' | 'stream') =>
  createSelector(selectAllChannels, (channels) =>
    channels.filter((c) => c.type === type)
  );

export const selectChannelLoading = createSelector(
  selectChannelState,
  (state) => state.loading
);

export const selectChannelError = createSelector(
  selectChannelState,
  (state) => state.error
);
