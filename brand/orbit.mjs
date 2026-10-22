// The Datasetto mark ("Orbit"): a planet with a tilted ring that passes in front of it.
// Every icon in the repository is drawn from the numbers in this file by generate.mjs.
//
// Geometry, in the units of a square canvas of `size`:
//   r          planet radius
//   rx, ry     ring ellipse semi-axes (centre line of the ring)
//   tilt       ring rotation in degrees (negative = rising to the right)
//   sw         ring thickness
//   gap        clear space between the ring and the planet
// The ring's front half crosses the planet; the planet is cut away around it, and the
// back half disappears behind the planet with the same clear space. All shapes are plain
// paths (circle and ellipse arcs), so they also work as Android vector drawables.

export const COLORS = {
  amber: '#FFAE3B', // planet, top left
  persimmon: '#FF6A3D', // planet, bottom right
  teal: '#12A89D', // ring
  night: '#17222B', // background for tiles, splash screens and the Android icon
  nightTop: '#22313D', // night gradient on tiles, top
  nightBottom: '#121B22', // night gradient on tiles, bottom
};

export const MASTER = { size: 256, r: 80, rx: 124, ry: 34, tilt: -33, sw: 16, gap: 9 };

// Small sizes, tuned so the ring stays a clean line: thicker ring and gap than a plain scale-down.
export const TUNED = {
  20: { size: 20, r: 6.25, rx: 9.6, ry: 2.85, tilt: -31, sw: 1.45, gap: 0.95 },
  24: { size: 24, r: 7.5, rx: 11.55, ry: 3.35, tilt: -32, sw: 1.65, gap: 1.15 },
  32: { size: 32, r: 10, rx: 15.4, ry: 4.4, tilt: -33, sw: 2.0, gap: 1.45 },
};

// 16 px is drawn by hand. Legend: A/M/O planet amber, mid, persimmon; T ring teal.
// Lower case is ~70% opacity, digits 1/2/3/4 are ~35% of amber/mid/persimmon/teal.
export const PIXELS_16 = [
  '................',
  '................',
  '................',
  '.....1aAMm2.....',
  '....aAAMMMMo.Tt.',
  '...1AAMMMMOO..T.',
  '...aAMMMMOO..T..',
  '...AMMMMO..TT...',
  '...MMMM..TT.....',
  '.4.mM..TT..Oo...',
  '.T...TT..OOO3...',
  '.tTTT..OOOOo....',
  '.....3oOOo3.....',
  '................',
  '................',
  '................',
];
const MID = '#FF8C3C';
export const PIXEL_PALETTE = {
  A: [COLORS.amber, 1], a: [COLORS.amber, 0.7], 1: [COLORS.amber, 0.35],
  M: [MID, 1], m: [MID, 0.7], 2: [MID, 0.35],
  O: [COLORS.persimmon, 1], o: [COLORS.persimmon, 0.7], 3: [COLORS.persimmon, 0.35],
  T: [COLORS.teal, 1], t: [COLORS.teal, 0.65], 4: [COLORS.teal, 0.35],
};

const n = (v) => String(Math.round(v * 1000) / 1000);
const P = ([x, y]) => `${n(x)} ${n(y)}`;

