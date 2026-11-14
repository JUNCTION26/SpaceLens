import { lazy, Suspense, useEffect, useState } from 'react';
import { useStore } from './core/store';
import type { Mode } from './core/types';
import { PlanView } from './features/plan2d/PlanView';
const SceneView = lazy(() => import('./features/scene3d/SceneView').then((m) => ({ default: m.SceneView })));
import { CapturePanel } from './features/capture/CapturePanel';
const DrawingsPanel = lazy(() => import('./features/drawings/DrawingsPanel').then((m) => ({ default: m.DrawingsPanel })));
import { IntentPanel } from './features/intent/IntentPanel';
import { DesignPanel } from './features/layout/DesignPanel';
import { LibraryPanel } from './features/furniture/LibraryPanel';
import { ChecksPanel } from './features/referee/ChecksPanel';
import { SimPanel } from './features/sim/SimPanel';
import { InspectorPanel } from './features/provenance/InspectorPanel';
const ExportPanel = lazy(() => import('./features/export/ExportPanel').then((m) => ({ default: m.ExportPanel })));
import { Home } from './ui/Home';
import { TopBar } from './ui/TopBar';
import { Toasts } from './ui/Toasts';
import { useTheme } from './ui/theme';
import { Settings } from './ui/Settings';
import { useUi } from './ui/uiStore';
import { CommandPalette } from './features/command/CommandPalette';
import { DemoRunner } from './features/demo/DemoRunner';
import { Coach } from './ui/onboarding/Coach';
import { VisionPanel } from './features/vision/VisionPanel';

const MODE_KEYS: Mode[] = ['capture', 'design', 'experience', 'deliver'];
const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl/Cmd + K', 'Search commands'],
  ['1 to 4', 'Switch mode'],
  ['Ctrl/Cmd + Z', 'Undo'],
  ['Ctrl/Cmd + Y', 'Redo'],
  ['?', 'Show shortcuts'],
  ['Esc', 'Close dialog'],
];

function PanelSkeleton() {
  return <div className="skeleton" aria-busy="true" aria-label="Loading"><i /><i /><i className="short" /></div>;
}
function StageSkeleton() {
  return <div className="skeleton stage-skel" aria-busy="true" aria-label="Loading 3D view"><span>Loading 3D view</span></div>;
}

function readWidth(key: string, def: number) {
  try { const v = Number(localStorage.getItem(key)); return v >= 220 && v <= 560 ? v : def; } catch { return def; }
}

function Resizer({ side, value, onChange }: { side: 'left' | 'right'; value: number; onChange: (w: number) => void }) {
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = value;
    const move = (ev: PointerEvent) => {
      const d = side === 'left' ? ev.clientX - x0 : x0 - ev.clientX;
      onChange(Math.min(560, Math.max(220, w0 + d)));
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.classList.remove('resizing'); };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const key = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 40 : 16;
    const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    if (e.key === grow) onChange(Math.min(560, value + step));
    if (e.key === shrink) onChange(Math.max(220, value - step));
  };
  return <div className={`resizer resizer-${side}`} role="separator" aria-orientation="vertical" aria-label="Resize panel" aria-valuenow={value} aria-valuemin={220} aria-valuemax={560} tabIndex={0} onPointerDown={start} onKeyDown={key} onDoubleClick={() => onChange(side === 'left' ? 320 : 300)} />;
}

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal shortcuts" role="dialog" aria-modal="true" aria-labelledby="sc-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2 id="sc-title">Keyboard shortcuts</h2><button className="icon-btn" onClick={onClose} aria-label="Close" autoFocus><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></svg></button></div>
        <dl>{SHORTCUTS.map(([k, d]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{d}</dd></div>)}</dl>
      </div>
    </div>
  );
}

function Globals({ help, setHelp }: { help: boolean; setHelp: (b: boolean) => void }) {
  return (<><CommandPalette /><DemoRunner /><Coach /><Toasts />{help && <ShortcutHelp onClose={() => setHelp(false)} />}</>);
}

