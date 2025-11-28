import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import toIco from 'png-to-ico';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const desktopRoot = path.resolve(__dirname, '..');
const resourcesDir = path.resolve(desktopRoot, 'resources');

// Icon paths - main app icon (D logo)
const iconPngPath = path.resolve(resourcesDir, 'icon.png');
const iconIcoPath = path.resolve(resourcesDir, 'icon.ico');

// Tray icon paths - microphone based (Discord-style)
const trayIdlePngPath = path.resolve(resourcesDir, 'tray-idle.png');
const trayIdleIcoPath = path.resolve(resourcesDir, 'tray-idle.ico');
const trayConnectedPngPath = path.resolve(resourcesDir, 'tray-connected.png');
const trayConnectedIcoPath = path.resolve(resourcesDir, 'tray-connected.ico');
const traySpeakingPngPath = path.resolve(resourcesDir, 'tray-speaking.png');
const traySpeakingIcoPath = path.resolve(resourcesDir, 'tray-speaking.ico');
const trayMutedPngPath = path.resolve(resourcesDir, 'tray-muted.png');
const trayMutedIcoPath = path.resolve(resourcesDir, 'tray-muted.ico');

// Legacy paths for backward compatibility
const iconSpeakingPngPath = path.resolve(resourcesDir, 'icon-speaking.png');
const iconSpeakingIcoPath = path.resolve(resourcesDir, 'icon-speaking.ico');

// Colors
const BRAND_PRIMARY = { r: 0x7f, g: 0x5a, b: 0xf0 };
const BRAND_ACCENT = { r: 0x55, g: 0xc2, b: 0xf6 };
const COLOR_WHITE = { r: 255, g: 255, b: 255 };
const COLOR_GRAY = { r: 156, g: 163, b: 175 };    // Idle - neutral gray
const COLOR_GREEN = { r: 34, g: 197, b: 94 };     // Connected/speaking - online green
const COLOR_RED = { r: 239, g: 68, b: 68 };       // Muted - warning red

function lerp(start, end, t) {
  return start + (end - start) * t;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// ============================================
// ANTI-ALIASED DRAWING PRIMITIVES
// ============================================

// Get/set pixel with bounds checking
function getPixel(png, x, y) {
  if (x < 0 || x >= png.width || y < 0 || y >= png.height) return { r: 0, g: 0, b: 0, a: 0 };
  const idx = (png.width * y + x) << 2;
  return {
    r: png.data[idx],
    g: png.data[idx + 1],
    b: png.data[idx + 2],
    a: png.data[idx + 3]
  };
}

function setPixelRaw(png, x, y, r, g, b, a) {
  if (x < 0 || x >= png.width || y < 0 || y >= png.height) return;
  const idx = (png.width * y + x) << 2;
  png.data[idx] = r;
  png.data[idx + 1] = g;
  png.data[idx + 2] = b;
  png.data[idx + 3] = a;
}

// Alpha-blend a color onto existing pixel
function blendPixel(png, x, y, color, alpha) {
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || x >= png.width || y < 0 || y >= png.height) return;
  if (alpha <= 0) return;
  
  alpha = clamp(alpha, 0, 255);
  const idx = (png.width * y + x) << 2;
  
  const srcA = alpha / 255;
  const dstA = png.data[idx + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  
  if (outA > 0) {
    png.data[idx] = Math.round((color.r * srcA + png.data[idx] * dstA * (1 - srcA)) / outA);
    png.data[idx + 1] = Math.round((color.g * srcA + png.data[idx + 1] * dstA * (1 - srcA)) / outA);
    png.data[idx + 2] = Math.round((color.b * srcA + png.data[idx + 2] * dstA * (1 - srcA)) / outA);
    png.data[idx + 3] = Math.round(outA * 255);
  }
}

// Anti-aliased filled circle using supersampling
function drawFilledCircleAA(png, cx, cy, radius, color) {
  const samples = 4; // 4x4 supersampling
  const r2 = radius * radius;
  
  for (let py = Math.floor(cy - radius - 1); py <= Math.ceil(cy + radius + 1); py++) {
    for (let px = Math.floor(cx - radius - 1); px <= Math.ceil(cx + radius + 1); px++) {
      let coverage = 0;
      
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const sampleX = px + (sx + 0.5) / samples;
          const sampleY = py + (sy + 0.5) / samples;
          const dx = sampleX - cx;
          const dy = sampleY - cy;
          if (dx * dx + dy * dy <= r2) {
            coverage++;
          }
        }
      }
      
      if (coverage > 0) {
        const alpha = Math.round((coverage / (samples * samples)) * 255);
        blendPixel(png, px, py, color, alpha);
      }
    }
  }
}

