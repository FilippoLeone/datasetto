/** Bellwick's catalogue entry (main bundle, ≤ 300 B gzip). Handover stub from the platform; owned by Bellwick from arcade-p-m1. */
import type { GameMeta } from '../catalog';

export const meta: GameMeta = {
  id: 'bellwick',
  name: 'Bellwick: The Silent Bells',
  tagline: 'Wake the bells of the Drowned Bellhouse, alone or together',
  icon: 'sword',
  lane: 'action',
  ready: { offline: false, online: false },
  modes: [
    { id: 'party', label: 'Party Tale', online: true, offline: false },
    { id: 'solo', label: 'Solo Tale', online: false, offline: true },
  ],
  seats: [1, 4],
  watch: false,
  options: [{ key: 'slot', label: 'Tale', kind: 'saveSlot', when: { mode: ['party'] } }],
  load: () => import('./index').then((m) => m.default),
};
