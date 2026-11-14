import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: process.env.GITHUB_PAGES ? '/SpaceLens/' : '/',
  plugins: [react()],
  // Workers import code that is split into chunks, which needs ES module output.
  worker: { format: 'es' },
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '.verify/**'],
    // Solver and geometry tests are CPU-bound; a busy runner must not turn slowness into failure.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
} as any);