// Anti-aliased ring (hollow circle) using supersampling
function drawRingAA(png, cx, cy, outerRadius, innerRadius, color) {
  const samples = 4;
  const outer2 = outerRadius * outerRadius;
  const inner2 = innerRadius * innerRadius;
  
  for (let py = Math.floor(cy - outerRadius - 1); py <= Math.ceil(cy + outerRadius + 1); py++) {
    for (let px = Math.floor(cx - outerRadius - 1); px <= Math.ceil(cx + outerRadius + 1); px++) {
      let coverage = 0;
      
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const sampleX = px + (sx + 0.5) / samples;
          const sampleY = py + (sy + 0.5) / samples;
          const dx = sampleX - cx;
          const dy = sampleY - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 <= outer2 && d2 >= inner2) {
            coverage++;
          }
        }
      }
      
      if (coverage > 0) {
        const alpha = Math.round((coverage / (samples * samples)) * 255);
        blendPixel(png, px, py, color, alpha);
      }
    }
  }
}

// Anti-aliased rounded rectangle
function drawRoundedRectAA(png, x, y, width, height, radius, color) {
  const samples = 4;
  
  for (let py = Math.floor(y - 1); py <= Math.ceil(y + height + 1); py++) {
    for (let px = Math.floor(x - 1); px <= Math.ceil(x + width + 1); px++) {
      let coverage = 0;
      
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const sampleX = px + (sx + 0.5) / samples;
          const sampleY = py + (sy + 0.5) / samples;
          
          // Check if point is inside rounded rect
          const inX = sampleX >= x && sampleX <= x + width;
          const inY = sampleY >= y && sampleY <= y + height;
          
          if (inX && inY) {
            // Check corners
            let inside = true;
            
            // Top-left corner
            if (sampleX < x + radius && sampleY < y + radius) {
              const dx = sampleX - (x + radius);
              const dy = sampleY - (y + radius);
              inside = dx * dx + dy * dy <= radius * radius;
            }
            // Top-right corner
            else if (sampleX > x + width - radius && sampleY < y + radius) {
              const dx = sampleX - (x + width - radius);
              const dy = sampleY - (y + radius);
              inside = dx * dx + dy * dy <= radius * radius;
            }
            // Bottom-left corner
            else if (sampleX < x + radius && sampleY > y + height - radius) {
              const dx = sampleX - (x + radius);
              const dy = sampleY - (y + height - radius);
              inside = dx * dx + dy * dy <= radius * radius;
            }
            // Bottom-right corner
            else if (sampleX > x + width - radius && sampleY > y + height - radius) {
              const dx = sampleX - (x + width - radius);
              const dy = sampleY - (y + height - radius);
              inside = dx * dx + dy * dy <= radius * radius;
            }
            
            if (inside) coverage++;
          }
        }
      }
      
      if (coverage > 0) {
        const alpha = Math.round((coverage / (samples * samples)) * 255);
        blendPixel(png, px, py, color, alpha);
      }
    }
  }
}

