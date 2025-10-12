import { createAction, props } from '@ngrx/store';
import { Channel, ChannelGroup } from '../../core/models';

export const loadChannels = createAction('[Channel] Load Channels');

export const loadChannelsSuccess = createAction(
  '[Channel] Load Channels Success',
  props<{ channels: Channel[]; groups?: ChannelGroup[] }>()
);

export const loadChannelsFailure = createAction(
  '[Channel] Load Channels Failure',
  props<{ error: string }>()
);

export const setCurrentChannel = createAction(
  '[Channel] Set Current Channel',
  props<{ channelId: string; channelType: 'text' | 'voice' | 'stream' }>()
);

export const createChannel = createAction(
  '[Channel] Create Channel',
  props<{ name: string; channelType: 'text' | 'voice' | 'stream'; groupId?: string }>()
);

export const createChannelSuccess = createAction(
  '[Channel] Create Channel Success',
  props<{ channel: Channel }>()
);

export const createChannelFailure = createAction(
  '[Channel] Create Channel Failure',
  props<{ error: string }>()
);

export const deleteChannel = createAction(
  '[Channel] Delete Channel',
  props<{ channelId: string }>()
);

export const deleteChannelSuccess = createAction(
  '[Channel] Delete Channel Success',
  props<{ channelId: string }>()
);

export const deleteChannelFailure = createAction(
  '[Channel] Delete Channel Failure',
  props<{ error: string }>()
);

export const updateChannel = createAction(
  '[Channel] Update Channel',
  props<{ channel: Channel }>()
);
