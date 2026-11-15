import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore, useShownFurniture } from '../../core/store';
import type { FurnitureItem, LayoutCandidate } from '../../core/types';
import { Icon, type IconName } from '../../ui/icons';
import { isRug } from '../sim/grid';
import { planMoveIn, VERDICT_LABEL, type MoveItem, type Verdict } from './plan';
import { buildMoveTimeline, frameAt, SECONDS_PER_ITEM, summarize } from './timeline';
import './movein.css';

const VERDICT_ICON: Record<Verdict, IconName> = { fits: 'check', tilt: 'rotate', assemble: 'ruler', wont: 'x' };
const PREVIEW_ID = 'movein-preview';
const SPEEDS = [1, 2, 4] as const;
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const prefersReduced = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

interface Saved { cand: string | null; list: LayoutCandidate[]; passage: ReturnType<typeof useStore.getState>['analysis']['passage']; highlights: ReturnType<typeof useStore.getState>['analysis']['highlights'] }

export function MoveInPanel() {
  const model = useStore((s) => s.model);
  const live = useShownFurniture();
  // while the time-lapse runs the plan is built from the furniture as it was before the preview
  const [frozen, setFrozen] = useState<FurnitureItem[] | null>(null);
  const furniture = frozen ?? live;
  const [flat, setFlat] = useState<ReadonlySet<string>>(new Set());
  const [picked, setPicked] = useState<string | null>(null);
  const plan = useMemo(() => planMoveIn(model, furniture, { flat }), [model, furniture, flat]);
  const tl = useMemo(() => buildMoveTimeline(plan), [plan]);
  const summary = useMemo(() => summarize(plan, furniture), [plan, furniture]);

  const [t, setT] = useState(0);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [active, setActive] = useState(false);
  const saved = useRef<Saved | null>(null);
  const lastSlot = useRef<string | null>(null);
  const reduced = useMemo(prefersReduced, []);

  const begin = useCallback(() => {
    if (saved.current) return;
    const st = useStore.getState();
    saved.current = { cand: st.activeCandidateId, list: st.candidates, passage: st.analysis.passage, highlights: st.analysis.highlights };
    setFrozen(live);
    setActive(true);
  }, [live]);

  const end = useCallback(() => {
    setRunning(false);
    lastSlot.current = null;
    const sv = saved.current;
    if (!sv) return;
    saved.current = null;
    useStore.setState({ candidates: sv.list, activeCandidateId: sv.cand });
    useStore.getState().setAnalysis({ passage: sv.passage, highlights: sv.highlights });
    setActive(false); setFrozen(null); setT(0);
  }, []);
  const endRef = useRef(end);
  endRef.current = end;

  // never leave the preview behind: unmount, Esc, mode or view change
  useEffect(() => {
    const unsub = useStore.subscribe((s, prev) => { if (saved.current && (s.mode !== prev.mode || s.view !== prev.view)) endRef.current(); });
    return () => { unsub(); endRef.current(); };
  }, []);
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') end(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, end]);

  useEffect(() => {
    if (!running) return;
    let raf = 0, last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      setT((cur) => {
        const nx = cur + dt * speed;
        if (nx >= tl.total) { setRunning(false); return tl.total; }
        return nx;
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running, speed, tl.total]);

  // with reduced motion each item simply appears in place, one per beat
  const shownT = reduced ? Math.min(tl.total, (Math.floor(t / SECONDS_PER_ITEM + 1e-6) + (t > 0 ? 1 : 0)) * SECONDS_PER_ITEM) : t;
  const frame = useMemo(() => frameAt(tl, shownT), [tl, shownT]);

  // push the current frame into the store as a preview candidate; the real model is never touched
  useEffect(() => {
    const sv = saved.current;
    if (!active || !sv) return;
    const byId = new Map(furniture.map((f) => [f.id, f]));
    const out: FurnitureItem[] = frame.placed.map((id) => byId.get(id)).filter((f): f is FurnitureItem => !!f);
    const { slot, p } = frame;
    const st = useStore.getState();
    if (slot) {
      const f = byId.get(slot.id), m = plan.items[slot.index];
      if (f && m) {
        const step = m.steps.find((x) => x.openingId === slot.tightId) ?? m.steps[0];
        const poses = step?.result.poses ?? [];
        const small = slot.flatPack ? 0.5 : 1;
        let x = f.x, y = f.y, rotation = f.rotation, k = small;
        if (!reduced) {
          if (slot.enters && p < 0.75 && poses.length) {
            const q = (p / 0.75) * (poses.length - 1), i = Math.min(Math.max(poses.length - 2, 0), Math.floor(q));
            const pa = poses[i], pb = poses[Math.min(poses.length - 1, i + 1)];
            x = lerp(pa.x, pb.x, q - i); y = lerp(pa.y, pb.y, q - i); rotation = lerp(pa.rotation, pb.rotation, q - i);
          } else if (slot.enters) {
            const lp = Math.min(1, Math.max(0, (p - 0.75) / 0.25)), last = poses[poses.length - 1];
            if (last) { x = lerp(last.x, f.x, lp); y = lerp(last.y, f.y, lp); rotation = lerp(last.rotation, f.rotation, lp); }
            k = lerp(small, 1, lp);
          } else {
            const stop = poses[Math.max(0, Math.min(poses.length - 1, Math.floor(p * poses.length)))];
            if (stop) { x = stop.x; y = stop.y; rotation = stop.rotation; }
          }
        } else if (!slot.enters) k = small;
        else k = 1;
        out.push({ ...f, x, y, rotation, w: f.w * k, d: f.d * k, h: f.h * k });
        if (lastSlot.current !== slot.id) {
          lastSlot.current = slot.id;
          const tightId = slot.tightId;
          st.setAnalysis({
            passage: step ? { ...step.result, itemId: slot.id, ok: slot.enters ? step.result.ok : false } : null,
            highlights: !slot.enters && tightId ? [{ ids: [tightId], color: '#e5484d', label: '' }] : [],
          });
        }
      }
    } else if (lastSlot.current) {
      lastSlot.current = null;
      st.setAnalysis({ passage: null, highlights: [] });
    }
    if (frame.done) for (const f of furniture) if (isRug(f)) out.push(f);
    const cand: LayoutCandidate = {
      id: PREVIEW_ID, name: '', summary: '', parentVersion: st.model.version, furniture: out,
      metrics: { openAreaM2: 0, costSek: 0, minClearanceM: null, routeLenM: null, score: 0 },
      checks: [], assumptions: [], generator: 'movein',
    };
    useStore.setState({ candidates: [...sv.list.filter((c) => c.id !== PREVIEW_ID), cand], activeCandidateId: PREVIEW_ID });
  }, [active, frame, furniture, plan, reduced]);

  const togglePlay = () => {
    begin();
    if (running) { setRunning(false); return; }
    if (t >= tl.total) setT(0);
    setRunning(true);
  };
  const scrub = (v: number) => { begin(); setRunning(false); setT(v); };

  const show = (m: MoveItem) => {
    if (active) return;
    setPicked(m.id);
    const step = m.steps.find((s) => s.openingId === m.tightId) ?? m.steps[0];
    if (step) useStore.getState().setAnalysis({ passage: { ...step.result, itemId: m.id } });
  };
  const toggleFlat = (id: string) => setFlat((cur) => { const n = new Set(cur); if (!n.delete(id)) n.add(id); return n; });

  if (!plan.items.length) return <div className="movein"><p className="movein-empty" aria-label="No items"><Icon name="sofa" size={20} /></p></div>;
  const landed = (id: string) => frame.placed.includes(id) || frame.stopped.includes(id);
  return (
    <div className="movein">
      <div className="movein-bar">
        <button className="btn btn-sm btn-primary" onClick={togglePlay} aria-label={running ? 'Pause' : 'Play'}><Icon name={running ? 'pause' : 'play'} size={14} /></button>
        <input className="movein-scrub" type="range" min={0} max={tl.total} step={0.01} value={t} onChange={(e) => scrub(Number(e.target.value))} aria-label="Timeline" />
        <span className="movein-speeds" role="group" aria-label="Speed">
          {SPEEDS.map((v) => <button key={v} className="btn btn-sm btn-ghost" aria-pressed={speed === v} onClick={() => setSpeed(v)}>{v}x</button>)}
        </span>
        <button className="btn btn-sm btn-ghost" onClick={end} disabled={!active} aria-label="Stop"><Icon name="x" size={14} /></button>
      </div>
      {active && <div className="movein-bar">
        {active && frame.slot?.tilt && frame.p < 0.5 && <span className="movein-chip warn" aria-label="Tilt"><Icon name="rotate" size={12} /></span>}
        {active && frame.slot && !frame.slot.enters && <span className="movein-chip bad pulse" aria-label="Won't fit"><Icon name="x" size={12} /></span>}
      </div>}
      <ol className="movein-list">
        {plan.items.map((m, i) => (
          <li key={m.id} className={`movein-row v-${m.verdict}${picked === m.id ? ' on' : ''}${active ? (landed(m.id) ? ' landed' : frame.slot?.id === m.id ? ' now' : ' later') : ''}`}>
            <button className="movein-main" onClick={() => show(m)} aria-label={`${m.name}, ${VERDICT_LABEL[m.verdict]}, ${m.tight}`}>
              <span className="movein-n">{active && landed(m.id) ? <Icon name={frame.placed.includes(m.id) ? 'check' : 'x'} size={12} /> : i + 1}</span>
              <Icon name={m.name.toLowerCase().includes('sofa') ? 'sofa' : 'cube'} size={16} />
              <span className="movein-name">{m.name}</span>
              <span className="movein-tag" title={VERDICT_LABEL[m.verdict]}><Icon name={VERDICT_ICON[m.verdict]} size={14} /></span>
              {m.verdict !== 'fits' && <span className="movein-door"><Icon name="door" size={12} />{m.tight}</span>}
            </button>
            <button className="btn btn-sm btn-ghost" aria-pressed={m.flat} onClick={() => toggleFlat(m.id)}>Flat-pack</button>
          </li>
        ))}
      </ol>
      {active && frame.done && (
        <div className="movein-summary" aria-label="Summary">
          <span className="movein-chip ok" aria-label="Fits"><Icon name="check" size={12} />{summary.fits}</span>
          <span className="movein-chip warn" aria-label="Tilt"><Icon name="rotate" size={12} />{summary.tilt}</span>
          <span className="movein-chip warn" aria-label="Assemble inside"><Icon name="ruler" size={12} />{summary.assemble}</span>
          <span className="movein-chip bad" aria-label="Won't fit"><Icon name="x" size={12} />{summary.wont}</span>
          {summary.widest && <span className="movein-chip" aria-label="Widest item and tightest door"><Icon name="door" size={12} />{summary.widest.name} · {summary.widest.door}</span>}
        </div>
      )}
    </div>
  );
}
