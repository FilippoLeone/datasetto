import { computed, signal } from '@preact/signals';

export type VoiceStatus = 'idle' | 'connecting' | 'connected';
export type ConnectionQuality = 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';

export interface VoicePeer {
  id: string;
  name: string;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  camera: boolean;
  screen: boolean;
  quality: ConnectionQuality;
}

export const voiceStatus = signal<VoiceStatus>('idle');
export const voiceChannelId = signal<string | null>(null);
export const voiceStartedAt = signal<number | null>(null);
/** Remote participants keyed by socket id. */
export const voicePeers = signal<Record<string, VoicePeer>>({});

export const localMuted = signal(false);
export const localDeafened = signal(false);
export const localSpeaking = signal(false);
/** 0..1 microphone level for the meter. */
export const micLevel = signal(0);
export const pttPressed = signal(false);
export const overallQuality = signal<ConnectionQuality>('unknown');

export const localCameraStream = signal<MediaStream | null>(null);
export const localScreenStream = signal<MediaStream | null>(null);
/** Remote video streams keyed by peer id. */
export const remoteVideo = signal<Record<string, { camera?: MediaStream; screen?: MediaStream }>>({});

export const voiceConnected = computed(() => voiceStatus.value === 'connected');
export const peerList = computed(() => Object.values(voicePeers.value));
export const participantCount = computed(() => peerList.value.length + (voiceConnected.value ? 1 : 0));
export const anyVideoActive = computed(
  () =>
    localCameraStream.value !== null ||
    localScreenStream.value !== null ||
    Object.values(remoteVideo.value).some((entry) => entry.camera || entry.screen),
);

export const upsertPeer = (peer: Partial<VoicePeer> & { id: string }): void => {
  const existing = voicePeers.value[peer.id];
  voicePeers.value = {
    ...voicePeers.value,
    [peer.id]: {
      id: peer.id,
      name: peer.name ?? existing?.name ?? 'Unknown',
      muted: peer.muted ?? existing?.muted ?? false,
      deafened: peer.deafened ?? existing?.deafened ?? false,
      speaking: peer.speaking ?? existing?.speaking ?? false,
      camera: peer.camera ?? existing?.camera ?? false,
      screen: peer.screen ?? existing?.screen ?? false,
      quality: peer.quality ?? existing?.quality ?? 'unknown',
    },
  };
};

export const removePeer = (peerId: string): void => {
  if (!voicePeers.value[peerId]) return;
  const next = { ...voicePeers.value };
  delete next[peerId];
  voicePeers.value = next;
  if (remoteVideo.value[peerId]) {
    const videos = { ...remoteVideo.value };
    delete videos[peerId];
    remoteVideo.value = videos;
  }
};

export const setRemoteVideo = (peerId: string, type: 'camera' | 'screen', stream: MediaStream | null): void => {
  const current = { ...(remoteVideo.value[peerId] ?? {}) };
  if (stream) current[type] = stream;
  else delete current[type];
  remoteVideo.value = { ...remoteVideo.value, [peerId]: current };
};

export const resetVoiceState = (): void => {
  voiceStatus.value = 'idle';
  voiceChannelId.value = null;
  voiceStartedAt.value = null;
  voicePeers.value = {};
  localSpeaking.value = false;
  micLevel.value = 0;
  pttPressed.value = false;
  overallQuality.value = 'unknown';
  localCameraStream.value = null;
  localScreenStream.value = null;
  remoteVideo.value = {};
};
