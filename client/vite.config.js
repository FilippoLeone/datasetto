import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    host: true,
  },
  build: {
    target: 'es2020',
    minify: 'esbuild',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'hls': ['hls.js'],
          'socket': ['socket.io-client'],
        },
      },
    },
  },
  optimizeDeps: {
    include: ['hls.js', 'socket.io-client'],
  },
});
