import { useEffect, useState } from 'react';
import { useStore } from './core/store';
import type { Mode } from './core/types';
import { PlanView } from './features/plan2d/PlanView';
import { SceneView } from './features/scene3d/SceneView';
import { CapturePanel } from './features/capture/CapturePanel';
import { DrawingsPanel } from './features/drawings/DrawingsPanel';
import { IntentPanel } from './features/intent/IntentPanel';
import { DesignPanel } from './features/layout/DesignPanel';
import { LibraryPanel } from './features/furniture/LibraryPanel';
import { ChecksPanel } from './features/referee/ChecksPanel';
import { SimPanel } from './features/sim/SimPanel';
import { InspectorPanel } from './features/provenance/InspectorPanel';
import { ExportPanel } from './features/export/ExportPanel';
import { Home } from './ui/Home';
import { TopBar } from './ui/TopBar';
import { Toasts } from './ui/Toasts';
import { useTheme } from './ui/theme';

const SIDE: Record<Exclude<Mode, 'home'>, Array<{ key: string; label: string; el: () => JSX.Element }>> = {
  capture: [
    { key: 'capture', label: 'Capture', el: CapturePanel },
    { key: 'drawings', label: 'Drawings', el: DrawingsPanel },
  ],
  design: [
    { key: 'request', label: 'Request', el: IntentPanel },
    { key: 'layouts', label: 'Layouts', el: DesignPanel },
    { key: 'furniture', label: 'Furniture', el: LibraryPanel },
  ],
  experience: [{ key: 'simulate', label: 'Simulate', el: SimPanel }],
  deliver: [{ key: 'export', label: 'Export', el: ExportPanel }],
};

export function App() {
  useTheme();
  const mode = useStore((s) => s.mode);
  const view = useStore((s) => s.view);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const [tab, setTab] = useState<Record<string, string>>({});

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, [contenteditable]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  if (mode === 'home') return (<><Home /><Toasts /></>);

  const tabs = SIDE[mode];
  const active = tabs.find((t) => t.key === tab[mode]) ?? tabs[0];
  const Side = active.el;

  return (
    <div className="app">
      <TopBar />
      <div className="workspace">
        <aside className="side">
          {tabs.length > 1 && (
            <div className="tabs" role="tablist">
              {tabs.map((t) => (
                <button key={t.key} role="tab" aria-selected={t === active} className={t === active ? 'tab on' : 'tab'} onClick={() => setTab({ ...tab, [mode]: t.key })}>
                  {t.label}
                </button>
              ))}
            </div>
          )}
          <div className="side-body"><Side /></div>
        </aside>
        <main className={`stage stage-${mode === 'experience' ? '3d' : view}`}>
          {(view !== '3d' && mode !== 'experience') && <section className="pane pane-2d"><PlanView /></section>}
          {(view !== '2d' || mode === 'experience') && <section className="pane pane-3d"><SceneView /></section>}
        </main>
        <aside className="inspector">
          <InspectorPanel />
          <ChecksPanel />
        </aside>
      </div>
      <Toasts />
    </div>
  );
}
