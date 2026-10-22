/**
 * The Glimmer Dash panel (glimmerhall.md §5.3): set one up (machine, 3/5/10 minutes, a buy-in of
 * 0/100/500/1,000), the lobby, the live scoreboard and the result. "A Dash is pure luck."
 */
import { DASH_BET, DASH_SPINS, type MachineIdx } from '@arcade/core/glimmer/machines';
import { DASH_BUYINS, DASH_LENGTHS, DASH_MIN, DASH_ST, dashRows, type DashView } from '@arcade/core/glimmer/wire';
import { SHORT_NAMES } from './hall';
import { button, fmt, h } from './ui';

export interface DashPanelDeps {
  dash: DashView | null;
  me: number;
  /** Outside a hall (left the call) you cannot join a Dash. */
  inHall: boolean;
  mode: 'local' | 'remote';
  machine: MachineIdx;
  name(slot: number): string;
  create(c: { m: MachineIdx; len: number; buy: number }): void;
  join(id: string): void;
  leave(id: string): void;
  start(id: string): void;
}

const clock = (s: number): string => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');

const options = <T extends number>(values: readonly T[], label: (v: T) => string, pick: T, onPick: (v: T) => void): HTMLDivElement => {
  const row = h('div', 'gh-row');
  const buttons = values.map((v) => {
    const b = button('gh-opt', label(v));
    b.setAttribute('aria-pressed', String(v === pick));
    b.addEventListener('click', () => {
      buttons.forEach((x, i) => x.setAttribute('aria-pressed', String(values[i] === v)));
      onPick(v);
    });
    row.append(b);
    return b;
  });
  return row;
};

const scoreboard = (d: DashView, deps: DashPanelDeps): HTMLTableElement => {
  const rows = dashRows(d).sort((a, b) => b[1] - a[1]);
  const pay = new Map<number, number>();
  for (let i = 0; i + 1 < (d.pay?.length ?? 0); i += 2) pay.set(d.pay?.[i] as number, d.pay?.[i + 1] as number);
  const table = h('table', 'gh-score gh-tbl');
  const head = h('tr');
  for (const t of ['', 'Player', 'Points', d.st === DASH_ST.done ? 'Prize' : 'Spins left']) head.append(h('th', '', t));
  table.append(head);
  rows.forEach(([slot, score, left], i) => {
    const tr = h('tr', slot === deps.me ? 'me' : '');
    tr.append(h('td', '', String(i + 1)), h('td', '', deps.name(slot)), h('td', '', fmt(score)));
    tr.append(h('td', '', d.st === DASH_ST.done ? (pay.has(slot) ? (d.buy > 0 ? fmt(pay.get(slot) as number) : 'Trophy') : '–') : String(left)));
    table.append(tr);
  });
  return table;
};

export const dashPanel = (deps: DashPanelDeps): HTMLDivElement => {
  const d = deps.dash;
  const out = h('div');
  const open = d && (d.st === DASH_ST.lobby || d.st === DASH_ST.running);
  if (!open) {
    if (d && d.st === DASH_ST.done) {
      out.append(h('h4', '', 'Last Dash: ' + SHORT_NAMES[d.m] + ', ' + d.len + ' min'));
      out.append(scoreboard(d, deps));
    } else if (d && d.st === DASH_ST.void) out.append(h('p', 'muted', 'The last Dash was called off. Every buy-in went back.'));
    out.append(h('p', '', 'A Dash is pure luck. Everyone gets ' + DASH_SPINS + ' spins at a fixed bet of ' + DASH_BET + ' points on one machine; the most points wins the pool.'));
    if (!deps.inHall) {
      out.append(h('p', 'muted', 'Join the voice call and open the hall to start or join a Dash.'));
      return out;
    }
    const cfg = { m: deps.machine, len: 5, buy: 0 };
    out.append(h('h4', '', 'Machine'));
    out.append(options([0, 1, 2] as const, (v) => SHORT_NAMES[v] as string, cfg.m, (v) => (cfg.m = v)));
    out.append(h('h4', '', 'Length'));
    out.append(options(DASH_LENGTHS, (v) => v + ' min', 5, (v) => (cfg.len = v)));
    out.append(h('h4', '', 'Buy-in'));
    out.append(options(DASH_BUYINS, (v) => (v === 0 ? 'Free' : fmt(v)), 0, (v) => (cfg.buy = v)));
    out.append(h('p', 'muted', deps.mode === 'local' ? 'Your bot neighbours join at once. Practice chips only.' : 'Friends in the hall can join for 60 seconds. It needs ' + DASH_MIN + ' to 8 players; with fewer, every buy-in goes back. 2 players: winner takes all; 3–4: 70/30; 5–8: 50/30/20.'));
    const go = button('gh-go', 'Open a Dash');
    go.addEventListener('click', () => deps.create({ ...cfg }));
    out.append(go);
    return out;
  }
  const rows = dashRows(d);
  const mine = rows.some((r) => r[0] === deps.me);
  out.append(h('h4', '', SHORT_NAMES[d.m] + ' · ' + d.len + ' min · ' + (d.buy === 0 ? 'free' : 'buy-in ' + fmt(d.buy)) + (d.buy > 0 ? ' · pool ' + fmt(d.buy * rows.length) : '')));
  out.append(h('p', 'muted', 'A Dash is pure luck.'));
  if (d.st === DASH_ST.lobby) {
    out.append(h('p', '', 'Starting in ' + clock(d.t) + ' or when the host starts it. ' + rows.length + ' joined.'));
    const list = h('p', '', rows.map((r) => deps.name(r[0])).join(', '));
    out.append(list);
    if (!mine && deps.inHall) {
      const join = button('gh-go', d.buy > 0 ? 'Join for ' + fmt(d.buy) : 'Join');
      join.addEventListener('click', () => deps.join(d.id));
      out.append(join);
    }
    if (mine && d.host === deps.me && rows.length >= DASH_MIN) {
      const start = button('gh-go', 'Start now');
      start.addEventListener('click', () => deps.start(d.id));
      out.append(start);
    }
    if (mine) {
      const leave = button('gh-go alt', d.host === deps.me && deps.mode === 'local' ? 'Call it off' : 'Leave');
      leave.addEventListener('click', () => deps.leave(d.id));
      out.append(leave);
    }
    return out;
  }
  out.append(h('p', '', clock(d.t) + ' left.' + (mine ? ' Your Dash spins use the SPIN button.' : '')));
  out.append(scoreboard(d, deps));
  return out;
};
