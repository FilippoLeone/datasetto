/**
 * Glimmerhall's lazy chunk (glimmerhall.md §7.3, plan.md §2.6.6): the hall module and, for offline
 * play, the local hall that answers the same table-lane events on the device.
 */
import type { GameChunk, GameModule, TableHost } from '../runtime/types';
import { mountHall } from './game';
import { createLocalHall } from './hosts/local';

const module: GameModule<TableHost> = {
  mount: (el, host, opts) => mountHall(el, host, opts),
};

const chunk: GameChunk = {
  module,
  local: () => {
    const hall = createLocalHall();
    // Dev builds only: lets a browser check force the next draws (never in a production build).
    if (import.meta.env.DEV) (window as unknown as { __glimmerLocal?: unknown }).__glimmerLocal = hall.debug;
    return hall;
  },
};

export default chunk;
