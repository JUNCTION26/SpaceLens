import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore, useShownFurniture } from '../../core/store';
import {
  add, area, bounds, centroid, closestPointOnSegment, convexOverlap, dist, fmtCm, fmtM2, itemCorners, lerp, mul, norm,
  openingSegment, perp, polygonInside, sub, uid, wallId, wallInwardNormal, wallLength, wallSegment,
} from '../../core/geometry';
import { CATALOG_DND, findFreeSpot } from '../objects/placement';
import { catalogEntry, makeItem } from '../furniture/catalog';
import type { FurnitureItem, Layers, Opening, SourceKind, Space, Vec2 } from '../../core/types';
import { useSketch } from '../agent/sketchStore';
import { SketchLayer } from '../agent/SketchLayer';
import { Icon } from '../../ui/icons';
import './plan2d.css';

type VB = { x: number; y: number; w: number; h: number };
type Drag =
  | { kind: 'pan'; start: Vec2; vb: VB; sx: number; sy: number }
  | { kind: 'vertex'; spaceId: string; index: number; pos: Vec2; moved: boolean }
  | { kind: 'item'; id: string; ids: string[]; origins: Record<string, Vec2>; off: Vec2; pos: Vec2; rot?: number; moved: boolean; guides: Guide[]; wall: { cm: number; at: Vec2 } | null }
  | { kind: 'marquee'; a: Vec2; b: Vec2 }
  | { kind: 'rotate'; id: string; rot: number };

type Guide = { a: Vec2; b: Vec2 };
const SNAP = 0.05;
const WALL_SNAP = 0.15;

// Catalog id of the item currently being dragged from the library (dataTransfer is unreadable during dragover).
let dndCatalogId: string | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('dragstart', (e) => { try { dndCatalogId = e.dataTransfer?.getData(CATALOG_DND) || null; } catch { dndCatalogId = null; } });
  window.addEventListener('dragend', () => { dndCatalogId = null; });
}

