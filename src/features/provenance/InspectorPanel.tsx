import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../../core/store';
import { fmtCm, fmtM2, fmtSek, parseWallId, perimeter, uid, wallLength } from '../../core/geometry';
import type { Evidence, Measurement, Op, Requirements, SpaceModel } from '../../core/types';
import {
  SOURCE_WORDS, STATUS_CHIP, diffSnaps, evaluateWall, layoutsOf, measurementFor, roomArea, snapshot, uncertainWalls, wallName,
  type Diff, type Snap,
} from './logic';
import { ObjectActions } from '../objects/ObjectActions';
import { Icon } from '../../ui/icons';
import './provenance.css';

function Num({ value, onCommit, step = 1, suffix = 'cm', min = 0, max = 100000, label }: {
  value: number; onCommit: (v: number) => void; step?: number; suffix?: string; min?: number; max?: number; label?: string;
}) {
  const [t, setT] = useState(String(value));
  useEffect(() => setT(String(value)), [value]);
  const n = parseFloat(t.replace(',', '.'));
  const err = !isFinite(n) ? 'Enter a number' : n < min ? `Min ${min}` : n > max ? `Max ${max}` : '';
  const commit = () => { if (!err && n !== value) onCommit(n); else setT(String(value)); };
  const bump = (dir: number) => {
    const base = isFinite(n) ? n : value; const v = Math.min(max, Math.max(min, base + dir * step));
    setT(String(v)); if (v !== value) onCommit(v);
  };
  return (
    <span className={`provenance-numwrap${err ? ' invalid' : ''}`} title={err || undefined}>
      <button type="button" className="provenance-step" onClick={() => bump(-1)} aria-label={`Decrease ${label ?? ''}`}>−</button>
      <input className="provenance-num" inputMode="decimal" value={t} aria-label={label} aria-invalid={!!err}
        onChange={(e) => setT(e.target.value)} onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
          else if (e.key === 'Escape') { setT(String(value)); requestAnimationFrame(() => (e.target as HTMLInputElement).blur()); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); bump(1); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); bump(-1); }
        }} />
      <span className="provenance-suffix">{suffix}</span>
      <button type="button" className="provenance-step" onClick={() => bump(1)} aria-label={`Increase ${label ?? ''}`}>+</button>
      {err && <span className="provenance-err" role="alert">{err}</span>}
    </span>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="field provenance-field"><span>{label}</span>{children}</div>;
}

