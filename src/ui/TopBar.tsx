import { useEffect, useState } from 'react';
import { SearchField } from '../features/command/CommandPalette';
import { useStore } from '../core/store';
import { Logo } from './Home';
import { Icon } from './icons';
import './shell.css';

const toggleFull = () => { try { if (document.fullscreenElement) void document.exitFullscreen?.(); else void document.documentElement.requestFullscreen?.(); } catch { /* blocked */ } };
const shareLink = () => {
  const st = useStore.getState();
  void import('../features/export/share').then(async (m) => {
    const url = await m.shareLink(st.model);
    try { await navigator.clipboard.writeText(url); st.toast('Link copied', 'ok'); } catch { st.toast('Link not copied', 'warn'); }
  }).catch(() => st.toast('Link not copied', 'warn'));
};
/** Shown in place of the built-in starter room's stored name. */
const shownName = (n: string) => (/^sample room$/i.test(n.trim()) ? 'My room' : n);

/** Project name, undo, redo, search, full screen and share. */
export function TopBar() {
  const setMode = useStore((s) => s.setMode);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const name = shownName(useStore((s) => s.model.name));
  const busy = useStore((s) => s.busy);
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
      <div className="tools">
        {busy && <span className="busy" role="status" aria-label={busy} title={busy}><i /></span>}
        <button className="icon-btn" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" /></button>
        <button className="icon-btn" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)" aria-label="Redo"><Icon name="redo" /></button>
        <SearchField />
        <button className="icon-btn" onClick={toggleFull} title="Full screen" aria-label="Full screen"><Icon name="maximize" /></button>
        <button className="icon-btn" onClick={shareLink} title="Share" aria-label="Share"><Icon name="share" /></button>
      </div>
    </header>
  );
}
