import { useMemo, useRef, useState } from 'react';
import { useStore } from '../../core/store';
import { bounds, fmtM2, fmtSek, itemCorners } from '../../core/geometry';
import type { LayoutCandidate, SpaceModel } from '../../core/types';
import { validateLayout } from '../referee/validate';
import { crossover } from './solver';
import { designRoom } from '../design/pipeline';
import { useReports } from '../design/reportStore';
import { DecisionsPanel, shortLabel } from '../design/DecisionsPanel';
import { notify } from '../../ui/notify';
import { useUi } from '../../ui/uiStore';
import { showLayouts } from './progress';
import './layout.css';


/** 0-100 score as a thin ring. */
function ScoreRing({ value }: { value: number }) {
  const r = 13, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, Math.round(value)));
  const tone = v >= 80 ? 'var(--ok)' : v >= 60 ? 'var(--warn)' : 'var(--bad)';
  return (
    <svg className="layout-ring" width={32} height={32} viewBox="0 0 32 32" role="img" aria-label={`Score ${v} of 100`}>
      <circle cx={16} cy={16} r={r} fill="none" stroke="var(--line)" strokeWidth={2} />
      <circle cx={16} cy={16} r={r} fill="none" stroke={tone} strokeWidth={2} strokeLinecap="round"
        strokeDasharray={`${(c * v) / 100} ${c}`} transform="rotate(-90 16 16)" />
      <text x={16} y={16} textAnchor="middle" dominantBaseline="central" fontSize={10} fill="currentColor">{v}</text>
    </svg>
  );
}

function Thumb({ model, cand, scale }: { model: SpaceModel; cand: LayoutCandidate; scale: number }) {
  const sp = model.spaces[0]; if (!sp) return null;
  const b = bounds(sp.polygon);
  const pts = (ps: { x: number; y: number }[]) => ps.map((p) => `${((p.x - b.minX) * scale).toFixed(1)},${((p.y - b.minY) * scale).toFixed(1)}`).join(' ');
  return (
    <svg className="layout-thumb" width={(b.maxX - b.minX) * scale + 2} height={(b.maxY - b.minY) * scale + 2} aria-label={cand.name}>
      <polygon points={pts(sp.polygon)} fill="none" stroke="var(--muted)" />
      {cand.furniture.map((f) => <polygon key={f.id} points={pts(itemCorners(f))} fill={f.color} opacity={0.8} />)}
    </svg>
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
      notify('Could not make layouts. Nothing changed.', {
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
      else notify('These two do not combine into a layout that fits.', { tone: 'warn', actions: [{ label: 'Pick another pair', run: () => setPins([]) }] });
    } catch (e) {
      console.error(e);
      notify('Could not combine these two.', { tone: 'warn', actions: [{ label: 'Try again', primary: true, run: () => void combine() }] });
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
                  <button key={r.label} className={`btn btn-sm${i === 0 ? ' btn-primary' : ''}`} disabled={busy} onClick={() => void regenerate({ ...req, ...r.patch })}>{r.label}</button>
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
      </div>
    );
  }

  const sp = model.spaces[0];
  const bb = sp ? bounds(sp.polygon) : null;
  const scale = bb ? 110 / Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY) : 30;

  return (
    <div className="panel layout-panel">
      {stale && (
        <div className="layout-stale">
          <span className="chip chip-warn">Outdated</span>
          <button className="btn btn-sm" disabled={busy || !req} onClick={() => void regenerate()}>Regenerate</button>
        </div>
      )}
      <div className="layout-toolbar">
        <span className="muted">{candidates.length} layout{candidates.length > 1 ? 's' : ''}</span>
        {(current || busy) && <span className="layout-progress" role="status" title={current?.label}><i aria-hidden="true" />Working</span>}
        <button className="btn btn-sm btn-ghost" aria-pressed={compare} onClick={() => { setCompare((c) => !c); setPins([]); }}>{compare ? 'Done' : 'Compare'}</button>
      </div>
      {compare && (
        <div className="layout-combine muted">
          <span>Pick 2 ({pins.length}/2)</span>
          <button className="btn btn-sm" disabled={busy || pins.length !== 2} onClick={combine}>Combine</button>
        </div>
      )}
      {compare && sp && (
        <div className="layout-compare">
          {candidates.map((c) => (
            <figure key={c.id} className={c.id === activeId ? 'on' : ''} onClick={() => useStore.getState().previewCandidate(c.id)}>
              <Thumb model={model} cand={c} scale={scale} />
              <figcaption>{shortLabel(c.name)}<br />{fmtM2(c.metrics.openAreaM2)} free</figcaption>
            </figure>
          ))}
        </div>
      )}
      <div className="layout-cards">
        {candidates.map((c, i) => {
          // Two layouts with the same short name get a letter so they can be told apart.
          const short = shortLabel(c.name);
          const label = candidates.filter((o) => shortLabel(o.name) === short).length > 1 ? `${short} ${String.fromCharCode(65 + i)}` : short;
          const nowFail = recheck.get(c.id) ?? 0;
          const rep = reports[c.id];
          return (
            <div key={c.id} className={`layout-card${c.id === activeId ? ' on' : ''}`} onClick={() => useStore.getState().previewCandidate(c.id)}>
              {sp && <Thumb model={model} cand={c} scale={scale * 0.6} />}
              <div className="layout-card-body">
                <div className="layout-card-head">
                  <strong title={c.name}>{label}</strong>
                  {nowFail > 0 && <span className="chip chip-bad">{nowFail} fail</span>}
                  <ScoreRing value={c.metrics.score} />
                </div>
                <div className="layout-foot">
                  <span>{fmtSek(c.metrics.costSek)}</span>
                  {compare && (
                    <button className="btn btn-sm btn-ghost" aria-pressed={pins.includes(c.id)} onClick={(e) => { e.stopPropagation(); togglePin(c.id); }}>
                      {pins.includes(c.id) ? 'Picked' : 'Pick'}
                    </button>
                  )}
                  {appliedId === c.id
                    ? <span className="chip chip-ok">Applied</span>
                    : <button className="btn btn-sm btn-primary" onClick={(e) => { e.stopPropagation(); useStore.getState().applyCandidate(c.id); }}>Apply</button>}
                </div>
                {rep && c.id === activeId && <DecisionsPanel report={rep} />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