const SIDE: Record<Exclude<Mode, 'home'>, Array<{ key: string; label: string; el: React.ComponentType }>> = {
  capture: [
    { key: 'capture', label: 'Capture', el: CapturePanel },
    { key: 'drawings', label: 'Drawings', el: DrawingsPanel },
  ],
  design: [
    { key: 'request', label: 'Request', el: IntentPanel },
    { key: 'layouts', label: 'Layouts', el: DesignPanel },
    { key: 'furniture', label: 'Furniture', el: LibraryPanel },
    { key: 'inspire', label: 'Inspire', el: VisionPanel },
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
  const tab = useUi((s) => s.tabByMode);
  const setTab = useUi((s) => s.setTab);
  const inspectorOpen = useUi((s) => s.inspectorOpen);
  const mobilePane = useUi((s) => s.mobilePane);
  const setMobilePane = useUi((s) => s.setMobilePane);
  const setMode = useStore((s) => s.setMode);
  const [help, setHelp] = useState(false);
  const [sideW, setSideW] = useState(() => readWidth('spacelens:sideW', 320));
  const [inspW, setInspW] = useState(() => readWidth('spacelens:inspW', 300));
  useEffect(() => { try { localStorage.setItem('spacelens:sideW', String(sideW)); localStorage.setItem('spacelens:inspW', String(inspW)); } catch { /* ignore */ } }, [sideW, inspW]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); window.dispatchEvent(new Event('spacelens:command')); return; }
      if (e.key === 'Escape') setHelp(false);
      const t = e.target as HTMLElement;
      if (t?.closest?.('input, textarea, select, [contenteditable]')) return;
      if (!mod && !e.altKey && e.key === '?') { e.preventDefault(); setHelp(true); return; }
      if (!mod && !e.altKey && /^[1-4]$/.test(e.key)) { setMode(MODE_KEYS[Number(e.key) - 1]); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, setMode]);

  if (mode === 'home') return (<><Home /><Globals help={help} setHelp={setHelp} /></>);

  const tabs = SIDE[mode];
  const active = tabs.find((t) => t.key === tab[mode]) ?? tabs[0];
  const Side = active.el;

  return (
    <div className="app">
      <TopBar />
      <div className={`workspace${inspectorOpen ? '' : ' no-inspector'} show-${mobilePane}`} style={{ '--side-w': `${sideW}px`, '--insp-w': `${inspW}px` } as React.CSSProperties}>
        <aside className="side">
          {tabs.length > 1 && (
            <div className="tabs" role="tablist">
              {tabs.map((t) => (
                <button key={t.key} role="tab" aria-selected={t === active} className={t === active ? 'tab on' : 'tab'} onClick={() => setTab(mode, t.key)}>
                  {t.label}
                </button>
              ))}
            </div>
          )}
          <div className="side-body"><Suspense fallback={<PanelSkeleton />}><Side /></Suspense></div>
          <Resizer side="left" value={sideW} onChange={setSideW} />
        </aside>
        <main className={`stage stage-${mode === 'experience' ? '3d' : view}`}>
          {(view !== '3d' && mode !== 'experience') && <section className="pane pane-2d"><PlanView /></section>}
          {(view !== '2d' || mode === 'experience') && <section className="pane pane-3d"><Suspense fallback={<StageSkeleton />}><SceneView /></Suspense></section>}
        </main>
        <aside className="inspector">
          <Resizer side="right" value={inspW} onChange={setInspW} />
          <InspectorPanel />
          <ChecksPanel />
        </aside>
      </div>
      <nav className="mobile-tabs" aria-label="Panels">
        <button className={mobilePane === 'side' ? 'on' : ''} onClick={() => setMobilePane('side')}>{active.label}</button>
        <button className={mobilePane === 'inspector' ? 'on' : ''} onClick={() => setMobilePane('inspector')}>Inspector</button>
      </nav>
      <Settings />
      <Globals help={help} setHelp={setHelp} />
    </div>
  );
}