const OPEN_KEY = 'spacelens.inspector.open.v2';
function readOpen(): Record<string, boolean> { try { return JSON.parse(localStorage.getItem(OPEN_KEY) || '{}'); } catch { return {}; } }
function Section({ id, title, count, defaultOpen = false, children }: {
  id: string; title: string; count?: number; defaultOpen?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(() => readOpen()[id] ?? defaultOpen);
  const toggle = () => {
    const v = !open; setOpen(v);
    try { localStorage.setItem(OPEN_KEY, JSON.stringify({ ...readOpen(), [id]: v })); } catch { /* storage off */ }
  };
  return (
    <section className="provenance-section">
      <button className="provenance-head" onClick={toggle} aria-expanded={open}>
        <Icon className="provenance-caret" name={open ? 'chevronDown' : 'chevronRight'} size={12} aria-hidden />{title}
        {count != null && <span className="provenance-count">{count}</span>}
      </button>
      {open && <div className="provenance-body">{children}</div>}
    </section>
  );
}
const EV_ICON: Record<Evidence['kind'], string> = { photo: 'camera', pdf: 'file', image: 'image', manual: 'ruler', sample: 'sparkles' };
const cm = (m: number) => Math.round(m * 100);

function DiffCard({ d, title, before, after, onUndo }: { d: Diff; title: string; before?: Snap; after?: Snap; onUndo?: () => void }) {
  const nothing = !d.invalid.length && !d.fixed.length && Math.abs(d.areaDelta) < 0.005 && !d.costDelta;
  const sign = (v: number) => (v > 0 ? '+' : '');
  return (
    <div className="provenance-diff">
      <div className="row"><b>{title}</b>{onUndo && <button className="btn btn-sm" onClick={onUndo}>Undo</button>}</div>
      {before && after && (
        <table className="provenance-ba"><thead><tr><th /><th>Before</th><th>After</th></tr></thead><tbody>
          <tr><td>Area</td><td>{fmtM2(before.area)}</td><td className={Math.abs(d.areaDelta) >= 0.005 ? 'chg' : ''}>{fmtM2(after.area)}</td></tr>
          <tr><td>Cost</td><td>{fmtSek(before.cost)}</td><td className={d.costDelta ? 'chg' : ''}>{fmtSek(after.cost)}</td></tr>
          <tr><td>Layouts OK</td><td>{before.ok.size}</td><td className={before.ok.size !== after.ok.size ? 'chg' : ''}>{after.ok.size}</td></tr>
        </tbody></table>
      )}
      {nothing && <div className="muted">No checks changed.</div>}
      {d.invalid.length > 0 && <div className="bad">Became invalid: {d.invalid.join('; ')}</div>}
      {d.fixed.length > 0 && <div className="ok">Now passes: {d.fixed.join('; ')}</div>}
      {!before && Math.abs(d.areaDelta) >= 0.005 && <div>Area {sign(d.areaDelta)}{d.areaDelta.toFixed(2)} m²</div>}
      {!before && d.costDelta !== 0 && <div>Cost {sign(d.costDelta)}{fmtSek(d.costDelta)}</div>}
    </div>
  );
}

function drawEvidence(c: HTMLCanvasElement, ev: Evidence, maxW: number) {
  const img = new Image();
  img.onload = () => {
    const s = Math.min(1, maxW / img.width);
    c.width = img.width * s; c.height = img.height * s;
    const g = c.getContext('2d'); if (!g) return;
    g.drawImage(img, 0, 0, c.width, c.height);
    if (ev.bbox) {
      const [x, y, w, h] = ev.bbox;
      g.strokeStyle = '#ff4d6d'; g.lineWidth = Math.max(2, c.width / 150);
      g.strokeRect(x * c.width, y * c.height, w * c.width, h * c.height);
    }
  };
  img.src = ev.imageUrl!;
}

function EvidenceThumb({ ev }: { ev: Evidence }) {
  const small = useRef<HTMLCanvasElement>(null); const big = useRef<HTMLCanvasElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (small.current) drawEvidence(small.current, ev, 320); }, [ev]);
  useEffect(() => { if (open && big.current) drawEvidence(big.current, ev, window.innerWidth * 0.9); }, [open, ev]);
  return (
    <>
      <canvas ref={small} className="provenance-thumb" onClick={() => setOpen(true)} role="button" aria-label={`Evidence: ${ev.label}. Click to enlarge`} />
      {open && <div className="provenance-modal" onClick={() => setOpen(false)} role="dialog" aria-label={ev.label}><canvas ref={big} /></div>}
    </>
  );
}

const GEO_OPS = ['SET_WALL_LENGTH', 'MOVE_VERTEX', 'INSERT_VERTEX', 'REMOVE_VERTEX', 'UPDATE_OPENING', 'SET_MEASUREMENT'];

function Provenance({ targetId, measurementId, sourceKind, status, valueM }: {
  targetId: string; measurementId?: string; sourceKind: Measurement['sourceKind']; status: Measurement['status']; valueM: number;
}) {
  const model = useStore((s) => s.model); const changes = useStore((s) => s.changes);
  const candidates = useStore((s) => s.candidates); const dispatch = useStore((s) => s.dispatch);
  const meas = measurementFor(model, targetId, measurementId);
  const evs = meas ? model.evidence.filter((e) => meas.evidenceIds.includes(e.id)) : [];
  const lastGeo = [...changes].reverse().find((c) => GEO_OPS.includes(c.op));
  const stale = candidates.filter((c) => lastGeo && c.parentVersion < lastGeo.version);
  const isWall = !!parseWallId(targetId);
  const isGeo = isWall || model.openings.some((o) => o.id === targetId);
  const usedBy: string[] = [];
  if (isWall) usedBy.push(`Room area (${fmtM2(roomArea(model))})`);
  if (isGeo) usedBy.push('Route and clearance checks');
  if (candidates.length) usedBy.push(`${candidates.length} layouts${stale.length ? `, ${stale.length} made before the last edit` : ''}`);
  if (model.furniture.some((f) => f.id === targetId)) usedBy.push('Total cost');
  const markMeasured = () => {
    const evId = uid('ev');
    dispatch({ type: 'ADD_EVIDENCE', evidence: { id: evId, kind: 'manual', label: 'Marked as measured', createdAt: Date.now() } });
    dispatch({ type: 'SET_MEASUREMENT', measurement: {
      id: uid('m'), label: targetId, valueM, sourceKind: 'user-measured', status: 'verified', evidenceIds: [evId], targetId,
    } });
  };
  const sk = meas?.sourceKind ?? sourceKind; const st = meas?.status ?? status;
  return (
    <Section id="source" title="Source">
      <div className="provenance-chips">
        <span className="chip">{SOURCE_WORDS[sk]}</span>
        <span className={`chip ${STATUS_CHIP[st]}`}>{st}</span>
        {meas?.toleranceM != null && <span className="chip">±{cm(meas.toleranceM)} cm</span>}
      </div>
      {evs.length > 0 && <ol className="provenance-timeline">{[...evs].sort((a, b) => b.createdAt - a.createdAt).map((e) => (
        <li key={e.id}>
          <span className="provenance-ico" aria-hidden><Icon name={EV_ICON[e.kind] ?? 'file'} size={12} /></span>
          <div>
            <div>{e.label}{e.page ? `, page ${e.page}` : ''}</div>
            {e.imageUrl && <EvidenceThumb ev={e} />}
            {e.note && <div className="muted">{e.note}</div>}
          </div>
        </li>
      ))}</ol>}
      {!evs.length && (
        <div className="row"><span className="muted">No evidence yet</span>
          <button className="btn btn-sm" onClick={markMeasured}>Mark as measured</button></div>
      )}
      {usedBy.length > 0 && <div className="muted">Used by: {usedBy.join(', ')}</div>}
    </Section>
  );
}

