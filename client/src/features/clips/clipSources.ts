import { effect } from '@preact/signals';
import { clipManager, type ClipSource } from '@/services/clips/clipManager';
import { usersById } from '@/state/presence';
import { localScreenStream, remoteScreenClipsAllowed, remoteVideo, voicePeers } from '@/state/voice';
import { OWN_SHARE_CLIP_KEY, voiceClipKey } from './clipKeys';

/**
 * Screens in a voice channel are received whether or not their tiles are on screen,
 * so they register with the clip manager from the voice state, not from a component:
 * clips of a friend's share keep buffering while you read a text channel. A share
 * whose owner disallows clipping is not registered (and stops at once when they turn
 * it off mid-share).
 */
export const installClipSources = (): (() => void) => {
  const registered = new Map<string, MediaStream>();
  return effect(() => {
    const desired = new Map<string, { source: ClipSource; stream: MediaStream }>();
    const own = localScreenStream.value;
    if (own) desired.set(OWN_SHARE_CLIP_KEY, { source: { key: OWN_SHARE_CLIP_KEY, kind: 'share', name: 'Your screen' }, stream: own });
    for (const [peerId, streams] of Object.entries(remoteVideo.value)) {
      if (!streams.screen || !remoteScreenClipsAllowed(peerId)) continue;
      const key = voiceClipKey(peerId);
      const name = (usersById.value.get(peerId)?.displayName ?? voicePeers.value[peerId]?.name ?? 'Friend') + "'s screen";
      desired.set(key, { source: { key, kind: 'share', name }, stream: streams.screen });
    }
    for (const key of Array.from(registered.keys())) {
      if (desired.has(key)) continue;
      clipManager.unregister(key);
      registered.delete(key);
    }
    for (const [key, { source, stream }] of desired) {
      if (registered.get(key) === stream) continue;
      clipManager.register(source, () => stream);
      registered.set(key, stream);
    }
  });
};
