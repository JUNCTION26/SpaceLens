import { useMemo, useState } from 'react';
import { bounds, closestPointOnSegment, dist, uid } from '../../core/geometry';
import type { Measurement, Opening, Vec2, WallMeta } from '../../core/types';
import type { RoomDraft } from './build';

type Shape = 'rect' | 'L' | 'U' | 'T' | 'free';
type Unit = 'cm' | 'm';
const SHAPES: { id: Shape; label: string; pts: string }[] = [
  { id: 'rect', label: 'Rectangle', pts: '4,4 28,4 28,24 4,24' },
  { id: 'L', label: 'L-shape', pts: '4,4 18,4 18,12 28,12 28,24 4,24' },
  { id: 'U', label: 'U-shape', pts: '4,4 11,4 11,14 21,14 21,4 28,4 28,24 4,24' },
  { id: 'T', label: 'T-shape', pts: '4,4 28,4 28,11 20,11 20,24 12,24 12,11 4,11' },
  { id: 'free', label: 'Custom', pts: '4,8 16,4 28,10 24,24 6,22' },
];
interface Seg { len: number; turn: number }

function Num({ label, value, onChange, unit }: { label: string; value: number; onChange: (n: number) => void; unit?: Unit }) {
  const k = unit === 'm' ? 100 : 1;
  return (
    <label className="field capture-field">
      <span>{label}{unit ? ` (${unit})` : ''}</span>
      <input type="number" inputMode="decimal" step={unit === 'm' ? 0.01 : 1} value={Number.isFinite(value) ? +(value / k).toFixed(3) : ''} onChange={(e) => onChange(parseFloat(e.target.value) * k)} />
    </label>
  );
}

/** Polygon (metres) plus which walls came straight from a typed length. */
function shapePolygon(shape: Shape, s: { W: number; D: number; cw: number; cd: number; segs: Seg[] }): { poly: Vec2[]; typed: boolean[]; closure: number } {
  const W = s.W / 100, D = s.D / 100, cw = s.cw / 100, cd = s.cd / 100;
  if (shape === 'rect') return { poly: [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: D }, { x: 0, y: D }], typed: [true, true, true, true], closure: 0 };
  if (shape === 'L') {
    return { poly: [{ x: 0, y: 0 }, { x: W - cw, y: 0 }, { x: W - cw, y: cd }, { x: W, y: cd }, { x: W, y: D }, { x: 0, y: D }], typed: Array(6).fill(true), closure: 0 };
  }
  if (shape === 'U') {
    const a = (W - cw) / 2;
    return { poly: [{ x: 0, y: 0 }, { x: a, y: 0 }, { x: a, y: cd }, { x: a + cw, y: cd }, { x: a + cw, y: 0 }, { x: W, y: 0 }, { x: W, y: D }, { x: 0, y: D }], typed: Array(8).fill(true), closure: 0 };
  }
  if (shape === 'T') {
    const a = (W - cw) / 2;
    return { poly: [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: cd }, { x: a + cw, y: cd }, { x: a + cw, y: D }, { x: a, y: D }, { x: a, y: cd }, { x: 0, y: cd }], typed: Array(8).fill(true), closure: 0 };
  }
  // Free: walk the typed walls, turning right (clockwise on screen) by each angle.
  const pts: Vec2[] = [{ x: 0, y: 0 }];
  let h = 0;
  for (const g of s.segs) {
    const p = pts[pts.length - 1];
    pts.push({ x: p.x + Math.cos(h) * g.len / 100, y: p.y + Math.sin(h) * g.len / 100 });
    h += (g.turn * Math.PI) / 180;
  }
  const end = pts.pop()!;
  const closure = dist(end, pts[0]);
  // Last typed wall ends where the closing wall starts; if it doesn't meet the start, a closing wall is added.
  if (closure < 0.01) return { poly: pts, typed: pts.map(() => true), closure };
  pts.push(end);
  return { poly: pts, typed: pts.map((_, i) => i < pts.length - 1), closure };
}