// Anti-aliased line with thickness
function drawLineAA(png, x1, y1, x2, y2, thickness, color) {
  const samples = 4;
  const halfThick = thickness / 2;
  
  // Bounding box
  const minX = Math.floor(Math.min(x1, x2) - halfThick - 1);
  const maxX = Math.ceil(Math.max(x1, x2) + halfThick + 1);
  const minY = Math.floor(Math.min(y1, y2) - halfThick - 1);
  const maxY = Math.ceil(Math.max(y1, y2) + halfThick + 1);
  
  // Line direction and length
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return;
  
  const nx = dx / len;
  const ny = dy / len;
  
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      let coverage = 0;
      
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const sampleX = px + (sx + 0.5) / samples;
          const sampleY = py + (sy + 0.5) / samples;
          
          // Project point onto line
          const t = clamp(((sampleX - x1) * nx + (sampleY - y1) * ny) / len, 0, 1);
          const closestX = x1 + t * dx;
          const closestY = y1 + t * dy;
          
          const distX = sampleX - closestX;
          const distY = sampleY - closestY;
          const dist = Math.sqrt(distX * distX + distY * distY);
          
          if (dist <= halfThick) {
            coverage++;
          }
        }
      }
      
      if (coverage > 0) {
        const alpha = Math.round((coverage / (samples * samples)) * 255);
        blendPixel(png, px, py, color, alpha);
      }
    }
  }
}

// ============================================
// APP ICON DRAWING (D monogram)
// ============================================

function drawCircularGradient(png, options = {}) {
  const size = png.width;
  const center = size / 2;
  const radius = size * (options.radiusRatio ?? 0.46);
  const innerColor = options.innerColor ?? BRAND_ACCENT;
  const outerColor = options.outerColor ?? BRAND_PRIMARY;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const dx = px - center + 0.5;
      const dy = py - center + 0.5;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > radius) continue;

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
  const ringColor = options.color ?? COLOR_WHITE;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const dx = px - center + 0.5;
      const dy = py - center + 0.5;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < radius - thickness || distance > radius + thickness) continue;

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

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
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

  const innerRadius = radius * 0.55;
  const cutoutStart = center - innerRadius * 0.35;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
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

