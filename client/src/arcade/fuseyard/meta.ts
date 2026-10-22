/** Fuseyard's catalogue entry (main bundle, ≤ 300 B gzip): the tile and the generic options form. */
import type { GameMeta } from '../catalog';

export const meta: GameMeta = {
  id: 'fuseyard',
  name: 'Fuseyard',
  tagline: 'Fuse bombs, burst blocks, be the last Wick standing',
  icon: 'bomb',
  lane: 'action',
  ready: { offline: true, online: true },
  modes: [
    { id: 'brawl', label: 'Brawl', online: true, offline: true },
    { id: 'quickfire', label: 'Quickfire', online: true, offline: true },
  ],
  seats: [2, 4],
  watch: true,
  // Bots fill every empty seat at the start (Fighters and Bots below decide), not the sheet's stepper.
  hostBots: false,
  options: [
    {
      key: 'arena',
      label: 'Arena',
      kind: 'choice',
      default: 'rotation',
      choices: [
        { value: 'rotation', label: 'Rotation' },
        { value: 'yard', label: 'Brickyard' },
        { value: 'mill', label: 'Rolling Mill' },
        { value: 'pond', label: 'Frostbite Pond' },
        { value: 'garden', label: 'Warp Garden' },
        { value: 'depot', label: 'Night Depot' },
      ],
    },
    { key: 'fighters', label: 'Fighters', kind: 'choice', default: 4, choices: [2, 3, 4].map((v) => ({ value: v, label: String(v) })) },
    { key: 'wins', label: 'Wins needed', kind: 'choice', default: 3, when: { mode: ['brawl'] }, choices: [2, 3, 5].map((v) => ({ value: v, label: String(v) })) },
    {
      key: 'bots',
      label: 'Bots',
      kind: 'choice',
      default: 'scrapper',
      choices: [
        { value: 'sprout', label: 'Sprout' },
        { value: 'scrapper', label: 'Scrapper' },
        { value: 'menace', label: 'Menace' },
      ],
    },
  ],
  load: () => import('./index').then((m) => m.default),
};
