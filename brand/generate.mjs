// Writes every Datasetto icon, splash screen and logo file from brand/orbit.mjs.
//   cd brand && npm ci && node generate.mjs          (all outputs)
//   node generate.mjs --only desktop,web             (some of: brand, desktop, web, android, ios, client)
// Outputs are committed; builds use them as they are and never run this script.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { COLORS, MASTER, TUNED, PIXELS_16, PIXEL_PALETTE, orbitPaths, markSvg } from './orbit.mjs';

const BRAND = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(BRAND, '..');
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > 0 ? new Set(process.argv[onlyArg + 1].split(',')) : null;
const wants = (group) => !ONLY || ONLY.has(group);

const write = (rel, data) => {
  const file = path.join(ROOT, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  console.log('  ' + rel);
};

// ------------------------------------------------------------------ rendering helpers
const raster = (svg, width) => new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// The planet pixels below the ring in the 16 px map: every planet pixel outside the largest connected patch.
const sliverPixels16 = () => {
  const planet = (x, y) => /[AaMmOo123]/.test(PIXELS_16[y]?.[x] ?? '.');
  const seen = new Map();
  const patches = [];
  PIXELS_16.forEach((row, y) => [...row].forEach((_, x) => {
    if (!planet(x, y) || seen.has(`${x},${y}`)) return;
    const patch = [];
    const stack = [[x, y]];
    seen.set(`${x},${y}`, true);
    while (stack.length) {
      const [px, py] = stack.pop();
      patch.push(`${px},${py}`);
      for (const [nx, ny] of [[px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]]) {
        if (planet(nx, ny) && !seen.has(`${nx},${ny}`)) { seen.set(`${nx},${ny}`, true); stack.push([nx, ny]); }
      }
    }
    patches.push(patch);
  }));
  patches.sort((a, b) => b.length - a.length);
  return new Set(patches.slice(1).flat());
};

// The 16 px hand-drawn mark; mono replaces every colour and keeps the coverage.
const pixels16 = (mono = null, { sliver = true } = {}) => {
  const size = PIXELS_16.length;
  const buf = Buffer.alloc(size * size * 4);
  const skip = sliver ? new Set() : sliverPixels16();
  PIXELS_16.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === '.' || skip.has(`${x},${y}`)) return;
      const [hex, alpha] = PIXEL_PALETTE[ch];
      const [r, g, b] = hexRgb(mono ?? hex);
      buf.set([r, g, b, Math.round(alpha * 255)], (y * size + x) * 4);
    }),
  );
  return sharp(buf, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
};

// The bare mark at a pixel size, using the hand-tuned drawing where there is one.
const mark = async (size, mono = null, { sliver = true } = {}) => {
  if (size === 16) return pixels16(mono, { sliver });
  return raster(markSvg(TUNED[size] ?? MASTER, { mono, sliver }), size);
};

// Mark markup for nesting inside a larger SVG (box = position and size in that SVG's units).
const nested = (x, y, size, { mono = null, id } = {}) => {
  const inner = markSvg(MASTER, { mono, id }).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 256 256">${inner}</svg>`;
};

const nightGradient = (id) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${COLORS.nightTop}"/><stop offset="1" stop-color="${COLORS.nightBottom}"/></linearGradient>`;

// Square tile on the night background with the mark in the middle.
//   shape: 'square' (full bleed), 'rounded' (inset rounded square), 'circle', 'mac' (Big Sur grid with shadow)
const tileSvg = (canvas, { shape = 'square', markScale = 0.62, gradient = true } = {}) => {
  const c = canvas;
  const fill = gradient ? 'url(#night)' : COLORS.night;
  let bg;
  let inner = c; // size of the coloured shape
  if (shape === 'square') bg = `<rect width="${c}" height="${c}" fill="${fill}"/>`;
  if (shape === 'circle') { inner = c * (44 / 48); bg = `<circle cx="${c / 2}" cy="${c / 2}" r="${inner / 2}" fill="${fill}"/>`; }
  if (shape === 'rounded') {
    inner = c * (44 / 48);
    const o = (c - inner) / 2;
    bg = `<rect x="${o}" y="${o}" width="${inner}" height="${inner}" rx="${inner * 0.2}" fill="${fill}"/>`;
  }
  if (shape === 'mac') {
    inner = c * (824 / 1024);
    const o = (c - inner) / 2;
    bg = `<rect x="${o}" y="${o}" width="${inner}" height="${inner}" rx="${inner * 0.225}" fill="${fill}" filter="url(#shadow)"/>`;
  }
  const m = inner * markScale;
  const filter = shape === 'mac'
    ? `<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur in="SourceAlpha" stdDeviation="${c * 0.014}"/><feOffset dy="${c * 0.01}"/><feComponentTransfer><feFuncA type="linear" slope="0.4"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${c} ${c}"><defs>${nightGradient('night')}${filter}</defs>${bg}${nested((c - m) / 2, (c - m) / 2, m, { id: 'tile' })}</svg>`;
};

