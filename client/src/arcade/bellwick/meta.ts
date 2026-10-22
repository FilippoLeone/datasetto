/**
 * Bellwick's catalogue entry (main bundle, ≤ 1 KB gzip). Party Tale: the host continues one of their
 * three account slots, or starts a new tale; the shell saves a new tale in the first empty slot and
 * asks which tale it replaces only when all three are used.
 */
import type { GameMeta } from '../catalog';

export const meta: GameMeta = {
  id: 'bellwick',
  name: 'Bellwick: The Silent Bells',
  tagline: 'A cosy adventure: wake the village bells, alone or with friends',
  icon: 'sword',
  lane: 'action',
  ready: { offline: true, online: true },
  modes: [
    { id: 'party', label: 'Party Tale', blurb: 'One shared tale; friends drop in and out.', online: true, offline: false },
    { id: 'solo', label: 'Solo Tale', blurb: 'Your own tale on this device.', online: false, offline: true },
  ],
  seats: [1, 4],
  watch: false,
  // The room never adds bots: friends drop in instead.
  hostBots: false,
  options: [
    { key: 'slot', label: 'Tale', kind: 'saveSlot', into: 'into', when: { mode: ['party'] } },
    {
      key: 'into',
      label: 'Replaces',
      hint: 'The old tale in that slot is erased.',
      kind: 'choice',
      choices: [
        { value: 0, label: 'Slot 1' },
        { value: 1, label: 'Slot 2' },
        { value: 2, label: 'Slot 3' },
      ],
      default: 0,
      sum: 'replaces #',
      more: true,
      when: { mode: ['party'], field: { key: 'slot', in: ['new'] } },
    },
  ],
  load: () => import('./index').then((m) => m.default),
};
