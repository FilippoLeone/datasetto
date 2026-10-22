/**
 * Small decisions behind renegotiating a peer connection after a drop, kept free of
 * WebRTC objects so they can be unit tested (services/voice/VoiceService.ts runs them).
 *
 * - Both sides may offer at the same moment (both notice a broken transport and restart
 *   ICE). One side yields: the polite one takes its own offer back and answers; the
 *   impolite one keeps its offer and drops theirs, unless its own offer is probably lost
 *   (made while the socket was down, sent to a socket id that is gone, or unanswered for
 *   a while). Both sides derive the roles from the account ids, which survive reconnects.
 * - An answer covers only what the offer listed: a camera added on our side after their
 *   offer (they rebuilt the connection after our reconnect) is not in it. We then offer
 *   ourselves right after answering.
 * - A broken transport is restarted again and again while the call lasts, slower each time.
 */

/** An offer we sent that has not been answered yet. */
export interface PendingOffer {
  /** Echoed by the answer, so an answer to an older offer of ours can be told apart. */
  id: number;
  at: number;
  /** Probably never reached them: made while signalling was down, or sent to a socket id that is gone. */
  lost: boolean;
}

/** An unanswered offer older than this is taken for lost (an answer takes well under a second). */
export const OFFER_STALE_MS = 4_000;

export const isOfferStale = (pending: PendingOffer | null | undefined, now: number): boolean =>
  !pending || pending.lost || now - pending.at > OFFER_STALE_MS;

/**
 * Their offer arrived while ours is unanswered. Polite: take ours back and answer theirs.
 * Impolite: keep ours (they will take theirs back and answer it), unless ours is stale.
 */
export const resolveOfferCollision = (polite: boolean, pending: PendingOffer | null | undefined, now: number): 'rollback' | 'ignore' =>
  polite || isOfferStale(pending, now) ? 'rollback' : 'ignore';

/** The side with the larger account id yields. Unknown ids: yield (what every older client does). */
export const isPolitePeer = (selfAccountId: string | null | undefined, peerAccountId: string | null | undefined): boolean => {
  if (!selfAccountId || !peerAccountId || selfAccountId === peerAccountId) return true;
  return selfAccountId > peerAccountId;
};

/** What `needsOwnOffer` looks at on each transceiver (an RTCRtpTransceiver fits). */
export interface TransceiverView {
  mid: string | null;
  direction: RTCRtpTransceiverDirection;
  currentDirection: RTCRtpTransceiverDirection | null;
  sender: { track: MediaStreamTrack | null };
}

const sends = (direction: RTCRtpTransceiverDirection | null): boolean => direction === 'sendrecv' || direction === 'sendonly';

/**
 * After answering: do we send a track the negotiation does not carry? A track added after
 * their offer has no m-line yet (mid null), and one put on a line they offered as
 * receive-only for us is not sent either.
 */
export const needsOwnOffer = (transceivers: readonly TransceiverView[]): boolean =>
  transceivers.some((t) => t.direction !== 'stopped' && t.currentDirection !== 'stopped' && t.sender.track !== null && sends(t.direction) && (t.mid === null || !sends(t.currentDirection)));

export const ICE_RESTART_FIRST_DELAY_MS = 2_000;
export const ICE_RESTART_MAX_DELAY_MS = 10_000;

/** Wait before ICE restart number `done + 1`: 2 s, 4 s, 8 s, then every 10 s, with ±20 % jitter so two peers drift apart. */
export const iceRestartDelay = (done: number, random: () => number = Math.random): number => {
  const base = Math.min(ICE_RESTART_MAX_DELAY_MS, ICE_RESTART_FIRST_DELAY_MS * 2 ** Math.max(0, Math.min(done, 10)));
  return Math.round(base * (0.8 + random() * 0.4));
};
