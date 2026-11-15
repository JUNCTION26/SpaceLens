import { lazy, Suspense, useEffect } from 'react';
import { useStore } from './core/store';
import type { Mode } from './core/types';
import { startProblems } from './features/problems/store';
import { ErrorBoundary } from './ui/ErrorBoundary';
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
import { applyDeepLink, resolveNav, useUi } from './ui/uiStore';
import { Sidebar, MobileNav, SectionTabs } from './ui/Sidebar';
import { Icon } from './ui/icons';
import { SearchResults, closeSearch, useSearchHotkeys } from './features/command/CommandPalette';
import { DemoRunner } from './features/demo/DemoRunner';
import { VisionPanel } from './features/vision/VisionPanel';
import { VoiceAdd } from './features/voice/VoiceAdd';
import { AgentDock, OPTIONAL_PANELS } from './ui/sections';
import { PollOverlay } from './features/vote/VoteUi';

applyDeepLink();

const MODE_KEYS: Mode[] = ['capture', 'design', 'experience', 'deliver'];
function PanelSkeleton() {
  return <div className="skeleton" aria-busy="true" aria-label="Loading"><i /><i /><i className="short" /></div>;
}
function StageSkeleton() {
  return <div className="skeleton stage-skel" aria-busy="true" aria-label="Loading 3D view"><span>Loading 3D view</span></div>;
}

/** Always-mounted listeners and full-page views opened by link. Nothing here floats over the workspace. */
function Globals() {
  useSearchHotkeys();
  return (<><PollOverlay /><DemoRunner /></>);
}

const PANELS: Record<string, React.ComponentType> = {
  capture: CapturePanel, drawings: DrawingsPanel, describe: IntentPanel, layouts: DesignPanel,
  furniture: LibraryPanel, checks: ChecksPanel, inspire: VisionPanel, walk: SimPanel, export: ExportPanel,
  ...Object.fromEntries(Object.entries(OPTIONAL_PANELS).filter((e): e is [string, React.ComponentType] => !!e[1])),
};
const VIEWS = [['2d', '2D'], ['split', 'Split'], ['3d', '3D']] as const;

/** The selected item, wall, opening or room, shown as the top section of the left panel. */
function InspectorSection() {
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  if (!selection) return null;
  return (
    <section className="inspector-section" aria-label="Inspector">
      <button className="icon-btn inspector-x" onClick={() => select(null)} aria-label="Close inspector" title="Close"><Icon name="x" size={14} /></button>
      <ErrorBoundary scope="area" label="Inspector"><InspectorPanel /></ErrorBoundary>
    </section>
  );
}

export function App() {
  return <ErrorBoundary scope="app"><Workspace /></ErrorBoundary>;
}

function Workspace() {
  useTheme();
  useEffect(() => { startProblems(); }, []);
  const mode = useStore((s) => s.mode);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const tab = useUi((s) => s.tabByMode);
  const setMode = useStore((s) => s.setMode);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const searchOpen = useUi((s) => s.searchOpen);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const t = e.target as HTMLElement;
      if (e.key === 'Escape' && !e.defaultPrevented && !t?.closest?.('input, textarea, select, [contenteditable]')) {
        // One step back at a time: search, then the selection, then settings.
        const ui = useUi.getState();
        if (ui.searchOpen) closeSearch();
        else if (useStore.getState().selection) useStore.getState().select(null);
        else if (ui.settingsOpen) ui.setSettingsOpen(false);
        return;
      }
      if (t?.closest?.('input, textarea, select, [contenteditable]')) return;
      if (!mod && !e.altKey && e.key === '?') { e.preventDefault(); useUi.getState().setSettingsOpen(true); return; }
      if (!mod && !e.altKey && /^[1-4]$/.test(e.key)) { setMode(MODE_KEYS[Number(e.key) - 1]); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    };
    const checks = () => useUi.getState().openSection('checks');
    window.addEventListener('keydown', onKey);
    window.addEventListener('spacelens:checks', checks);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('spacelens:checks', checks); };
  }, [undo, redo, setMode]);

  if (mode === 'home') return (<><Home /><Toasts /><Globals /></>);

  const active = resolveNav(mode, tab[mode]);
  const Panel = PANELS[active.key];
  const exp = mode === 'experience';
  const shown = exp ? '3d' : view;
  const shellLabel = searchOpen ? 'Search' : settingsOpen ? 'Settings' : active.label;

  const viewSwitch = !exp && (
    <div className="seg view-seg" role="radiogroup" aria-label="View">
      {VIEWS.map(([v, l]) => <button key={v} role="radio" aria-checked={v === view} className={v === view ? 'on' : ''} onClick={() => setView(v)}>{l}</button>)}
    </div>
  );

  return (
    <div className="app">
      <TopBar />
      <div className="workspace">
        <Sidebar active={active} />
        <section className="panel-col" aria-label={shellLabel}>
          <div className="side-body">
            <InspectorSection />
            {searchOpen ? <SearchResults /> : settingsOpen ? <Settings /> : <>
              <header className="panel-col-head"><h1>{active.group}</h1><SectionTabs active={active} /></header>
              <ErrorBoundary scope="area" label={active.label} key={active.key}><Suspense fallback={<PanelSkeleton />}><Panel /></Suspense></ErrorBoundary>
            </>}
          </div>
          {AgentDock ? <Suspense fallback={null}><AgentDock overlay={false} /></Suspense> : <VoiceAdd />}
          <Toasts />
        </section>
        <main className={`stage stage-${shown}`}>
          {shown !== '3d' && <section className="pane pane-2d" aria-label="Plan"><ErrorBoundary scope="area" label="The plan"><PlanView /></ErrorBoundary></section>}
          {shown !== '2d' && <section className="pane pane-3d" aria-label="3D view"><ErrorBoundary scope="area" label="The 3D view"><Suspense fallback={<StageSkeleton />}><SceneView /></Suspense></ErrorBoundary></section>}
          {viewSwitch && <div className="stage-tools">{viewSwitch}</div>}
        </main>
      </div>
      <MobileNav active={active} />
      <Globals />
    </div>
  );
}