// Flat night background of any size with the mark centred (splash screens).
const splashSvg = (w, h, markSize) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${COLORS.night}"/>${nested((w - markSize) / 2, (h - markSize) / 2, markSize, { id: 'splash' })}</svg>`;

const opaque = (png) => sharp(png).flatten({ background: COLORS.night }).png().toBuffer();

// ------------------------------------------------------------------ tray states and overlay
const GREEN = '#23A559'; // the client's speaking / online colour
const RED = '#DA373C'; // the client's danger colour
const GREY = '#8E939B'; // idle: reads on light and dark taskbars

// Status badge in the bottom right corner: [cx, cy, radius, clear radius] per size.
const badgeAt = (s) =>
  ({ 16: [12.5, 12.5, 3.5, 4.6], 20: [15.5, 15.5, 4.5, 5.7], 24: [19, 19, 5, 6.5], 32: [25.5, 25.5, 6.5, 8.2] })[s] ??
  [s * 0.8, s * 0.8, s * 0.2, s * 0.2 + s * 0.055];

const badge = (s, kind) => {
  const [cx, cy, r, clear] = badgeAt(s);
  const k = r * 0.55;
  const slash = kind === 'muted'
    ? `<line x1="${cx - k}" y1="${cy + k}" x2="${cx + k}" y2="${cy - k}" stroke="#fff" stroke-width="${Math.max(1.3, s * 0.075)}" stroke-linecap="round"/>`
    : '';
  return {
    clear: raster(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}"><circle cx="${cx}" cy="${cy}" r="${clear}"/></svg>`, s),
    dot: raster(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}"><circle cx="${cx}" cy="${cy}" r="${r}" fill="${kind === 'muted' ? RED : GREEN}"/>${slash}</svg>`, s),
  };
};

// idle: grey mark (not in a voice channel); connected: the mark; speaking: + green dot; muted: + red dot with a slash.
const tray = async (state, s) => {
  if (state === 'idle' || state === 'connected') return mark(s, state === 'idle' ? GREY : null);
  const glyph = await mark(s, null, { sliver: false }); // the dot sits where the sliver of planet would be
  const b = badge(s, state);
  return sharp(glyph).composite([{ input: b.clear, blend: 'dest-out' }, { input: b.dot }]).png().toBuffer();
};

// Taskbar overlay while speaking (Windows draws it over the bottom right of the taskbar button).
const overlaySvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7.5" fill="#fff"/><circle cx="8" cy="8" r="6.5" fill="${GREEN}"/><rect x="4" y="6" width="2" height="4" rx="1" fill="#fff"/><rect x="7" y="4" width="2" height="8" rx="1" fill="#fff"/><rect x="10" y="6" width="2" height="4" rx="1" fill="#fff"/></svg>`;

