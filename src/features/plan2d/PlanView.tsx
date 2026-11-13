import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore, useShownFurniture } from '../../core/store';
import {
  add, area, bounds, centroid, closestPointOnSegment, convexOverlap, dist, fmtCm, fmtM2, itemCorners, lerp, mul, norm,
  openingSegment, perp, polygonInside, sub, uid, wallId, wallInwardNormal, wallLength, wallSegment,
} from '../../core/geometry';
import type { FurnitureItem, Layers, Opening, SourceKind, Space, Vec2 } from '../../core/types';
import './plan2d.css';

type VB = { x: number; y: number; w: number; h: number };
type Drag =
  | { kind: 'pan'; start: Vec2; vb: VB; sx: number; sy: number }
  | { kind: 'vertex'; spaceId: string; index: number; pos: Vec2; moved: boolean }
  | { kind: 'item'; id: string; off: Vec2; pos: Vec2; moved: boolean }
  | { kind: 'rotate'; id: string; rot: number };

const SNAP = 0.05;
const snap = (n: number, s = SNAP) => Math.round(n / s) * s;
const pts = (p: Vec2[]) => p.map((q) => `${q.x},${q.y}`).join(' ');

const PROV: Record<SourceKind, string> = {
  'user-measured': '#2fbf71', 'ar-depth': '#3fa7ff', 'photo-inferred': '#f0a030', 'pdf-annotation': '#a77bff',
  manual: '#5ed1c9', catalog: '#9aa4b2', generated: '#e86fb0', sample: '#8a8f98',
};
const PROV_LABEL: Record<SourceKind, string> = {
  'user-measured': 'Measured', 'ar-depth': 'Phone scan', 'photo-inferred': 'From photo', 'pdf-annotation': 'From drawing',
  manual: 'Manual', catalog: 'Catalog', generated: 'Generated', sample: 'Sample',
};

/** Parse "320", "3.2", "3.2m", "320cm". Bare numbers above 10 are centimetres. */
export function parseLength(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(',', '.');
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(cm|mm|m)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = m[2] ?? (n > 10 ? 'cm' : 'm');
  const v = u === 'cm' ? n / 100 : u === 'mm' ? n / 1000 : n;
  return v > 0.05 && v < 100 ? v : null;
}

function fitBox(spaces: Space[]): VB {
  const all = spaces.flatMap((s) => s.polygon);
  if (!all.length) return { x: -1, y: -1, w: 6, h: 5 };
  const b = bounds(all) as { minX: number; minY: number; maxX: number; maxY: number };
  const pad = Math.max(0.8, 0.12 * Math.max(b.maxX - b.minX, b.maxY - b.minY));
  return { x: b.minX - pad, y: b.minY - pad, w: b.maxX - b.minX + pad * 2, h: b.maxY - b.minY + pad * 2 };
}