function Uncertainty() {
  const model = useStore((s) => s.model); const candidates = useStore((s) => s.candidates);
  const req = useStore((s) => s.requirements); const select = useStore((s) => s.select);
  const res = useMemo(() => {
    const layouts = layoutsOf(model, candidates);
    return uncertainWalls(model).map((w) => ({ w, verdicts: evaluateWall(model, w, layouts, req) }));
  }, [model, candidates, req]);
  if (!res.length) return null;
  const open = (v: { holds: boolean }[]) => v.filter((x) => !x.holds).length;
  const best = [...res].sort((a, b) => open(b.verdicts) - open(a.verdicts))[0];
  const bestCount = open(best.verdicts);
  return (
    <Section id="uncertainty" title="Uncertainty" count={res.length}>
      {res.map(({ w, verdicts }) => (
        <div key={w.id} className="card">
          <b>{w.name}</b> {fmtCm(w.len)} ±{cm(w.tol)} cm {!w.calibrated && <span className="chip">heuristic</span>}
          <ul className="list">{verdicts.map((v) => <li key={v.layout} className={v.holds ? '' : 'muted'}>{v.layout}: {v.text}</li>)}</ul>
          {!verdicts.length && <div className="muted">No layouts to check yet</div>}
        </div>
      ))}
      {bestCount > 0 && (
        <div className="row"><span>Measure {best.w.name} next · {bestCount} layouts</span>
          <button className="btn btn-sm btn-primary" onClick={() => select({ kind: 'wall', id: best.w.id })}>Select</button></div>
      )}
    </Section>
  );
}

function defaultReq(): Requirements {
  return { purpose: 'living', people: 2, budgetSek: null, items: [], routeTargets: [], minRouteWidthM: 0.8, style: '', lockedIds: [], notes: [], questions: [], compiledBy: 'rules' };
}

