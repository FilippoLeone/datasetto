/**
 * The placeholder chunk behind a game that is not built yet (plan.md §2.4 handover stubs). Its
 * meta says `ready: {offline: false, online: false}`, so the shell hides the tile; if it is mounted
 * anyway it shows a plain card and holds nothing.
 */
import type { GameChunk, GameHandle } from './types';

export const comingSoon = (name: string): GameChunk => ({
  module: {
    mount(el): GameHandle {
      const card = document.createElement('div');
      card.className = 'flex h-full w-full items-center justify-center p-6 text-center text-sm text-text-muted';
      card.textContent = name + ' is coming soon.';
      el.appendChild(card);
      return {
        pause: () => undefined,
        resume: () => undefined,
        unmount: () => card.remove(),
      };
    },
  },
  local() {
    throw new Error(name + ' is not available yet');
  },
});