export function PlanView() {
  const model = useStore((s) => s.model);
  const layers = useStore((s) => s.layers);
  const selection = useStore((s) => s.selection);
  const analysis = useStore((s) => s.analysis);
  const activeCandidateId = useStore((s) => s.activeCandidateId);
  const { dispatch, select, toggleLayer, applyCandidate, toast } = useStore.getState();
  const shown = useShownFurniture();

  const svgRef = useRef<SVGSVGElement>(null);
  const [vb, setVb] = useState<VB>(() => fitBox(model.spaces));
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; vb: VB; c: Vec2 } | null>(null);
  const [editWall, setEditWall] = useState<{ spaceId: string; i: number; pos: Vec2; value: string } | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });

  const setD = (d: Drag | null) => { dragRef.current = d; setDrag(d); };
  const fit = useCallback(() => setVb(fitBox(useStore.getState().model.spaces)), []);

  // Refit when a different model is loaded.
  const modelId = model.id;
  useEffect(() => { fit(); }, [modelId, fit]);

  useEffect(() => {
    const el = svgRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 1, h: el.clientHeight || 1 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Effective viewBox respecting aspect ratio, so 1 unit is uniform.
  const view = useMemo(() => {
    const aspect = size.w / size.h;
    let { x, y, w, h } = vb;
    if (w / h > aspect) { const nh = w / aspect; y -= (nh - h) / 2; h = nh; } else { const nw = h * aspect; x -= (nw - w) / 2; w = nw; }
    return { x, y, w, h };
  }, [vb, size]);
  const px = view.w / size.w; // metres per screen pixel

  const toPlan = (cx: number, cy: number): Vec2 => {
    const el = svgRef.current!; const r = el.getBoundingClientRect();
    return { x: view.x + ((cx - r.left) / r.width) * view.w, y: view.y + ((cy - r.top) / r.height) * view.h };
  };

  // Preview geometry: model with dragged vertex / furniture applied locally.
  const spaces = useMemo(() => {
    if (drag?.kind !== 'vertex') return model.spaces;
    return model.spaces.map((s) => s.id !== drag.spaceId ? s : { ...s, polygon: s.polygon.map((p, i) => (i === drag.index ? drag.pos : p)) });
  }, [model.spaces, drag]);
  const furniture = useMemo(() => {
    if (!drag || (drag.kind !== 'item' && drag.kind !== 'rotate')) return shown;
    return shown.map((f) => f.id !== drag.id ? f : drag.kind === 'item' ? { ...f, x: drag.pos.x, y: drag.pos.y } : { ...f, rotation: drag.rot });
  }, [shown, drag]);

  const problems = useMemo(() => {
    const bad = new Set<string>();
    const cs = furniture.map((f) => itemCorners(f));
    for (let i = 0; i < furniture.length; i++) {
      for (let j = i + 1; j < furniture.length; j++) if (convexOverlap(cs[i], cs[j]) > 0.01) { bad.add(furniture[i].id); bad.add(furniture[j].id); }
      if (spaces.length && !spaces.some((s) => polygonInside(cs[i], s.polygon))) bad.add(furniture[i].id);
    }
    return bad;
  }, [furniture, spaces]);

  /** Editing a previewed candidate applies it first. */
  const ensureEditable = () => {
    const id = useStore.getState().activeCandidateId;
    if (id) { applyCandidate(id); toast('Layout applied so you can edit it', 'info'); }
  };

  const selId = selection?.id;
  const isSel = (kind: string, id: string) => selection?.kind === kind && selId === id;

  // Keyboard: Esc, Delete, R.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const st = useStore.getState(); const sel = st.selection;
      if (e.key === 'Escape') { st.select(null); setEditWall(null); return; }
      if (!sel) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (sel.kind === 'furniture') {
          const f = (st.activeCandidateId ? st.candidates.find((c) => c.id === st.activeCandidateId)?.furniture : st.model.furniture)?.find((x) => x.id === sel.id);
          if (!f) return;
          if (f.locked) { st.toast(`${f.name} is locked`, 'warn'); return; }
          ensureEditable(); st.dispatch({ type: 'REMOVE_OBJECT', id: sel.id }); st.select(null);
        } else if (sel.kind === 'vertex') {
          const [sid, idx] = splitId(sel.id); const sp = st.model.spaces.find((s) => s.id === sid);
          if (!sp || sp.polygon.length <= 3) { st.toast('A room needs at least 3 corners', 'warn'); return; }
          st.dispatch({ type: 'REMOVE_VERTEX', spaceId: sid, index: idx }); st.select(null);
        } else if (sel.kind === 'opening') { st.dispatch({ type: 'REMOVE_OPENING', id: sel.id }); st.select(null); }
        e.preventDefault();
      } else if ((e.key === 'r' || e.key === 'R') && sel.kind === 'furniture') {
        const f = useShownList().find((x) => x.id === sel.id); if (!f) return;
        if (f.locked) { st.toast(`${f.name} is locked`, 'warn'); return; }
        ensureEditable();
        useStore.getState().dispatch({ type: 'UPDATE_OBJECT', id: f.id, patch: { rotation: normAng(f.rotation + Math.PI / 2) } });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wheel zoom (non-passive).
  useEffect(() => {
    const el = svgRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const k = Math.exp(e.deltaY * 0.0015);
      setVb((cur) => zoomAt(cur, r, e.clientX, e.clientY, k, size));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [size]);

  const onPointerDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), vb: view, c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      setD(null); return;
    }
    const target = (e.target as Element).closest('[data-hit]') as HTMLElement | null;
    const hit = target?.getAttribute('data-hit') ?? '';
    const p = toPlan(e.clientX, e.clientY);
    if (hit.startsWith('v:')) {
      const [sid, idx] = splitId(hit.slice(2));
      select({ kind: 'vertex', id: hit.slice(2) });
      const sp = model.spaces.find((s) => s.id === sid)!;
      setD({ kind: 'vertex', spaceId: sid, index: idx, pos: sp.polygon[idx], moved: false });
    } else if (hit.startsWith('rot:')) {
      const id = hit.slice(4); const f = furniture.find((x) => x.id === id);
      if (f && !f.locked) setD({ kind: 'rotate', id, rot: f.rotation });
    } else if (hit.startsWith('f:')) {
      const id = hit.slice(2); const f = furniture.find((x) => x.id === id)!;
      select({ kind: 'furniture', id });
      if (!f.locked) setD({ kind: 'item', id, off: sub({ x: f.x, y: f.y }, p), pos: { x: f.x, y: f.y }, moved: false });
    } else if (hit.startsWith('o:')) {
      select({ kind: 'opening', id: hit.slice(2) });
    } else if (hit.startsWith('w:')) {
      select({ kind: 'wall', id: hit.slice(2) });
    } else {
      setD({ kind: 'pan', start: { x: e.clientX, y: e.clientY }, vb, sx: px, sy: px });
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y); const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const st = pinch.current; const k = st.d / Math.max(d, 1);
      const mpp = st.vb.w / size.w;
      const r = svgRef.current!.getBoundingClientRect();
      // Keep plan point under the original centre under the new centre.
      const anchor = { x: st.vb.x + (st.c.x - r.left) * mpp, y: st.vb.y + (st.c.y - r.top) * mpp };
      const nw = st.vb.w * k, nh = st.vb.h * k, nm = mpp * k;
      setVb({ x: anchor.x - (c.x - r.left) * nm, y: anchor.y - (c.y - r.top) * nm, w: nw, h: nh });
      return;
    }
    const d = dragRef.current; if (!d) return;
    if (d.kind === 'pan') {
      setVb({ ...d.vb, x: d.vb.x - (e.clientX - d.start.x) * d.sx, y: d.vb.y - (e.clientY - d.start.y) * d.sy });
      return;
    }
    const p = toPlan(e.clientX, e.clientY);
    if (d.kind === 'vertex') {
      const sp = model.spaces.find((s) => s.id === d.spaceId)!; const n = sp.polygon.length;
      const prev = sp.polygon[(d.index - 1 + n) % n], next = sp.polygon[(d.index + 1) % n];
      let q = { x: snap(p.x), y: snap(p.y) };
      const tol = 10 * px;
      for (const nb of [prev, next]) { if (Math.abs(p.x - nb.x) < tol) q.x = nb.x; if (Math.abs(p.y - nb.y) < tol) q.y = nb.y; }
      setD({ ...d, pos: q, moved: true });
    } else if (d.kind === 'item') {
      setD({ ...d, pos: { x: snap(p.x + d.off.x), y: snap(p.y + d.off.y) }, moved: true });
    } else if (d.kind === 'rotate') {
      const f = furniture.find((x) => x.id === d.id)!;
      // Handle sits on the front side (+y local); angle from centre to pointer.
      let a = Math.atan2(p.y - f.y, p.x - f.x) - Math.PI / 2;
      a = e.shiftKey ? a : Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
      setD({ ...d, rot: normAng(a) });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const d = dragRef.current; setD(null);
    if (!d) return;
    if (d.kind === 'vertex' && d.moved) dispatch({ type: 'MOVE_VERTEX', spaceId: d.spaceId, index: d.index, to: d.pos });
    if (d.kind === 'item' && d.moved) { ensureEditable(); useStore.getState().dispatch({ type: 'UPDATE_OBJECT', id: d.id, patch: { x: d.pos.x, y: d.pos.y } }); }
    if (d.kind === 'rotate') { ensureEditable(); useStore.getState().dispatch({ type: 'UPDATE_OBJECT', id: d.id, patch: { rotation: d.rot } }); }
    if (d.kind === 'pan' && Math.hypot(e.clientX - d.start.x, e.clientY - d.start.y) < 4) select(null);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const hit = ((e.target as Element).closest('[data-hit]') as HTMLElement | null)?.getAttribute('data-hit') ?? '';
    if (!hit.startsWith('w:')) return;
    const [sid, i] = splitId(hit.slice(2)); const sp = model.spaces.find((s) => s.id === sid); if (!sp) return;
    const [a, b] = wallSegment(sp, i);
    const { point } = closestPointOnSegment(toPlan(e.clientX, e.clientY), a, b);
    dispatch({ type: 'INSERT_VERTEX', spaceId: sid, afterIndex: i, at: { x: snap(point.x), y: snap(point.y) } });
  };

  const addOpening = (kind: 'door' | 'window') => {
    const sel = useStore.getState().selection;
    if (sel?.kind !== 'wall') { toast('Select a wall first', 'warn'); return; }
    const [sid, i] = splitId(sel.id); const sp = model.spaces.find((s) => s.id === sid); if (!sp) return;
    const L = wallLength(sp, i); const width = kind === 'door' ? 0.9 : 1.2;
    if (L < width + 0.1) { toast('Wall is too short', 'warn'); return; }
    const o: Opening = {
      id: uid(kind), kind, spaceId: sid, wallIndex: i, offsetM: L / 2, widthM: width,
      heightM: kind === 'door' ? 2.1 : 1.2, sillM: kind === 'door' ? 0 : 0.9,
      swing: kind === 'door' ? 'in' : 'none', hinge: 'start', sourceKind: 'manual', status: 'estimated',
    };
    dispatch({ type: 'ADD_OPENING', opening: o });
    select({ kind: 'opening', id: o.id });
  };

  const commitLength = () => {
    if (!editWall) return;
    const v = parseLength(editWall.value);
    if (v == null) { toast('Type a length like 320 or 3.2 m', 'warn'); return; }
    dispatch({ type: 'SET_WALL_LENGTH', spaceId: editWall.spaceId, wallIndex: editWall.i, lengthM: v, sourceKind: 'user-measured' });
    setEditWall(null);
  };

  const fs = 12 * px; // font size in metres for ~12px text
  const hlMap = useMemo(() => {
    const m = new Map<string, { color: string; label: string }>();
    for (const h of analysis.highlights ?? []) for (const id of h.ids) m.set(id, { color: h.color, label: h.label });
    return m;
  }, [analysis.highlights]);

  const scaleLen = niceLen(view.w * 0.18);
  const stroke = (k = 1) => k * px;

  return (
    <div className="plan2d">
      <svg
        ref={svgRef}
        className={`plan2d-svg${drag?.kind === 'pan' ? ' plan2d-panning' : ''}`}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        role="img" aria-label={`Floor plan of ${model.name}`}
      >
        <Grid view={view} px={px} />

        {/* Heat */}
        {layers.heat && analysis.heat && <Heat grid={analysis.heat} />}

        {/* Rooms */}
        {spaces.map((sp) => (
          <g key={sp.id}>
            <polygon points={pts(sp.polygon)} className="plan2d-floor" />
            {sp.polygon.map((_, i) => {
              const [a, b] = wallSegment(sp, i); const w = sp.walls[i];
              const id = wallId(sp.id, i); const t = w?.thicknessM ?? 0.12;
              const n = wallInwardNormal(sp, i); const o = mul(n, -t / 2);
              const prov = layers.provenance && w ? PROV[w.sourceKind] : undefined;
              const hl = hlMap.get(id);
              return (
                <g key={id}>
                  <line x1={a.x + o.x} y1={a.y + o.y} x2={b.x + o.x} y2={b.y + o.y} strokeWidth={t}
                    className={`plan2d-wall${isSel('wall', id) ? ' is-sel' : ''}`} style={prov ? { stroke: prov } : undefined} strokeLinecap="square" />
                  {hl && <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={hl.color} strokeWidth={stroke(4)} opacity={0.8} />}
                  <line data-hit={`w:${id}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={Math.max(t, 14 * px)} className="plan2d-hit" />
                </g>
              );
            })}
            <text {...centroid(sp.polygon)} className="plan2d-room-label" fontSize={fs * 1.2} textAnchor="middle">
              <tspan x={centroid(sp.polygon).x} dy={0}>{sp.name}</tspan>
              <tspan x={centroid(sp.polygon).x} dy={fs * 1.4} className="plan2d-room-area">{fmtM2(area(sp.polygon))}</tspan>
            </text>
          </g>
        ))}

        {/* Openings */}
        {model.openings.map((o) => {
          const sp = spaces.find((s) => s.id === o.spaceId); if (!sp || o.wallIndex >= sp.polygon.length) return null;
          const { a, b, inward, dir } = openingSegment(sp, o);
          const t = sp.walls[o.wallIndex]?.thicknessM ?? 0.12;
          const out = mul(inward, -t / 2);
          const sel = isSel('opening', o.id);
          const prov = layers.provenance ? PROV[o.sourceKind] : undefined;
          const hl = hlMap.get(o.id);
          const cls = `plan2d-opening${sel ? ' is-sel' : ''}`;
          const gapPoly = [add(a, mul(inward, 0.01)), add(b, mul(inward, 0.01)), add(b, mul(inward, -t - 0.01)), add(a, mul(inward, -t - 0.01))];
          let sym: JSX.Element;
          if (o.kind === 'window') {
            const off = t * 0.3;
            sym = (<g className={cls} style={prov ? { stroke: prov } : undefined}>
              <line x1={a.x + out.x + inward.x * off} y1={a.y + out.y + inward.y * off} x2={b.x + out.x + inward.x * off} y2={b.y + out.y + inward.y * off} />
              <line x1={a.x + out.x - inward.x * off} y1={a.y + out.y - inward.y * off} x2={b.x + out.x - inward.x * off} y2={b.y + out.y - inward.y * off} />
            </g>);
          } else if (o.kind === 'door' && o.swing !== 'none') {
            const n = o.swing === 'in' ? inward : mul(inward, -1);
            const hinge = o.hinge === 'start' ? a : b; const free = o.hinge === 'start' ? b : a;
            const leafEnd = add(hinge, mul(n, o.widthM));
            const sweep = (cross2(sub(free, hinge), n) > 0) ? 1 : 0;
            sym = (<g className={cls} style={prov ? { stroke: prov } : undefined}>
              <line x1={hinge.x} y1={hinge.y} x2={leafEnd.x} y2={leafEnd.y} strokeWidth={stroke(2)} />
              <path d={`M ${free.x} ${free.y} A ${o.widthM} ${o.widthM} 0 0 ${sweep} ${leafEnd.x} ${leafEnd.y}`} className="plan2d-swing" />
            </g>);
          } else {
            sym = <line className={cls} x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeDasharray={`${4 * px} ${3 * px}`} />;
          }
          void dir;
          return (
            <g key={o.id}>
              <polygon points={pts(gapPoly)} className="plan2d-gap" />
              {sym}
              {hl && <polygon points={pts(gapPoly)} fill="none" stroke={hl.color} strokeWidth={stroke(2)} />}
              <polygon data-hit={`o:${o.id}`} points={pts(gapPoly)} className="plan2d-hit-fill" />
            </g>
          );
        })}

        {/* Dimensions */}
        {layers.dimensions && spaces.map((sp) => sp.polygon.map((_, i) => {
          const [a, b] = wallSegment(sp, i); const w = sp.walls[i]; const t = w?.thicknessM ?? 0.12;
          const L = dist(a, b); if (L < 0.05) return null;
          const out = mul(wallInwardNormal(sp, i), -1); const off = t + 28 * px;
          const A = add(a, mul(out, off)), B = add(b, mul(out, off)), M = lerp(A, B, 0.5);
          const status = w?.status ?? 'unknown';
          let ang = Math.atan2(B.y - A.y, B.x - A.x) * 180 / Math.PI; if (ang > 90 || ang < -90) ang += 180;
          const tick = mul(norm(perp(sub(b, a))), 5 * px);
          const label = fmtCm(L);
          return (
            <g key={`d${sp.id}${i}`} className={`plan2d-dim plan2d-dim-${status}`}>
              <line x1={a.x + out.x * t} y1={a.y + out.y * t} x2={A.x + out.x * 6 * px} y2={A.y + out.y * 6 * px} className="plan2d-ext" />
              <line x1={b.x + out.x * t} y1={b.y + out.y * t} x2={B.x + out.x * 6 * px} y2={B.y + out.y * 6 * px} className="plan2d-ext" />
              <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} strokeDasharray={status === 'estimated' || status === 'unknown' ? `${5 * px} ${3 * px}` : undefined} />
              <line x1={A.x - tick.x + tick.y} y1={A.y - tick.y - tick.x} x2={A.x + tick.x - tick.y} y2={A.y + tick.y + tick.x} />
              <line x1={B.x - tick.x + tick.y} y1={B.y - tick.y - tick.x} x2={B.x + tick.x - tick.y} y2={B.y + tick.y + tick.x} />
              <g transform={`translate(${M.x} ${M.y}) rotate(${ang})`} className="plan2d-dim-label"
                onPointerDown={(e) => { e.stopPropagation(); }}
                onClick={(e) => { e.stopPropagation(); select({ kind: 'wall', id: wallId(sp.id, i) }); setEditWall({ spaceId: sp.id, i, pos: M, value: String(Math.round(L * 100)) }); }}>
                <rect x={-fs * 2.4} y={-fs * 0.8} width={fs * 4.8} height={fs * 1.6} rx={fs * 0.3} />
                <text fontSize={fs} textAnchor="middle" dominantBaseline="central">{label}</text>
                <title>{`${label} (${status}). Click to type the real length.`}</title>
              </g>
            </g>
          );
        }))}

        {/* Furniture */}
        {furniture.map((f) => (
          <Item key={f.id} f={f} px={px} fs={fs} layers={layers} sel={isSel('furniture', f.id)} bad={problems.has(f.id)}
            hl={hlMap.get(f.id)} preview={!!activeCandidateId} />
        ))}

        {/* Routes */}
        {layers.routes && analysis.routes.map((r) => r.points.length > 1 && (
          <g key={r.id} className={`plan2d-route ${r.ok ? 'is-ok' : 'is-fail'}`}>
            <polyline points={pts(r.points)} strokeWidth={stroke(3)} />
            {r.narrowestAt && r.narrowestM != null && (
              <g>
                <circle cx={r.narrowestAt.x} cy={r.narrowestAt.y} r={5 * px} />
                <text x={r.narrowestAt.x + 8 * px} y={r.narrowestAt.y - 6 * px} fontSize={fs}>{fmtCm(r.narrowestM)}</text>
              </g>
            )}
          </g>
        ))}

        {/* Passage */}
        {analysis.passage && (() => {
          const p = analysis.passage!; const item = [...furniture, ...model.furniture].find((x) => x.id === p.itemId);
          if (!item) return null;
          const step = Math.max(1, Math.floor(p.poses.length / 14));
          return (
            <g className={`plan2d-passage ${p.ok ? 'is-ok' : 'is-fail'}`}>
              {p.poses.filter((_, i) => i % step === 0 || i === p.poses.length - 1).map((q, i) => (
                <polygon key={i} points={pts(itemCorners({ ...item, x: q.x, y: q.y, rotation: q.rotation }))} strokeWidth={stroke(1)} />
              ))}
              {p.blockedAt && <g className="plan2d-blocked"><circle cx={p.blockedAt.x} cy={p.blockedAt.y} r={8 * px} /><text x={p.blockedAt.x + 10 * px} y={p.blockedAt.y} fontSize={fs}>Blocked</text></g>}
            </g>
          );
        })()}

        {/* Sightlines */}
        {layers.sightlines && analysis.sightlines.map((s, i) => (
          <line key={i} x1={s.a.x} y1={s.a.y} x2={s.b.x} y2={s.b.y} className={`plan2d-sight ${s.visible ? 'is-ok' : 'is-fail'}`} strokeWidth={stroke(1.5)} />
        ))}

        {/* Highlight labels */}
        {(analysis.highlights ?? []).map((h, i) => {
          const f = furniture.find((x) => h.ids.includes(x.id)); if (!f) return null;
          return <text key={i} x={f.x} y={f.y - f.d / 2 - 8 * px} fontSize={fs} fill={h.color} textAnchor="middle" className="plan2d-hl-label">{h.label}</text>;
        })}

        {/* Vertices (top) */}
        {spaces.map((sp) => sp.polygon.map((p, i) => {
          const id = `${sp.id}#${i}`; const sel = isSel('vertex', id);
          return <circle key={id} data-hit={`v:${id}`} cx={p.x} cy={p.y} r={(sel ? 7 : 5) * px} className={`plan2d-vertex${sel ? ' is-sel' : ''}`} strokeWidth={stroke(1.5)} />;
        }))}

        {/* Live lengths while dragging a vertex */}
        {drag?.kind === 'vertex' && (() => {
          const sp = spaces.find((s) => s.id === drag.spaceId)!; const n = sp.polygon.length;
          return [(drag.index - 1 + n) % n, drag.index].map((wi) => {
            const [a, b] = wallSegment(sp, wi); const m = lerp(a, b, 0.5);
            return <text key={wi} x={m.x} y={m.y - 8 * px} fontSize={fs * 1.1} textAnchor="middle" className="plan2d-live">{fmtCm(dist(a, b))}</text>;
          });
        })()}
      </svg>

      {editWall && (
        <form className="plan2d-edit card" onSubmit={(e) => { e.preventDefault(); commitLength(); }}
          style={{ left: ((editWall.pos.x - view.x) / view.w) * size.w, top: ((editWall.pos.y - view.y) / view.h) * size.h }}>
          <label className="plan2d-edit-label" htmlFor="plan2d-len">Wall length</label>
          <input id="plan2d-len" className="field" autoFocus value={editWall.value}
            onChange={(e) => setEditWall({ ...editWall, value: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Escape') setEditWall(null); }} onBlur={() => setEditWall(null)} />
          <span className="muted plan2d-edit-hint">cm or m</span>
        </form>
      )}

      <div className="plan2d-toolbar panel">
        <button className="btn btn-sm btn-ghost" onClick={fit} title="Fit plan to view">Fit</button>
        <span className="plan2d-sep" />
        {(['dimensions', 'clearance', 'routes', 'provenance', 'heat'] as const).map((k) => (
          <button key={k} className={`btn btn-sm ${layers[k] ? 'plan2d-on' : 'btn-ghost'}`} aria-pressed={layers[k]} onClick={() => toggleLayer(k)}>
            {LAYER_LABEL[k]}
          </button>
        ))}
        <span className="plan2d-sep" />
        <button className="btn btn-sm btn-ghost" onClick={() => addOpening('door')} disabled={selection?.kind !== 'wall'} title="Add a door to the selected wall">+ Door</button>
        <button className="btn btn-sm btn-ghost" onClick={() => addOpening('window')} disabled={selection?.kind !== 'wall'} title="Add a window to the selected wall">+ Window</button>
      </div>

      {activeCandidateId && <div className="plan2d-preview chip chip-warn">Previewing a layout. Editing applies it.</div>}

      <div className="plan2d-scale">
        <svg width={scaleLen / px} height={14} aria-hidden="true">
          <rect x={0} y={4} width={scaleLen / px / 2} height={5} fill="var(--text)" />
          <rect x={scaleLen / px / 2} y={4} width={scaleLen / px / 2} height={5} fill="none" stroke="var(--text)" />
        </svg>
        <span>{scaleLen >= 1 ? `${scaleLen} m` : `${Math.round(scaleLen * 100)} cm`}</span>
      </div>

      {layers.provenance && (
        <div className="plan2d-legend panel">
          {(Object.keys(PROV) as SourceKind[]).filter((k) => usedKinds(model).has(k)).map((k) => (
            <div key={k} className="plan2d-legend-row"><i style={{ background: PROV[k] }} />{PROV_LABEL[k]}</div>
          ))}
        </div>
      )}
    </div>
  );
}

const LAYER_LABEL: Record<keyof Layers, string> = {
  dimensions: 'Sizes', clearance: 'Clearance', routes: 'Routes', provenance: 'Sources', heat: 'Heat', sightlines: 'Views',
};

function usedKinds(m: { spaces: Space[]; openings: Opening[] }) {
  const s = new Set<SourceKind>();
  m.spaces.forEach((sp) => sp.walls.forEach((w) => s.add(w.sourceKind)));
  m.openings.forEach((o) => s.add(o.sourceKind));
  return s;
}

function useShownList(): FurnitureItem[] {
  const s = useStore.getState();
  if (s.activeCandidateId) { const c = s.candidates.find((x) => x.id === s.activeCandidateId); if (c) return c.furniture; }
  return s.model.furniture;
}

function splitId(id: string): [string, number] {
  const k = Math.max(id.lastIndexOf('#'), id.lastIndexOf(':'));
  return [id.slice(0, k), Number(id.slice(k + 1))];
}
const cross2 = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const normAng = (a: number) => { const t = Math.PI * 2; return ((a % t) + t) % t; };
function niceLen(m: number) {
  const steps = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 50];
  return steps.reduce((best, s) => (s <= m ? s : best), 0.1);
}

function zoomAt(cur: VB, r: DOMRect, cx: number, cy: number, k: number, size: { w: number; h: number }): VB {
  // Work in the aspect-corrected box so the point under the cursor stays put.
  const aspect = size.w / size.h; let { x, y, w, h } = cur;
  if (w / h > aspect) { const nh = w / aspect; y -= (nh - h) / 2; h = nh; } else { const nw = h * aspect; x -= (nw - w) / 2; w = nw; }
  const nw = Math.min(200, Math.max(0.5, w * k)); const kk = nw / w;
  const fx = (cx - r.left) / r.width, fy = (cy - r.top) / r.height;
  const px = x + fx * w, py = y + fy * h;
  return { x: px - fx * w * kk, y: py - fy * h * kk, w: w * kk, h: h * kk };
}

function Grid({ view, px }: { view: VB; px: number }) {
  const lines: JSX.Element[] = [];
  const fine = px < 0.012; // show 10 cm lines only when they are at least ~8 px apart
  const step = fine ? 0.1 : 1;
  const x0 = Math.floor(view.x / step) * step, y0 = Math.floor(view.y / step) * step;
  const maxLines = 400;
  let c = 0;
  for (let x = x0; x <= view.x + view.w && c < maxLines; x += step, c++) {
    const major = Math.abs(x - Math.round(x)) < 1e-6;
    lines.push(<line key={`x${c}`} x1={x} y1={view.y} x2={x} y2={view.y + view.h} className={major ? 'plan2d-grid-major' : 'plan2d-grid-minor'} strokeWidth={px} />);
  }
  for (let y = y0; y <= view.y + view.h && c < maxLines * 2; y += step, c++) {
    const major = Math.abs(y - Math.round(y)) < 1e-6;
    lines.push(<line key={`y${c}`} x1={view.x} y1={y} x2={view.x + view.w} y2={y} className={major ? 'plan2d-grid-major' : 'plan2d-grid-minor'} strokeWidth={px} />);
  }
  return <g pointerEvents="none">{lines}</g>;
}

function Heat({ grid }: { grid: NonNullable<import('../../core/types').Analysis['heat']> }) {
  let mx = 0; for (const v of grid.values) if (v > mx) mx = v;
  if (mx <= 0) return null;
  const cells: JSX.Element[] = [];
  for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) {
    const v = grid.values[r * grid.cols + c] ?? 0; if (v <= 0) continue;
    const t = v / mx;
    cells.push(<rect key={`${r}_${c}`} x={grid.origin.x + c * grid.cellM} y={grid.origin.y + r * grid.cellM} width={grid.cellM} height={grid.cellM}
      fill={`hsl(${(1 - t) * 220 + t * 10} 85% 55%)`} opacity={0.15 + 0.45 * t} />);
  }
  return <g pointerEvents="none">{cells}</g>;
}

function Item({ f, px, fs, layers, sel, bad, hl, preview }: {
  f: FurnitureItem; px: number; fs: number; layers: Layers; sel: boolean; bad: boolean; hl?: { color: string; label: string }; preview: boolean;
}) {
  const deg = (f.rotation * 180) / Math.PI;
  const { w, d } = f; const c = f.clearance;
  const label = Math.min(fs, (w / Math.max(f.name.length, 4)) * 1.6);
  return (
    <g transform={`translate(${f.x} ${f.y}) rotate(${deg})`} className={`plan2d-item${sel ? ' is-sel' : ''}${bad ? ' is-bad' : ''}${preview ? ' is-preview' : ''}`}>
      {layers.clearance && c && (
        <rect x={-w / 2 - c.left} y={-d / 2 - c.back} width={w + c.left + c.right} height={d + c.back + c.front}
          className="plan2d-clear" strokeWidth={px} strokeDasharray={`${4 * px} ${3 * px}`} />
      )}
      <rect data-hit={`f:${f.id}`} x={-w / 2} y={-d / 2} width={w} height={d} rx={Math.min(0.03, w / 10)}
        style={{ fill: f.color }} className="plan2d-item-body" strokeWidth={(sel || bad ? 2.5 : 1) * px} />
      <line x1={-w / 2 + 0.03} y1={d / 2 - 0.03} x2={w / 2 - 0.03} y2={d / 2 - 0.03} className="plan2d-front" strokeWidth={3 * px} pointerEvents="none" />
      {hl && <rect x={-w / 2 - 4 * px} y={-d / 2 - 4 * px} width={w + 8 * px} height={d + 8 * px} fill="none" stroke={hl.color} strokeWidth={2 * px} pointerEvents="none" />}
      <text fontSize={label} textAnchor="middle" dominantBaseline="central" className="plan2d-item-label" pointerEvents="none"
        transform={`rotate(${-deg})`}>{f.locked ? '\u{1F512} ' : ''}{f.name}</text>
      {sel && !f.locked && (
        <g>
          <line x1={0} y1={d / 2} x2={0} y2={d / 2 + 18 * px} stroke="var(--accent)" strokeWidth={1.5 * px} pointerEvents="none" />
          <circle data-hit={`rot:${f.id}`} cx={0} cy={d / 2 + 18 * px} r={7 * px} className="plan2d-rot" strokeWidth={1.5 * px}>
            <title>Drag to rotate (15° steps). Press R for 90°.</title>
          </circle>
        </g>
      )}
    </g>
  );
}