function WhatIf() {
  const [diff, setDiff] = useState<{ label: string; d: Diff; undoable: boolean; before: Snap; after: Snap } | null>(null);
  const run = (label: string, op: Op | null, reqPatch?: Partial<Requirements>) => {
    const s = useStore.getState();
    const before = snapshot(s.model, layoutsOf(s.model, s.candidates), s.requirements);
    let nextModel = s.model; let nextReq = s.requirements;
    if (op) { s.dispatch(op); nextModel = useStore.getState().model; }
    if (reqPatch) { nextReq = { ...(s.requirements ?? defaultReq()), ...reqPatch }; s.setRequirements(nextReq); }
    const after = snapshot(nextModel, layoutsOf(nextModel, s.candidates), nextReq);
    setDiff({ label, undoable: !!op, before, after, d: diffSnaps(before, after) });
    if (!op) prevReq.current = s.requirements;
  };
  const prevReq = useRef<Requirements | null>(null);
  const narrower = () => {
    const sp = useStore.getState().model.spaces[0]; if (!sp) return;
    let i = -1;
    sp.walls.forEach((_, k) => { const l = wallLength(sp, k); if (l > 1 && (i < 0 || l < wallLength(sp, i))) i = k; });
    if (i < 0) return;
    run('Room 30 cm narrower', { type: 'SET_WALL_LENGTH', spaceId: sp.id, wallIndex: i, lengthM: wallLength(sp, i) - 0.3, sourceKind: 'manual' });
  };
  const door = () => {
    const d = useStore.getState().model.openings.find((o) => o.kind === 'door'); if (!d) return;
    run('Door 10 cm wider', { type: 'UPDATE_OPENING', id: d.id, patch: { widthM: d.widthM + 0.1 } });
  };
  const budget = () => {
    const s = useStore.getState();
    const cur = s.requirements?.budgetSek ?? s.model.furniture.reduce((a, f) => a + f.priceSek, 0);
    run('Budget minus 2 000 kr', null, { budgetSek: Math.max(0, cur - 2000) });
  };
  const undo = () => {
    if (diff?.undoable) useStore.getState().undo(); else useStore.getState().setRequirements(prevReq.current);
    setDiff(null);
  };
  return (
    <Section id="whatif" title="What-if">
      <div className="provenance-actions">
        <button className="btn btn-sm" onClick={narrower}>Room 30 cm narrower</button>
        <button className="btn btn-sm" onClick={door}>Door 10 cm wider</button>
        <button className="btn btn-sm" onClick={budget}>Budget minus 2 000 kr</button>
        <button className="btn btn-sm" onClick={() => run('Wheelchair first', null, { minRouteWidthM: 0.9 })}>Wheelchair first</button>
      </div>
      {diff && <DiffCard d={diff.d} title={diff.label} before={diff.before} after={diff.after} onUndo={undo} />}
    </Section>
  );
}

// Change history: diff checks between consecutive models, recorded as they happen.
const changeDiffs = new Map<number, Diff>();
const isGeoChange = (a: SpaceModel, b: SpaceModel) => a.spaces !== b.spaces || a.openings !== b.openings || a.ceilingM !== b.ceilingM;
useStore.subscribe((s, prev) => {
  if (s.model === prev.model || !isGeoChange(prev.model, s.model)) return;
  changeDiffs.set(s.model.version, diffSnaps(
    snapshot(prev.model, layoutsOf(prev.model, s.candidates), s.requirements),
    snapshot(s.model, layoutsOf(s.model, s.candidates), s.requirements),
  ));
});

function History() {
  const changes = useStore((s) => s.changes);
  if (!changes.length) return null;
  return (
    <Section id="history" title="History" count={changes.length}>
      {<ul className="list provenance-hist">{[...changes].reverse().map((c) => {
        const d = changeDiffs.get(c.version);
        return <li key={`${c.version}-${c.at}`}>v{c.version} {c.label}{d && <DiffCard d={d} title="What changed" />}</li>;
      })}</ul>}
    </Section>
  );
}

