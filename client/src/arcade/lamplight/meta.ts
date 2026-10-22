/** Lamplight Hold'em's catalogue entry (main bundle, ≤ 300 B gzip). Handover stub from the platform; owned by Lamplight from arcade-p-m1. */
import type { GameMeta } from '../catalog';

export const meta: GameMeta = {
  id: 'lamplight',
  name: "Lamplight Hold'em",
  tagline: 'Hold’em with play chips at the Open Tables, the Cup and the Firefly Trio',
  icon: 'cards',
  lane: 'table',
  ready: { offline: false, online: false },
  modes: [
    { id: 'open', label: 'Open Tables', online: true, offline: true },
    { id: 'cup', label: 'Lamplight Cup', online: true, offline: true },
    { id: 'trio', label: 'Firefly Trio', online: true, offline: true },
  ],
  seats: [2, 9],
  watch: true,
  options: [],
  load: () => import('./index').then((m) => m.default),
};
