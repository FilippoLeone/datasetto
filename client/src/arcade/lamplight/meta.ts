/** Lamplight Hold'em's catalogue entry (main bundle, ≤ 1 KB gzip): card, modes and setup fields. */
import type { Choice, GameMeta } from '../catalog';

const n = (v: number): Choice => ({ value: v, label: v.toLocaleString('en') });
const bots: readonly Choice[] = [
  { value: 'greenhorn', label: 'Greenhorn', hint: 'Easy' },
  { value: 'regular', label: 'Regular', hint: 'Fair' },
  { value: 'sharp', label: 'Sharp', hint: 'Tough' },
];
const ONLINE = 'online';
const FILL = 'Fill empty seats with bots';

export const meta: GameMeta = {
  id: 'lamplight',
  name: "Lamplight Hold'em",
  tagline: "Texas Hold'em with play chips",
  icon: 'cards',
  lane: 'table',
  ready: { offline: true, online: true },
  chips: true,
  modes: [
    { id: 'open', label: 'Cash table', blurb: 'Sit down and leave any time. The blinds never change.', online: true, offline: true },
    { id: 'cup', label: 'Tournament', blurb: 'Lamplight Cup: same stack for all, rising blinds, last one standing wins.', online: true, offline: true },
    { id: 'trio', label: '3-player jackpot', blurb: 'Firefly Trio: three players, fast blinds, a random prize multiplier.', online: true, offline: true },
  ],
  seats: [2, 9],
  watch: true,
  // Bots come from the setup (solo, and online cash tables and Cups), never the sheet's stepper; the Trio is people only.
  hostBots: false,
  options: [
    { key: 'bots', label: 'Bot level', when: { where: 'offline' }, kind: 'choice', default: 'regular', choices: bots, sum: '# bots' },
    {
      key: 'tier',
      label: 'Stakes',
      when: { mode: ['open'] },
      more: 'offline',
      kind: 'choice',
      default: 'pebble',
      choices: [
        { value: 'pebble', label: 'Pebble 5/10', hint: 'Buy in up to 1,000' },
        { value: 'cobble', label: 'Cobble 25/50', hint: 'Buy in up to 5,000' },
        { value: 'boulder', label: 'Boulder 100/200', hint: 'Buy in up to 20,000' },
        { value: 'summit', label: 'Summit 500/1,000', hint: 'Buy in up to 100,000' },
      ],
    },
    { key: 'buyIn', label: 'Buy-in', when: { mode: ['cup'] }, more: 'offline', kind: 'choice', default: 2000, choices: [n(500), n(2000), n(10000)] },
    { key: 'buyIn', label: 'Buy-in', when: { mode: ['trio'] }, more: 'offline', kind: 'choice', default: 1000, choices: [n(200), n(1000), n(5000)] },
    { key: 'players', label: 'Seats', when: { mode: ['open', 'cup'] }, more: true, setsSeats: true, kind: 'choice', control: 'stepper', default: 6, choices: [2, 3, 4, 5, 6, 7, 8, 9].map(n), sum: '# seats' },
    // Online tables have no bots unless the host asks: Pebble and Cobble cash tables, or a Cup.
    { key: 'onlineBots', label: FILL, hint: 'Pebble and Cobble tables only', when: { mode: ['open'], where: ONLINE, field: { key: 'tier', in: ['pebble', 'cobble'] } }, more: true, kind: 'toggle', default: false },
    { key: 'onlineBots', label: FILL, hint: "Needs 2 people; bots don't add to the prize", when: { mode: ['cup'], where: ONLINE }, more: true, kind: 'toggle', default: false },
    { key: 'bots', label: 'Bot level', when: { mode: ['open', 'cup'], where: ONLINE, field: { key: 'onlineBots', in: [true] } }, more: true, kind: 'choice', default: 'regular', choices: bots, sum: '# bots' },
  ],
  load: () => import('./index').then((m) => m.default),
};