function Selected() {
  const model = useStore((s) => s.model); const sel = useStore((s) => s.selection);
  const dispatch = useStore((s) => s.dispatch); const select = useStore((s) => s.select);
  if (sel?.kind === 'wall') {
    const p = parseWallId(sel.id); const sp = p ? model.spaces.find((s) => s.id === p.spaceId) : undefined;
    const w = p && sp ? sp.walls[p.wallIndex] : undefined;
    if (p && sp && w) {
      const L = wallLength(sp, p.wallIndex);
      return (<>
        <h3>{wallName(sp, p.wallIndex)}</h3>
        <div className="provenance-sheet">
        <Field label="Length"><Num label="Length" value={cm(L)} onCommit={(v) => dispatch({ type: 'SET_WALL_LENGTH', spaceId: sp.id, wallIndex: p.wallIndex, lengthM: v / 100, sourceKind: 'user-measured' })} /></Field>
        <Field label="Thickness"><span>{fmtCm(w.thicknessM)}</span></Field>
        </div>
        <Provenance targetId={sel.id} measurementId={w.measurementId} sourceKind={w.sourceKind} status={w.status} valueM={L} />
      </>);
    }
  }
  if (sel?.kind === 'opening') {
    const o = model.openings.find((x) => x.id === sel.id);
    if (o) {
      const up = (patch: Partial<typeof o>) => dispatch({ type: 'UPDATE_OPENING', id: o.id, patch });
      return (<>
        <div className="provenance-title"><h3>{o.kind[0].toUpperCase() + o.kind.slice(1)}</h3>
          <button className="icon-btn" title="Delete" aria-label="Delete" onClick={() => { dispatch({ type: 'REMOVE_OPENING', id: o.id }); select(null); }}><Icon name="trash" size={14} /></button></div>
        <div className="provenance-sheet">
        <div>
          <Field label="Width"><Num label="Width" value={cm(o.widthM)} onCommit={(v) => up({ widthM: v / 100 })} /></Field>
          <Field label="Height"><Num label="Height" value={cm(o.heightM)} onCommit={(v) => up({ heightM: v / 100 })} /></Field>
          <Field label="Sill"><Num label="Sill" value={cm(o.sillM)} onCommit={(v) => up({ sillM: v / 100 })} /></Field>
          <Field label="Offset"><Num label="Offset" value={cm(o.offsetM)} onCommit={(v) => up({ offsetM: v / 100 })} /></Field>
          <label className="field provenance-field">Swing <select value={o.swing} onChange={(e) => up({ swing: e.target.value as typeof o.swing })}>
            <option value="in">In</option><option value="out">Out</option><option value="none">None</option></select></label>
          <label className="field provenance-field">Hinge <select value={o.hinge} onChange={(e) => up({ hinge: e.target.value as typeof o.hinge })}>
            <option value="start">Start</option><option value="end">End</option></select></label>
        </div>
        </div>
        <Provenance targetId={o.id} measurementId={o.measurementId} sourceKind={o.sourceKind} status={o.status} valueM={o.widthM} />
      </>);
    }
  }
  if (sel?.kind === 'furniture') {
    const f = model.furniture.find((x) => x.id === sel.id);
    if (f) {
      const up = (patch: Partial<typeof f>) => dispatch({ type: 'UPDATE_OBJECT', id: f.id, patch });
      return (<>
        <div className="provenance-title"><h3>{f.name}</h3>
          <button className="icon-btn" title="Delete" aria-label="Delete" onClick={() => { dispatch({ type: 'REMOVE_OBJECT', id: f.id }); select(null); }}><Icon name="trash" size={14} /></button></div>
        <ObjectActions itemId={f.id} />
        <div className="provenance-sheet">
        <div>
          <Field label="Width"><Num label="Width" value={cm(f.w)} onCommit={(v) => up({ w: v / 100 })} /></Field>
          <Field label="Depth"><Num label="Depth" value={cm(f.d)} onCommit={(v) => up({ d: v / 100 })} /></Field>
          <Field label="Height"><Num label="Height" value={cm(f.h)} onCommit={(v) => up({ h: v / 100 })} /></Field>
          <Field label="Rotation"><Num label="Rotation" value={Math.round((f.rotation * 180) / Math.PI)} suffix="°" min={-360} max={360} step={15} onCommit={(v) => up({ rotation: (v * Math.PI) / 180 })} /></Field>
        </div>
        <div className="provenance-checks">
          <label><input type="checkbox" checked={f.locked} onChange={(e) => up({ locked: e.target.checked })} /> Locked</label>
          <label><input type="checkbox" checked={f.owned} onChange={(e) => up({ owned: e.target.checked })} /> Owned</label>
        </div>
        <Field label="Price"><span>{fmtSek(f.priceSek)} <span className="muted">{f.priceStatus}</span></span></Field>
        </div>
        <Provenance targetId={f.id} sourceKind={f.sourceKind} status={f.sourceKind === 'catalog' ? 'estimated' : 'verified'} valueM={f.w} />
      </>);
    }
  }
  const counts = { verified: 0, estimated: 0, unknown: 0, conflicting: 0 };
  model.spaces.forEach((s) => s.walls.forEach((w) => { counts[w.status]++; }));
  return (<>
    <h3>{model.name}</h3>
    <div className="provenance-sheet">
    <Field label="Area"><span>{fmtM2(roomArea(model))}</span></Field>
    <Field label="Perimeter"><span>{model.spaces.reduce((a, s) => a + perimeter(s.polygon), 0).toFixed(2)} m</span></Field>
    <Field label="Ceiling"><Num label="Ceiling" value={cm(model.ceilingM)} onCommit={(v) => dispatch({ type: 'SET_CEILING', heightM: v / 100 })} /></Field>
    <div className="provenance-chips">
      {(Object.keys(counts) as (keyof typeof counts)[]).filter((k) => counts[k]).map((k) => (
        <span key={k} className={`chip ${STATUS_CHIP[k]}`}>{counts[k]} {k}</span>
      ))}
    </div>
    <Field label="Source"><span>{model.sourceLabel}</span></Field>
    </div>
  </>);
}

export function InspectorPanel() {
  return (
    <div className="provenance">
      <Selected />
      <Uncertainty />
      <WhatIf />
      <History />
    </div>
  );
}
