import { describe, expect, it } from 'vitest';
import { OFFER_STALE_MS, iceRestartDelay, isOfferStale, isPolitePeer, needsOwnOffer, resolveOfferCollision, type TransceiverView } from './negotiation';

const track = { kind: 'video' } as MediaStreamTrack;
const tx = (patch: Partial<TransceiverView>): TransceiverView => ({ mid: '0', direction: 'sendrecv', currentDirection: 'sendrecv', sender: { track }, ...patch });

describe('offer collisions', () => {
  it('the polite side always takes its own offer back', () => {
    expect(resolveOfferCollision(true, { id: 1, at: 1000, lost: false }, 1100)).toBe('rollback');
  });

  it('the impolite side keeps a fresh offer and drops theirs', () => {
    expect(resolveOfferCollision(false, { id: 1, at: 1000, lost: false }, 1000 + OFFER_STALE_MS - 1)).toBe('ignore');
  });

  it('the impolite side gives up an offer that is probably lost', () => {
    // Made while the socket was down, or sent to a socket id that is gone.
    expect(resolveOfferCollision(false, { id: 1, at: 1000, lost: true }, 1100)).toBe('rollback');
    // Never answered.
    expect(resolveOfferCollision(false, { id: 1, at: 1000, lost: false }, 1000 + OFFER_STALE_MS + 1)).toBe('rollback');
    // Nothing recorded (an offer from before this code ran).
    expect(resolveOfferCollision(false, undefined, 1100)).toBe('rollback');
    expect(isOfferStale(null, 0)).toBe(true);
  });

  it('both sides agree on who yields, from the account ids', () => {
    expect(isPolitePeer('acc-b', 'acc-a')).toBe(true);
    expect(isPolitePeer('acc-a', 'acc-b')).toBe(false);
    // Unknown ids (an older client, a peer not listed yet): yield, as before.
    expect(isPolitePeer(null, 'acc-a')).toBe(true);
    expect(isPolitePeer('acc-a', undefined)).toBe(true);
    expect(isPolitePeer('acc-a', 'acc-a')).toBe(true);
  });
});

describe('our own offer after answering', () => {
  it('is needed for a track their offer did not list (a camera on a connection they rebuilt)', () => {
    expect(needsOwnOffer([tx({ mid: '0' }), tx({ mid: null, currentDirection: null })])).toBe(true);
  });

  it('is needed for a track on a line they offered as receive-only for us', () => {
    expect(needsOwnOffer([tx({ currentDirection: 'recvonly' })])).toBe(true);
    expect(needsOwnOffer([tx({ currentDirection: 'inactive' })])).toBe(true);
  });

  it('is not needed when everything we send is negotiated', () => {
    expect(needsOwnOffer([tx({}), tx({ mid: '1', currentDirection: 'sendonly' })])).toBe(false);
  });

  it('ignores lines without a track, receive-only lines and stopped lines', () => {
    expect(needsOwnOffer([tx({ mid: null, currentDirection: null, sender: { track: null } })])).toBe(false);
    expect(needsOwnOffer([tx({ direction: 'recvonly', currentDirection: 'recvonly' })])).toBe(false);
    expect(needsOwnOffer([tx({ direction: 'stopped', currentDirection: 'stopped', mid: null })])).toBe(false);
  });
});

describe('ICE restart pacing', () => {
  it('waits 2, 4, 8 s, then every 10 s', () => {
    const middle = () => 0.5;
    expect([0, 1, 2, 3, 4, 20].map((done) => iceRestartDelay(done, middle))).toEqual([2000, 4000, 8000, 10000, 10000, 10000]);
  });

  it('spreads the two sides apart by up to 20 % either way', () => {
    expect(iceRestartDelay(0, () => 0)).toBe(1600);
    expect(iceRestartDelay(0, () => 0.999999)).toBe(2400);
  });
});
