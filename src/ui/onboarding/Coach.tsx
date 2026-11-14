import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../../core/store';

const KEY = 'spacelens.coach.done.v1';

/** Find a button whose text matches inside a container. */
function byText(sel: string, re: RegExp): Element | null {
  return Array.from(document.querySelectorAll(sel)).find((e) => re.test(e.textContent ?? '')) ?? null;
}

const STEPS: Array<{ title: string; text: string; find: () => Element | null }> = [
  { title: 'Edit the room', text: 'Drag corners or click a size to edit.', find: () => document.querySelector('.plan2d-toolbar') ?? document.querySelector('.pane-2d') },
  { title: 'Describe what you want', text: 'Say how you use the room. We plan around it.', find: () => byText('.tabs .tab', /request/i) },
  { title: 'Pick a layout', text: 'Compare layouts that fit and choose one.', find: () => byText('.tabs .tab', /layouts/i) },
  { title: 'Walk through it', text: 'Step inside in 3D.', find: () => byText('.modes button', /experience|walk|simulate/i) },
  { title: 'Export', text: 'Save plans, images and a shopping list.', find: () => byText('.modes button', /deliver|export/i) },
];

function seen(): boolean { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } }
function markSeen() { try { localStorage.setItem(KEY, '1'); } catch { /* blocked */ } }

export function Coach() {
  const mode = useStore((s) => s.mode);
  const [step, setStep] = useState<number | null>(null);
  const [box, setBox] = useState<DOMRect | null>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (mode === 'design' && step === null && !seen()) { const t = setTimeout(() => setStep(0), 600); return () => clearTimeout(t); }
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

  if (mode === 'home' || step === null || step < 0 || !box) return null;
  const s = STEPS[step];
  const last = step === STEPS.length - 1;
  const w = Math.min(280, window.innerWidth - 32);
  const below = box.bottom + 160 < window.innerHeight;
  const top = below ? box.bottom + 10 : Math.max(16, box.top - 150);
  const left = Math.max(16, Math.min(box.left, window.innerWidth - w - 16));
  return (
    <>
      <div className="coach-ring" aria-hidden="true" style={{ top: box.top - 4, left: box.left - 4, width: box.width + 8, height: box.height + 8 }} />
      <div className="coach-tip" role="dialog" aria-live="polite" aria-label={s.title} style={{ top, left, width: w }}>
        <span className="coach-count">{step + 1} of {STEPS.length}</span>
        <strong>{s.title}</strong>
        <p>{s.text}</p>
        <div className="coach-actions">
          <button className="btn btn-ghost btn-sm" onClick={finish}>Skip tour</button>
          <button ref={nextRef} className="btn btn-primary btn-sm" onClick={() => (last ? finish() : setStep(step + 1))}>{last ? 'Done' : 'Next'}</button>
        </div>
      </div>
    </>
  );
}
