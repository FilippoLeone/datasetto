/**
 * Wrap a game's pure `CoreMatch` into the server's `MatchRuntime`. The core keeps one code path for
 * online and offline; the server adds only identity, the HANDOVER body, the replay dump and cleanup.
 */
import type { CoreMatch } from '../core/net/match.js';
import type { ActionGameId } from '../core/version.js';
import type { MatchRuntime } from './types.js';

export const wrapCore = (
  game: ActionGameId,
  id: string,
  core: CoreMatch,
  extra: { handover(): Uint8Array; replay(): Uint8Array; dispose?(): void },
): MatchRuntime => {
  let disposed = false;
  return {
    game,
    id,
    get idle() {
      return core.idle;
    },
    get tick() {
      return core.tick;
    },
    step: () => core.step(),
    onUp: (slot, payload, upSeq) => core.onUp(slot, payload, upSeq),
    onEvent: (slot, payload) => core.onEvent(slot, payload),
    ackUp: (slot) => core.ackUp(slot),
    setSeat: (slot, cmd) => core.setSeat(slot, cmd),
    setRtt: (slot, rttMs) => core.setRtt(slot, rttMs),
    welcomeCfg: () => core.welcomeCfg(),
    snapshotFor: (r) => core.snapshotFor(r),
    keyframeFor: (r) => core.keyframeFor(r),
    takeEvents: (r) => core.takeEvents(r),
    takeHostEvents: () => core.takeHostEvents(),
    dump: () => core.dump(),
    handover: () => extra.handover(),
    replay: () => extra.replay(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      extra.dispose?.();
    },
  };
};
