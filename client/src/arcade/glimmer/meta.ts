/** Glimmerhall's catalogue entry (main bundle, ≤ 300 B gzip). Handover stub from the platform; owned by Glimmerhall from arcade-p-m1. */
import type { GameMeta } from '../catalog';

export const meta: GameMeta = {
  id: 'glimmer',
  name: 'Glimmerhall',
  tagline: 'Three play-chip machines, the Glimmer Pot and the Glimmer Dash',
  icon: 'coins',
  lane: 'table',
  ready: { offline: false, online: false },
  modes: [
    { id: 'hall', label: 'The hall', online: true, offline: true },
    { id: 'dash', label: 'Glimmer Dash', online: true, offline: true },
  ],
  seats: [1, 16],
  watch: false,
  options: [],
  load: () => import('./index').then((m) => m.default),
};
