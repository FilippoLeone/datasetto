/**
 * Bellwick's lazy chunk (plan.md §2.6.6): the game module and, for Solo Tale, the local tale the
 * platform's local host steps. Party Tale mounts the same module on a remote host.
 */
import type { GameChunk, GameModule, MatchHost } from '../runtime/types';
import { mountBellwick } from './game';
import { createLocalTale, offerLocalTale } from './offline';

const module: GameModule<MatchHost> = { mount: mountBellwick };

const chunk: GameChunk = {
  module,
  local(o) {
    const tale = createLocalTale(o.seed[0] ?? 1);
    offerLocalTale(tale);
    return tale;
  },
};

export default chunk;
