/**
 * Releases API Service
 * Handles listing and serving desktop application releases
 */

import express from 'express';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default release directory (can be overridden via config)
const DEFAULT_RELEASE_DIR = path.resolve(__dirname, '../../../desktop/release');
const DESKTOP_DIR = path.resolve(__dirname, '../../../desktop');

// Build state tracking
let buildState = {
  isBuilding: false,
  currentPlatform: null,
  startedAt: null,
  logs: [],
};

export function createReleasesRouter(options = {}) {
  const router = express.Router();
  const releaseDir = options.releaseDir || DEFAULT_RELEASE_DIR;
  const desktopDir = options.desktopDir || DESKTOP_DIR;
  
  // Track download counts in memory (could be persisted to file/db)
  const downloadCounts = new Map();

  /**
   * GET /api/releases
   * List all available releases
   */
  router.get('/', async (req, res) => {
    try {
      // Check if release directory exists
      try {
        await fs.access(releaseDir);
      } catch {
        return res.json({
          version: null,
          builds: [],
          message: 'No releases available yet',
        });
      }

      // Try to read the builds manifest
      const manifestPath = path.join(releaseDir, 'builds.json');
      
      try {
        const manifestData = await fs.readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestData);
        
        // Enrich with download counts
        const builds = manifest.builds.map(build => ({
          ...build,
          downloads: downloadCounts.get(build.filename) || 0,
          downloadUrl: `/api/releases/download/${encodeURIComponent(build.filename)}`,
        }));
        
        return res.json({
          version: manifest.version,
          buildDate: manifest.buildDate,
          builds,
        });
      } catch {
        // No manifest, scan directory manually
        const files = await fs.readdir(releaseDir);
        const builds = [];
        
        for (const file of files) {
          const filePath = path.join(releaseDir, file);
          const fileStat = await fs.stat(filePath);
          
          // Skip directories and meta files
          if (fileStat.isDirectory()) continue;
          if (file.endsWith('.blockmap')) continue;
          if (file.endsWith('.yml') || file.endsWith('.yaml')) continue;
          if (file === 'builds.json') continue;
          
          // Parse platform from filename
          let platform = 'unknown';
          let arch = 'x64';
          
          if (file.includes('-win-') || file.endsWith('.exe')) {
            platform = 'windows';
          } else if (file.includes('-mac-') || file.endsWith('.dmg')) {
            platform = 'macos';
          } else if (file.includes('-linux-') || file.endsWith('.AppImage') || file.endsWith('.deb')) {
            platform = 'linux';
          }
          
          if (file.includes('arm64')) {
            arch = 'arm64';
          }
          
          builds.push({
            filename: file,
            platform,
            arch,
            size: fileStat.size,
            sizeFormatted: formatBytes(fileStat.size),
            downloads: downloadCounts.get(file) || 0,
            downloadUrl: `/api/releases/download/${encodeURIComponent(file)}`,
          });
        }
        
        return res.json({
          version: 'unknown',
          builds,
        });
      }
    } catch (error) {
      console.error('Error listing releases:', error);
      return res.status(500).json({ error: 'Failed to list releases' });
    }
  });

  /**
   * GET /api/releases/latest
   * Get the latest release info
   */
  router.get('/latest', async (req, res) => {
    try {
      const manifestPath = path.join(releaseDir, 'builds.json');
      
      try {
        const manifestData = await fs.readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestData);
        
        return res.json({
          version: manifest.version,
          buildDate: manifest.buildDate,
          changelog: manifest.changelog || null,
        });
      } catch {
        return res.status(404).json({ error: 'No release information available' });
      }
    } catch (error) {
      console.error('Error getting latest release:', error);
      return res.status(500).json({ error: 'Failed to get latest release' });
    }
  });

  /**
   * GET /api/releases/download/:filename
   * Download a specific release file
   */
  router.get('/download/:filename', async (req, res) => {
    try {
      const { filename } = req.params;
      
      // Security: prevent directory traversal
      const sanitizedFilename = path.basename(filename);
      const filePath = path.join(releaseDir, sanitizedFilename);
      
      // Verify file exists and is within release directory
      try {
        const realPath = await fs.realpath(filePath);
        const realReleaseDir = await fs.realpath(releaseDir);
        
        if (!realPath.startsWith(realReleaseDir)) {
          return res.status(403).json({ error: 'Access denied' });
        }
        
        await fs.access(realPath);
      } catch {
        return res.status(404).json({ error: 'File not found' });
      }
      
      // Increment download count
      const currentCount = downloadCounts.get(sanitizedFilename) || 0;
      downloadCounts.set(sanitizedFilename, currentCount + 1);
      
      // Set appropriate headers
      const stats = await fs.stat(filePath);
      
      res.setHeader('Content-Disposition', `attachment; filename="${sanitizedFilename}"`);
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Content-Type', getContentType(sanitizedFilename));
      
      // Stream the file
      const { createReadStream } = await import('fs');
      const stream = createReadStream(filePath);
      stream.pipe(res);
      
    } catch (error) {
      console.error('Error downloading release:', error);
      return res.status(500).json({ error: 'Failed to download file' });
    }
  });

  /**
   * GET /api/releases/stats
   * Get download statistics
   */
  router.get('/stats', async (req, res) => {
    try {
      const stats = {};
      let totalDownloads = 0;
      
      for (const [filename, count] of downloadCounts) {
        stats[filename] = count;
        totalDownloads += count;
      }
      
      return res.json({
        totalDownloads,
        byFile: stats,
      });
    } catch (error) {
      console.error('Error getting stats:', error);
      return res.status(500).json({ error: 'Failed to get stats' });
    }
  });

  /**
   * GET /api/releases/build/status
   * Get current build status
   */
  router.get('/build/status', (req, res) => {
    return res.json({
      isBuilding: buildState.isBuilding,
      platform: buildState.currentPlatform,
      startedAt: buildState.startedAt,
      duration: buildState.startedAt 
        ? Math.floor((Date.now() - new Date(buildState.startedAt).getTime()) / 1000) 
        : null,
      recentLogs: buildState.logs.slice(-20),
    });
  });

  /**
   * POST /api/releases/build
   * Trigger a new build via Docker
   * Requires admin authentication (should be protected)
   */
  router.post('/build', async (req, res) => {
    // Check if already building
    if (buildState.isBuilding) {
      return res.status(409).json({ 
        error: 'Build already in progress',
        platform: buildState.currentPlatform,
        startedAt: buildState.startedAt,
      });
    }

    const { platform = 'linux' } = req.body;
    
    // Validate platform
    const validPlatforms = ['linux', 'win', 'windows', 'all'];
    if (!validPlatforms.includes(platform)) {
      return res.status(400).json({ 
        error: 'Invalid platform',
        validPlatforms,
      });
    }

    // Check if Docker is available
    try {
      await new Promise((resolve, reject) => {
        const check = spawn('docker', ['--version'], { shell: true });
        check.on('close', (code) => code === 0 ? resolve() : reject());
        check.on('error', reject);
      });
    } catch {
      return res.status(500).json({ 
        error: 'Docker is not available on this system',
      });
    }

    // Start build in background
    buildState = {
      isBuilding: true,
      currentPlatform: platform,
      startedAt: new Date().toISOString(),
      logs: ['Build started...'],
    };

    // Determine docker compose command
    const composeFile = path.join(desktopDir, 'docker-compose.builder.yml');
    let composeArgs = ['-f', composeFile, 'up', '--build', '--abort-on-container-exit'];
    
    if (platform === 'win' || platform === 'windows') {
      composeArgs.push('--profile', 'windows', 'builder-win');
    } else {
      composeArgs.push('builder');
    }

    // Run docker compose
    const buildProcess = spawn('docker', ['compose', ...composeArgs], {
      cwd: desktopDir,
      shell: true,
    });

    buildProcess.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      buildState.logs.push(...lines);
      // Keep only last 100 lines
      if (buildState.logs.length > 100) {
        buildState.logs = buildState.logs.slice(-100);
      }
    });

    buildProcess.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      buildState.logs.push(...lines);
      if (buildState.logs.length > 100) {
        buildState.logs = buildState.logs.slice(-100);
      }
    });

    buildProcess.on('close', (code) => {
      buildState.logs.push(code === 0 ? '✅ Build completed successfully!' : `❌ Build failed with code ${code}`);
      buildState.isBuilding = false;
    });

    buildProcess.on('error', (error) => {
      buildState.logs.push(`❌ Build error: ${error.message}`);
      buildState.isBuilding = false;
    });

    return res.json({
      message: 'Build started',
      platform,
      statusUrl: '/api/releases/build/status',
    });
  });

  return router;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const types = {
    '.exe': 'application/x-msdownload',
    '.dmg': 'application/x-apple-diskimage',
    '.AppImage': 'application/x-executable',
    '.deb': 'application/vnd.debian.binary-package',
    '.zip': 'application/zip',
    '.tar.gz': 'application/gzip',
  };
  return types[ext] || 'application/octet-stream';
}

export default createReleasesRouter;