function renderAppIcon(size, options = {}) {
  const png = new PNG({ width: size, height: size, colorType: 6 });
  png.data.fill(0);

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

// ============================================
// TRAY ICON DRAWING (Simple, clean microphone)
// ============================================

function drawMicrophone(png, color) {
  const size = png.width;
  const s = size / 16; // Scale factor (design based on 16px grid)
  const cx = size / 2;
  
  // Microphone head - pill shape (wider, cleaner)
  const headWidth = 6 * s;
  const headHeight = 8 * s;
  const headY = 1.5 * s;
  const headRadius = headWidth / 2;
  
  drawRoundedRectAA(png, cx - headWidth / 2, headY, headWidth, headHeight, headRadius, color);
  
  // Cradle/stand - U shape
  const cradleWidth = 8 * s;
  const cradleTop = headY + headHeight - 2 * s;
  const cradleBottom = headY + headHeight + 2 * s;
  const cradleThickness = 1.2 * s;
  
  // Left side of U
  drawRoundedRectAA(png, cx - cradleWidth / 2, cradleTop, cradleThickness, cradleBottom - cradleTop + cradleThickness, cradleThickness / 2, color);
  // Right side of U
  drawRoundedRectAA(png, cx + cradleWidth / 2 - cradleThickness, cradleTop, cradleThickness, cradleBottom - cradleTop + cradleThickness, cradleThickness / 2, color);
  // Bottom of U
  drawRoundedRectAA(png, cx - cradleWidth / 2, cradleBottom, cradleWidth, cradleThickness, cradleThickness / 2, color);
  
  // Stem
  const stemTop = cradleBottom + cradleThickness - 0.5 * s;
  const stemBottom = 13 * s;
  const stemWidth = 1.5 * s;
  
  drawRoundedRectAA(png, cx - stemWidth / 2, stemTop, stemWidth, stemBottom - stemTop, stemWidth / 2, color);
  
  // Base
  const baseWidth = 5 * s;
  const baseHeight = 1.5 * s;
  const baseY = stemBottom - 0.5 * s;
  
  drawRoundedRectAA(png, cx - baseWidth / 2, baseY, baseWidth, baseHeight, baseHeight / 2, color);
}

function drawSpeakingIndicator(png, color) {
  const size = png.width;
  const cx = size / 2;
  const cy = size / 2;
  const s = size / 16;
  
  // Draw a ring around the icon
  const outerRadius = 7.5 * s;
  const innerRadius = 6.2 * s;
  
  drawRingAA(png, cx, cy, outerRadius, innerRadius, color);
}

function drawMuteSlash(png, color) {
  const size = png.width;
  const s = size / 16;
  const thickness = 1.8 * s;
  
  // Diagonal line from top-right to bottom-left
  const margin = 2 * s;
  drawLineAA(png, size - margin, margin, margin, size - margin, thickness, color);
}

function drawMuteCircle(png, color) {
  const size = png.width;
  const cx = size / 2;
  const cy = size / 2;
  const s = size / 16;
  
  // Draw ring
  const outerRadius = 7.5 * s;
  const innerRadius = 6 * s;
  
  drawRingAA(png, cx, cy, outerRadius, innerRadius, color);
}

function renderTrayIcon(size, state = 'idle') {
  const png = new PNG({ width: size, height: size, colorType: 6 });
  png.data.fill(0);
  
  switch (state) {
    case 'idle':
      // Gray microphone - not connected (inactive)
      drawMicrophone(png, COLOR_GRAY);
      break;
      
    case 'connected':
      // Green microphone - connected/online, not speaking
      drawMicrophone(png, COLOR_GREEN);
      break;
      
    case 'speaking':
      // Green ring first (behind) - speaking indicator
      drawSpeakingIndicator(png, COLOR_GREEN);
      // Green microphone on top
      drawMicrophone(png, COLOR_GREEN);
      break;
      
    case 'muted':
      // Gray microphone (inactive appearance)
      drawMicrophone(png, COLOR_GRAY);
      // Red circle and slash - warning/blocked
      drawMuteCircle(png, COLOR_RED);
      drawMuteSlash(png, COLOR_RED);
      break;
  }
  
  return PNG.sync.write(png);
}

// ============================================
// MAIN GENERATION
// ============================================

(async () => {
  // For tray icons, focus on small sizes that Windows actually uses
  // Windows tray: 16, 20, 24, 32 (scaled based on DPI)
  const trayIcoSizes = [16, 20, 24, 32, 48, 64];
  const appIcoSizes = [16, 24, 32, 48, 64, 128, 256];
  const primarySize = 256; // Smaller primary for tray, larger for app

  // Generate main app icon (D monogram)
  console.log('[desktop] Generating app icons...');
  const appIconPng = renderAppIcon(512, { ringColor: COLOR_WHITE });
  await writeFile(iconPngPath, appIconPng);
  
  const appIcoBuffers = appIcoSizes.map((s) => renderAppIcon(s, { ringColor: COLOR_WHITE }));
  const appIcoBuffer = await toIco(appIcoBuffers);
  await writeFile(iconIcoPath, appIcoBuffer);

  // Generate legacy speaking icon (for backward compat)
  const speakingPng = renderTrayIcon(primarySize, 'speaking');
  await writeFile(iconSpeakingPngPath, speakingPng);
  const speakingIcoBuffers = trayIcoSizes.map((s) => renderTrayIcon(s, 'speaking'));
  const speakingIcoBuffer = await toIco(speakingIcoBuffers);
  await writeFile(iconSpeakingIcoPath, speakingIcoBuffer);

  // Generate tray icons for each state
  const states = ['idle', 'connected', 'speaking', 'muted'];
  const trayPaths = {
    idle: { png: trayIdlePngPath, ico: trayIdleIcoPath },
    connected: { png: trayConnectedPngPath, ico: trayConnectedIcoPath },
    speaking: { png: traySpeakingPngPath, ico: traySpeakingIcoPath },
    muted: { png: trayMutedPngPath, ico: trayMutedIcoPath },
  };

  console.log('[desktop] Generating tray icons (microphone style with AA)...');
  for (const state of states) {
    // PNG at higher res for preview
    const pngBuffer = renderTrayIcon(primarySize, state);
    await writeFile(trayPaths[state].png, pngBuffer);
    
    // ICO with proper small sizes for Windows tray
    const icoBuffers = trayIcoSizes.map((s) => renderTrayIcon(s, state));
    const icoBuffer = await toIco(icoBuffers);
    await writeFile(trayPaths[state].ico, icoBuffer);
    
    console.log(`  - tray-${state}.png/ico`);
  }

  console.log('[desktop] Icon generation complete!');
})();
