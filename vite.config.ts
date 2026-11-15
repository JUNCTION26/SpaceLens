import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import os from 'node:os';

// Wall-clock budgets in tests are multiplied by this. Strict numbers: SPACELENS_TIME_SLACK=1.
const slack = process.env.SPACELENS_TIME_SLACK ?? (process.env.CI || os.cpus().length < 8 || os.loadavg()[0] > os.cpus().length ? '4' : '1');

export default defineConfig({
  base: process.env.GITHUB_PAGES ? '/SpaceLens/' : '/',
  plugins: [react()],
  // Workers import code that is split into chunks, which needs ES module output.
  worker: { format: 'es' },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Vendor code gets its own long-cached files, so an app update does not re-download it.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('pdfjs-dist')) return 'pdfjs';
          if (id.includes('@react-three')) return 'r3f';
          if (id.includes('/three/') || id.includes('three-stdlib') || id.includes('three-mesh-bvh')) return 'three';
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '.verify*/**'],
    env: { SPACELENS_TIME_SLACK: slack },
    // Separate processes keep the heavy solver tests from starving each other.
    pool: 'forks',
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
    // Solver and geometry tests are CPU-bound; a busy runner must not turn slowness into failure.
    testTimeout: 120000,
    hookTimeout: 120000,
  },
} as any);
