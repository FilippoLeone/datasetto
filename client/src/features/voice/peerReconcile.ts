/**
 * After a reconnect everyone in the room has a new socket id, but the WebRTC
 * connections between us never went through the server and may be perfectly
 * fine. This decides, per person the server lists, what to do with what we
 * already have:
 *
 * - keep:    same socket id, nothing happened;
 * - rekey:   same account and the same media session id on a new socket, and
 *            they still hold their side: the existing connection is moved to
 *            the new id; an ICE restart is requested when it is broken (their
 *            or our network changed);
 * - rebuild: no connection to that account, they rebuilt theirs (new media
 *            session id), or they say they no longer hold ours: negotiate from
 *            scratch (dropping the old one first);
 * - stale:   someone we have a connection to is not (yet) in the room: keep the
 *            connection for a while, they may reconnect after us.
 */
export type PeerHealth = 'connected' | 'connecting' | 'broken' | 'missing';

export interface KnownPeer {
  id: string;
  accountId: string | null;
  rtcSessionId: string | null;
  health: PeerHealth;
}

export interface HeldConnection {
  accountId: string;
  rtcSessionId: string | null;
}

export interface RoomPeer {
  id: string;
  accountId: string;
  rtcSessionId: string | null;
  /** What a (re)joining peer says it still holds; undefined when not told (the whole-room list, older clients). */
  holding?: HeldConnection[];
}

export interface SelfIdentity {
  accountId: string | null;
  rtcSessionId: string | null;
}

export type PeerAction =
  | { action: 'keep'; id: string }
  | { action: 'rekey'; from: string; to: string; restartIce: boolean }
  | { action: 'rebuild'; from: string | null; to: string }
  | { action: 'stale'; id: string };

export interface ReconcileOptions {
  /** The list is one `voice:peer-join`, not the whole room: nobody is stale for missing from it. */
  partial?: boolean;
}

/** Does the peer say it still holds a connection to us, in our current media session? */
const holdsUs = (peer: RoomPeer, self: SelfIdentity): boolean | null => {
  if (!peer.holding) return null;
  if (self.accountId === null) return null;
  return peer.holding.some((held) => held.accountId === self.accountId && (held.rtcSessionId === null || held.rtcSessionId === self.rtcSessionId));
};

export const reconcilePeers = (known: KnownPeer[], room: RoomPeer[], self: SelfIdentity, options: ReconcileOptions = {}): PeerAction[] => {
  const actions: PeerAction[] = [];
  const matched = new Set<string>();

  for (const peer of room) {
    // Our own previous seat (the server has not dropped it yet) is not a peer.
    if (self.accountId !== null && peer.accountId === self.accountId) continue;
    const exact = known.find((entry) => entry.id === peer.id);
    if (exact) {
      matched.add(exact.id);
      actions.push({ action: 'keep', id: peer.id });
      continue;
    }
    const sameAccount = known.filter((entry) => entry.accountId === peer.accountId && !matched.has(entry.id));
    // Prefer a live connection when several entries (a double) carry the account.
    const previous = sameAccount.find((entry) => entry.health !== 'missing') ?? sameAccount[0] ?? null;
    if (previous) matched.add(previous.id);
    const sameSession = previous !== null && previous.rtcSessionId !== null && previous.rtcSessionId === peer.rtcSessionId && previous.health !== 'missing';
    if (previous && sameSession && holdsUs(peer, self) !== false) {
      actions.push({ action: 'rekey', from: previous.id, to: peer.id, restartIce: previous.health === 'broken' });
    } else {
      actions.push({ action: 'rebuild', from: previous?.id ?? null, to: peer.id });
    }
  }

  if (!options.partial) {
    for (const entry of known) {
      if (!matched.has(entry.id)) actions.push({ action: 'stale', id: entry.id });
    }
  }
  return actions;
};
