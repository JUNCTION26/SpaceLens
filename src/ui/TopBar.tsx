import { useEffect, useState } from 'react';
import { useStore } from '../core/store';
import type { Mode } from '../core/types';
import { useUi } from './uiStore';
import { Logo } from './Home';

const MODES: Array<[Mode, string]> = [['capture', 'Capture'], ['design', 'Design'], ['experience', 'Experience'], ['deliver', 'Deliver']];
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const VIEWS = [['2d', '2D'], ['split', 'Split'], ['3d', '3D']] as const;

export function TopBar() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const name = useStore((s) => s.model.name);
  const version = useStore((s) => s.model.version);
  const sample = useStore((s) => s.model.sourceLabel === 'Sample');
  const busy = useStore((s) => s.busy);
  const dispatch = useStore((s) => s.dispatch);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const toggleInspector = useUi((s) => s.toggleInspector);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const commit = () => {
    const n = draft.trim();
    if (n && n !== name) dispatch({ type: 'RENAME', name: n });
    else setDraft(name);
  };

  return (
    <header className="topbar">
      <button className="brand" onClick={() => setMode('home')} aria-label="SpaceLens home"><Logo /><span>SpaceLens</span></button>
      <div className="project">
        <input
          className="project-name" value={draft} aria-label="Project name"
          onChange={(e) => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') { setDraft(name); e.currentTarget.blur(); }
          }}
        />
        <span className="ver" title="Model version">v{version}</span>
        {sample && <span className="chip">Sample</span>}
      </div>
      <nav className="modes" aria-label="Mode">
        {MODES.map(([m, l]) => (
          <button key={m} className={m === mode ? 'on' : ''} aria-current={m === mode ? 'page' : undefined} onClick={() => setMode(m)}>{l}</button>
        ))}
      </nav>
      <div className="tools">
        <button className="kbd-btn" onClick={() => window.dispatchEvent(new Event('spacelens:command'))} title="Search commands (Ctrl+K)" aria-label="Search commands"><span className="kbd-label">Search</span><kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd></button>
        <button className="ghost-btn hide-mobile" onClick={() => window.dispatchEvent(new Event('spacelens:demo'))}>Guided demo</button>
        {busy && <span className="busy" role="status"><i />{busy}</span>}
        {mode !== 'experience' && (
          <div className="seg" role="radiogroup" aria-label="View">
            {VIEWS.map(([v, l]) => <button key={v} role="radio" aria-checked={v === view} className={v === view ? 'on' : ''} onClick={() => setView(v)}>{l}</button>)}
          </div>
        )}
        <button className="icon-btn" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo"><svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" /></svg></button>
        <button className="icon-btn" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)" aria-label="Redo"><svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5M20 9H9a5 5 0 0 0 0 10h3" /></svg></button>
        <button className="icon-btn hide-mobile" onClick={toggleInspector} title="Show or hide inspector" aria-label="Toggle inspector"><svg viewBox="0 0 24 24"><path d="M3 4h18v16H3zM15 4v16" /></svg></button>
        <button className="icon-btn" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></svg></button>
      </div>
    </header>
  );
}
