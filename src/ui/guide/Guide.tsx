import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../core/store';
import { useDrill } from '../../features/safety/DrillButton';
import { useUi } from '../uiStore';
import { useViewPrefs } from '../ViewFold';
import { Icon } from '../icons';
import { useGuide } from './guideStore';
import { STEPS, WALK_KEYS, arrowPath, snapOf, stepDone, type Box, type Snap } from './steps';
import './guide.css';

function find(keys: string[]): Element | null {
  for (const k of keys) {
    const el = document.querySelector(`[data-guide="${k}"]`);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}
const boxOf = (el: Element): Box => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
const sameBox = (a: Box | null, b: Box | null) => a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom);

/** Starts or stops the guide. */
export function GuideButton() {
  const on = useGuide((s) => s.on);
  const toggle = () => (on ? useGuide.getState().stop() : useGuide.getState().start());
  return (
    <button className={`btn btn-sm btn-ghost guide-btn${on ? ' on' : ''}`} aria-pressed={on} onClick={toggle}>
      <Icon name="info" size={14} /> Guide
    </button>
  );
}

/** The instruction card at the top of the left panel. Only the ring and arrow it draws sit over other UI. */
export function GuideCard() {
  const on = useGuide((s) => s.on);
  return on ? <GuideOn /> : null;
}

function GuideOn() {
  const step = useGuide((g) => g.step);
  const viewPokes = useGuide((g) => g.viewPokes);
  const walkStops = useGuide((g) => g.walkStops);
  const model = useStore((st) => st.model);
  const drills = useDrill((d) => d.runKey);
  const walking = useViewPrefs((v) => v.cam === 'walk' || v.touring);
  const cardRef = useRef<HTMLElement>(null);
  const [ring, setRing] = useState<Box | null>(null);
  const [arrow, setArrow] = useState<string | null>(null);
  const s = STEPS[step];
  const last = step === STEPS.length - 1;
  const { move, stop, start } = useGuide.getState();

  // What the room looked like when the step began, so the step moves on once its action shows up.
  const now = snapOf(model, { drills, viewPokes, walkStops });
  const startRef = useRef<{ step: number; snap: Snap } | null>(null);
  let begun = startRef.current;
  if (!begun || begun.step !== step) begun = startRef.current = { step, snap: now };
  const done = stepDone(s.id, begun.snap, now);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => { if (useGuide.getState().step === step) move(1); }, 700);
    return () => clearTimeout(t);
  }, [done, step, move]);

  const wasWalking = useRef(walking);
  useEffect(() => {
    if (wasWalking.current && !walking) useGuide.getState().walkStopped();
    wasWalking.current = walking;
  }, [walking]);

  // Drags and scrolls on the views count for the orbit step.
  useEffect(() => {
    let lastWheel = 0;
    const onPoke = (e: Event) => {
      if (!(e.target as Element | null)?.closest?.('.stage')) return;
      if (e.type === 'wheel') { const t = performance.now(); if (t - lastWheel < 400) return; lastWheel = t; }
      useGuide.getState().poke();
    };
    window.addEventListener('pointerdown', onPoke, true);
    window.addEventListener('wheel', onPoke, { capture: true, passive: true });
    return () => { window.removeEventListener('pointerdown', onPoke, true); window.removeEventListener('wheel', onPoke, true); };
  }, []);

  // Each step opens its section first, then the target is brought into view.
  useEffect(() => {
    if (s.section) useUi.getState().openSection(s.section);
    if (s.id === 'view' && useStore.getState().view === '2d') useStore.getState().setView('split');
    const t = setTimeout(() => {
      const el = find(s.target);
      if (el?.closest('.panel-col')) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 250);
    return () => clearTimeout(t);
  }, [s]);

  useLayoutEffect(() => {
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = find(s.target);
        const aimEl = (s.aim && find([s.aim])) || el;
        const r = el ? boxOf(el) : null;
        const a = cardRef.current && aimEl ? arrowPath(boxOf(cardRef.current), boxOf(aimEl)) : null;
        setRing((p) => (sameBox(p, r) ? p : r));
        setArrow(a);
      });
    };
    update();
    // Panels load lazily and the views resize, so the target is re-measured a few times a second too.
    const id = window.setInterval(update, 300);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { cancelAnimationFrame(raf); clearInterval(id); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [s]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]')) return;
      // Esc stops a walk or leaves full screen first.
      const v = useViewPrefs.getState();
      if (v.cam === 'walk' || v.touring || v.full || v.pseudo) return;
      e.preventDefault();
      stop();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [stop]);

  return (
    <>
      <section ref={cardRef} className="guide-card" aria-label="Guide" aria-live="polite">
        <p className="guide-text">{s.text}</p>
        {s.id === 'walk' && (
          <dl className="guide-keys" aria-label="Walk keys">
            {WALK_KEYS.map(([k, v]) => (
              <div key={v}><dt>{k.map((x) => <kbd key={x}>{x}</kbd>)}</dt><dd>{v}</dd></div>
            ))}
          </dl>
        )}
        <div className="guide-actions">
          {last ? (<>
            <button className="btn btn-sm" onClick={() => start(0)}><Icon name="rotate" size={14} /> Restart</button>
            <button className="btn btn-sm btn-ghost" onClick={stop}>Close</button>
          </>) : (<>
            <button className="btn btn-sm btn-ghost" onClick={stop} title="Esc">Skip</button>
            {step > 0 && <button className="btn btn-sm btn-ghost" onClick={() => move(-1)}>Back</button>}
            <button className="btn btn-sm" onClick={() => move(1)}>Next</button>
          </>)}
        </div>
      </section>
      {createPortal(
        <>
          {ring && <div className="coach-ring guide-ring" aria-hidden="true" style={{ top: ring.top - 4, left: ring.left - 4, width: ring.right - ring.left + 8, height: ring.bottom - ring.top + 8 }} />}
          {arrow && (
            <svg className="guide-arrow" aria-hidden="true">
              <defs>
                <marker id="guide-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0 0L10 5L0 10z" />
                </marker>
              </defs>
              <path d={arrow} markerEnd="url(#guide-head)" />
            </svg>
          )}
        </>,
        document.body,
      )}
    </>
  );
}
