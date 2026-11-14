import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useShownFurniture, useStore } from './core/store';
import { summarize, validateLayout } from './features/referee/validate';
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
import { resolveNav, useUi } from './ui/uiStore';
import { Sidebar, MobileNav } from './ui/Sidebar';
import { Icon } from './ui/icons';
import { CommandPalette } from './features/command/CommandPalette';
import { DemoRunner } from './features/demo/DemoRunner';
import { Coach } from './ui/onboarding/Coach';
import { VisionPanel } from './features/vision/VisionPanel';
import { VoiceAdd } from './features/voice/VoiceAdd';

const MODE_KEYS: Mode[] = ['capture', 'design', 'experience', 'deliver'];
const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl/Cmd + K', 'Search commands'],
  ['1 to 4', 'Jump to section group'],
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

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal shortcuts" role="dialog" aria-modal="true" aria-labelledby="sc-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2 id="sc-title">Keyboard shortcuts</h2><button className="icon-btn" onClick={onClose} aria-label="Close" autoFocus><Icon name="x" size={16} /></button></div>
        <dl>{SHORTCUTS.map(([k, d]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{d}</dd></div>)}</dl>
      </div>
    </div>
  );
}

function Globals({ help, setHelp }: { help: boolean; setHelp: (b: boolean) => void }) {
  return (<><CommandPalette /><DemoRunner /><Coach /><Toasts />{help && <ShortcutHelp onClose={() => setHelp(false)} />}</>);
}

const PANELS: Record<string, React.ComponentType> = {
  capture: CapturePanel, drawings: DrawingsPanel, describe: IntentPanel, layouts: DesignPanel,
  furniture: LibraryPanel, inspire: VisionPanel, walk: SimPanel, export: ExportPanel,
};
const VIEWS = [['2d', '2D'], ['split', 'Split'], ['3d', '3D']] as const;

function ChecksPill() {
  const model = useStore((s) => s.model);
  const requirements = useStore((s) => s.requirements);
  const furniture = useShownFurniture();
  const [open, setOpen] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fails = useMemo(() => summarize(validateLayout(model, furniture, requirements)).fail, [model.version, furniture, requirements]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <div className="checks-float">
      {open && <div className="checks-pop" role="dialog" aria-label="Checks"><ChecksPanel /></div>}
      <button className={`status-pill${fails ? ' bad' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <i aria-hidden="true" />{fails ? `${fails} to fix` : 'All clear'}
      </button>
    </div>
  );
}

function InspectorSheet() {
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  useEffect(() => {
    if (!selection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if ((e.target as HTMLElement)?.closest?.('input, textarea, select')) return;
      select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, select]);
  if (!selection) return null;
  return (
    <aside className="inspector-sheet" aria-label="Inspector">
      <div className="sheet-head"><span>Inspector</span><button className="icon-btn" onClick={() => select(null)} aria-label="Close inspector"><Icon name="x" size={16} /></button></div>
      <div className="sheet-body"><InspectorPanel /></div>
    </aside>
  );
}

export function App() {
  useTheme();
  const mode = useStore((s) => s.mode);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const tab = useUi((s) => s.tabByMode);
  const collapsed = useUi((s) => s.navCollapsed);
  const setMode = useStore((s) => s.setMode);
  const [help, setHelp] = useState(false);

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

  const active = resolveNav(mode, tab[mode]);
  const Panel = PANELS[active.key];
  const exp = mode === 'experience';
  const shown = exp ? '3d' : view;

  return (
    <div className="app">
      <TopBar />
      <div className={`workspace${collapsed ? ' nav-collapsed' : ''}`}>
        <Sidebar active={active} />
        <section className="panel-col" aria-label={active.label}>
          <header className="panel-col-head"><h1>{active.label}</h1></header>
          <div className="side-body"><Suspense fallback={<PanelSkeleton />}><Panel key={active.key} /></Suspense></div>
        </section>
        <main className={`stage stage-${shown}`}>
          {shown !== '3d' && <section className="pane pane-2d"><PlanView /></section>}
          {shown !== '2d' && <section className="pane pane-3d"><Suspense fallback={<StageSkeleton />}><SceneView /></Suspense></section>}
          {!exp && (
            <div className="seg view-seg" role="radiogroup" aria-label="View">
              {VIEWS.map(([v, l]) => <button key={v} role="radio" aria-checked={v === view} className={v === view ? 'on' : ''} onClick={() => setView(v)}>{l}</button>)}
            </div>
          )}
          <ChecksPill />
          <VoiceAdd />
          <InspectorSheet />
        </main>
      </div>
      <MobileNav active={active} />
      <Settings />
      <Globals help={help} setHelp={setHelp} />
    </div>
  );
}