export function DrawRoom({ onCreate, ceilingCm, setCeilingCm }: { onCreate: (d: RoomDraft) => void; ceilingCm: number; setCeilingCm: (n: number) => void }) {
  const [shape, setShape] = useState<Shape>('rect');
  const [W, setW] = useState(340);
  const [D, setD] = useState(420);
  const [cw, setCw] = useState(120);
  const [cd, setCd] = useState(150);
  const [segs, setSegs] = useState<Seg[]>([{ len: 400, turn: 90 }, { len: 300, turn: 90 }, { len: 400, turn: 90 }, { len: 300, turn: 90 }]);
  const [thick, setThick] = useState(12);
  const [unit, setUnit] = useState<Unit>('cm');
  const [pickWall, setPickWall] = useState<{ wall: number; offset: number } | null>(null);
  const [door, setDoor] = useState({ on: true, wall: 0, offset: 60, width: 80 });
  const [win, setWin] = useState({ on: true, wall: 2, offset: 150, width: 120, sill: 90, height: 120 });

  const { poly, typed, closure } = useMemo(() => shapePolygon(shape, { W, D, cw, cd, segs }), [shape, W, D, cw, cd, segs]);
  const lens = poly.map((p, i) => dist(p, poly[(i + 1) % poly.length]));
  const valid = poly.length >= 3 && poly.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) && lens.every((l) => l > 0.05)
    && (shape === 'rect' || shape === 'free' || (cw < W && cd < D));
  const fmt = (m: number) => (unit === 'm' ? `${m.toFixed(2)} m` : `${Math.round(m * 100)} cm`);
  const problem = !valid ? (shape !== 'rect' && shape !== 'free' && !(cw < W && cd < D) ? 'The inner part must be smaller than the overall size.' : 'Every wall must be longer than 5 cm.')
    : !(ceilingCm > 150) ? 'Ceiling must be over 150 cm.' : null;

  const openingFits = (o: { wall: number; offset: number; width: number }) => o.wall < poly.length && o.offset / 100 >= o.width / 200 && o.offset / 100 + o.width / 200 <= lens[o.wall] + 1e-6;
  const doorOk = !door.on || openingFits(door);
  const winOk = !win.on || openingFits(win);

  const create = () => {
    const measurements: Measurement[] = [];
    const walls: WallMeta[] = poly.map((_, i) => {
      if (!typed[i]) return { thicknessM: thick / 100, sourceKind: 'manual', status: 'estimated' };
      measurements.push({ id: uid('ms'), label: `Wall ${i + 1}`, valueM: lens[i], sourceKind: 'user-measured', status: 'verified', toleranceM: 0.01, evidenceIds: [], targetId: `#${i}` });
      return { thicknessM: thick / 100, sourceKind: 'user-measured', status: 'verified' };
    });
    const openings: Omit<Opening, 'spaceId'>[] = [];
    const mk = (kind: 'door' | 'window', o: { wall: number; offset: number; width: number }, heightM: number, sillM: number) => {
      const mid = uid('ms');
      measurements.push({ id: mid, label: `${kind === 'door' ? 'Door' : 'Window'} width`, valueM: o.width / 100, sourceKind: 'user-measured', status: 'verified', toleranceM: 0.01, evidenceIds: [] });
      openings.push({ id: uid(kind), kind, wallIndex: o.wall, offsetM: o.offset / 100, widthM: o.width / 100, heightM, sillM, swing: kind === 'door' ? 'in' : 'none', hinge: 'start', sourceKind: 'user-measured', status: 'verified', measurementId: mid });
      measurements[measurements.length - 1].targetId = openings[openings.length - 1].id;
    };
    if (door.on) mk('door', door, 2.0, 0);
    if (win.on) mk('window', win, win.height / 100, win.sill / 100);
    // Typed values are their own evidence: record one manual entry and link every measurement to it.
    const ev = { id: uid('ev'), kind: 'manual' as const, label: 'Typed measurements', note: `${SHAPES.find((x) => x.id === shape)?.label ?? 'Shape'} entered in ${unit}.`, createdAt: Date.now() };
    measurements.forEach((m) => { m.evidenceIds = [ev.id]; });
    onCreate({ polygon: poly, walls, openings, measurements, evidence: [ev] });
  };

  const b = bounds(poly.length ? poly : [{ x: 0, y: 0 }]);
  const pad = 0.4;
  const vb = `${b.minX - pad} ${b.minY - pad} ${Math.max(0.5, b.maxX - b.minX) + pad * 2} ${Math.max(0.5, b.maxY - b.minY) + pad * 2}`;
  const wallOpts = poly.map((_, i) => <option key={i} value={i}>Wall {i + 1} ({fmt(lens[i])})</option>);
  const fs = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1) * 0.045;
  const clickPreview = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget, ctm = svg.getScreenCTM();
    if (!ctm || !valid) return;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    let best = -1, bd = Infinity, bt = 0;
    poly.forEach((a, i) => { const c = closestPointOnSegment(pt, a, poly[(i + 1) % poly.length]); const d = dist(pt, c.point); if (d < bd) { bd = d; best = i; bt = c.t; } });
    if (best >= 0 && bd < fs * 3) setPickWall({ wall: best, offset: Math.round(bt * lens[best] * 100) });
    else setPickWall(null);
  };
  const putOpening = (k: 'door' | 'window') => {
    if (!pickWall) return;
    const w = k === 'door' ? door.width : win.width;
    const off = Math.min(lens[pickWall.wall] * 100 - w / 2, Math.max(w / 2, pickWall.offset));
    if (k === 'door') setDoor({ ...door, on: true, wall: pickWall.wall, offset: Math.round(off) });
    else setWin({ ...win, on: true, wall: pickWall.wall, offset: Math.round(off) });
    setPickWall(null);
  };
  const opMark = (o: { on: boolean; wall: number; offset: number; width: number }, cls: string) => {
    if (!o.on || o.wall >= poly.length) return null;
    const a = poly[o.wall], q = poly[(o.wall + 1) % poly.length], L = lens[o.wall] || 1;
    const t0 = (o.offset - o.width / 2) / 100 / L, t1 = (o.offset + o.width / 2) / 100 / L;
    return <line x1={a.x + (q.x - a.x) * t0} y1={a.y + (q.y - a.y) * t0} x2={a.x + (q.x - a.x) * t1} y2={a.y + (q.y - a.y) * t1} className={cls} style={{ strokeWidth: thick / 100 + 0.04 }} />;
  };

  return (
    <div className="capture-draw">
      <div className="capture-tiles" role="radiogroup" aria-label="Room shape">
        {SHAPES.map((t) => (
          <button key={t.id} role="radio" aria-checked={shape === t.id} className={`capture-tile ${shape === t.id ? 'is-on' : ''}`} onClick={() => setShape(t.id)}>
            <svg viewBox="0 0 32 28" aria-hidden="true"><polygon points={t.pts} /></svg>
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <div className="row capture-wrap">
        <span className="muted capture-small">Units</span>
        <div className="capture-seg capture-units">
          {(['cm', 'm'] as Unit[]).map((u) => <button key={u} className={`btn btn-sm ${unit === u ? 'btn-primary' : ''}`} aria-pressed={unit === u} onClick={() => setUnit(u)}>{u}</button>)}
        </div>
      </div>

      <svg className="capture-preview" viewBox={vb} onClick={clickPreview} role="img" aria-label="Room preview">
        {valid && <polygon points={poly.map((p) => `${p.x},${p.y}`).join(' ')} className="capture-prevpoly" style={{ strokeWidth: thick / 100 }} />}
        {valid && poly.map((p, i) => {
          const q = poly[(i + 1) % poly.length];
          return <text key={i} x={(p.x + q.x) / 2} y={(p.y + q.y) / 2} className={`capture-prevtxt ${typed[i] ? '' : 'is-est'}`} style={{ fontSize: fs }}>{i + 1}: {fmt(lens[i])}</text>;
        })}
        {valid && opMark(door, 'capture-prevdoor')}
        {valid && opMark(win, 'capture-prevwin')}
        {pickWall && valid && (() => { const a = poly[pickWall.wall], q = poly[(pickWall.wall + 1) % poly.length], t = pickWall.offset / 100 / (lens[pickWall.wall] || 1); return <circle cx={a.x + (q.x - a.x) * t} cy={a.y + (q.y - a.y) * t} r={fs * 0.6} className="capture-prevpick" />; })()}
      </svg>

      {pickWall && (
        <div className="row capture-wrap capture-pick">
          <span>Wall {pickWall.wall + 1}, {fmt(pickWall.offset / 100)} from start:</span>
          <button className="btn btn-sm" onClick={() => putOpening('door')}>Door here</button>
          <button className="btn btn-sm" onClick={() => putOpening('window')}>Window here</button>
          <button className="btn btn-sm btn-ghost" onClick={() => setPickWall(null)}>Cancel</button>
        </div>
      )}

      {shape === 'rect' && <div className="capture-grid"><Num label="Width" unit={unit} value={W} onChange={setW} /><Num label="Depth" unit={unit} value={D} onChange={setD} /></div>}
      {(shape === 'L' || shape === 'U' || shape === 'T') && (
        <div className="capture-grid">
          <Num label="Overall width" unit={unit} value={W} onChange={setW} /><Num label="Overall depth" unit={unit} value={D} onChange={setD} />
          <Num label={shape === 'L' ? 'Cut-out width' : shape === 'U' ? 'Notch width' : 'Stem width'} unit={unit} value={cw} onChange={setCw} />
          <Num label={shape === 'L' ? 'Cut-out depth' : shape === 'U' ? 'Notch depth' : 'Top bar depth'} unit={unit} value={cd} onChange={setCd} />
        </div>
      )}
      {shape === 'free' && (
        <div className="list">
          {segs.map((g, i) => (
            <div key={i} className="row capture-wrap">
              <span className="capture-mono">{i + 1}</span>
              <Num label="Length" unit={unit} value={g.len} onChange={(n) => setSegs(segs.map((x, j) => (j === i ? { ...x, len: n } : x)))} />
              <Num label="Then turn (°)" value={g.turn} onChange={(n) => setSegs(segs.map((x, j) => (j === i ? { ...x, turn: n } : x)))} />
              <button className="btn btn-sm btn-ghost" aria-label={`Remove wall ${i + 1}`} disabled={segs.length <= 3} onClick={() => setSegs(segs.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <div className="row capture-wrap">
            <button className="btn btn-sm" onClick={() => setSegs([...segs, { len: 100, turn: 90 }])}>Add wall</button>
            <span className={`chip ${closure < 0.01 ? 'chip-ok' : closure < 0.05 ? 'chip-warn' : 'chip-bad'}`}>Gap at the end: {fmt(closure)}</span>
          </div>
          {closure >= 0.01 && <p className="muted">A closing wall is added and marked as estimated.</p>}
        </div>
      )}

      <details className="capture-more" open={!doorOk || !winOk || undefined}>
        <summary>More options</summary>
        <p className="muted capture-small">Tap a wall in the preview to place a door or window.</p>
      <div className="capture-grid">
          <Num label="Ceiling" unit={unit} value={ceilingCm} onChange={setCeilingCm} />
          <Num label="Wall thickness" unit={unit} value={thick} onChange={setThick} />
        </div>
  
        <fieldset className="capture-fs">
          <legend><label><input type="checkbox" checked={door.on} onChange={(e) => setDoor({ ...door, on: e.target.checked })} /> Door</label></legend>
          {door.on && <div className="capture-grid">
            <label className="field capture-field"><span>Wall</span><select value={door.wall} onChange={(e) => setDoor({ ...door, wall: +e.target.value })}>{wallOpts}</select></label>
            <Num label="Centre from wall start" unit={unit} value={door.offset} onChange={(n) => setDoor({ ...door, offset: n })} />
            <Num label="Width" unit={unit} value={door.width} onChange={(n) => setDoor({ ...door, width: n })} />
          </div>}
          {!doorOk && <p className="chip chip-bad">Door doesn't fit on that wall.</p>}
        </fieldset>
  
        <fieldset className="capture-fs">
          <legend><label><input type="checkbox" checked={win.on} onChange={(e) => setWin({ ...win, on: e.target.checked })} /> Window</label></legend>
          {win.on && <div className="capture-grid">
            <label className="field capture-field"><span>Wall</span><select value={win.wall} onChange={(e) => setWin({ ...win, wall: +e.target.value })}>{wallOpts}</select></label>
            <Num label="Centre from wall start" unit={unit} value={win.offset} onChange={(n) => setWin({ ...win, offset: n })} />
            <Num label="Width" unit={unit} value={win.width} onChange={(n) => setWin({ ...win, width: n })} />
            <Num label="Sill height" unit={unit} value={win.sill} onChange={(n) => setWin({ ...win, sill: n })} />
            <Num label="Height" unit={unit} value={win.height} onChange={(n) => setWin({ ...win, height: n })} />
          </div>}
          {!winOk && <p className="chip chip-bad">Window doesn't fit on that wall.</p>}
        </fieldset>
      </details>

      {problem && <p className="chip chip-bad capture-msg">{problem}</p>}
      <button className="btn btn-primary capture-big" disabled={!valid || !doorOk || !winOk || !(ceilingCm > 150)} onClick={create}>Create room</button>
    </div>
  );
}
