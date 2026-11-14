// A private dev server for the object screenshot stage (scripts/forge-shot.mjs --port 5197), with its
// own dependency cache so it never disturbs, or is disturbed by, the main dev server.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  cacheDir: 'node_modules/.vite-forge-shot',
  plugins: [react()],
  server: { port: 5197, strictPort: true },
});
