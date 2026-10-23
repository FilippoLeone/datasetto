/** Glimmerhall's catalogue entry (main bundle, ≤ 1 KB gzip). Owned by Glimmerhall. */
import type { GameMeta } from '../catalog';

export const meta: GameMeta = {
  id: 'glimmer',
  name: 'Glimmerhall',
  tagline: 'Three slot machines, played with chips',
  icon: 'coins',
  lane: 'table',
  ready: { offline: true, online: true },
  chips: true,
  modes: [{ id: 'hall', label: 'Open hall', blurb: 'Spin any of three machines; everyone in the hall shares the Glimmer Pot.', online: true, offline: true }],
  seats: [1, 16],
  watch: false,
  options: [],
  load: () => import('./index').then((m) => m.default),
};