// ------------------------------------------------------------------ containers
// Windows icon: 32-bit bitmaps up to 128 px (what every Windows API and NSIS read), PNG at 256 px.
const ico = async (pngs) => {
  const images = [];
  for (const png of await Promise.all(pngs)) {
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = info;
    if (w >= 256) { images.push({ w, h, data: png }); continue; }
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(w, 4);
    header.writeInt32LE(h * 2, 8); // colour rows + mask rows
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    const pixels = Buffer.alloc(w * h * 4);
    const maskRow = Math.ceil(w / 32) * 4;
    const mask = Buffer.alloc(maskRow * h); // all zero: the alpha channel decides
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = (y * w + x) * 4;
        const d = ((h - 1 - y) * w + x) * 4; // bottom-up, BGRA
        pixels[d] = data[s + 2]; pixels[d + 1] = data[s + 1]; pixels[d + 2] = data[s]; pixels[d + 3] = data[s + 3];
      }
    }
    images.push({ w, h, data: Buffer.concat([header, pixels, mask]) });
  }
  const dir = Buffer.alloc(6 + images.length * 16);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  images.forEach((img, i) => {
    const e = 6 + i * 16;
    dir[e] = img.w >= 256 ? 0 : img.w;
    dir[e + 1] = img.h >= 256 ? 0 : img.h;
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(img.data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += img.data.length;
  });
  return Buffer.concat([dir, ...images.map((img) => img.data)]);
};