const aabb = (c: Vec2[]) => bounds(c) as { minX: number; minY: number; maxX: number; maxY: number };
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
  const [multi, setMultiState] = useState<string[]>([]);
  const multiRef = useRef<string[]>([]);
  const setMulti = (ids: string[]) => { multiRef.current = ids; setMultiState(ids); };
  const [hover, setHover] = useState<{ id: string; sx: number; sy: number } | null>(null);
  const [menu, setMenu] = useState<{ id: string; sx: number; sy: number } | null>(null);
  const [ghost, setGhost] = useState<{ id: string | null; p: Vec2 } | null>(null);
  const anim = useRef<number>(0);
  const [layersOpen, setLayersOpen] = useState(false);
  const sketching = useSketch((s) => s.drawing);

  // Keep the group in step with the store selection (other panels can select too).
  useEffect(() => {
    if (selection?.kind !== 'furniture') { if (multiRef.current.length) setMulti([]); return; }
    if (!multiRef.current.includes(selection.id)) setMulti([selection.id]);
  }, [selection]);

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
    if (drag.kind === 'rotate') return shown.map((f) => f.id !== drag.id ? f : { ...f, rotation: drag.rot });
    const o0 = drag.origins[drag.id]; const dx = drag.pos.x - o0.x, dy = drag.pos.y - o0.y;
    return shown.map((f) => {
      const o = drag.origins[f.id]; if (!o) return f;
      return f.id === drag.id ? { ...f, x: drag.pos.x, y: drag.pos.y, rotation: drag.rot ?? f.rotation } : { ...f, x: o.x + dx, y: o.y + dy };
    });
  }, [shown, drag]);

  const { problems, overlapsWith } = useMemo(() => {
    const bad = new Set<string>();
    const withMap = new Map<string, string[]>();
    const push = (a: FurnitureItem, b: FurnitureItem) => { const l = withMap.get(a.id) ?? []; l.push(b.name); withMap.set(a.id, l); };
    const cs = furniture.map((f) => itemCorners(f));
    const soft = (f: FurnitureItem) => f.category === 'rug' || !!catalogEntry(f.catalogId)?.overlaps;
    for (let i = 0; i < furniture.length; i++) {
      for (let j = i + 1; j < furniture.length; j++) {
        if (convexOverlap(cs[i], cs[j]) > 0.01) {
          bad.add(furniture[i].id); bad.add(furniture[j].id);
          if (!soft(furniture[i]) && !soft(furniture[j])) { push(furniture[i], furniture[j]); push(furniture[j], furniture[i]); }
        }
      }
      if (spaces.length && !spaces.some((s) => polygonInside(cs[i], s.polygon))) bad.add(furniture[i].id);
    }
    return { problems: bad, overlapsWith: withMap };
  }, [furniture, spaces]);

  /** Editing a previewed candidate applies it first. */
  const ensureEditable = () => {
    const id = useStore.getState().activeCandidateId;
    if (id) { applyCandidate(id); toast('Layout applied so you can edit it', 'info'); }
  };

  const selId = selection?.id;
  const isSel = (kind: string, id: string) => selection?.kind === kind && selId === id;

  // Smoothly animate the view box to a target.
  const animateTo = (target: VB) => {
    cancelAnimationFrame(anim.current);
    const from = { ...vb }; const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 280); const e = 1 - Math.pow(1 - k, 3);
      setVb({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, w: from.w + (target.w - from.w) * e, h: from.h + (target.h - from.h) * e });
      if (k < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  };
  const animRef = useRef(animateTo); animRef.current = animateTo;

  // Other parts of the app can ask the plan to reset its view.
  useEffect(() => {
    const onReset = () => fit();
    window.addEventListener('spacelens:reset-view', onReset);
    return () => window.removeEventListener('spacelens:reset-view', onReset);
  }, [fit]);

  /** Selected furniture ids (the group, or just the primary). */
  const groupIds = () => {
    const sel = useStore.getState().selection;
    if (sel?.kind !== 'furniture') return [];
    return multiRef.current.includes(sel.id) ? multiRef.current : [sel.id];
  };
  const lockedWarn = (items: FurnitureItem[]) => {
    if (items.length) useStore.getState().toast(items.length > 1 ? 'All selected items are locked' : `${items[0].name} is locked`, 'warn');
  };
  const editGroup = (ids: string[], patch: (f: FurnitureItem) => Partial<FurnitureItem> | null) => {
    const items = useShownList().filter((f) => ids.includes(f.id));
    const free = items.filter((f) => !f.locked);
    if (!free.length) { lockedWarn(items); return; }
    ensureEditable();
    for (const f of free) { const pt = patch(f); if (pt) useStore.getState().dispatch({ type: 'UPDATE_OBJECT', id: f.id, patch: pt }); }
  };
  const deleteGroup = (ids: string[]) => {
    const items = useShownList().filter((f) => ids.includes(f.id));
    const free = items.filter((f) => !f.locked);
    if (!free.length) { lockedWarn(items); return; }
    ensureEditable();
    for (const f of free) useStore.getState().dispatch({ type: 'REMOVE_OBJECT', id: f.id });
    if (free.length < items.length) useStore.getState().toast(`Kept ${items.length - free.length} locked`, 'info');
    setMulti([]); useStore.getState().select(null);
  };
  const duplicateGroup = (ids: string[]) => {
    const items = useShownList().filter((f) => ids.includes(f.id)); if (!items.length) return;
    ensureEditable();
    const placed: FurnitureItem[] = []; const newIds: string[] = [];
    for (const f of items) {
      const st = useStore.getState();
      const copy: FurnitureItem = { ...f, id: uid('f'), locked: false, clearance: { ...f.clearance } };
      const pose = findFreeSpot(st.model, copy, [...st.model.furniture, ...placed]);
      const item = { ...copy, ...pose }; placed.push(item); newIds.push(item.id);
      st.dispatch({ type: 'PLACE_OBJECT', item });
    }
    setMulti(newIds); useStore.getState().select({ kind: 'furniture', id: newIds[0] });
  };
  const toggleLock = (ids: string[]) => {
    const items = useShownList().filter((f) => ids.includes(f.id)); if (!items.length) return;
    ensureEditable();
    const to = !items.every((f) => f.locked);
    for (const f of items) useStore.getState().dispatch({ type: 'UPDATE_OBJECT', id: f.id, patch: { locked: to } });
  };
  const zoomToSelection = () => {
    const ids = groupIds(); const items = useShownList().filter((f) => ids.includes(f.id));
    if (!items.length) { animRef.current(fitBox(useStore.getState().model.spaces)); return; }
    const b = aabb(items.flatMap((f) => itemCorners(f)));
    const pad = Math.max(0.6, 0.25 * Math.max(b.maxX - b.minX, b.maxY - b.minY));
    animRef.current({ x: b.minX - pad, y: b.minY - pad, w: b.maxX - b.minX + pad * 2, h: b.maxY - b.minY + pad * 2 });
  };
  const actions = useRef({ editGroup, deleteGroup, duplicateGroup, toggleLock, zoomToSelection, groupIds });
  actions.current = { editGroup, deleteGroup, duplicateGroup, toggleLock, zoomToSelection, groupIds };

  // Keyboard: Esc, Delete, R, arrows, L, Ctrl+D, F.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const st = useStore.getState(); const sel = st.selection; const A = actions.current;
      if (e.key === 'Escape') { setLayersOpen(false); st.select(null); setMulti([]); setEditWall(null); setMenu(null); return; }
      if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) { A.zoomToSelection(); return; }
      if (!sel) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (sel.kind === 'furniture') {
          A.deleteGroup(A.groupIds());
        } else if (sel.kind === 'vertex') {
          const [sid, idx] = splitId(sel.id); const sp = st.model.spaces.find((s) => s.id === sid);
          if (!sp || sp.polygon.length <= 3) { st.toast('A room needs at least 3 corners', 'warn'); return; }
          st.dispatch({ type: 'REMOVE_VERTEX', spaceId: sid, index: idx }); st.select(null);
        } else if (sel.kind === 'opening') { st.dispatch({ type: 'REMOVE_OPENING', id: sel.id }); st.select(null); }
        e.preventDefault();
        return;
      }
      if (sel.kind !== 'furniture') return;
      const ids = A.groupIds();
      if ((e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); A.duplicateGroup(ids); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'r' || e.key === 'R') {
        const da = e.shiftKey ? -Math.PI / 12 : Math.PI / 2;
        A.editGroup(ids, (f) => ({ rotation: normAng(f.rotation + da) }));
      } else if (e.key === 'l' || e.key === 'L') {
        A.toggleLock(ids);
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const s = e.shiftKey ? 0.1 : 0.01;
        const dx = e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0;
        const dy = e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0;
        A.editGroup(ids, (f) => ({ x: Math.round((f.x + dx) * 1000) / 1000, y: Math.round((f.y + dy) * 1000) / 1000 }));
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

  /** Wall snap, alignment guides and wall distance for a dragged item. Alt skips snapping. */
  const snapItem = (f: FurnitureItem, raw: Vec2, ids: string[], free: boolean) => {
    let pos = free ? raw : { x: snap(raw.x, 0.01), y: snap(raw.y, 0.01) };
    let rot: number | undefined;
    const guides: Guide[] = [];
    const single = ids.length === 1;
    // Back edge to wall.
    if (single && !free) {
      let best: { gap: number; pt: Vec2; n: Vec2 } | null = null;
      for (const sp of spaces) for (let i = 0; i < sp.polygon.length; i++) {
        const [a, b] = wallSegment(sp, i);
        const { point, t } = closestPointOnSegment(raw, a, b); if (t <= 0.02 || t >= 0.98) continue;
        const gap = Math.abs(dist(raw, point) - f.d / 2);
        if (gap < WALL_SNAP && (!best || gap < best.gap)) best = { gap, pt: point, n: wallInwardNormal(sp, i) };
      }
      if (best) { pos = add(best.pt, mul(best.n, f.d / 2)); rot = normAng(Math.atan2(-best.n.x, best.n.y)); }
    }
    // Alignment with other items' edges and centres.
    const moving = { ...f, x: pos.x, y: pos.y, rotation: rot ?? f.rotation };
    const mb = aabb(itemCorners(moving));
    const tol = 6 * px;
    const mx = [mb.minX, (mb.minX + mb.maxX) / 2, mb.maxX], my = [mb.minY, (mb.minY + mb.maxY) / 2, mb.maxY];
    let bx: { d: number; v: number; o: { minY: number; maxY: number } } | null = null;
    let by: { d: number; v: number; o: { minX: number; maxX: number } } | null = null;
    if (!free) for (const o of furniture) {
      if (ids.includes(o.id)) continue;
      const ob = aabb(itemCorners(o));
      const ox = [ob.minX, (ob.minX + ob.maxX) / 2, ob.maxX], oy = [ob.minY, (ob.minY + ob.maxY) / 2, ob.maxY];
      for (const a of mx) for (const b of ox) { const dd = b - a; if (Math.abs(dd) < tol && (!bx || Math.abs(dd) < Math.abs(bx.d))) bx = { d: dd, v: b, o: ob }; }
      for (const a of my) for (const b of oy) { const dd = b - a; if (Math.abs(dd) < tol && (!by || Math.abs(dd) < Math.abs(by.d))) by = { d: dd, v: b, o: ob }; }
    }
    if (bx && rot == null) { pos = { ...pos, x: pos.x + bx.d }; guides.push({ a: { x: bx.v, y: Math.min(mb.minY, bx.o.minY) }, b: { x: bx.v, y: Math.max(mb.maxY, bx.o.maxY) } }); }
    if (by && rot == null) { pos = { ...pos, y: pos.y + by.d }; guides.push({ a: { x: Math.min(mb.minX, by.o.minX), y: by.v }, b: { x: Math.max(mb.maxX, by.o.maxX), y: by.v } }); }
    // Distance to nearest wall.
    let wall: { cm: number; at: Vec2 } | null = null;
    const cs = itemCorners({ ...moving, x: pos.x, y: pos.y });
    let bestD = Infinity;
    for (const sp of spaces) for (let i = 0; i < sp.polygon.length; i++) {
      const [a, b] = wallSegment(sp, i);
      for (const c of cs) { const { point } = closestPointOnSegment(c, a, b); const dd = dist(c, point); if (dd < bestD) { bestD = dd; wall = { cm: Math.round(dd * 100), at: lerp(c, point, 0.5) }; } }
    }
    return { pos, rot, guides, wall };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 2) return;
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
      setMenu(null); setHover(null);
      if (e.shiftKey) {
        const cur = selection?.kind === 'furniture' ? (multiRef.current.length ? multiRef.current : [selection.id]) : [];
        const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
        setMulti(next);
        select(next.length ? { kind: 'furniture', id: next.includes(id) ? id : next[next.length - 1] } : null);
        return;
      }
      const group = multiRef.current.includes(id) && selection?.kind === 'furniture' ? multiRef.current : [id];
      if (group.length === 1) setMulti([id]);
      select({ kind: 'furniture', id });
      const ids = group.filter((gid) => !furniture.find((x) => x.id === gid)?.locked);
      if (!f.locked) {
        const origins: Record<string, Vec2> = {};
        for (const gid of ids) { const g = furniture.find((x) => x.id === gid); if (g) origins[gid] = { x: g.x, y: g.y }; }
        setD({ kind: 'item', id, ids, origins, off: sub({ x: f.x, y: f.y }, p), pos: { x: f.x, y: f.y }, moved: false, guides: [], wall: null });
      }
    } else if (hit.startsWith('o:')) {
      select({ kind: 'opening', id: hit.slice(2) });
    } else if (hit.startsWith('w:')) {
      select({ kind: 'wall', id: hit.slice(2) });
    } else if (e.shiftKey) {
      setMenu(null);
      setD({ kind: 'marquee', a: p, b: p });
    } else {
      setMenu(null);
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
    const d = dragRef.current;
    if (!d) {
      const hit = ((e.target as Element).closest('[data-hit]') as HTMLElement | null)?.getAttribute('data-hit') ?? '';
      if (hit.startsWith('f:') && e.pointerType === 'mouse') {
        const r = svgRef.current!.getBoundingClientRect();
        setHover({ id: hit.slice(2), sx: e.clientX - r.left, sy: e.clientY - r.top });
      } else if (hover) setHover(null);
      return;
    }
    if (d.kind === 'marquee') { setD({ ...d, b: toPlan(e.clientX, e.clientY) }); return; }
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
      const raw = { x: p.x + d.off.x, y: p.y + d.off.y };
      const f = shown.find((x) => x.id === d.id)!;
      const r = snapItem(f, raw, d.ids, e.altKey);
      setD({ ...d, pos: r.pos, rot: r.rot, guides: r.guides, wall: r.wall, moved: true });
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
    if (d.kind === 'item' && d.moved) {
      ensureEditable();
      const o0 = d.origins[d.id]; const dx = d.pos.x - o0.x, dy = d.pos.y - o0.y;
      for (const id of d.ids) {
        const o = d.origins[id]; if (!o) continue;
        const patch: Partial<FurnitureItem> = id === d.id ? { x: d.pos.x, y: d.pos.y, ...(d.rot != null ? { rotation: d.rot } : {}) } : { x: o.x + dx, y: o.y + dy };
        useStore.getState().dispatch({ type: 'UPDATE_OBJECT', id, patch });
      }
      const others = overlapsWith.get(d.id);
      if (others?.length) toast(`Overlaps ${others[0]}`, 'warn');
    }
    if (d.kind === 'marquee') {
      const x0 = Math.min(d.a.x, d.b.x), x1 = Math.max(d.a.x, d.b.x), y0 = Math.min(d.a.y, d.b.y), y1 = Math.max(d.a.y, d.b.y);
      const hits = furniture.filter((f) => f.x >= x0 && f.x <= x1 && f.y >= y0 && f.y <= y1).map((f) => f.id);
      const prev = selection?.kind === 'furniture' ? multiRef.current : [];
      const next = Array.from(new Set([...prev, ...hits]));
      setMulti(next); select(next.length ? { kind: 'furniture', id: next[0] } : null);
    }
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
    <div className={`plan2d${sketching ? ' plan2d-drawing' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(CATALOG_DND)) return;
        e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
        setGhost({ id: dndCatalogId, p: toPlan(e.clientX, e.clientY) });
      }}
      onDragLeave={(e) => { if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) setGhost(null); }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(CATALOG_DND); setGhost(null);
        if (!id) return;
        e.preventDefault();
        const q = toPlan(e.clientX, e.clientY);
        ensureEditable();
        const item = makeItem(id, { x: snap(q.x, 0.01), y: snap(q.y, 0.01) });
        useStore.getState().dispatch({ type: 'PLACE_OBJECT', item });
        setMulti([item.id]); select({ kind: 'furniture', id: item.id });
      }}>
      <svg
        ref={svgRef}
        className={`plan2d-svg${drag?.kind === 'pan' ? ' plan2d-panning' : ''}`}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onPointerLeave={() => setHover(null)}
        onContextMenu={(e) => {
          const hit = ((e.target as Element).closest('[data-hit]') as HTMLElement | null)?.getAttribute('data-hit') ?? '';
          e.preventDefault();
          if (!hit.startsWith('f:')) { setMenu(null); return; }
          const id = hit.slice(2);
          if (!(multiRef.current.includes(id) && selection?.kind === 'furniture')) { setMulti([id]); select({ kind: 'furniture', id }); }
          const r = svgRef.current!.getBoundingClientRect();
          setMenu({ id, sx: e.clientX - r.left, sy: e.clientY - r.top }); setHover(null);
        }}
        role="img" aria-label={`Floor plan of ${model.name}`}
      >
        {px < 0.02 && <Grid view={view} px={px} />}

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
            const off = t * 0.32;
            sym = (<g className={cls} style={prov ? { stroke: prov } : undefined}>
              <line x1={a.x + out.x + inward.x * off} y1={a.y + out.y + inward.y * off} x2={b.x + out.x + inward.x * off} y2={b.y + out.y + inward.y * off} />
              <line x1={a.x + out.x} y1={a.y + out.y} x2={b.x + out.x} y2={b.y + out.y} />
              <line x1={a.x} y1={a.y} x2={add(a, mul(inward, -t)).x} y2={add(a, mul(inward, -t)).y} />
              <line x1={b.x} y1={b.y} x2={add(b, mul(inward, -t)).x} y2={add(b, mul(inward, -t)).y} />
              <line x1={a.x + out.x - inward.x * off} y1={a.y + out.y - inward.y * off} x2={b.x + out.x - inward.x * off} y2={b.y + out.y - inward.y * off} />
            </g>);
          } else if (o.kind === 'door' && o.swing !== 'none') {
            const n = o.swing === 'in' ? inward : mul(inward, -1);
            const hinge = o.hinge === 'start' ? a : b; const free = o.hinge === 'start' ? b : a;
            const leafEnd = add(hinge, mul(n, o.widthM));
            const sweep = (cross2(sub(free, hinge), n) > 0) ? 1 : 0;
            sym = (<g className={cls} style={prov ? { stroke: prov } : undefined}>
              <line x1={hinge.x} y1={hinge.y} x2={leafEnd.x} y2={leafEnd.y} strokeWidth={stroke(1.25)} />
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
          const out = mul(wallInwardNormal(sp, i), -1); const off = t + 22 * px;
          const A = add(a, mul(out, off)), B = add(b, mul(out, off)), M = lerp(A, B, 0.5);
          const status = w?.status ?? 'unknown';
          let ang = Math.atan2(B.y - A.y, B.x - A.x) * 180 / Math.PI; if (ang >= 89.5 || ang < -90.5) ang += 180;
          const tick = mul(norm(perp(sub(b, a))), 3.5 * px);
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
                <rect x={-fs * 2.4} y={-fs * 0.75} width={fs * 4.8} height={fs * 1.5} rx={fs * 0.25} />
                <text fontSize={fs * 0.92} textAnchor="middle" dominantBaseline="central">{label}</text>
                <title>{`${label} (${status}). Click to type the real length.`}</title>
              </g>
            </g>
          );
        }))}

        {/* Furniture */}
        {furniture.map((f) => (
          <Item key={f.id} f={f} px={px} fs={fs} layers={layers} sel={isSel('furniture', f.id) || (selection?.kind === 'furniture' && multi.includes(f.id))} bad={problems.has(f.id)}
            hl={hlMap.get(f.id)} preview={!!activeCandidateId} hover={hover?.id === f.id} />
        ))}


        {/* Drag feedback: guides, wall distance, overlaps */}
        {drag?.kind === 'item' && drag.moved && (() => {
          const f = furniture.find((x) => x.id === drag.id); if (!f) return null;
          const over = drag.ids.flatMap((id) => overlapsWith.get(id) ?? []).filter((n, i, a) => a.indexOf(n) === i && !drag.ids.some((id) => furniture.find((x) => x.id === id)?.name === n));
          const b = aabb(itemCorners(f));
          return (
            <g pointerEvents="none">
              {drag.guides.map((g, i) => <line key={i} x1={g.a.x} y1={g.a.y} x2={g.b.x} y2={g.b.y} className="plan2d-guide" strokeWidth={px} strokeDasharray={`${5 * px} ${4 * px}`} />)}
              {drag.wall && <text x={drag.wall.at.x} y={drag.wall.at.y} fontSize={fs} textAnchor="middle" dominantBaseline="central" className="plan2d-live plan2d-halo">{drag.wall.cm} cm</text>}
              {over.length > 0 && <text x={f.x} y={b.minY - 10 * px} fontSize={fs} textAnchor="middle" className="plan2d-over plan2d-halo">Overlaps {over.join(', ')}</text>}
            </g>
          );
        })()}

        {/* Marquee */}
        {drag?.kind === 'marquee' && (
          <rect x={Math.min(drag.a.x, drag.b.x)} y={Math.min(drag.a.y, drag.b.y)} width={Math.abs(drag.b.x - drag.a.x)} height={Math.abs(drag.b.y - drag.a.y)}
            className="plan2d-marquee" strokeWidth={px} strokeDasharray={`${4 * px} ${3 * px}`} pointerEvents="none" />
        )}

        {/* Drop ghost */}
        {ghost && (() => {
          const e = ghost.id ? catalogEntry(ghost.id) : undefined; const w = e?.w ?? 0.6, d = e?.d ?? 0.6;
          return (
            <g pointerEvents="none" transform={`translate(${ghost.p.x} ${ghost.p.y})`}>
              <rect x={-w / 2} y={-d / 2} width={w} height={d} className="plan2d-ghost" strokeWidth={1.5 * px} strokeDasharray={`${5 * px} ${3 * px}`} />
              {e && <text y={d / 2 + fs * 1.2} fontSize={fs} textAnchor="middle" className="plan2d-live plan2d-halo">{e.name}</text>}
            </g>
          );
        })()}

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
        {/* Sketch marks from you and the assistant; last so the pencil sits above everything. */}
        <SketchLayer />
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

      {hover && !drag && !menu && (() => {
        const f = furniture.find((x) => x.id === hover.id); if (!f) return null;
        return <div className="plan2d-tip" style={{ left: hover.sx + 14, top: hover.sy + 14 }}>{f.name} <span className="muted">{Math.round(f.w * 100)}×{Math.round(f.d * 100)} cm</span></div>;
      })()}

      {menu && (() => {
        const ids = groupIds().length ? groupIds() : [menu.id];
        const items = furniture.filter((f) => ids.includes(f.id));
        const allLocked = items.length > 0 && items.every((f) => f.locked);
        const run = (fn: () => void) => () => { fn(); setMenu(null); };
        return (
          <div className="plan2d-menu card" role="menu" style={{ left: Math.min(menu.sx, size.w - 150), top: Math.min(menu.sy, size.h - 150) }}
            onPointerDown={(e) => e.stopPropagation()}>
            <button role="menuitem" onClick={run(() => editGroup(ids, (f) => ({ rotation: normAng(f.rotation + Math.PI / 2) })))}>Rotate<kbd>R</kbd></button>
            <button role="menuitem" onClick={run(() => duplicateGroup(ids))}>Duplicate<kbd>Ctrl D</kbd></button>
            <button role="menuitem" onClick={run(() => toggleLock(ids))}>{allLocked ? 'Unlock' : 'Lock'}<kbd>L</kbd></button>
            <button role="menuitem" className="plan2d-menu-bad" onClick={run(() => deleteGroup(ids))}>Delete<kbd>Del</kbd></button>
          </div>
        );
      })()}

      <div className="plan2d-toolbar" role="toolbar" aria-label="Plan tools">
        <button className="plan2d-tb" onClick={fit} aria-label="Fit plan to view" data-tip="Fit to view"><Icon name="maximize" /></button>
        <div className="plan2d-layers">
          <button className={`plan2d-tb${layersOpen ? ' is-on' : ''}`} onClick={() => setLayersOpen((v) => !v)} aria-haspopup="menu" aria-expanded={layersOpen} aria-label="Layers" data-tip="Layers"><Icon name="layout" /></button>
          {layersOpen && (
            <div className="plan2d-layer-menu" role="menu" onPointerDown={(e) => e.stopPropagation()}>
              {(['dimensions', 'clearance', 'routes', 'provenance', 'heat'] as const).map((k) => (
                <label key={k} className="plan2d-layer-row">
                  <input type="checkbox" checked={layers[k]} onChange={() => toggleLayer(k)} />{LAYER_LABEL[k]}
                </label>
              ))}
            </div>
          )}
        </div>
        <span className="plan2d-sep" />
        <button className="plan2d-tb" onClick={() => addOpening('door')} disabled={selection?.kind !== 'wall'} aria-label="Add door to selected wall" data-tip="Add door (select a wall)"><Icon name="door" /></button>
        <button className="plan2d-tb" onClick={() => addOpening('window')} disabled={selection?.kind !== 'wall'} aria-label="Add window to selected wall" data-tip="Add window (select a wall)"><Icon name="window" /></button>
        <span className="plan2d-sep" />
        <span className="plan2d-tb plan2d-help" tabIndex={0} role="note" aria-label="Shortcuts: Shift click or drag to multi-select, arrows nudge, R rotate, L lock, Ctrl D duplicate, F zoom, Alt drag skips snap">
          ?
          <span className="plan2d-help-pop" aria-hidden="true">
            <span><kbd>Shift</kbd>click or drag to multi-select</span><span><kbd>Arrows</kbd>nudge</span><span><kbd>R</kbd>rotate</span>
            <span><kbd>L</kbd>lock</span><span><kbd>Ctrl D</kbd>duplicate</span><span><kbd>F</kbd>zoom to selection</span><span><kbd>Alt</kbd>drag without snapping</span>
          </span>
        </span>
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
  const fine = px < 0.006; // show 10 cm lines only when they are at least ~8 px apart
  const step = fine ? 0.1 : 0.5;
  const x0 = Math.floor(view.x / step) * step, y0 = Math.floor(view.y / step) * step;
  const maxLines = 400;
  let c = 0;
  for (let x = x0; x <= view.x + view.w && c < maxLines; x += step, c++) {
    const major = Math.abs(x - Math.round(x)) < 1e-6 && fine;
    lines.push(<line key={`x${c}`} x1={x} y1={view.y} x2={x} y2={view.y + view.h} className={major ? 'plan2d-grid-major' : 'plan2d-grid-minor'} strokeWidth={px} />);
  }
  for (let y = y0; y <= view.y + view.h && c < maxLines * 2; y += step, c++) {
    const major = Math.abs(y - Math.round(y)) < 1e-6 && fine;
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

function Item({ f, px, fs, layers, sel, bad, hl, preview, hover }: {
  f: FurnitureItem; px: number; fs: number; layers: Layers; sel: boolean; bad: boolean; hl?: { color: string; label: string }; preview: boolean; hover: boolean;
}) {
  const deg = (f.rotation * 180) / Math.PI;
  const { w, d } = f; const c = f.clearance;
  return (
    <g transform={`translate(${f.x} ${f.y}) rotate(${deg})`} className={`plan2d-item${sel ? ' is-sel' : ''}${bad ? ' is-bad' : ''}${preview ? ' is-preview' : ''}`}>
      {layers.clearance && c && (
        <rect x={-w / 2 - c.left} y={-d / 2 - c.back} width={w + c.left + c.right} height={d + c.back + c.front}
          className="plan2d-clear" strokeWidth={px} strokeDasharray={`${4 * px} ${3 * px}`} />
      )}
      <rect data-hit={`f:${f.id}`} x={-w / 2} y={-d / 2} width={w} height={d} rx={Math.min(0.02, w / 12)}
        className="plan2d-item-body" strokeWidth={(sel || bad ? 2 : 1) * px} />
      <g className="plan2d-sym" strokeWidth={px} pointerEvents="none"><FurnSymbol cat={f.category} w={w} d={d} /></g>
      {hl && <rect x={-w / 2 - 4 * px} y={-d / 2 - 4 * px} width={w + 8 * px} height={d + 8 * px} fill="none" stroke={hl.color} strokeWidth={1.5 * px} pointerEvents="none" />}
      {(sel || hover) && (
        <text fontSize={fs * 0.9} textAnchor="middle" dominantBaseline="central" className="plan2d-item-label plan2d-halo" pointerEvents="none"
          transform={`rotate(${-deg})`}>{f.locked ? 'Locked · ' : ''}{f.name}</text>
      )}
      {sel && !f.locked && (
        <g>
          <line x1={0} y1={d / 2} x2={0} y2={d / 2 + 18 * px} stroke="var(--accent)" strokeWidth={px} pointerEvents="none" />
          <circle data-hit={`rot:${f.id}`} cx={0} cy={d / 2 + 18 * px} r={6 * px} className="plan2d-rot" strokeWidth={1.25 * px}>
            <title>Drag to rotate (15° steps). Press R for 90°.</title>
          </circle>
        </g>
      )}
    </g>
  );
}

/** Top-down architectural symbol inside the item outline. Local frame: back edge at -d/2, front at +d/2. */
function FurnSymbol({ cat, w, d }: { cat: string; w: number; d: number }) {
  const x0 = -w / 2, y0 = -d / 2, x1 = w / 2, y1 = d / 2;
  const m = Math.min(w, d);
  const R = (x: number, y: number, ww: number, hh: number, k: string | number, rx = 0) =>
    <rect key={k} x={x} y={y} width={Math.max(0, ww)} height={Math.max(0, hh)} rx={rx} />;
  const L = (ax: number, ay: number, bx: number, by: number, k: string | number) => <line key={k} x1={ax} y1={ay} x2={bx} y2={by} />;
  if (/bed|crib/.test(cat)) {
    const ph = Math.min(0.22, d * 0.14); const two = w > 1.1; const pw = two ? w / 2 - 0.12 : w - 0.16;
    const fold = y0 + 0.08 + ph + 0.14;
    return <>
      {R(x0 + 0.08, y0 + 0.08, pw, ph, 'p1', 0.03)}
      {two && R(0.04, y0 + 0.08, pw, ph, 'p2', 0.03)}
      {L(x0, fold, x1, fold, 'f')}
      {L(x0, fold, x0 + Math.min(0.35, w * 0.3), fold + 0.25, 'c')}
      {cat === 'bunk-bed' && L(x0, y0, x1, y1, 'x')}
    </>;
  }
  if (cat === 'bench') return <>{L(x0, 0, x1, 0, 'm')}</>;
  if (/sofa|armchair/.test(cat)) {
    const back = Math.min(0.2, d * 0.25), arm = Math.min(0.18, w * 0.15);
    const seats = cat === 'armchair' ? 1 : Math.max(2, Math.round((w - 2 * arm) / 0.65));
    const sw = (w - 2 * arm) / seats;
    return <>
      {R(x0, y0, w, back, 'b')}{R(x0, y0 + back, arm, d - back, 'l')}{R(x1 - arm, y0 + back, arm, d - back, 'r')}
      {Array.from({ length: seats - 1 }, (_, i) => L(x0 + arm + sw * (i + 1), y0 + back, x0 + arm + sw * (i + 1), y1 - 0.04, `s${i}`))}
    </>;
  }
  if (cat === 'coffee-table') return <>{R(x0 + 0.05, y0 + 0.05, w - 0.1, d - 0.1, 'i', 0.02)}</>;
  if (cat === 'table' || cat === 'cafe-table') {
    // Chairs tucked under both long sides.
    const cw = 0.4, ch = Math.min(0.18, d * 0.22), n = Math.max(1, Math.floor((w - 0.1) / 0.6)), gap = w / n;
    return <>{Array.from({ length: n }, (_, i) => {
      const cx = x0 + gap * (i + 0.5);
      return <g key={i}>{R(cx - cw / 2, y0 + 0.04, cw, ch, 't', 0.03)}{R(cx - cw / 2, y1 - 0.04 - ch, cw, ch, 'u', 0.03)}</g>;
    })}</>;
  }
  if (/desk|counter/.test(cat)) {
    const dw = Math.min(0.45, w * 0.35);
    return <>{L(x0 + 0.04, y0 + 0.06, x1 - 0.04, y0 + 0.06, 'e')}{R(x1 - dw - 0.04, y0 + 0.1, dw, d - 0.2, 'p')}{R(-0.22, y1 - 0.12, 0.44, 0.08, 'c', 0.02)}</>;
  }
  if (cat === 'stool') return <circle r={m * 0.3} />;
  if (/chair/.test(cat)) return <>{R(x0 + w * 0.12, y0 + d * 0.06, w * 0.76, d * 0.18, 'b', 0.02)}</>;
  if (/shelf|storage|cabinet|wardrobe|dresser|tv-unit|filing|nightstand/.test(cat)) {
    const n = Math.max(1, Math.round(w / 0.4));
    const lines = Array.from({ length: n - 1 }, (_, i) => L(x0 + (w / n) * (i + 1), y0, x0 + (w / n) * (i + 1), y1, i));
    if (cat === 'wardrobe') return <>{L(x0 + 0.05, 0, x1 - 0.05, 0, 'r')}{lines}</>;
    return <>{L(x0, y1 - 0.03, x1, y1 - 0.03, 'f')}{lines}</>;
  }
  if (cat === 'rug') return <>{R(x0 + 0.06, y0 + 0.06, w - 0.12, d - 0.12, 'i')}</>;
  if (cat === 'plant' || cat === 'lamp') return <><circle r={m * 0.32} />{L(-m * 0.3, 0, m * 0.3, 0, 'h')}{L(0, -m * 0.3, 0, m * 0.3, 'v')}</>;
  return <>{L(x0 + 0.04, y1 - 0.04, x1 - 0.04, y1 - 0.04, 'f')}</>;
}

