import { useEffect, useRef, useState, type ReactNode } from 'react';
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
const openSearch = () => window.dispatchEvent(new Event('spacelens:command'));

function MoreMenu() {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btn.current?.focus(); } };
    const onDown = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest?.('.topbar-more')) setOpen(false); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown); };
  }, [open]);
  const item = (label: string, icon: string, run: () => void) => (
    <button role="menuitem" onClick={() => { setOpen(false); run(); }}><Icon name={icon} size={14} />{label}</button>
  );
  return (
    <div className="topbar-more">
      <button ref={btn} className="icon-btn" aria-label="More" aria-haspopup="menu" aria-expanded={open} title="More" onClick={() => setOpen(!open)}><Icon name="more" /></button>
      {open && <div className="topbar-menu" role="menu" ref={box}>
        {item('Search', 'search', openSearch)}
        {item('Full screen', 'maximize', toggleFull)}
        {item('Share', 'share', shareLink)}
      </div>}
    </div>
  );
}

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
        <span className="topbar-inline">
          <button className="icon-btn" onClick={toggleFull} title="Full screen" aria-label="Full screen"><Icon name="maximize" /></button>
          <button className="icon-btn" onClick={shareLink} title="Share" aria-label="Share"><Icon name="share" /></button>
          <button className="kbd-btn" onClick={openSearch} title="Search" aria-label="Search">
            <Icon name="search" size={14} /><span className="kbd-label">Search</span><kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
        </span>
        <MoreMenu />
      </div>
    </header>
  );
}
