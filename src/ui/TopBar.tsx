import { useEffect, useState } from 'react';
import { SearchField } from '../features/command/CommandPalette';
import { useStore } from '../core/store';
import { useXRSupport, type XRMode } from '../features/xr/xrSupport';
import { Logo } from './Home';
import { GuideButton } from './guide/Guide';
import { Icon } from './icons';
import { toggleStageFull, toggleWalk, useViewPrefs } from './ViewFold';
import './shell.css';

const shareLink = () => {
  const st = useStore.getState();
  void import('../features/export/share').then(async (m) => {
    const url = await m.shareLink(st.model);
    try { await navigator.clipboard.writeText(url); st.toast('Link copied', 'ok'); } catch { st.toast('Link not copied', 'warn'); }
  }).catch(() => st.toast('Link not copied', 'warn'));
};
const startXR = (m: XRMode) => window.dispatchEvent(new CustomEvent('spacelens:xr', { detail: m }));
/** The camera walks the room by itself, so it needs no keys. From the plan alone, a 3D pane opens first. */
const startTour = () => {
  const fire = () => window.dispatchEvent(new CustomEvent('spacelens:auto-tour', { detail: { record: false } }));
  const st = useStore.getState();
  if (st.view !== '2d' || st.mode === 'experience') { fire(); return; }
  st.setView('split');
  // wait for the 3D view to mount and listen before asking it to tour
  let n = 0;
  const t = setInterval(() => { if (document.querySelector('.scene3d') || ++n > 40) { clearInterval(t); setTimeout(fire, 300); } }, 150);
};
/** Shown in place of the built-in starter room's stored name. */
const shownName = (n: string) => (/^sample room$/i.test(n.trim()) ? 'My room' : n);
const VIEWS = [['2d', '2D'], ['split', 'Split'], ['3d', '3D']] as const;

/** Project name, undo and redo; the view switch in the centre; walk, full screen, VR/AR, search and share on the right. */
export function TopBar() {
  const setMode = useStore((s) => s.setMode);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const name = shownName(useStore((s) => s.model.name));
  const busy = useStore((s) => s.busy);
  const dispatch = useStore((s) => s.dispatch);
  const mode = useStore((s) => s.mode);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const exp = mode === 'experience';
  const has3d = exp || view !== '2d';
  const walking = useViewPrefs((s) => s.cam === 'walk') && has3d;
  const touring = useViewPrefs((s) => s.touring);
  const full = useViewPrefs((s) => s.full || s.pseudo);
  const xrMode = useViewPrefs((s) => s.xrMode);
  const xr = useXRSupport();
  /** A design has landed: the tour becomes the next step. */
  const designed = useStore((s) => !!s.requirements);
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
      {busy && <span className="busy" role="status" aria-label={busy} title={busy}><i /></span>}
      <button className="icon-btn" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" /></button>
      <button className="icon-btn" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)" aria-label="Redo"><Icon name="redo" /></button>
      {/* Walk and Safety show the 3D view only: the switch stays in place with 3D on, so the bar keeps its shape. */}
      <div className="topbar-center">
        <div className="seg view-seg" role="radiogroup" aria-label="View">
          {VIEWS.map(([v, l]) => {
            const on = exp ? v === '3d' : v === view;
            return <button key={v} role="radio" aria-checked={on} className={on ? 'on' : ''} disabled={exp && v !== '3d'} onClick={() => setView(v)}>{l}</button>;
          })}
        </div>
      </div>
      <div className="tools">
        {designed && !touring && (
          <button className="icon-btn" onClick={startTour} aria-label="Tour" title="Tour"><Icon name="play" /></button>
        )}
        <button className={`icon-btn${walking || touring ? ' on' : ''}`} onClick={toggleWalk} aria-pressed={walking || touring} data-guide="walk"
          aria-label={touring ? 'Stop tour' : 'Walk'} title={touring ? 'Stop tour' : walking ? 'Stop walking (Esc)' : 'Walk'}>
          <Icon name={touring ? 'pause' : walking ? 'x' : 'walk'} />
        </button>
        <button className={`icon-btn${full ? ' on' : ''}`} onClick={toggleStageFull} aria-pressed={full} title={full ? 'Leave full screen (Esc)' : 'Full screen (Shift+F)'} aria-label="Full screen"><Icon name={full ? 'x' : 'maximize'} /></button>
        {has3d && xr.vr && <button className={`icon-btn${xrMode === 'immersive-vr' ? ' on' : ''}`} onClick={() => startXR('immersive-vr')} aria-label="VR" title="VR"><Icon name="headset" /></button>}
        {has3d && xr.ar && <button className={`icon-btn${xrMode === 'immersive-ar' ? ' on' : ''}`} onClick={() => startXR('immersive-ar')} aria-label="AR" title="AR"><Icon name="cube" /></button>}
        <SearchField />
        <button className="icon-btn" onClick={shareLink} title="Share" aria-label="Share"><Icon name="share" /></button>
        <GuideButton />
      </div>
    </header>
  );
}
