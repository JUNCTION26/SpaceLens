import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from '../core/store';
import { useUi } from './uiStore';
import { Logo } from './Home';
import { Icon } from './icons';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function TopBar({ center }: { center?: ReactNode }) {
  const setMode = useStore((s) => s.setMode);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const name = useStore((s) => s.model.name);
  const busy = useStore((s) => s.busy);
  const dispatch = useStore((s) => s.dispatch);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
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
      <span className="topbar-sep" aria-hidden="true">/</span>
      <input
        className="project-name" value={draft} aria-label="Project name"
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') { setDraft(name); e.currentTarget.blur(); }
        }}
      />
      {center && <div className="topbar-center">{center}</div>}
      <div className="tools">
        {busy && <span className="busy" role="status"><i />{busy}</span>}
        <button className="icon-btn" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" /></button>
        <button className="icon-btn" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)" aria-label="Redo"><Icon name="redo" /></button>
        <button className="kbd-btn" onClick={() => window.dispatchEvent(new Event('spacelens:command'))} title="Search commands" aria-label="Search commands">
          <Icon name="search" size={14} /><span className="kbd-label">Search</span><kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <span className="tool-sep" aria-hidden="true" />
        <button className="icon-btn" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings"><Icon name="settings" /></button>
      </div>
    </header>
  );
}
