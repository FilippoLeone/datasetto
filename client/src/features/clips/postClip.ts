import { signal } from '@preact/signals';
import { sendChatMessage } from '@/features/chat/outboxService';
import { formatBytes } from '@/lib/format';
import { clipFileName, type ClipRecord } from '@/services/clips/clipStore';
import { uploadFile } from '@/services/uploads';
import { channelLabel } from '@/state/channels';
import type { Channel, ChannelType } from '@/types/protocol';

/**
 * Posting a saved clip into a channel. The WebM goes up through the same path as
 * pictures (`POST /api/uploads`, under the server's video cap) and the message is
 * queued with the attachment like one typed in the composer, so it still lands if
 * the connection drops in between.
 */

/** Channel kinds that carry chat, in the order the picker lists them. */
const CHAT_TYPES: readonly ChannelType[] = ['text', 'stream', 'dm'];

/** The channels a clip can be posted to, text channels first, then streams, then direct messages. */
export const postTargets = (all: readonly Channel[]): Channel[] => CHAT_TYPES.flatMap((type) => all.filter((channel) => channel.type === type));

/** The channel the picker starts on: the first of `preferred` that is a target (the one being read, the last one posted to), else the first target. */
export const defaultPostTarget = (targets: readonly Channel[], ...preferred: ReadonlyArray<string | null | undefined>): string | null => {
  for (const id of preferred) if (id && targets.some((channel) => channel.id === id)) return id;
  return targets[0]?.id ?? null;
};

export const postTargetLabel = (channel: Channel): string => (channel.type === 'dm' ? '@' : '#') + channelLabel(channel);

/** Why a clip cannot go to this server, or null when it fits under the video cap. */
export const clipTooBigReason = (bytes: number, videoMaxBytes: number): string | null =>
  bytes > videoMaxBytes ? 'This clip is ' + formatBytes(bytes) + '; this server takes videos up to ' + formatBytes(videoMaxBytes) + '.' : null;

/** The channel a clip was last posted to, so the next one offers the same place first. */
export const lastPostTarget = signal<string | null>(null);

export interface ClipPost {
  /** Resolves once the message is queued; rejects with a message that can be shown. */
  done: Promise<void>;
  abort: () => void;
}

/** Upload the clip's video and queue a message carrying it in `channelId`; `onProgress` gets 0..1 while the bytes go up. */
export const postClip = (clip: ClipRecord, video: Blob, channelId: string, onProgress?: (fraction: number) => void): ClipPost => {
  const file = new File([video], clipFileName(clip.sourceName, clip.createdAt), { type: 'video/webm' });
  const upload = uploadFile(file, onProgress);
  const done = upload.done.then((attachment) => {
    sendChatMessage(channelId, '', [attachment.id]);
  });
  return { done, abort: upload.abort };
};
