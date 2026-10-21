import { peerAccountId } from '@/state/peerAudio';

/**
 * Source keys for the clip buffers (state/clips.ts). A key stays the same across
 * reconnects so the "Clips on" switch is remembered: channels by id, friends by account.
 */
export const streamClipKey = (channelId: string): string => 'stream:' + channelId;
export const shareClipKey = (channelId: string): string => 'share:' + channelId;
/** Your own screen in a voice channel. */
export const OWN_SHARE_CLIP_KEY = 'voice:me';
/** A friend's screen in a voice channel: by account when known, else by their socket. */
export const voiceClipKey = (peerId: string): string => {
  const accountId = peerAccountId(peerId);
  return 'voice:' + (accountId ? 'account:' + accountId : 'peer:' + peerId);
};
