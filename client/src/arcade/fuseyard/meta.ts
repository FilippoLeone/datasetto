/** Fuseyard's catalogue entry (main bundle, ≤ 300 B gzip). Handover stub from the platform; owned by Fuseyard from arcade-p-m1. */
import type { GameMeta } from '../catalog';

export const meta: GameMeta = {
  id: 'fuseyard',
  name: 'Fuseyard',
  tagline: 'Fuse bombs, burst blocks, be the last Wick standing',
  icon: 'bomb',
  lane: 'action',
  ready: { offline: false, online: false },
  modes: [
    { id: 'brawl', label: 'Brawl', online: true, offline: true },
    { id: 'quickfire', label: 'Quickfire', online: true, offline: true },
  ],
  seats: [2, 4],
  watch: true,
  options: [],
  load: () => import('./index').then((m) => m.default),
};