// Paths for one parameter set, centred on (cx, cy).
export function orbitPaths(p, cx = p.size / 2, cy = p.size / 2) {
  const th = (p.tilt * Math.PI) / 180;
  const u = [Math.cos(th), Math.sin(th)];
  const v = [-Math.sin(th), Math.cos(th)];
  const at = (a, b, t) => [cx + a * Math.cos(t) * u[0] + b * Math.sin(t) * v[0], cy + a * Math.cos(t) * u[1] + b * Math.sin(t) * v[1]];
  // Parameter t where the ellipse (a, b) meets the concentric circle of radius R (first quadrant).
  const meet = (a, b, R) => {
    if (!(b < R && R < a)) throw new Error(`ellipse ${a}x${b} does not cross radius ${R}`);
    return Math.acos(Math.sqrt((R * R - b * b) / (a * a - b * b)));
  };
  const angle = ([x, y]) => Math.atan2(y - cy, x - cx);
  const shortSweep = (from, to) => {
    let d = angle(to) - angle(from);
    while (d <= -Math.PI) d += 2 * Math.PI;
    while (d > Math.PI) d -= 2 * Math.PI;
    return d > 0 ? 1 : 0;
  };
  const tilt = n(p.tilt);
  const half = p.sw / 2;
  const cut = half + p.gap;

  // Ring: the band between two ellipses, minus its back half where it passes behind the planet.
  const [ao, bo, ai, bi, rc] = [p.rx + half, p.ry + half, p.rx - half, p.ry - half, p.r + p.gap];
  const to = meet(ao, bo, rc);
  const ti = meet(ai, bi, rc);
  const oL = at(ao, bo, Math.PI + to);
  const oR = at(ao, bo, 2 * Math.PI - to);
  const iR = at(ai, bi, 2 * Math.PI - ti);
  const iL = at(ai, bi, Math.PI + ti);
  const ring =
    `M${P(oL)}A${n(ao)} ${n(bo)} ${tilt} 1 0 ${P(oR)}` +
    `A${n(rc)} ${n(rc)} 0 0 ${shortSweep(oR, iR)} ${P(iR)}` +
    `A${n(ai)} ${n(bi)} ${tilt} 1 1 ${P(iL)}` +
    `A${n(rc)} ${n(rc)} 0 0 ${shortSweep(iL, oL)} ${P(oL)}Z`;

  // Planet above the ring's front half (bounded below by the inner clear-space ellipse).
  const [am, bm] = [p.rx - cut, p.ry - cut];
  const tm = meet(am, bm, p.r);
  const aL = at(am, bm, Math.PI - tm);
  const aR = at(am, bm, tm);
  const body = `M${P(aL)}A${n(p.r)} ${n(p.r)} 0 1 1 ${P(aR)}A${n(am)} ${n(bm)} ${tilt} 0 1 ${P(aL)}Z`;

  // The sliver of planet below the ring (bounded above by the outer clear-space ellipse).
  const [ap, bp] = [p.rx + cut, p.ry + cut];
  const tp = meet(ap, bp, p.r);
  const bL = at(ap, bp, Math.PI - tp);
  const bR = at(ap, bp, tp);
  const sliver = `M${P(bL)}A${n(ap)} ${n(bp)} ${tilt} 0 0 ${P(bR)}A${n(p.r)} ${n(p.r)} 0 0 1 ${P(bL)}Z`;

  // Planet gradient, amber at the top left to persimmon at the bottom right.
  const gradient = { x1: n(cx - 0.5 * p.r), y1: n(cy - 0.9 * p.r), x2: n(cx + 0.5 * p.r), y2: n(cy + 0.9 * p.r) };
  return { ring, body, sliver, gradient };
}

// A standalone SVG of the mark. mono: one colour for everything (or null for full colour).
// sliver: false leaves out the bit of planet below the ring (where the tray status dot goes).
export function markSvg(p = MASTER, { mono = null, id = 'dsto', sliver = true } = {}) {
  const g = orbitPaths(p);
  const s = n(p.size);
  const planet = mono ?? `url(#${id}-planet)`;
  const defs = mono
    ? ''
    : `<defs><linearGradient id="${id}-planet" gradientUnits="userSpaceOnUse" x1="${g.gradient.x1}" y1="${g.gradient.y1}" x2="${g.gradient.x2}" y2="${g.gradient.y2}">` +
      `<stop offset="0" stop-color="${COLORS.amber}"/><stop offset="1" stop-color="${COLORS.persimmon}"/></linearGradient></defs>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" width="${s}" height="${s}">` +
    defs +
    `<path fill="${planet}" d="${g.body}"/>${sliver ? `<path fill="${planet}" d="${g.sliver}"/>` : ''}` +
    `<path fill="${mono ?? COLORS.teal}" d="${g.ring}"/></svg>`
  );
}
