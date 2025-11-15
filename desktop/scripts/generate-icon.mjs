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

function drawCircularGradient(png, options = {}) {
  const size = png.width;
  const center = size / 2;
  const radius = size * (options.radiusRatio ?? 0.46);
  const innerColor = options.innerColor ?? BRAND_ACCENT;
  const outerColor = options.outerColor ?? BRAND_PRIMARY;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const dx = px - center + 0.5;
      const dy = py - center + 0.5;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > radius) {
        continue;
      }

      const t = distance / radius;
      const idx = (size * py + px) << 2;
      png.data[idx] = Math.round(lerp(innerColor.r, outerColor.r, t));
      png.data[idx + 1] = Math.round(lerp(innerColor.g, outerColor.g, t));
      png.data[idx + 2] = Math.round(lerp(innerColor.b, outerColor.b, t));
      png.data[idx + 3] = 255;
    }
  }
}

function drawHighlightRing(png, options = {}) {
  const size = png.width;
  const center = size / 2;
  const radius = size * (options.radiusRatio ?? 0.46);
  const thickness = size * (options.thicknessRatio ?? 0.03);
  const ringColor = options.color ?? { r: 255, g: 255, b: 255 };

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const dx = px - center + 0.5;
      const dy = py - center + 0.5;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < radius - thickness || distance > radius + thickness) {
        continue;
      }

      const falloff = 1 - Math.abs(distance - radius) / thickness;
      const idx = (size * py + px) << 2;
      const alpha = Math.max(png.data[idx + 3], Math.round(200 * falloff));
      png.data[idx] = Math.round(lerp(png.data[idx] || 0, ringColor.r, 0.65));
      png.data[idx + 1] = Math.round(lerp(png.data[idx + 1] || 0, ringColor.g, 0.65));
      png.data[idx + 2] = Math.round(lerp(png.data[idx + 2] || 0, ringColor.b, 0.65));
      png.data[idx + 3] = alpha;
    }
  }
}

function drawMonogram(png, options = {}) {
  const size = png.width;
  const center = size / 2;
  const radius = size * (options.radiusRatio ?? 0.26);

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

function drawOuterAura(png, options = {}) {
  if (!options.enabled) {
    return;
  }

  const size = png.width;
  const center = size / 2;
  const baseRadius = size * (options.baseRadiusRatio ?? 0.46);
  const auraRadius = baseRadius * (options.radiusMultiplier ?? 1.9);
  const auraColor = options.color ?? { r: 74, g: 222, b: 128 };
  const intensity = options.intensity ?? 1;
  const falloffRange = auraRadius - baseRadius;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const dx = px - center + 0.5;
      const dy = py - center + 0.5;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < baseRadius || distance > auraRadius) {
        continue;
      }

      const falloff = 1 - (distance - baseRadius) / falloffRange;
      if (falloff <= 0) {
        continue;
      }

      const idx = (size * py + px) << 2;
      const alpha = Math.max(png.data[idx + 3], Math.round(255 * falloff * intensity * 0.6));
      png.data[idx] = Math.round(lerp(png.data[idx] || 0, auraColor.r, falloff * 0.9));
      png.data[idx + 1] = Math.round(lerp(png.data[idx + 1] || 0, auraColor.g, falloff * 0.9));
      png.data[idx + 2] = Math.round(lerp(png.data[idx + 2] || 0, auraColor.b, falloff * 0.9));
      png.data[idx + 3] = alpha;
    }
  }
}

(async () => {
  const size = 512;
  function renderIcon(size, options = {}) {
    const png = new PNG({ width: size, height: size, colorType: 6 });
    png.data.fill(0);

    drawOuterAura(png, {
      enabled: Boolean(options.aura),
      baseRadiusRatio: options.radiusRatio ?? 0.46,
      radiusMultiplier: options.aura?.radiusMultiplier,
      color: options.aura?.color,
      intensity: options.aura?.intensity,
    });

    drawCircularGradient(png, {
      radiusRatio: options.radiusRatio ?? 0.46,
      innerColor: options.innerColor,
      outerColor: options.outerColor,
    });
    drawHighlightRing(png, {
      radiusRatio: options.radiusRatio ?? 0.46,
      thicknessRatio: options.ringThicknessRatio ?? 0.02,
      color: options.ringColor,
    });
    drawMonogram(png, { radiusRatio: options.monogramRadiusRatio ?? 0.26 });

    return PNG.sync.write(png);
  }

  const primarySize = 512;
  const primaryPngBuffer = renderIcon(primarySize, {
    ringColor: { r: 255, g: 255, b: 255 },
  });
  const speakingPngBuffer = renderIcon(primarySize, {
    ringColor: { r: 255, g: 255, b: 255 },
    aura: {
      enabled: true,
      color: { r: 74, g: 222, b: 128 },
      intensity: 1,
      radiusMultiplier: 2.05,
    },
  });
  await writeFile(iconPngPath, primaryPngBuffer);
  await writeFile(iconSpeakingPngPath, speakingPngBuffer);

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoBuffers = icoSizes.map((size) => renderIcon(size, {
    ringColor: { r: 255, g: 255, b: 255 },
  }));
  const icoSpeakingBuffers = icoSizes.map((size) => renderIcon(size, {
    ringColor: { r: 255, g: 255, b: 255 },
    aura: {
      enabled: true,
      color: { r: 74, g: 222, b: 128 },
      intensity: 1,
      radiusMultiplier: 2.05,
    },
  }));
  const icoBuffer = await toIco(icoBuffers);
  const icoSpeakingBuffer = await toIco(icoSpeakingBuffers);
  await writeFile(iconIcoPath, icoBuffer);
  await writeFile(iconSpeakingIcoPath, icoSpeakingBuffer);

  console.log('[desktop] Generated icon assets (default + speaking variants)');
})();
