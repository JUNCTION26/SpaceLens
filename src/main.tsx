import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './ui/styles.css';
import './ui/mobile.css';

// Development-only handle so the browser test scripts in scripts/e2e can read and drive state.
// A module that fails to load leaves its entry undefined and is listed in `failed`, so one broken feature
// does not hide the rest from the tests.
if (import.meta.env.DEV) {
  const parts = {
    useStore: () => import('./core/store').then((m) => m.useStore),
    useUi: () => import('./ui/uiStore').then((m) => m.useUi),
    useAgent: () => import('./features/agent/agentStore').then((m) => m.useAgent),
    useSketch: () => import('./features/agent/sketchStore').then((m) => m.useSketch),
    useReports: () => import('./features/design/reportStore').then((m) => m.useReports),
    useForgeLibrary: () => import('./features/forge/library').then((m) => m.useForgeLibrary),
  };
  void Promise.allSettled(Object.values(parts).map((load) => load())).then((settled) => {
    const keys = Object.keys(parts);
    const handle: Record<string, unknown> = { failed: [] as string[] };
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') handle[keys[i]] = r.value;
      else (handle.failed as string[]).push(`${keys[i]}: ${String(r.reason).slice(0, 200)}`);
    });
    (window as unknown as { __spacelens: unknown }).__spacelens = handle;
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
