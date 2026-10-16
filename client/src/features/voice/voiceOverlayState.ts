/**
 * What the desktop voice overlay shows, derived from the voice store. Pure so it can be
 * unit tested; `desktopVoice.ts` feeds the result to the Electron shell over IPC.
 */
import type { VoicePeer, VoiceStatus } from '@/state/voice';

export type OverlayCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export const OVERLAY_CORNERS: OverlayCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
export const DEFAULT_OVERLAY_CORNER: OverlayCorner = 'top-right';

/** Rows shown before the list is cut with a "+N more" line. */
export const OVERLAY_MAX_ROWS = 8;

export interface OverlayParticipant {
  id: string;
  name: string;
  /** Absolute URL or data URI; the overlay window cannot resolve server-relative paths. */
  avatarUrl: string | null;
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
  self: boolean;
}

export interface VoiceOverlayState {
  channelName: string;
  participants: OverlayParticipant[];
  /** Participants not listed because of OVERLAY_MAX_ROWS. */
  more: number;
  /** Your own state, repeated for the header. */
  muted: boolean;
  deafened: boolean;
  pushToTalk: boolean;
  /** Push to talk is on and the key is held. */
  transmitting: boolean;
}

export interface OverlayInput {
  status: VoiceStatus;
  channelName: string | null | undefined;
  me: { id: string; name: string; avatarUrl: string | null } | null;
  peers: VoicePeer[];
  /** Avatar for a peer (socket id) as an absolute URL or data URI. */
  avatarFor: (peerId: string) => string | null;
  localMuted: boolean;
  localDeafened: boolean;
  localSpeaking: boolean;
  pttEnable: boolean;
  pttPressed: boolean;
}

const byName = (a: OverlayParticipant, b: OverlayParticipant): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/** Null while not in a voice channel: the overlay is hidden then. */
export const buildOverlayState = (input: OverlayInput): VoiceOverlayState | null => {
  if (input.status !== 'connected' || !input.me) return null;
  const transmitting = input.pttEnable && input.pttPressed;
  const selfMuted = input.localMuted || input.localDeafened || (input.pttEnable && !input.pttPressed);
  const self: OverlayParticipant = {
    id: input.me.id,
    name: input.me.name,
    avatarUrl: input.me.avatarUrl,
    speaking: !selfMuted && input.localSpeaking,
    muted: selfMuted,
    deafened: input.localDeafened,
    self: true,
  };
  const others = input.peers
    .map(
      (peer): OverlayParticipant => ({
        id: peer.id,
        name: peer.name,
        avatarUrl: input.avatarFor(peer.id),
        speaking: peer.speaking && !peer.muted,
        muted: peer.muted,
        deafened: peer.deafened,
        self: false,
      }),
    )
    .sort(byName);
  const all = [self, ...others];
  return {
    channelName: input.channelName || 'Voice',
    participants: all.slice(0, OVERLAY_MAX_ROWS),
    more: Math.max(0, all.length - OVERLAY_MAX_ROWS),
    muted: input.localMuted || input.localDeafened,
    deafened: input.localDeafened,
    pushToTalk: input.pttEnable,
    transmitting,
  };
};

/** True when nothing the overlay draws has changed, so the IPC message can be skipped. */
export const sameOverlayState = (a: VoiceOverlayState | null, b: VoiceOverlayState | null): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.channelName !== b.channelName || a.more !== b.more || a.muted !== b.muted || a.deafened !== b.deafened || a.pushToTalk !== b.pushToTalk || a.transmitting !== b.transmitting) {
    return false;
  }
  if (a.participants.length !== b.participants.length) return false;
  return a.participants.every((p, index) => {
    const q = b.participants[index];
    return p.id === q.id && p.name === q.name && p.avatarUrl === q.avatarUrl && p.speaking === q.speaking && p.muted === q.muted && p.deafened === q.deafened && p.self === q.self;
  });
};

export const isOverlayCorner = (value: unknown): value is OverlayCorner => typeof value === 'string' && (OVERLAY_CORNERS as string[]).includes(value);
