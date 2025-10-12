import { createReducer, on } from '@ngrx/store';
import { Channel, ChannelGroup } from '../../core/models';
import * as ChannelActions from './channel.actions';

export interface ChannelState {
  channels: Channel[];
  channelGroups: ChannelGroup[];
  currentChannelId: string | null;
  currentChannelType: 'text' | 'voice' | 'stream' | null;
  loading: boolean;
  error: string | null;
}

export const initialState: ChannelState = {
  channels: [],
  channelGroups: [],
  currentChannelId: null,
  currentChannelType: null,
  loading: false,
  error: null,
};

export const channelReducer = createReducer(
  initialState,
  
  on(ChannelActions.loadChannels, (state) => ({
    ...state,
    loading: true,
    error: null,
  })),
  
  on(ChannelActions.loadChannelsSuccess, (state, { channels, groups }) => ({
    ...state,
    channels,
    channelGroups: groups || state.channelGroups,
    loading: false,
    error: null,
  })),
  
  on(ChannelActions.loadChannelsFailure, (state, { error }) => ({
    ...state,
    loading: false,
    error,
  })),

  on(ChannelActions.setCurrentChannel, (state, { channelId, channelType }) => ({
    ...state,
    currentChannelId: channelId,
    currentChannelType: channelType,
  })),

  on(ChannelActions.createChannelSuccess, (state, { channel }) => ({
    ...state,
    channels: [...state.channels, channel],
  })),

  on(ChannelActions.deleteChannelSuccess, (state, { channelId }) => ({
    ...state,
    channels: state.channels.filter((c) => c.id !== channelId),
  })),

  on(ChannelActions.updateChannel, (state, { channel }) => ({
    ...state,
    channels: state.channels.map((c) => (c.id === channel.id ? channel : c)),
  }))
);
