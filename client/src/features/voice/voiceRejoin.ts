/**
 * What a voice call does when the socket goes away: nothing visible. The media
 * connections to friends are peer to peer and keep flowing; this state machine
 * only decides when to tell the server "I am still in this room" again and when
 * to give up. Pure: the voice manager feeds it events and runs the effects.
 *
 *   active ──socketLost──> suspended ──authenticated──> rejoining ──joined──> active
 *                              ^                            │
 *                              └──── joinFailed (retry) ────┘   (permanent refusal, too many
 *                                                                attempts or 90 s away: abandoned)
 */
export type RejoinPhase = 'idle' | 'active' | 'suspended' | 'rejoining' | 'abandoned';

export interface RejoinState {
  phase: RejoinPhase;
  channelId: string | null;
  /** Rejoin attempts since the socket was lost. */
  attempts: number;
  /** When the socket was lost; the clock for the overall timeout. */
  suspendedAt: number | null;
  /** When to try again after a transient refusal. */
  retryAt: number | null;
}

export type RejoinEvent =
  | { type: 'joined'; channelId: string }
  | { type: 'left' }
  | { type: 'socketLost'; at: number }
  | { type: 'authenticated'; at: number }
  | { type: 'joinFailed'; at: number; code?: string | null }
  | { type: 'tick'; at: number };

export type GiveUpReason = 'timeout' | 'attempts' | 'refused';
export type RejoinEffect = { type: 'rejoin'; channelId: string; attempt: number } | { type: 'giveUp'; reason: GiveUpReason; code: string | null };

export interface RejoinOptions {
  maxAttempts: number;
  /** Give up this long after the socket was lost, whatever happened meanwhile. */
  maxSuspendedMs: number;
  /** Wait before retrying after a transient refusal. */
  retryDelayMs: number;
}

export const REJOIN_DEFAULTS: RejoinOptions = { maxAttempts: 6, maxSuspendedMs: 90_000, retryDelayMs: 3_000 };

/** Refusals that will not change by asking again. */
export const PERMANENT_JOIN_ERRORS = new Set(['FORBIDDEN', 'INVALID_VOICE_CHANNEL', 'VOICE_TIMED_OUT', 'NOT_FOUND', 'BANNED', 'VALIDATION_FAILED', 'PASSWORD_CHANGE_REQUIRED']);

export const initialRejoinState: RejoinState = { phase: 'idle', channelId: null, attempts: 0, suspendedAt: null, retryAt: null };

export interface RejoinStep {
  state: RejoinState;
  effects: RejoinEffect[];
}

const same = (state: RejoinState): RejoinStep => ({ state, effects: [] });

const abandon = (state: RejoinState, reason: GiveUpReason, code: string | null = null): RejoinStep => ({
  state: { ...state, phase: 'abandoned', retryAt: null },
  effects: [{ type: 'giveUp', reason, code }],
});

const tryRejoin = (state: RejoinState, options: RejoinOptions): RejoinStep => {
  if (!state.channelId) return same({ ...initialRejoinState });
  if (state.attempts >= options.maxAttempts) return abandon(state, 'attempts');
  const attempt = state.attempts + 1;
  return {
    state: { ...state, phase: 'rejoining', attempts: attempt, retryAt: null },
    effects: [{ type: 'rejoin', channelId: state.channelId, attempt }],
  };
};

export const reduceRejoin = (state: RejoinState, event: RejoinEvent, options: RejoinOptions = REJOIN_DEFAULTS): RejoinStep => {
  switch (event.type) {
    case 'joined':
      return same({ phase: 'active', channelId: event.channelId, attempts: 0, suspendedAt: null, retryAt: null });
    case 'left':
      return same({ ...initialRejoinState });
    case 'socketLost':
      if (state.phase === 'active') return same({ ...state, phase: 'suspended', attempts: 0, suspendedAt: event.at, retryAt: null });
      // Lost again while a rejoin was in flight: wait for the next sign-in, the clock keeps running.
      if (state.phase === 'rejoining') return same({ ...state, phase: 'suspended', retryAt: null });
      return same(state);
    case 'authenticated':
      if (state.phase !== 'suspended' && state.phase !== 'rejoining') return same(state);
      if (state.suspendedAt !== null && event.at - state.suspendedAt >= options.maxSuspendedMs) return abandon(state, 'timeout');
      return tryRejoin(state, options);
    case 'joinFailed': {
      if (state.phase !== 'rejoining') return same(state);
      const code = event.code ?? null;
      if (code && PERMANENT_JOIN_ERRORS.has(code)) return abandon(state, 'refused', code);
      if (state.attempts >= options.maxAttempts) return abandon(state, 'attempts', code);
      return same({ ...state, phase: 'suspended', retryAt: event.at + options.retryDelayMs });
    }
    case 'tick': {
      if (state.phase !== 'suspended' && state.phase !== 'rejoining') return same(state);
      if (state.suspendedAt !== null && event.at - state.suspendedAt >= options.maxSuspendedMs) return abandon(state, 'timeout');
      if (state.phase === 'suspended' && state.retryAt !== null && event.at >= state.retryAt) return tryRejoin(state, options);
      return same(state);
    }
    default:
      return same(state);
  }
};

/** The call is on hold: the UI shows "reconnecting" and keeps the microphone state. */
export const isRejoinPending = (state: RejoinState): boolean => state.phase === 'suspended' || state.phase === 'rejoining';
