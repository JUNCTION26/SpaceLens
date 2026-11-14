import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './ui/styles.css';
import './ui/mobile.css';

// Development-only handle so the browser test scripts in scripts/e2e can read and drive state.
if (import.meta.env.DEV) {
  void Promise.all([
    import('./core/store'), import('./ui/uiStore'), import('./features/agent/agentStore'),
    import('./features/agent/sketchStore'), import('./features/design/reportStore'), import('./features/forge/library'),
  ]).then(([core, ui, agent, sketch, reports, forge]) => {
    (window as unknown as { __spacelens: unknown }).__spacelens = {
      useStore: core.useStore, useUi: ui.useUi, useAgent: agent.useAgent, useSketch: sketch.useSketch,
      useReports: reports.useReports, useForgeLibrary: forge.useForgeLibrary,
    };
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
