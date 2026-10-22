/**
 * Bellwick's catalogue entry (main bundle, ≤ 300 B gzip). Party Tale: the host continues one of their
 * three account slots, or starts a new tale in the slot picked under "New tale in".
 */
import type { GameMeta } from '../catalog';

export const meta: GameMeta = {
  id: 'bellwick',
  name: 'Bellwick: The Silent Bells',
  tagline: 'Wake the bells of the Drowned Bellhouse, alone or together',
  icon: 'sword',
  lane: 'action',
  ready: { offline: true, online: true },
  modes: [
    { id: 'party', label: 'Party Tale', online: true, offline: false },
    { id: 'solo', label: 'Solo Tale', online: false, offline: true },
  ],
  seats: [1, 4],
  watch: false,
  options: [
    { key: 'slot', label: 'Tale', kind: 'saveSlot', when: { mode: ['party'] } },
    {
      key: 'into',
      label: 'New tale in',
      kind: 'choice',
      choices: [
        { value: 0, label: 'Slot 1' },
        { value: 1, label: 'Slot 2' },
        { value: 2, label: 'Slot 3' },
      ],
      default: 0,
      when: { mode: ['party'] },
    },
  ],
  load: () => import('./index').then((m) => m.default),
};
