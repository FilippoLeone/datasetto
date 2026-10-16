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

/** Replaces the __SITE_URL__ placeholder in index.html and the static pages in public/. */
const siteUrlPlugin = () => ({
  name: 'datasetto-site-url',
  transformIndexHtml: (html) => html.split('__SITE_URL__').join(SITE_URL),
  closeBundle() {
    const dist = resolve(__dirname, 'dist');
    for (const file of ['landing.html', 'downloads.html']) {
      const target = resolve(dist, file);
      if (!existsSync(target)) continue;
      writeFileSync(target, readFileSync(target, 'utf8').split('__SITE_URL__').join(SITE_URL));
    }
  },
});

export default defineConfig({
  base: isDesktopBuild ? './' : '/',
  plugins: [preact(), tailwindcss(), siteUrlPlugin()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
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
    rollupOptions: {
      output: {
        manualChunks: {
          hls: ['hls.js'],
          socket: ['socket.io-client'],
          preact: ['preact', '@preact/signals'],
        },
      },
    },
  },
});
