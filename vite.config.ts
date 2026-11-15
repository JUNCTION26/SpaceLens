import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
    exclude: ['**/node_modules/**', '**/dist/**', '.verify/**'],
    // Solver and geometry tests are CPU-bound; a busy runner must not turn slowness into failure.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
} as any);
