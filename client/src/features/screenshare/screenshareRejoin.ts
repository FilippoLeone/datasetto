/**
 * What a screenshare room does when the socket goes away: the presenter keeps
 * capturing, the viewers keep their picture, and the room is put back together
 * on the next sign-in. Pure, like features/voice/voiceRejoin.ts: the service
 * feeds it events and runs the effects.
 *
 * Host:   active ──socketLost──> suspended ──authenticated──> rejoining ──settled──> active
 * Viewer: active ──socketLost──> suspended ──authenticated──> rejoining ──settled──> active
 *                 └─sessionInactive──> waiting-host ──sessionActive (same presenter)──> rejoining
 *
 * Give-ups: 90 s with the socket down, 60 s without the presenter, a refusal
 * from the server, too many attempts, or a different presenter in the room.
 */
export type ShareRole = 'host' | 'viewer';
export type SharePhase = 'idle' | 'active' | 'suspended' | 'rejoining' | 'waiting-host' | 'abandoned';

export interface ShareState {
  role: ShareRole | null;
  phase: SharePhase;
  channelId: string | null;
  attempts: number;
  /** When the socket was lost; the clock for the overall timeout. */
  suspendedAt: number | null;
  /** When the presenter went missing (viewer); the clock for the host grace. */
  waitingSince: number | null;
  hostAccountId: string | null;
  hostRtcSessionId: string | null;
}

export type ShareEvent =
  | { type: 'started'; role: ShareRole; channelId: string; hostAccountId?: string | null; hostRtcSessionId?: string | null }
  | { type: 'settled'; at: number; hostAccountId?: string | null; hostRtcSessionId?: string | null }
  | { type: 'stopped' }
  | { type: 'socketLost'; at: number }
  | { type: 'authenticated'; at: number }
  | { type: 'sessionInactive'; at: number }
  | { type: 'sessionActive'; at: number; hostAccountId: string | null; hostRtcSessionId: string | null }
  | { type: 'refused'; at: number; code?: string | null }
  | { type: 'tick'; at: number };

export type GiveUpReason = 'timeout' | 'host-gone' | 'new-host' | 'refused' | 'attempts';
export type ShareEffect = { type: 'restartHosting'; channelId: string } | { type: 'rejoinViewer'; channelId: string } | { type: 'giveUp'; reason: GiveUpReason; code: string | null };

export interface ShareOptions {
  maxAttempts: number;
  /** Give up this long after the socket was lost. */
  maxSuspendedMs: number;
  /** A viewer waits this long for the presenter to come back. */
  hostGraceMs: number;
}

export const SHARE_DEFAULTS: ShareOptions = { maxAttempts: 6, maxSuspendedMs: 90_000, hostGraceMs: 60_000 };

export const initialShareState: ShareState = {
  role: null,
  phase: 'idle',
  channelId: null,
  attempts: 0,
  suspendedAt: null,
  waitingSince: null,
  hostAccountId: null,
  hostRtcSessionId: null,
};

export interface ShareStep {
  state: ShareState;
  effects: ShareEffect[];
}

const same = (state: ShareState): ShareStep => ({ state, effects: [] });

const abandon = (state: ShareState, reason: GiveUpReason, code: string | null = null): ShareStep => ({
  state: { ...state, phase: 'abandoned' },
  effects: [{ type: 'giveUp', reason, code }],
});

const rejoin = (state: ShareState, options: ShareOptions): ShareStep => {
  if (!state.role || !state.channelId) return same({ ...initialShareState });
  if (state.attempts >= options.maxAttempts) return abandon(state, 'attempts');
  return {
    state: { ...state, phase: 'rejoining', attempts: state.attempts + 1 },
    effects: [state.role === 'host' ? { type: 'restartHosting', channelId: state.channelId } : { type: 'rejoinViewer', channelId: state.channelId }],
  };
};

const pending = (state: ShareState): boolean => state.phase === 'suspended' || state.phase === 'rejoining' || state.phase === 'waiting-host';

export const reduceShare = (state: ShareState, event: ShareEvent, options: ShareOptions = SHARE_DEFAULTS): ShareStep => {
  switch (event.type) {
    case 'started':
      return same({
        role: event.role,
        phase: 'active',
        channelId: event.channelId,
        attempts: 0,
        suspendedAt: null,
        waitingSince: null,
        hostAccountId: event.hostAccountId ?? null,
        hostRtcSessionId: event.hostRtcSessionId ?? null,
      });
    case 'stopped':
      return same({ ...initialShareState });
    case 'settled':
      if (state.phase === 'idle' || state.phase === 'abandoned') return same(state);
      return same({
        ...state,
        phase: 'active',
        attempts: 0,
        suspendedAt: null,
        waitingSince: null,
        hostAccountId: event.hostAccountId !== undefined ? event.hostAccountId : state.hostAccountId,
        hostRtcSessionId: event.hostRtcSessionId !== undefined ? event.hostRtcSessionId : state.hostRtcSessionId,
      });
    case 'socketLost':
      if (state.phase === 'active' || state.phase === 'rejoining' || state.phase === 'waiting-host') {
        return same({ ...state, phase: 'suspended', suspendedAt: state.suspendedAt ?? event.at });
      }
      return same(state);
    case 'authenticated':
      if (state.phase !== 'suspended' && state.phase !== 'rejoining') return same(state);
      if (state.suspendedAt !== null && event.at - state.suspendedAt >= options.maxSuspendedMs) return abandon(state, 'timeout');
      return rejoin(state, options);
    case 'sessionInactive':
      if (state.role !== 'viewer') return same(state);
      if (state.phase === 'active' || state.phase === 'rejoining') {
        return same({ ...state, phase: 'waiting-host', waitingSince: state.waitingSince ?? event.at, suspendedAt: null });
      }
      return same(state);
    case 'sessionActive': {
      if (state.role !== 'viewer') return same(state);
      if (state.phase === 'waiting-host') {
        if (state.hostAccountId !== null && event.hostAccountId !== state.hostAccountId) return abandon(state, 'new-host');
        if (event.at - state.waitingSince! >= options.hostGraceMs) return abandon(state, 'host-gone');
        return rejoin({ ...state, hostRtcSessionId: event.hostRtcSessionId, hostAccountId: event.hostAccountId ?? state.hostAccountId }, options);
      }
      if (state.phase === 'active' && state.hostAccountId !== null && event.hostAccountId !== null && event.hostAccountId !== state.hostAccountId) {
        return abandon(state, 'new-host');
      }
      if (state.phase === 'active' || state.phase === 'rejoining') {
        return same({ ...state, hostRtcSessionId: event.hostRtcSessionId, hostAccountId: event.hostAccountId ?? state.hostAccountId });
      }
      return same(state);
    }
    case 'refused':
      if (state.phase === 'idle' || state.phase === 'abandoned') return same(state);
      return abandon(state, 'refused', event.code ?? null);
    case 'tick': {
      if (!pending(state)) return same(state);
      if ((state.phase === 'suspended' || state.phase === 'rejoining') && state.suspendedAt !== null && event.at - state.suspendedAt >= options.maxSuspendedMs) {
        return abandon(state, 'timeout');
      }
      if (state.phase === 'waiting-host' && state.waitingSince !== null && event.at - state.waitingSince >= options.hostGraceMs) {
        return abandon(state, 'host-gone');
      }
      return same(state);
    }
    default:
      return same(state);
  }
};

/** The room is being held together: keep the capture, the picture and the connections. */
export const isSharePending = (state: ShareState): boolean => pending(state);
