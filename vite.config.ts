import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: process.env.GITHUB_PAGES ? '/SpaceLens/' : '/',
  plugins: [react()],
  test: { environment: 'node' },
} as any);
