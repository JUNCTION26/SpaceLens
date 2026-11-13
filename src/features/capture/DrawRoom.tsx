import { useMemo, useState } from 'react';
import { bounds, dist, uid } from '../../core/geometry';
import type { Measurement, Opening, Vec2, WallMeta } from '../../core/types';
import type { RoomDraft } from './build';

type Shape = 'rect' | 'L' | 'free';
interface Seg { len: number; turn: number }

function Num({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <label className="field capture-field">
      <span>{label}</span>
      <input type="number" inputMode="decimal" value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(parseFloat(e.target.value))} />
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
  const [door, setDoor] = useState({ on: true, wall: 0, offset: 60, width: 80 });
  const [win, setWin] = useState({ on: true, wall: 2, offset: 150, width: 120, sill: 90, height: 120 });

  const { poly, typed, closure } = useMemo(() => shapePolygon(shape, { W, D, cw, cd, segs }), [shape, W, D, cw, cd, segs]);
  const lens = poly.map((p, i) => dist(p, poly[(i + 1) % poly.length]));
  const valid = poly.length >= 3 && poly.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) && lens.every((l) => l > 0.05)
    && (shape !== 'L' || (cw < W && cd < D));

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
    const ev = { id: uid('ev'), kind: 'manual' as const, label: 'Typed measurements', note: `${shape === 'rect' ? 'Rectangle' : shape === 'L' ? 'L-shape' : 'Free shape'} entered in cm.`, createdAt: Date.now() };
    measurements.forEach((m) => { m.evidenceIds = [ev.id]; });
    onCreate({ polygon: poly, walls, openings, measurements, evidence: [ev] });
  };

  const b = bounds(poly.length ? poly : [{ x: 0, y: 0 }]);
  const pad = 0.4;
  const vb = `${b.minX - pad} ${b.minY - pad} ${Math.max(0.5, b.maxX - b.minX) + pad * 2} ${Math.max(0.5, b.maxY - b.minY) + pad * 2}`;
  const wallOpts = poly.map((_, i) => <option key={i} value={i}>Wall {i + 1} ({Math.round(lens[i] * 100)} cm)</option>);

  return (
    <div className="capture-draw">
      <div className="capture-seg" role="tablist">
        {(['rect', 'L', 'free'] as Shape[]).map((s) => (
          <button key={s} className={`btn btn-sm ${shape === s ? 'btn-primary' : ''}`} onClick={() => setShape(s)}>{s === 'rect' ? 'Rectangle' : s === 'L' ? 'L-shape' : 'Free'}</button>
        ))}
      </div>

      <svg className="capture-preview" viewBox={vb}>
        {valid && <polygon points={poly.map((p) => `${p.x},${p.y}`).join(' ')} className="capture-prevpoly" style={{ strokeWidth: thick / 100 }} />}
        {valid && poly.map((p, i) => {
          const q = poly[(i + 1) % poly.length];
          return <text key={i} x={(p.x + q.x) / 2} y={(p.y + q.y) / 2} className={`capture-prevtxt ${typed[i] ? '' : 'is-est'}`}>{i + 1}</text>;
        })}
      </svg>

      {shape === 'rect' && <div className="capture-grid"><Num label="Width (cm)" value={W} onChange={setW} /><Num label="Depth (cm)" value={D} onChange={setD} /></div>}
      {shape === 'L' && (
        <div className="capture-grid">
          <Num label="Overall width" value={W} onChange={setW} /><Num label="Overall depth" value={D} onChange={setD} />
          <Num label="Cut-out width" value={cw} onChange={setCw} /><Num label="Cut-out depth" value={cd} onChange={setCd} />
        </div>
      )}
      {shape === 'free' && (
        <div className="list">
          {segs.map((g, i) => (
            <div key={i} className="row capture-wrap">
              <span className="capture-mono">{i + 1}</span>
              <Num label="Length (cm)" value={g.len} onChange={(n) => setSegs(segs.map((x, j) => (j === i ? { ...x, len: n } : x)))} />
              <Num label="Then turn (°)" value={g.turn} onChange={(n) => setSegs(segs.map((x, j) => (j === i ? { ...x, turn: n } : x)))} />
              <button className="btn btn-sm btn-ghost" aria-label={`Remove wall ${i + 1}`} disabled={segs.length <= 3} onClick={() => setSegs(segs.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <div className="row capture-wrap">
            <button className="btn btn-sm" onClick={() => setSegs([...segs, { len: 100, turn: 90 }])}>Add wall</button>
            <span className={`chip ${closure < 0.01 ? 'chip-ok' : closure < 0.05 ? 'chip-warn' : 'chip-bad'}`}>Gap at the end: {Math.round(closure * 100)} cm</span>
          </div>
          {closure >= 0.01 && <p className="muted">A closing wall is added and marked as estimated.</p>}
        </div>
      )}

      <div className="capture-grid">
        <Num label="Ceiling (cm)" value={ceilingCm} onChange={setCeilingCm} />
        <Num label="Wall thickness (cm)" value={thick} onChange={setThick} />
      </div>

      <fieldset className="capture-fs">
        <legend><label><input type="checkbox" checked={door.on} onChange={(e) => setDoor({ ...door, on: e.target.checked })} /> Door</label></legend>
        {door.on && <div className="capture-grid">
          <label className="field capture-field"><span>Wall</span><select value={door.wall} onChange={(e) => setDoor({ ...door, wall: +e.target.value })}>{wallOpts}</select></label>
          <Num label="Centre from wall start" value={door.offset} onChange={(n) => setDoor({ ...door, offset: n })} />
          <Num label="Width" value={door.width} onChange={(n) => setDoor({ ...door, width: n })} />
        </div>}
        {!doorOk && <p className="chip chip-bad">Door doesn't fit on that wall.</p>}
      </fieldset>

      <fieldset className="capture-fs">
        <legend><label><input type="checkbox" checked={win.on} onChange={(e) => setWin({ ...win, on: e.target.checked })} /> Window</label></legend>
        {win.on && <div className="capture-grid">
          <label className="field capture-field"><span>Wall</span><select value={win.wall} onChange={(e) => setWin({ ...win, wall: +e.target.value })}>{wallOpts}</select></label>
          <Num label="Centre from wall start" value={win.offset} onChange={(n) => setWin({ ...win, offset: n })} />
          <Num label="Width" value={win.width} onChange={(n) => setWin({ ...win, width: n })} />
          <Num label="Sill height" value={win.sill} onChange={(n) => setWin({ ...win, sill: n })} />
          <Num label="Height" value={win.height} onChange={(n) => setWin({ ...win, height: n })} />
        </div>}
        {!winOk && <p className="chip chip-bad">Window doesn't fit on that wall.</p>}
      </fieldset>

      <button className="btn btn-primary capture-big" disabled={!valid || !doorOk || !winOk || !(ceilingCm > 150)} onClick={create}>Create room</button>
    </div>
  );
}
