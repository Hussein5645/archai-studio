import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  test: { environment: 'node', include: ['scripts/picking-performance.audit.ts'], testTimeout: 120000, fileParallelism: false },
});
