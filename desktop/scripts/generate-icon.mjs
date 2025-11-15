import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import toIco from 'png-to-ico';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const desktopRoot = path.resolve(__dirname, '..');
const resourcesDir = path.resolve(desktopRoot, 'resources');
const iconPngPath = path.resolve(resourcesDir, 'icon.png');
const iconIcoPath = path.resolve(resourcesDir, 'icon.ico');
const iconSpeakingPngPath = path.resolve(resourcesDir, 'icon-speaking.png');
const iconSpeakingIcoPath = path.resolve(resourcesDir, 'icon-speaking.ico');

const BRAND_PRIMARY = { r: 0x7f, g: 0x5a, b: 0xf0 }; // Matches client brand gradient
const BRAND_ACCENT = { r: 0x55, g: 0xc2, b: 0xf6 };

function lerp(start, end, t) {
  return start + (end - start) * t;
}

function createGradientPixel(x, y, size) {
  const t = y / (size - 1);
  return {
    r: Math.round(lerp(BRAND_PRIMARY.r, BRAND_ACCENT.r, t)),
    g: Math.round(lerp(BRAND_PRIMARY.g, BRAND_ACCENT.g, t)),
    b: Math.round(lerp(BRAND_PRIMARY.b, BRAND_ACCENT.b, t)),
  };
}

function drawMonogram(png) {
  const size = png.width;
  const center = size / 2;
  const radius = size * 0.32;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const dx = px - center + 0.5;
      const dy = py - center + 0.5;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance <= radius) {
        const idx = (size * py + px) << 2;
        png.data[idx] = 255;
        png.data[idx + 1] = 255;
        png.data[idx + 2] = 255;
        png.data[idx + 3] = 255;
      }
    }
  }

  // Hollow out the middle to form a "D"
  const innerRadius = radius * 0.55;
  const cutoutStart = center - innerRadius * 0.35;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const dx = px - center + 0.5;
      const dy = py - center + 0.5;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const insideInnerCircle = distance <= innerRadius;
      const inLeftBlock = px < cutoutStart;
      if (insideInnerCircle && !inLeftBlock) {
        const idx = (size * py + px) << 2;
        png.data[idx + 3] = 0;
      }
    }
  }
}

function applyGlow(png, intensity = 0.45) {
  const size = png.width;
  const center = size / 2;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const dx = px - center + 0.5;
      const dy = py - center + 0.5;
      const distance = Math.sqrt(dx * dx + dy * dy) / (size / 2);
      const falloff = Math.max(0, 1 - distance);
      if (falloff <= 0) {
        continue;
      }

      const boost = falloff * intensity * 80;
      const idx = (size * py + px) << 2;
      png.data[idx] = Math.min(255, png.data[idx] + boost);
      png.data[idx + 1] = Math.min(255, png.data[idx + 1] + boost * 0.9);
      png.data[idx + 2] = Math.min(255, png.data[idx + 2] + boost * 0.5);
    }
  }
}

(async () => {
  const size = 512;
  function renderIcon(size, options = { glow: false }) {
    const png = new PNG({ width: size, height: size, colorType: 6 });

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const idx = (size * y + x) << 2;
        const { r, g, b } = createGradientPixel(x, y, size);
        png.data[idx] = r;
        png.data[idx + 1] = g;
        png.data[idx + 2] = b;
        png.data[idx + 3] = 255;
      }
    }

    if (options.glow) {
      applyGlow(png, options.glowIntensity ?? 0.55);
    }

    drawMonogram(png);
    return PNG.sync.write(png);
  }

  const primarySize = 512;
  const primaryPngBuffer = renderIcon(primarySize);
  const speakingPngBuffer = renderIcon(primarySize, { glow: true, glowIntensity: 0.7 });
  await writeFile(iconPngPath, primaryPngBuffer);
  await writeFile(iconSpeakingPngPath, speakingPngBuffer);

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoBuffers = icoSizes.map((size) => renderIcon(size));
  const icoSpeakingBuffers = icoSizes.map((size) => renderIcon(size, { glow: true, glowIntensity: 0.7 }));
  const icoBuffer = await toIco(icoBuffers);
  const icoSpeakingBuffer = await toIco(icoSpeakingBuffers);
  await writeFile(iconIcoPath, icoBuffer);
  await writeFile(iconSpeakingIcoPath, icoSpeakingBuffer);

  console.log('[desktop] Generated icon assets (default + speaking variants)');
})();
