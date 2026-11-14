import { useMemo, useState } from 'react';
import { useStore } from '../../core/store';
import { bounds, fmtM2, fmtSek, itemCorners } from '../../core/geometry';
import type { LayoutCandidate, SpaceModel } from '../../core/types';
import { validateLayout } from '../referee/validate';
import { crossover, generateLayouts } from './solver';
import './layout.css';

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

  const stale = candidates.length > 0 && candidates.some((c) => c.parentVersion < model.version);
  const recheck = useMemo(() => {
    const m = new Map<string, number>();
    if (!stale) return m;
    for (const c of candidates) m.set(c.id, validateLayout(model, c.furniture, req).filter((r) => r.result === 'fail').length);
    return m;
  }, [stale, candidates, model, req]);

  const regenerate = async () => {
    if (!req) return;
    setBusy(true);
    try {
      const { candidates: c, infeasibility: inf } = await generateLayouts(model, req, { seed: model.version + 1 });
      useStore.getState().setCandidates(c, inf);
    } finally { setBusy(false); }
  };
  const combine = async () => {
    const [a, b] = pins.map((id) => candidates.find((c) => c.id === id));
    if (!a || !b || !req) return;
    setBusy(true);
    try {
      const c = await crossover(a, b, model, req);
      const st = useStore.getState();
      if (c) { st.setCandidates([...st.candidates, c]); st.previewCandidate(c.id); setPins([]); }
      else st.toast('These two do not combine into a valid layout', 'warn');
    } finally { setBusy(false); }
  };
  const togglePin = (id: string) => setPins((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]));

  if (!candidates.length) {
    return (
      <div className="panel layout-panel">
        {infeasibility ? (
          <div className="layout-infeasible">
            <strong>No layout fits</strong>
            <ul className="list">{infeasibility.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            {req && infeasibility.relaxations.map((r) => (
              <button key={r.label} className="btn btn-sm" onClick={() => useStore.getState().setRequirements({ ...req, ...r.patch })}>{r.label}</button>
            ))}
            {req && <button className="btn btn-primary btn-sm" disabled={busy} onClick={regenerate}>Try again</button>}
          </div>
        ) : <p className="muted">No layouts yet.</p>}
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
          <span>Room changed since these were made.</span>
          <button className="btn btn-sm" disabled={busy || !req} onClick={regenerate}>Regenerate</button>
        </div>
      )}
      <div className="layout-toolbar">
        <span className="muted">{candidates.length} layout{candidates.length > 1 ? 's' : ''}</span>
        {busy && <span className="muted">Working...</span>}
        <button className="btn btn-sm btn-ghost" aria-pressed={compare} onClick={() => { setCompare((c) => !c); setPins([]); }}>{compare ? 'Done' : 'Compare'}</button>
      </div>
      {compare && (
        <div className="layout-combine muted">
          <span>Pick two to combine ({pins.length}/2)</span>
          <button className="btn btn-sm" disabled={busy || pins.length !== 2} onClick={combine}>Combine</button>
        </div>
      )}
      {compare && sp && (
        <div className="layout-compare">
          {candidates.map((c) => (
            <figure key={c.id} className={c.id === activeId ? 'on' : ''} onClick={() => useStore.getState().previewCandidate(c.id)}>
              <Thumb model={model} cand={c} scale={scale} />
              <figcaption>{c.name}<br />{fmtM2(c.metrics.openAreaM2)} open{c.metrics.routeLenM != null && ` · route ${c.metrics.routeLenM.toFixed(1)} m`}</figcaption>
            </figure>
          ))}
        </div>
      )}
      <div className="layout-cards">
        {candidates.map((c) => {
          const passed = c.checks.filter((r) => r.result === 'pass').length;
          const failed = c.checks.filter((r) => r.result === 'fail').length;
          const tone = failed > 0 ? 'chip-bad' : passed < c.checks.length ? 'chip-warn' : 'chip-ok';
          const nowFail = recheck.get(c.id) ?? 0;
          return (
            <div key={c.id} className={`layout-card${c.id === activeId ? ' on' : ''}`} onClick={() => useStore.getState().previewCandidate(c.id)}>
              {sp && <Thumb model={model} cand={c} scale={scale * 0.6} />}
              <div className="layout-card-body">
                <div className="layout-card-head">
                  <strong>{c.name}</strong>
                  <span className={`chip ${tone}`}>{passed}/{c.checks.length} checks</span>
                  {nowFail > 0 && <span className="chip chip-bad">{nowFail} now fail</span>}
                </div>
                <div className="muted layout-reason" title={c.summary}>{c.summary}</div>
                <div className="layout-foot">
                  <span>{fmtSek(c.metrics.costSek)}</span>
                  {compare && (
                    <button className="btn btn-sm btn-ghost" aria-pressed={pins.includes(c.id)} onClick={(e) => { e.stopPropagation(); togglePin(c.id); }}>
                      {pins.includes(c.id) ? 'Picked' : 'Pick'}
                    </button>
                  )}
                  <button className="btn btn-sm btn-primary" onClick={(e) => { e.stopPropagation(); useStore.getState().applyCandidate(c.id); }}>Apply</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
