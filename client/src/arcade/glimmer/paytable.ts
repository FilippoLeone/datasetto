/**
 * "How it works" (glimmerhall.md §2, §15): each machine's return, hit frequency, feature odds,
 * paytable at the current bet and lines, worked out from the strips themselves (`exactRtp`).
 * Built when first opened.
 */
import { DEFS_BY_IDX, ROWS, type MachineDef, type MachineIdx } from '@arcade/core/glimmer/machines';
import { exactRtp, PUBLISHED_HIT } from '@arcade/core/glimmer/rtp';
import { symbolUrl } from './art';
import { PLAY_MONEY, SHORT_NAMES } from './hall';
import { button, fmt, h } from './ui';

const pct = (x: number): string => (Math.round(x * 10000) / 100).toFixed(2) + ' %';

const lineSvg = (line: readonly number[], color: string): SVGSVGElement => {
  const ns = 'http://www.w3.org/2000/svg';
  const w = line.length * 8;
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', String(w + 4));
  svg.setAttribute('height', '28');
  svg.setAttribute('viewBox', '0 0 ' + (w + 4) + ' 28');
  svg.setAttribute('aria-hidden', 'true');
  for (let r = 0; r < line.length; r += 1) {
    for (let y = 0; y < ROWS; y += 1) {
      const c = document.createElementNS(ns, 'rect');
      c.setAttribute('x', String(2 + r * 8 + 1));
      c.setAttribute('y', String(2 + y * 8 + 1));
      c.setAttribute('width', '6');
      c.setAttribute('height', '6');
      c.setAttribute('fill', line[r] === y ? color : '#ffffff22');
      svg.append(c);
    }
  }
  return svg;
};

const featureText = (def: MachineDef, bet: number): string => {
  const f = def.feature;
  if (f.kind === 'wheel') {
    const mean = f.segments.reduce((a, b) => a + b, 0) / f.segments.length;
    return (
      'A Basket on each reel turns the Harvest Wheel: twelve equal segments paying ' +
      f.segments.join(', ') +
      ' × your bet (' +
      f.segments.map((s) => fmt(s * bet)).join(', ') +
      ' chips now). Every segment is equally likely; the average is ' +
      Math.round(mean * 100) / 100 +
      ' × the bet.'
    );
  }
  if (f.kind === 'tide') {
    return (
      'A Starfish on reels 1, 3 and 5 pays ' +
      f.scatterPay +
      ' × your bet and gives ' +
      f.spins +
      ' free spins on the same reels. Every free-spin win counts double. Three Starfish during free spins pay again (doubled) and add ' +
      f.retrigger +
      ' spins. A feature stops at 200 free spins.'
    );
  }
  return (
    'A Vault Key on reels 1, 3 and 5 pays ' +
    f.scatterPay +
    ' × your bet and shows three vault doors. Behind them, shuffled at random when the keys land: ' +
    f.prizes.map((p) => p.spins + ' spins at ×' + p.mult).join(', ') +
    '. Every door is equally likely to hold every prize, so the pick is a reveal, not a skill. Then the Forge Spins play on reels with more Molten Cores. Three keys during Forge Spins pay again (× the multiplier) and add ' +
    f.retrigger +
    ' spins.'
  );
};

const unitText = (def: MachineDef): string => (def.unitDiv === 5 ? 'line bet (bet ÷ 5)' : def.eval === 'ways' ? 'coin per way (bet ÷ 20)' : 'coin per line (bet ÷ 20)');

