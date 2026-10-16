import { defineConfig } from 'vite';
import { resolve } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';

const isDesktopBuild = process.env.VITE_BUILD_TARGET === 'desktop';
const devProxyTarget = process.env.VITE_DEV_PROXY || 'http://localhost:8080';

// Absolute public URL used in SEO tags (Open Graph, JSON-LD). Empty means the
// tags are omitted at build time, which is fine for a private server.
const SITE_URL = (process.env.VITE_SITE_URL || '').replace(new RegExp('/+$'), '');

const BUILD_DATE = new Date().toISOString().slice(0, 10);

/** Fills the __SITE_URL__ and __BUILD_DATE__ placeholders in a page or SEO file. */
const fillPlaceholders = (text) => text.split('__SITE_URL__').join(SITE_URL).split('__BUILD_DATE__').join(BUILD_DATE);

/**
 * Replaces the placeholders in index.html and in the static pages and SEO files in public/
 * (landing, downloads, robots.txt, sitemap.xml). Without a SITE_URL the sitemap line is
 * dropped from robots.txt because crawlers need an absolute URL there.
 */
const siteUrlPlugin = () => ({
  name: 'datasetto-site-url',
  transformIndexHtml: (html) => fillPlaceholders(html),
  configureServer(server) {
    // Dev server: serve the public pages with placeholders filled, like the build does.
    server.middlewares.use((req, res, next) => {
      const file = (req.url || '').split('?')[0];
      if (!['/landing.html', '/downloads.html', '/robots.txt', '/sitemap.xml'].includes(file)) return next();
      const source = resolve(import.meta.dirname, 'public', file.slice(1));
      if (!existsSync(source)) return next();
      res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.xml') ? 'application/xml' : 'text/plain');
      res.end(fillPlaceholders(readFileSync(source, 'utf8')));
    });
  },
  closeBundle() {
    const dist = resolve(import.meta.dirname, 'dist');
    for (const file of ['landing.html', 'downloads.html', 'robots.txt', 'sitemap.xml']) {
      const target = resolve(dist, file);
      if (!existsSync(target)) continue;
      let text = fillPlaceholders(readFileSync(target, 'utf8'));
      if (file === 'robots.txt' && !SITE_URL) text = text.split(/\r?\n/).filter((line) => !line.startsWith('Sitemap:')).join('\n');
      writeFileSync(target, text);
    }
  },
});

export default defineConfig({
  base: isDesktopBuild ? './' : '/',
  plugins: [preact(), tailwindcss(), siteUrlPlugin()],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 5173,
    host: true,
    // During development the API, socket and HLS come from the local Docker stack
    // (docker compose -f ops/docker-compose.yml -f ops/docker-compose.local.yml up).
    proxy: {
      '/api': { target: devProxyTarget, changeOrigin: true },
      '/health': { target: devProxyTarget, changeOrigin: true },
      '/hls': { target: devProxyTarget, changeOrigin: true },
      '/socket.io': { target: devProxyTarget, changeOrigin: true, ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rolldownOptions: {
      output: {
        // Vite 8 bundles with Rolldown: the old manualChunks map became codeSplitting groups.
        codeSplitting: {
          groups: [
            { name: 'hls', test: /[\/]node_modules[\/]hls\.js[\/]/ },
            { name: 'socket', test: /[\/]node_modules[\/](socket\.io-client|socket\.io-parser|engine\.io-client|engine\.io-parser|@socket\.io)[\/]/ },
            { name: 'preact', test: /[\/]node_modules[\/](preact|@preact)[\/]/ },
          ],
        },
      },
    },
  },
});
