import { createReducer, on } from '@ngrx/store';
import { VoicePeerEvent } from '../../core/models';
import * as VoiceActions from './voice.actions';

export interface VoiceState {
  activeChannelId: string | null;
  peers: VoicePeerEvent[];
  muted: boolean;
  deafened: boolean;
  connected: boolean;
  sessionId: string | null;
  startedAt: number | null;
  speakingPeers: Set<string>;
  loading: boolean;
  error: string | null;
}

export const initialState: VoiceState = {
  activeChannelId: null,
  peers: [],
  muted: false,
  deafened: false,
  connected: false,
  sessionId: null,
  startedAt: null,
  speakingPeers: new Set(),
  loading: false,
  error: null,
};

export const voiceReducer = createReducer(
  initialState,
  
  on(VoiceActions.joinVoiceChannel, (state) => ({
    ...state,
    loading: true,
    error: null,
  })),
  
  on(VoiceActions.joinVoiceChannelSuccess, (state, { channelId, peers, sessionId, startedAt }) => ({
    ...state,
    activeChannelId: channelId,
    peers,
    connected: true,
    sessionId: sessionId || null,
    startedAt: startedAt || null,
    loading: false,
    error: null,
  })),
  
  on(VoiceActions.joinVoiceChannelFailure, (state, { error }) => ({
    ...state,
    loading: false,
    error,
  })),

  on(VoiceActions.leaveVoiceChannelSuccess, () => initialState),

  on(VoiceActions.peerJoined, (state, { peer }) => ({
    ...state,
    peers: [...state.peers, peer],
  })),

  on(VoiceActions.peerLeft, (state, { peerId }) => ({
    ...state,
    peers: state.peers.filter((p) => p.id !== peerId),
  })),

  on(VoiceActions.peerStateChanged, (state, { peerId, muted, deafened }) => ({
    ...state,
    peers: state.peers.map((p) =>
      p.id === peerId ? { ...p, muted, deafened } : p
    ),
  })),

  on(VoiceActions.setMuted, (state, { muted }) => ({
    ...state,
    muted,
  })),

  on(VoiceActions.setDeafened, (state, { deafened }) => ({
    ...state,
    deafened,
    muted: deafened ? true : state.muted, // Deafened implies muted
  })),

  on(VoiceActions.setSpeaking, (state, { peerId, speaking }) => {
    const newSpeakingPeers = new Set(state.speakingPeers);
    if (speaking) {
      newSpeakingPeers.add(peerId);
    } else {
      newSpeakingPeers.delete(peerId);
    }
    return {
      ...state,
      speakingPeers: newSpeakingPeers,
    };
  })
);
