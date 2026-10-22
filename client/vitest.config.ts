import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, './src'),
      // The shared Arcade core lives in the server tree; the client imports it as @arcade/core/*.
      '@arcade/core': resolve(import.meta.dirname, '../server/src/arcade/core'),
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
  },
});
