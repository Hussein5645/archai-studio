import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The release number (package.json build.buildVersion, e.g. 0.2.2.14) shown in Home → Settings.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string; build?: { buildVersion?: string } };

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.build?.buildVersion ?? pkg.version) },
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
    // ARCHAI_LOCAL_VR (the vr-share Worker) works the same way with VITE_VR_SHARE_URL=/__vr.
    proxy: {
      ...(process.env['ARCHAI_LOCAL_CLOUD'] ? { '/__cloud': { target: process.env['ARCHAI_LOCAL_CLOUD'], changeOrigin: true, ws: true, rewrite: (path: string) => path.replace(/^\/__cloud/, '') } } : {}),
      ...(process.env['ARCHAI_LOCAL_VR'] ? { '/__vr': { target: process.env['ARCHAI_LOCAL_VR'], changeOrigin: true, rewrite: (path: string) => path.replace(/^\/__vr/, '') } } : {}),
    },
  },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'shared/**/*.test.ts'],
  },
});
