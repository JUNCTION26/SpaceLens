import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../core/store';
import { useUi } from '../../ui/uiStore';
import { sampleRoom } from '../../core/sample';
import { runSequence, type SeqCtx, type SeqStep } from './sequencer';

const BRIEF = 'a calm home office with a reading corner';
const CAT_TREE = 'a cat tree with three platforms';

const S = () => useStore.getState();
const tab = (mode: 'design' | 'experience' | 'deliver', key: string) => { S().setMode(mode); useUi.getState().setTab(mode, key); };
const until = async (c: SeqCtx, ok: () => boolean, ms: number) => {
  for (let t = 0; t < ms && !ok(); t += 150) await c.wait(150);
};

/** Type into the Describe field letter by letter, if it is on screen. Returns false when it is not. */
async function typeBrief(c: SeqCtx): Promise<boolean> {
  await until(c, () => !!document.querySelector('textarea[aria-label="Describe your space"]'), 3000);
  const el = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe your space"]');
  if (!el) return false;
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  for (let i = 1; i <= BRIEF.length; i++) {
    set?.call(el, BRIEF.slice(0, i));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await c.wait(55);
  }
  return true;
}

/** The scripted tour. Every step uses public store actions or exported functions only. */
export const SHOW_STEPS: SeqStep[] = [
  { id: 'room', ms: 6000, run: async () => {
    if (S().mode === 'home') S().setMode('design');
    S().dispatch({ type: 'REPLACE_MODEL', model: sampleRoom() });
    S().setCandidates([]); S().setView('split'); tab('design', 'describe');
  } },
  { id: 'design', ms: 22000, timeoutMs: 40000, run: async (c) => {
    tab('design', 'describe');
    const typed = await typeBrief(c);
    window.dispatchEvent(new CustomEvent('spacelens:request', { detail: BRIEF }));
    await until(c, () => S().candidates.length > 0, typed ? 22000 : 8000);
    if (!S().candidates.length) {
      const { designThemedRoom } = await import('../themes/designThemed');
      const res = await designThemedRoom(S().model, BRIEF);
      S().setCandidates(res.candidates, res.infeasibility);
    }
    tab('design', 'layouts');
    const best = [...S().candidates].sort((a, b) => (b.metrics.score ?? 0) - (a.metrics.score ?? 0))[0];
    if (!best) throw new Error('no layouts');
    await c.wait(1500);
    S().applyCandidate(best.id);
  } },
  { id: 'orbit', ms: 9000, run: async () => {
    S().setView('3d');
    window.dispatchEvent(new Event('spacelens:auto-tour'));
  } },
  { id: 'forge', ms: 11000, timeoutMs: 30000, run: async () => {
    tab('design', 'create');
    const [{ generateObject }, { placeSpec }] = await Promise.all([import('../forge/generate'), import('../forge/library')]);
    placeSpec(await generateObject(CAT_TREE, { detail: false }));
  } },
  { id: 'safety', ms: 6000, run: async () => { tab('experience', 'safety'); } },
  { id: 'movein', ms: 6000, run: async () => { tab('deliver', 'movein'); } },
  { id: 'villa', ms: 12000, timeoutMs: 25000, run: async () => {
    const { loadDemo } = await import('../building/demo');
    if (!(await loadDemo('villa', false))) throw new Error('villa');
    S().setCandidates([]); tab('design', 'layouts'); S().setView('3d');
  } },
  { id: 'home', ms: 3000, run: async () => { S().setMode('home'); } },
];
const TOTAL = SHOW_STEPS.reduce((a, s) => a + s.ms, 0);

/** Hands-free tour: ?show=1 or the spacelens:show event. Esc or any click stops it. */
export function ShowRunner() {
  const [on, setOn] = useState(false);
  const [idx, setIdx] = useState(0);
  const [pct, setPct] = useState(0);
  const ac = useRef<AbortController | null>(null);

  useEffect(() => {
    const start = () => {
      if (ac.current) return;
      const ctl = new AbortController(); ac.current = ctl;
      const t0 = Date.now(); setOn(true); setIdx(0); setPct(0);
      const tick = setInterval(() => setPct(Math.min(100, ((Date.now() - t0) / TOTAL) * 100)), 200);
      const armed = Date.now() + 600;
      const stop = () => { if (Date.now() >= armed) ctl.abort(); };
      const key = (e: KeyboardEvent) => { if (e.key === 'Escape') ctl.abort(); };
      window.addEventListener('pointerdown', stop, true);
      window.addEventListener('keydown', key, true);
      void runSequence(SHOW_STEPS, ctl.signal, { onStep: (i) => setIdx(i) }).finally(() => {
        clearInterval(tick);
        window.removeEventListener('pointerdown', stop, true);
        window.removeEventListener('keydown', key, true);
        ac.current = null; setOn(false);
      });
    };
    window.addEventListener('spacelens:show', start);
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('show') === '1') setTimeout(start, 800);
    return () => window.removeEventListener('spacelens:show', start);
  }, []);

  if (!on) return null;
  return (
    <div role="progressbar" aria-label="Tour" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}
      style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 95, pointerEvents: 'none', padding: '0 0 10px' }}>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 8 }}>
        {SHOW_STEPS.map((s, i) => (
          <span key={s.id} style={{ width: 8, height: 8, borderRadius: '50%', background: i <= idx ? 'var(--accent, #3b82f6)' : 'var(--border, #8884)', opacity: i === idx ? 1 : 0.6, transform: i === idx ? 'scale(1.3)' : 'none' }} />
        ))}
      </div>
      <div style={{ height: 3, background: 'var(--border, #8884)' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent, #3b82f6)', transition: 'width 200ms linear' }} />
      </div>
    </div>
  );
}
