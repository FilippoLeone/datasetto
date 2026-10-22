/** Fuseyard's catalogue entry (main bundle, ≤ 1 KB gzip): the card and the generic setup fields. */
import type { Choice, GameMeta } from '../catalog';

const n = (v: number): Choice => ({ value: v, label: String(v) });
const bots: readonly Choice[] = [
  { value: 'sprout', label: 'Sprout', hint: 'Easy' },
  { value: 'scrapper', label: 'Scrapper', hint: 'Fair' },
  { value: 'menace', label: 'Menace', hint: 'Tough' },
];

export const meta: GameMeta = {
  id: 'fuseyard',
  name: 'Fuseyard',
  tagline: 'Bomb-dropping arena battle for 2–4',
  icon: 'bomb',
  lane: 'action',
  ready: { offline: true, online: true },
  modes: [
    { id: 'brawl', label: 'Brawl', blurb: 'Several rounds. The first to the target number of wins takes the match.', online: true, offline: true },
    { id: 'quickfire', label: 'Quickfire', blurb: 'One 90-second round. Everyone starts powered up.', online: true, offline: true },
  ],
  seats: [2, 4],
  watch: true,
  // Bots fill every empty seat at the start (Fighters and Bot level below decide), not the sheet's stepper.
  hostBots: false,
  options: [
    { key: 'bots', label: 'Bot level', when: { where: 'offline' }, kind: 'choice', default: 'scrapper', choices: bots, sum: '# bots' },
    { key: 'bots', label: 'Bot level', hint: 'For empty seats', when: { where: 'online' }, more: true, kind: 'choice', default: 'scrapper', choices: bots, sum: '# bots' },
    { key: 'wins', label: 'Wins needed', when: { mode: ['brawl'] }, more: true, kind: 'choice', default: 3, choices: [2, 3, 5].map(n), sum: 'first to #' },
    {
      key: 'arena',
      label: 'Arena',
      hint: 'Rotation changes the arena every round',
      more: true,
      kind: 'choice',
      control: 'select',
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
    { key: 'fighters', label: 'Fighters', hint: 'Empty places are filled with bots', more: true, setsSeats: true, kind: 'choice', control: 'stepper', default: 4, choices: [2, 3, 4].map(n), sum: '# fighters' },
  ],
  load: () => import('./index').then((m) => m.default),
};
