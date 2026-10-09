import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // Relative base so the production bundle also loads from file:// inside Electron.
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Testing against `wrangler dev` (workers/archai-cloud): ARCHAI_LOCAL_CLOUD=http://127.0.0.1:8787
    // with VITE_CLOUD_URL=/__cloud serves the local Worker from the app's own origin.
    ...(process.env['ARCHAI_LOCAL_CLOUD']
      ? { proxy: { '/__cloud': { target: process.env['ARCHAI_LOCAL_CLOUD'], changeOrigin: true, ws: true, rewrite: (path: string) => path.replace(/^\/__cloud/, '') } } }
      : {}),
  },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'shared/**/*.test.ts'],
  },
});
