/** Lamplight Hold'em's catalogue entry (main bundle, ≤ 300 B gzip): tile, modes and the lobby form fields. */
import type { GameMeta } from '../catalog';

const n = (v: number) => ({ value: v, label: String(v) });

export const meta: GameMeta = {
  id: 'lamplight',
  name: "Lamplight Hold'em",
  tagline: 'Hold’em with play chips at the Open Tables, the Cup and the Firefly Trio',
  icon: 'cards',
  lane: 'table',
  ready: { offline: true, online: true },
  modes: [
    { id: 'open', label: 'Open Tables', online: true, offline: true },
    { id: 'cup', label: 'Lamplight Cup', online: true, offline: true },
    { id: 'trio', label: 'Firefly Trio', online: true, offline: true },
  ],
  seats: [2, 9],
  watch: true,
  // Bots come from the lobby options (cash and Cup), never the sheet's stepper; the Trio is people only.
  hostBots: false,
  options: [
    {
      key: 'tier',
      label: 'Stakes',
      when: { mode: ['open'] },
      kind: 'choice',
      default: 'pebble',
      choices: [
        { value: 'pebble', label: 'Pebble 5/10' },
        { value: 'cobble', label: 'Cobble 25/50' },
        { value: 'boulder', label: 'Boulder 100/200' },
        { value: 'summit', label: 'Summit 500/1000' },
      ],
    },
    { key: 'buyIn', label: 'Buy-in', when: { mode: ['cup'] }, kind: 'choice', default: 2000, choices: [n(500), n(2000), n(10000)] },
    { key: 'buyIn', label: 'Buy-in', when: { mode: ['trio'] }, kind: 'choice', default: 1000, choices: [n(200), n(1000), n(5000)] },
    { key: 'players', label: 'Players', when: { mode: ['open', 'cup'] }, kind: 'choice', default: 6, choices: [2, 3, 4, 5, 6, 7, 8, 9].map(n) },
    // Online tables have no bots unless the host asks (Pebble and Cobble cash tables, or a Cup); offline always.
    { key: 'onlineBots', label: 'Bots at an online table', when: { mode: ['open', 'cup'] }, kind: 'toggle', default: false },
    {
      key: 'bots',
      label: 'Bot level',
      kind: 'choice',
      default: 'regular',
      choices: [
        { value: 'greenhorn', label: 'Greenhorn' },
        { value: 'regular', label: 'Regular' },
        { value: 'sharp', label: 'Sharp' },
      ],
    },
  ],
  load: () => import('./index').then((m) => m.default),
};
