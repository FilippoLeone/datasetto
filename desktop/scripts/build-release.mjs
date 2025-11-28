#!/usr/bin/env node
/**
 * Build Release Script
 * Builds Datasetto desktop app for multiple platforms
 * 
 * Usage:
 *   node scripts/build-release.mjs [--platform <win|mac|linux|all>] [--arch <x64|arm64|all>]
 * 
 * Examples:
 *   node scripts/build-release.mjs --platform win
 *   node scripts/build-release.mjs --platform linux --arch arm64
 *   node scripts/build-release.mjs --platform all
 */

import { spawn, execSync } from 'node:child_process';
import { cp, mkdir, rm, stat, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, '..');
const releaseDir = path.resolve(desktopRoot, 'release');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    platform: 'current', // win, mac, linux, all, or current
    arch: 'current',     // x64, arm64, all, or current
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--platform' && args[i + 1]) {
      result.platform = args[++i];
    } else if (args[i] === '--arch' && args[i + 1]) {
      result.arch = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Build Release Script for Datasetto Desktop

Usage:
  node scripts/build-release.mjs [options]

Options:
  --platform <platform>  Target platform: win, mac, linux, all, current (default: current)
  --arch <arch>          Target architecture: x64, arm64, all, current (default: current)
  --help, -h             Show this help message

Examples:
  node scripts/build-release.mjs                        # Build for current platform
  node scripts/build-release.mjs --platform win         # Build Windows x64
  node scripts/build-release.mjs --platform linux       # Build Linux x64
  node scripts/build-release.mjs --platform all         # Build all platforms (requires cross-compile support)

Notes:
  - Building for Windows on Linux/ARM requires Wine and appropriate build tools
  - Cross-compilation may not work on all host platforms
  - For production builds, consider using CI/CD (GitHub Actions)
`);
      process.exit(0);
    }
  }

  return result;
}

function getCurrentPlatform() {
  const platform = os.platform();
  if (platform === 'win32') return 'win';
  if (platform === 'darwin') return 'mac';
  return 'linux';
}

function getCurrentArch() {
  const arch = os.arch();
  if (arch === 'arm64') return 'arm64';
  return 'x64';
}

function getPlatformTargets(platform) {
  const targets = {
    win: ['--win'],
    mac: ['--mac'],
    linux: ['--linux'],
  };
  
  if (platform === 'all') {
    return ['--win', '--mac', '--linux'];
  }
  if (platform === 'current') {
    return targets[getCurrentPlatform()] || ['--linux'];
  }
  return targets[platform] || [];
}

function getArchTargets(arch) {
  if (arch === 'all') {
    return ['--x64', '--arm64'];
  }
  if (arch === 'current') {
    return [`--${getCurrentArch()}`];
  }
  return [`--${arch}`];
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\n📦 Running: ${command} ${args.join(' ')}\n`);
    
    const proc = spawn(command, args, {
      cwd: options.cwd || desktopRoot,
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, ...options.env },
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function buildClient() {
  console.log('\n🔨 Building client...\n');
  const clientRoot = path.resolve(desktopRoot, '..', 'client');
  
  await runCommand('npm', ['run', 'build'], { 
    cwd: clientRoot,
    env: { VITE_BUILD_TARGET: 'desktop' },
  });
}

async function prepareRenderer() {
  console.log('\n📋 Preparing renderer...\n');
  await runCommand('node', ['./scripts/copy-dist.mjs']);
}

async function generateIcons() {
  console.log('\n🎨 Generating icons...\n');
  await runCommand('node', ['./scripts/generate-icon.mjs']);
}

async function cleanRelease() {
  console.log('\n🧹 Cleaning release directory...\n');
  await runCommand('node', ['./scripts/clean-release.mjs']);
}

async function buildElectron(platformArgs, archArgs) {
  console.log('\n⚡ Building Electron app...\n');
  
  const args = ['electron-builder', ...platformArgs, ...archArgs];
  
  // Check if we need Wine for Windows builds on non-Windows
  const hostPlatform = getCurrentPlatform();
  if (platformArgs.includes('--win') && hostPlatform !== 'win') {
    console.log('⚠️  Building Windows on non-Windows platform - Wine may be required');
  }
  
  await runCommand('npx', args);
}

async function generateBuildManifest() {
  console.log('\n📝 Generating build manifest...\n');
  
  const files = await readdir(releaseDir);
  const builds = [];
  
  // Read package.json for version
  const pkgPath = path.resolve(desktopRoot, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
  
  for (const file of files) {
    const filePath = path.resolve(releaseDir, file);
    const fileStat = await stat(filePath);
    
    // Skip directories and non-distributable files
    if (fileStat.isDirectory()) continue;
    if (file.endsWith('.blockmap')) continue;
    if (file.endsWith('.yml') || file.endsWith('.yaml')) continue;
    if (file === 'builds.json') continue;
    
    // Determine platform and arch from filename
    let platform = 'unknown';
    let arch = 'x64';
    let type = 'unknown';
    
    if (file.includes('-win-')) {
      platform = 'windows';
    } else if (file.includes('-mac-') || file.includes('.dmg')) {
      platform = 'macos';
    } else if (file.includes('-linux-') || file.endsWith('.AppImage') || file.endsWith('.deb')) {
      platform = 'linux';
    }
    
    if (file.includes('-arm64') || file.includes('arm64')) {
      arch = 'arm64';
    } else if (file.includes('-x64') || file.includes('x64')) {
      arch = 'x64';
    }
    
    // Determine installer type
    if (file.endsWith('.exe') && !file.includes('portable')) {
      type = 'installer';
    } else if (file.includes('portable') && file.endsWith('.exe')) {
      type = 'portable';
    } else if (file.endsWith('.dmg')) {
      type = 'dmg';
    } else if (file.endsWith('.AppImage')) {
      type = 'appimage';
    } else if (file.endsWith('.deb')) {
      type = 'deb';
    } else if (file.endsWith('.zip')) {
      type = 'zip';
    }
    
    builds.push({
      filename: file,
      platform,
      arch,
      type,
      size: fileStat.size,
      sizeFormatted: formatBytes(fileStat.size),
      createdAt: fileStat.mtime.toISOString(),
    });
  }
  
  const manifest = {
    version: pkg.version,
    buildDate: new Date().toISOString(),
    builds,
  };
  
  await writeFile(
    path.resolve(releaseDir, 'builds.json'),
    JSON.stringify(manifest, null, 2)
  );
  
  console.log(`✅ Generated manifest with ${builds.length} builds`);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function main() {
  const args = parseArgs();
  
  console.log('🚀 Datasetto Desktop Build Script');
  console.log('==================================');
  console.log(`Host Platform: ${getCurrentPlatform()}`);
  console.log(`Host Arch: ${getCurrentArch()}`);
  console.log(`Target Platform: ${args.platform}`);
  console.log(`Target Arch: ${args.arch}`);
  console.log('');
  
  try {
    // Step 1: Build client
    await buildClient();
    
    // Step 2: Prepare renderer
    await prepareRenderer();
    
    // Step 3: Generate icons
    await generateIcons();
    
    // Step 4: Clean release directory
    await cleanRelease();
    
    // Step 5: Build Electron for each target
    const platformArgs = getPlatformTargets(args.platform);
    const archArgs = getArchTargets(args.arch);
    
    await buildElectron(platformArgs, archArgs);
    
    // Step 6: Generate build manifest
    await generateBuildManifest();
    
    console.log('\n✅ Build completed successfully!');
    console.log(`📁 Artifacts available in: ${releaseDir}`);
    
  } catch (error) {
    console.error('\n❌ Build failed:', error.message);
    process.exit(1);
  }
}

main();
