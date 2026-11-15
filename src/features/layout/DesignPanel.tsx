import { shortRelax } from './relax';
import { useMemo, useRef, useState } from 'react';
import { caseFor, whyText } from './caseFor';
import { Chips, CheckRing, CompareView, PlanThumb, ringAround } from './LayoutCard';
import { speak } from '../agent/speech';
import { useSketch } from '../agent/sketchStore';
import { mark } from '../agent/actions';
import { useStore } from '../../core/store';
import { fmtSek } from '../../core/geometry';
import type { LayoutCandidate, SpaceModel } from '../../core/types';
import { validateLayout } from '../referee/validate';
import { crossover } from './solver';
import { designRoom } from '../design/pipeline';
import { useReports } from '../design/reportStore';
import { DecisionsPanel } from '../design/DecisionsPanel';
import { notify } from '../../ui/notify';
import { useUi } from '../../ui/uiStore';
import { Icon } from '../../ui/icons';
import { showLayouts } from './progress';
import { SharePoll } from '../vote/VoteUi';
import { TastePanel } from '../taste/TastePanel';
import './layout.css';


function TasteDisclosure() {
  return (
    <details className="layout-taste">
      <summary>Taste</summary>
      <TastePanel />
    </details>
  );
}

export function DesignPanel() {
  const model = useStore((s) => s.model);
  const candidates = useStore((s) => s.candidates);
  const activeId = useStore((s) => s.activeCandidateId);
  const req = useStore((s) => s.requirements);
  const infeasibility = useStore((s) => s.infeasibility);
  const [compare, setCompare] = useState(false);
  const [pins, setPins] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const base = useRef<string | null>(null);
  const reports = useReports((s) => s.reports);
  const running = useReports((s) => s.running);
  const stages = useReports((s) => s.stages);
  const current = running ? stages.find((x) => x.status === 'running') : undefined;

  // Layouts go stale when the room itself changes, not when furniture moves (applying one moves furniture).
  const roomSig = JSON.stringify([model.spaces.map((s) => s.polygon), model.openings.map((o) => [o.wallIndex, o.offsetM, o.widthM, o.kind]), model.ceilingM]);
  const madeFor = useRef<{ cands: LayoutCandidate[]; sig: string } | null>(null);
  if (madeFor.current?.cands !== candidates) madeFor.current = { cands: candidates, sig: roomSig };
  const stale = candidates.length > 0 && madeFor.current.sig !== roomSig;
  const appliedId = candidates.find((c) => c.furniture.length === model.furniture.length && c.furniture.every((f) => {
    const g = model.furniture.find((x) => x.id === f.id);
    return !!g && Math.abs(g.x - f.x) < 1e-3 && Math.abs(g.y - f.y) < 1e-3;
  }))?.id;
  const recheck = useMemo(() => {
    const m = new Map<string, number>();
    if (!stale) return m;
    for (const c of candidates) m.set(c.id, validateLayout(model, c.furniture, req).filter((r) => r.result === 'fail').length);
    return m;
  }, [stale, candidates, model, req]);

  const regenerate = async (override?: typeof req) => {
    const r = override ?? req;
    if (!r) return;
    if (override) useStore.getState().setRequirements(override);
    setBusy(true);
    try {
      // Rule-based layouts arrive in a few seconds; model concepts and the second opinion update them in place.
      const res = await designRoom(useStore.getState().model, r, { variants: 3, onStage: (s) => useReports.getState().setStages(s, true), onProgress: (p) => showLayouts(p) });
      showLayouts(res);
    } catch (e) {
      console.error(e);
      notify('Layouts failed', {
        tone: 'warn', actions: [{ label: 'Try again', primary: true, run: () => void regenerate(r) }, { label: 'Edit the brief', run: () => useUi.getState().openSection('describe') }],
      });
    } finally { setBusy(false); useReports.getState().setStages(useReports.getState().stages, false); }
  };
  const combine = async () => {
    const [a, b] = pins.map((id) => candidates.find((c) => c.id === id));
    if (!a || !b || !req) return;
    setBusy(true);
    try {
      const c = await crossover(a, b, model, req);
      const st = useStore.getState();
      if (c) { st.setCandidates([...st.candidates, c]); st.previewCandidate(c.id); setPins([]); }
      else notify('These do not combine', { tone: 'warn', actions: [{ label: 'Pick another pair', run: () => setPins([]) }] });
    } catch (e) {
      console.error(e);
      notify('Combine failed', { tone: 'warn', actions: [{ label: 'Try again', primary: true, run: () => void combine() }] });
    } finally { setBusy(false); }
  };
  const togglePin = (id: string) => setPins((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]));

  if (!candidates.length) {
    return (
      <div className="panel layout-panel">
        {infeasibility ? (
          <div className="layout-infeasible">
            <strong>Does not fit</strong>
            {req && (
              <div className="layout-actions">
                {infeasibility.relaxations.slice(0, 3).map((r, i) => (
                  <button key={r.label} className={`btn btn-sm${i === 0 ? ' btn-primary' : ''}`} disabled={busy} onClick={() => void regenerate({ ...req, ...r.patch })} title={r.label}>{shortRelax(r.label)}</button>
                ))}
                <button className="btn btn-sm btn-ghost" onClick={() => useUi.getState().openSection('describe')}>Edit brief</button>
              </div>
            )}
          </div>
        ) : (
          <div className="layout-empty">
            <strong>{req ? 'No layouts yet' : 'No brief yet'}</strong>
            {req
              ? <button className="btn btn-primary" disabled={busy} onClick={() => void regenerate()}>{busy ? 'Working' : 'Make layouts'}</button>
              : <button className="btn btn-primary" onClick={() => useUi.getState().openSection('describe')}>Describe</button>}
          </div>
        )}
        <TasteDisclosure />
      </div>
    );
  }

  const sp = model.spaces[0];
  const cases = new Map(candidates.map((c) => [c.id, caseFor(c, reports[c.id], model, candidates.filter((x) => x.id !== c.id))]));
  const pair = pins.length === 2 ? pins.map((id) => candidates.find((c) => c.id === id)) : [];
  const holdPreview = (id: string) => { if (base.current === null) base.current = useStore.getState().activeCandidateId ?? ''; useStore.getState().previewCandidate(id); };
  const releasePreview = () => { if (base.current !== null) { useStore.getState().previewCandidate(base.current || null); base.current = null; } };
  const choose = (id: string) => { base.current = null; useStore.getState().previewCandidate(id); };
  const why = (c: LayoutCandidate) => {
    const k = cases.get(c.id); if (!k) return;
    void speak(whyText(k, c));
    const big = [...c.furniture].sort((x, y) => y.w * y.d - x.w * x.d).slice(0, 2);
    useSketch.getState().addMany(big.map((f, i) => mark('circle', ringAround(f), { delayMs: i * 250 })));
  };

  return (
    <div className="panel layout-panel">
      {stale && (
        <div className="layout-stale">
          <button className="btn btn-sm" disabled={busy || !req} onClick={() => void regenerate()}>Regenerate</button>
        </div>
      )}
      <div className="layout-toolbar">
        <span />
        {(current || busy) && <span className="layout-progress" role="status" aria-label="Working"><i aria-hidden="true" /></span>}
        <button className="btn btn-sm btn-ghost" aria-pressed={compare} onClick={() => { setCompare((c) => !c); setPins([]); }}>{compare ? 'Done' : 'Compare'}</button>
        <SharePoll />
      </div>
      {compare && (
        <div className="layout-combine muted">
          <span>Pick 2 ({pins.length}/2)</span>
          <button className="btn btn-sm" disabled={busy || pins.length !== 2} onClick={combine}>Combine</button>
        </div>
      )}
      {compare && pair[0] && pair[1] && (
        <CompareView model={model} a={pair[0]} b={pair[1]} ca={cases.get(pair[0].id)!} cb={cases.get(pair[1].id)!} />
      )}
      <div className="layout-cards">
        {candidates.map((c, i) => {
          const k = cases.get(c.id)!;
          const nowFail = recheck.get(c.id) ?? 0;
          const rep = reports[c.id];
          const degraded = Boolean((c as { degraded?: unknown }).degraded) || k.leftOut.length > 0;
          const on = c.id === activeId;
          return (
            <div key={c.id} className={`layout-card${on ? ' on' : ''}${appliedId === c.id ? ' applied' : ''}${degraded ? ' degraded' : ''}`} style={{ animationDelay: `${i * 70}ms` }}
              tabIndex={0} role="button" aria-label={k.title} aria-pressed={on}
              onClick={() => choose(c.id)} onMouseEnter={() => holdPreview(c.id)} onMouseLeave={releasePreview} onFocus={() => holdPreview(c.id)} onBlur={releasePreview}
              onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); choose(c.id); } }}>
              {sp && <PlanThumb model={model} cand={c} size={92} />}
              <div className="layout-card-body">
                <div className="layout-card-head">
                  <strong title={c.name}>{k.title}</strong>
                  {nowFail > 0 && <span className="chip chip-bad">{nowFail} fail</span>}
                  <CheckRing passed={k.passed} total={k.total} degraded={degraded} />
                </div>
                <Chips c={k} degraded={degraded} />
                <div className="layout-foot">
                  <span>{fmtSek(c.metrics.costSek)}</span>
                  {compare && (
                    <button className="btn btn-sm btn-ghost" aria-pressed={pins.includes(c.id)} onClick={(e) => { e.stopPropagation(); togglePin(c.id); }}>
                      {pins.includes(c.id) ? 'Picked' : 'Pick'}
                    </button>
                  )}
                  {on && <button className="btn btn-sm btn-ghost" onClick={(e) => { e.stopPropagation(); why(c); }}>Why</button>}
                  {appliedId === c.id
                    ? <button className="btn btn-sm" disabled aria-label="Applied"><Icon name="check" size={14} /></button>
                    : <button className="btn btn-sm btn-primary" onClick={(e) => { e.stopPropagation(); base.current = null; useStore.getState().applyCandidate(c.id); }}>Apply</button>}
                </div>
                {rep && on && <DecisionsPanel report={rep} />}
              </div>
            </div>
          );
        })}
      </div>
      <TasteDisclosure />
    </div>
  );
}
