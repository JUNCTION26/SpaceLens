import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../../core/store';
import '../shell.css';

const KEY = 'spacelens.coach.done.v1';

// Only sidebar entries count: on phones the sidebar is hidden, so the tour ends after the plan step.
const nav = (k: string) => () => visible(document.querySelector(`.sidebar [data-nav="${k}"]`));
const visible = (el: Element | null) => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? el : null; };

const STEPS: Array<{ title: string; find: () => Element | null }> = [
  // Points at a real size label on the plan; skipped when the plan is hidden (3D only).
  { title: 'Click a size', find: () => visible(document.querySelector('.pane-2d .plan2d-dim-label')) ?? visible(document.querySelector('.pane-2d .plan2d-vertex')) },
  { title: 'Describe it', find: nav('describe') },
  { title: 'Pick a layout', find: nav('layouts') },
];

const suppressed = () => { try { const q = new URLSearchParams(location.search); return q.has('show') || q.get('coach') === '0'; } catch { return false; } };

function seen(): boolean { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } }
function markSeen() { try { localStorage.setItem(KEY, '1'); } catch { /* blocked */ } }

export function Coach() {
  const mode = useStore((s) => s.mode);
  const [step, setStep] = useState<number | null>(null);
  const [box, setBox] = useState<DOMRect | null>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (mode === 'design' && step === null && !seen() && !suppressed()) { const t = setTimeout(() => setStep(0), 600); return () => clearTimeout(t); }
  }, [mode, step]);

  useEffect(() => {
    // The guided demo has its own captions, so the tour steps aside while it runs.
    const close = () => { markSeen(); setStep(-1); setBox(null); };
    const replay = () => setStep(0);
    window.addEventListener('spacelens:demo', close);
    window.addEventListener('spacelens:tour', replay);
    return () => { window.removeEventListener('spacelens:demo', close); window.removeEventListener('spacelens:tour', replay); };
  }, []);

  const finish = () => { markSeen(); setStep(-1); setBox(null); };

  useLayoutEffect(() => {
    if (step === null || step < 0 || mode === 'home') return;
    let i = step;
    while (i < STEPS.length && !STEPS[i].find()) i++;
    if (i >= STEPS.length) { finish(); return; }
    if (i !== step) { setStep(i); return; }
    const el = STEPS[i].find()!;
    const update = () => setBox(el.getBoundingClientRect());
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    nextRef.current?.focus();
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [step, mode]);

  useEffect(() => {
    if (step === null || step < 0) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  if (mode === 'home' || step === null || step < 0 || !box || suppressed()) return null;
  const s = STEPS[step];
  const last = step === STEPS.length - 1;
  const w = 190, h = 36, gap = 12;
  // Always placed beside the target, never on top of it.
  const room = { right: window.innerWidth - box.right, below: window.innerHeight - box.bottom };
  let top: number, left: number;
  if (room.right >= w + gap + 8 && box.width < 260) { left = box.right + gap; top = Math.max(8, Math.min(box.top + (box.height - h) / 2, window.innerHeight - h - 8)); }
  else if (room.below >= h + gap + 8) { top = box.bottom + gap; left = Math.max(8, Math.min(box.left, window.innerWidth - w - 8)); }
  else { top = Math.max(8, box.top - h - gap); left = Math.max(8, Math.min(box.left, window.innerWidth - w - 8)); }
  return (
    <>
      <div className="coach-ring" aria-hidden="true" style={{ top: box.top - 4, left: box.left - 4, width: box.width + 8, height: box.height + 8, pointerEvents: 'none' }} />
      <div className="coach-pin" role="dialog" aria-live="polite" aria-label={s.title} style={{ top, left }}>
        <span>{s.title}</span>
        <button ref={nextRef} className="coach-next" onClick={() => (last ? finish() : setStep(step + 1))} aria-label={last ? 'Done' : 'Next'}>{last ? 'Done' : 'Next'}</button>
        <button onClick={finish} aria-label="Skip tour">Skip</button>
      </div>
    </>
  );
}