/** The page for one machine. */
export const paytablePage = (m: MachineIdx, bet: number, mode: 'local' | 'remote', accent: string): HTMLDivElement => {
  const def = DEFS_BY_IDX[m] as MachineDef;
  const r = exactRtp(def);
  const page = h('div');
  page.append(h('h4', '', def.name));
  const odds = h('p');
  odds.textContent =
    'Return: ' +
    pct(r.total) +
    ' of everything bet, worked out exactly from the reels below' +
    (mode === 'remote' ? '; online the shared Glimmer Pot adds 1.5 %, for ' + pct(r.total + 0.015) : '') +
    '. ' +
    pct(PUBLISHED_HIT[m] as number) +
    ' of spins return something. The ' +
    def.featureName +
    ' comes about once in ' +
    fmt(1 / r.triggerP) +
    ' spins.';
  page.append(odds);
  page.append(h('p', 'muted', 'Over a long run you get back less than you put in, like any machine of this kind. Results are luck only.'));

  page.append(h('h4', '', def.featureName));
  page.append(h('p', '', featureText(def, bet)));

  page.append(h('h4', '', 'Pays at your bet of ' + fmt(bet)));
  const unit = bet / def.unitDiv;
  const table = h('table', 'gh-tbl');
  const counts: number[] = [];
  for (let k = 2; k <= def.reels; k += 1) if (def.pays.some((p) => (p[k] as number) > 0)) counts.push(k);
  const head = h('tr');
  head.append(h('th', '', 'Symbol'));
  for (const k of counts) head.append(h('th', '', k + ' in a row'));
  table.append(head);
  for (let s = def.symbols.length - 1; s >= 0; s -= 1) {
    const pays = def.pays[s] as readonly number[];
    const isWild = s === def.wild;
    const isScatter = s === def.scatter;
    if (!isWild && !isScatter && pays.every((p) => p === 0)) continue;
    const tr = h('tr');
    const name = h('td');
    const img = h('img');
    img.alt = '';
    img.src = symbolUrl(m, s, 2);
    name.append(img, document.createTextNode((def.symbolNames[s] as string) + (isWild ? ' (wild)' : isScatter ? (def.feature.kind === 'wheel' ? ' (bonus)' : ' (scatter)') : '')));
    tr.append(name);
    if (isScatter) {
      const td = h('td', '', def.feature.kind === 'wheel' ? 'one on each reel: the wheel' : 'reels 1, 3 and 5: the ' + def.featureName);
      td.colSpan = counts.length;
      tr.append(td);
    } else if (isWild && !def.wildPays) {
      const td = h('td', '', 'stands in for every symbol except the ' + (def.symbolNames[def.scatter] as string) + '; reels 2–4');
      td.colSpan = counts.length;
      tr.append(td);
    } else for (const k of counts) tr.append(h('td', '', (pays[k] as number) > 0 ? fmt((pays[k] as number) * unit) : '–'));
    table.append(tr);
  }
  page.append(table);
  page.append(
    h(
      'p',
      'muted',
      def.eval === 'lines'
        ? 'Pays are per ' + unitText(def) + '. Lines pay left to right from the first reel on neighbouring reels; each line pays its highest win and line wins add up.' + (def.wildPays ? ' On a line with Sunseeds, the line pays the higher of the Sunseed run and the symbol run.' : '')
        : 'Pays are per ' + unitText(def) + ': for each symbol, count the reels from the first that show it or a Molten Core; ways = the matching positions multiplied together.',
    ),
  );
  if (def.eval === 'lines') {
    page.append(h('h4', '', def.lines.length + ' lines'));
    const lines = h('div', 'gh-lines');
    for (const line of def.lines) lines.append(lineSvg(line, accent));
    page.append(lines);
  }
  page.append(h('h4', '', 'Fair by construction'));
  page.append(
    h(
      'p',
      '',
      'Every spin picks one stop on each reel, each stop equally likely. What you see is exactly what was drawn: no hidden reels, no weighting and no staged near misses. ' +
        (mode === 'remote' ? 'Online, the server draws every spin with a cryptographic random source.' : 'Here your device draws every spin with its cryptographic random source.'),
    ),
  );
  page.append(h('p', 'muted', PLAY_MONEY));
  return page;
};

/** Tabs for the three machines over their pages. */
export const paytable = (start: MachineIdx, betOf: (m: MachineIdx) => number, mode: 'local' | 'remote', accent: string): HTMLDivElement => {
  const wrap = h('div');
  const tabs = h('div', 'gh-row');
  const holder = h('div');
  const show = (m: MachineIdx): void => {
    tabs.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(i === m)));
    holder.replaceChildren(paytablePage(m, betOf(m), mode, accent));
  };
  SHORT_NAMES.forEach((name, i) => {
    const b = button('gh-opt', name);
    b.addEventListener('click', () => show(i as MachineIdx));
    tabs.append(b);
  });
  wrap.append(tabs, holder);
  show(start);
  return wrap;
};