// Apple icon container with PNG entries.
const icns = async (render) => {
  const types = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];
  const cache = new Map();
  const parts = [];
  for (const [type, size] of types) {
    if (!cache.has(size)) cache.set(size, await render(size));
    const png = cache.get(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    parts.push(head, png);
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
};

// ------------------------------------------------------------------ Android vector drawables
const vector = (dp, viewport, scale, offset, colour) => {
  const g = orbitPaths(MASTER);
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by brand/generate.mjs from brand/orbit.mjs. Do not edit by hand. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="${dp}dp"
    android:height="${dp}dp"
    android:viewportWidth="${viewport}"
    android:viewportHeight="${viewport}">
    <group
        android:scaleX="${scale}"
        android:scaleY="${scale}"
        android:translateX="${offset}"
        android:translateY="${offset}">
        <path android:fillColor="${colour}" android:pathData="${g.body}" />
        <path android:fillColor="${colour}" android:pathData="${g.sliver}" />
        <path android:fillColor="${colour}" android:pathData="${g.ring}" />
    </group>
</vector>
`;
};

// ------------------------------------------------------------------ outputs
async function brandFiles() {
  console.log('brand/');
  const pretty = (svg) => svg.replace(/></g, '>\n<') + '\n';
  write('brand/logo.svg', pretty(markSvg(MASTER)));
  write('brand/logo-mono.svg', pretty(markSvg(MASTER, { mono: '#000000' })));
  write('brand/logo-tile.svg', pretty(tileSvg(1024, { shape: 'square', markScale: 0.62 })));
  write('brand/logo-1024.png', await raster(markSvg(MASTER), 1024));
}

async function desktop() {
  console.log('desktop/resources/');
  const dir = 'desktop/resources';
  write(`${dir}/icon.png`, await raster(markSvg(MASTER), 1024));
  write(`${dir}/icon.ico`, await ico([16, 20, 24, 32, 40, 48, 64, 128, 256].map((s) => mark(s))));
  write(`${dir}/icon.icns`, await icns((s) => raster(tileSvg(1024, { shape: 'mac', markScale: 0.66 }), s)));
  write(`${dir}/icon-speaking.png`, raster(overlaySvg, 32));
  write(`${dir}/icon-speaking.ico`, await ico([16, 20, 24, 32].map((s) => raster(overlaySvg, s))));
  for (const state of ['idle', 'connected', 'speaking', 'muted']) {
    write(`${dir}/tray-${state}.png`, await tray(state, 32));
    write(`${dir}/tray-${state}.ico`, await ico([16, 20, 24, 32, 40, 48].map((s) => tray(state, s))));
  }
}

async function web() {
  console.log('client/public/');
  const dir = 'client/public';
  write(`${dir}/favicon.svg`, markSvg(MASTER).replace(' width="256" height="256"', '') + '\n');
  write(`${dir}/favicon.ico`, await ico([16, 32, 48].map((s) => mark(s))));
  // "any" icons: the bare mark with a little air around it.
  const padded = (s) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}">${nested(s * 0.04, s * 0.04, s * 0.92, { id: 'any' })}</svg>`;
  write(`${dir}/icon-192.png`, raster(padded(192), 192));
  write(`${dir}/icon-512.png`, raster(padded(512), 512));
  // Maskable: full-bleed night background, the mark inside the 80% safe circle.
  for (const s of [192, 512]) write(`${dir}/icon-maskable-${s}.png`, raster(tileSvg(s, { shape: 'square', markScale: 0.6 }), s));
  write(`${dir}/apple-touch-icon.png`, await opaque(raster(tileSvg(180, { shape: 'square', markScale: 0.66 }), 180)));
}

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const SPLASH = {
  'drawable': [480, 320],
  'drawable-land-mdpi': [480, 320], 'drawable-land-hdpi': [800, 480], 'drawable-land-xhdpi': [1280, 720],
  'drawable-land-xxhdpi': [1600, 960], 'drawable-land-xxxhdpi': [1920, 1280],
  'drawable-port-mdpi': [320, 480], 'drawable-port-hdpi': [480, 800], 'drawable-port-xhdpi': [720, 1280],
  'drawable-port-xxhdpi': [960, 1600], 'drawable-port-xxxhdpi': [1280, 1920],
};

async function android() {
  console.log('mobile/android/app/src/main/res/');
  const res = 'mobile/android/app/src/main/res';
  // The adaptive foreground: the mark in a 60dp box at the centre of the 108dp layer, inside the 66dp safe circle.
  const fg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">${nested(24, 24, 60, { id: 'fg' })}</svg>`;
  for (const [name, k] of Object.entries(DENSITIES)) {
    const launcher = 48 * k;
    write(`${res}/mipmap-${name}/ic_launcher.png`, raster(tileSvg(launcher, { shape: 'rounded', markScale: 0.68 }), launcher));
    write(`${res}/mipmap-${name}/ic_launcher_round.png`, raster(tileSvg(launcher, { shape: 'circle', markScale: 0.68 }), launcher));
    write(`${res}/mipmap-${name}/ic_launcher_foreground.png`, raster(fg, 108 * k));
  }
  write(`${res}/drawable/ic_launcher_monochrome.xml`, vector(108, 108, 60 / 256, 24, '#FFFFFFFF'));
  // Status bar icon for the voice notification: white on transparent, 1dp of air on each side.
  write(`${res}/drawable/ic_stat_datasetto.xml`, vector(24, 24, 22 / 256, 1, '#FFFFFFFF'));
  const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>
</adaptive-icon>
`;
  write(`${res}/mipmap-anydpi-v26/ic_launcher.xml`, adaptive);
  write(`${res}/mipmap-anydpi-v26/ic_launcher_round.xml`, adaptive);
  write(`${res}/values/ic_launcher_background.xml`, `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- Brand night: the adaptive icon background and the splash screen (brand/orbit.mjs). -->
    <color name="ic_launcher_background">${COLORS.night}</color>
</resources>
`);
  for (const [folder, [w, h]] of Object.entries(SPLASH)) {
    write(`${res}/${folder}/splash.png`, await opaque(raster(splashSvg(w, h, Math.round(Math.min(w, h) * 0.3)), w)));
  }
}

async function ios() {
  console.log('mobile/ios/App/App/Assets.xcassets/');
  const dir = 'mobile/ios/App/App/Assets.xcassets';
  write(`${dir}/AppIcon.appiconset/AppIcon-512@2x.png`, await opaque(raster(tileSvg(1024, { shape: 'square', markScale: 0.64 }), 1024)));
  const splash = await opaque(raster(splashSvg(2732, 2732, 520), 2732));
  for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) write(`${dir}/Splash.imageset/${name}`, splash);
}

async function client() {
  console.log('client/src/components/');
  const g = orbitPaths(MASTER);
  write('client/src/components/logoMark.ts', `// Generated by brand/generate.mjs from brand/orbit.mjs. Do not edit by hand.
export const LOGO_MARK = {
  viewBox: '0 0 256 256',
  body: '${g.body}',
  sliver: '${g.sliver}',
  ring: '${g.ring}',
  gradient: { x1: ${g.gradient.x1}, y1: ${g.gradient.y1}, x2: ${g.gradient.x2}, y2: ${g.gradient.y2} },
  colors: { planetFrom: '${COLORS.amber}', planetTo: '${COLORS.persimmon}', ring: '${COLORS.teal}' },
} as const;
`);
}

if (wants('brand')) await brandFiles();
if (wants('desktop')) await desktop();
if (wants('web')) await web();
if (wants('android')) await android();
if (wants('ios')) await ios();
if (wants('client')) await client();
console.log('done');
