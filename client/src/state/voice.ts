import { computed, signal } from '@preact/signals';
import type { NeuralStatus } from '@/services/voice/neuralSuppression';
import { OFF_STATUS, type CameraBlurStatus } from '@/services/voice/backgroundBlur';

/** `reconnecting`: the socket is gone but the call is kept; it rejoins by itself when the socket is back. */
export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting';
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
  /** Who is behind the socket; stable across their reconnects. */
  accountId?: string | null;
  /** Their media session id (see features/voice/peerReconcile.ts). */
  rtcSessionId?: string | null;
  /** Not in the room according to the server since this time (they may be reconnecting); null when present. */
  staleSince?: number | null;
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
/** What the "strong" noise suppression runs right now (engine, loading state, last notice). */
export const noiseSuppressionStatus = signal<NeuralStatus>({ tier: 'deepfilternet3', state: 'idle', notice: null, load: null });
export const pttPressed = signal(false);
export const overallQuality = signal<ConnectionQuality>('unknown');

/** Background blur of my camera (in the call or in the settings preview): where it runs, its cost, any notice. */
export const cameraBlurStatus = signal<CameraBlurStatus>(OFF_STATUS);
export const localCameraStream = signal<MediaStream | null>(null);
/** The settings dialog's own camera preview (outside a call), blurred as drafted. */
export const cameraPreviewStream = signal<MediaStream | null>(null);
export const localScreenStream = signal<MediaStream | null>(null);
/** Remote video streams keyed by peer id. */
export const remoteVideo = signal<Record<string, { camera?: MediaStream; screen?: MediaStream }>>({});
/** Whether each friend lets their shared screen be clipped (peer id -> flag); absent means allowed. */
export const remoteScreenClips = signal<Record<string, boolean>>({});

export const setRemoteScreenClips = (peerId: string, allowed: boolean): void => {
  if (remoteScreenClips.value[peerId] === allowed) return;
  remoteScreenClips.value = { ...remoteScreenClips.value, [peerId]: allowed };
};

/** False only when the friend behind `peerId` said no; unknown or older clients mean yes. */
export const remoteScreenClipsAllowed = (peerId: string): boolean => remoteScreenClips.value[peerId] !== false;

export const voiceConnected = computed(() => voiceStatus.value === 'connected');
/** In a call: connected, or holding the call together while the socket reconnects. */
export const voiceInCall = computed(() => voiceStatus.value === 'connected' || voiceStatus.value === 'reconnecting');
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
      accountId: peer.accountId ?? existing?.accountId ?? null,
      name: peer.name ?? existing?.name ?? 'Unknown',
      muted: peer.muted ?? existing?.muted ?? false,
      deafened: peer.deafened ?? existing?.deafened ?? false,
      speaking: peer.speaking ?? existing?.speaking ?? false,
      camera: peer.camera ?? existing?.camera ?? false,
      screen: peer.screen ?? existing?.screen ?? false,
      quality: peer.quality ?? existing?.quality ?? 'unknown',
      rtcSessionId: peer.rtcSessionId !== undefined ? peer.rtcSessionId : (existing?.rtcSessionId ?? null),
      staleSince: peer.staleSince !== undefined ? peer.staleSince : (existing?.staleSince ?? null),
    },
  };
};

/** The same person came back on a new socket: move their entry (and video) to the new id. */
export const rekeyPeer = (from: string, to: string, patch: Partial<VoicePeer> = {}): void => {
  const existing = voicePeers.value[from];
  if (!existing || from === to) return;
  const next = { ...voicePeers.value };
  delete next[from];
  next[to] = { ...existing, ...patch, id: to, staleSince: null };
  voicePeers.value = next;
  if (remoteVideo.value[from]) {
    const videos = { ...remoteVideo.value };
    videos[to] = videos[from];
    delete videos[from];
    remoteVideo.value = videos;
  }
  if (from in remoteScreenClips.value) {
    const clips = { ...remoteScreenClips.value };
    clips[to] = clips[from];
    delete clips[from];
    remoteScreenClips.value = clips;
  }
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
  if (peerId in remoteScreenClips.value) {
    const clips = { ...remoteScreenClips.value };
    delete clips[peerId];
    remoteScreenClips.value = clips;
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
  remoteScreenClips.value = {};
};
