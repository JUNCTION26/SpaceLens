import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from '../core/store';
import { Logo } from './Home';
import { Icon } from './icons';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function TopBar({ status }: { status?: ReactNode }) {
  const setMode = useStore((s) => s.setMode);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const name = useStore((s) => s.model.name);
  const busy = useStore((s) => s.busy);
  const sample = useStore((s) => s.model.sourceLabel === 'Sample');
  const dispatch = useStore((s) => s.dispatch);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const commit = () => {
    const n = draft.trim();
    if (n && n !== name) dispatch({ type: 'RENAME', name: n });
    else setDraft(name);
  };

  return (
    <header className="topbar">
      <button className="brand" onClick={() => setMode('home')} aria-label="SpaceLens home" title="Home"><Logo /></button>
      <input
        className="project-name" value={draft} aria-label="Project name"
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') { setDraft(name); e.currentTarget.blur(); }
        }}
      />
      {sample && <span className="chip sample-tag">Sample</span>}
      <div className="tools">
        {busy ? <span className="busy" role="status" aria-label={busy} title={busy}><i /></span> : status}
        <button className="icon-btn" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" /></button>
        <button className="icon-btn" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)" aria-label="Redo"><Icon name="redo" /></button>
        <button className="kbd-btn" onClick={() => window.dispatchEvent(new Event('spacelens:command'))} title="Search" aria-label="Search">
          <Icon name="search" size={14} /><span className="kbd-label">Search</span><kbd>{isMac ? '\u2318K' : 'Ctrl K'}</kbd>
        </button>
      </div>
    </header>
  );
}
