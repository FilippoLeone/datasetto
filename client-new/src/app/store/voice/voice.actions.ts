import { createAction, props } from '@ngrx/store';
import { VoicePeerEvent } from '../../core/models';

export const joinVoiceChannel = createAction(
  '[Voice] Join Voice Channel',
  props<{ channelId: string }>()
);

export const joinVoiceChannelSuccess = createAction(
  '[Voice] Join Voice Channel Success',
  props<{ channelId: string; peers: VoicePeerEvent[]; sessionId?: string | null; startedAt?: number | null }>()
);

export const joinVoiceChannelFailure = createAction(
  '[Voice] Join Voice Channel Failure',
  props<{ error: string }>()
);

export const leaveVoiceChannel = createAction('[Voice] Leave Voice Channel');

export const leaveVoiceChannelSuccess = createAction('[Voice] Leave Voice Channel Success');

export const peerJoined = createAction(
  '[Voice] Peer Joined',
  props<{ peer: VoicePeerEvent }>()
);

export const peerLeft = createAction(
  '[Voice] Peer Left',
  props<{ peerId: string }>()
);

export const peerStateChanged = createAction(
  '[Voice] Peer State Changed',
  props<{ peerId: string; muted: boolean; deafened: boolean }>()
);

export const setMuted = createAction(
  '[Voice] Set Muted',
  props<{ muted: boolean }>()
);

export const setDeafened = createAction(
  '[Voice] Set Deafened',
  props<{ deafened: boolean }>()
);

export const setSpeaking = createAction(
  '[Voice] Set Speaking',
  props<{ peerId: string; speaking: boolean }>()
);
