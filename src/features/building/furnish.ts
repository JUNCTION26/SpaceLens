// Furnish a whole floor with the single-room designer: each room is cut out as its own model
// (net of the neighbour's half of every shared wall, moved to the origin), laid out, and the
// furniture is moved back into building coordinates.
import { area, centroid, closestPointOnSegment, dist, pointInPolygon, wallInwardNormal } from '../../core/geometry';
import type { FurnitureItem, Opening, Requirements, Space, SpaceModel, Vec2 } from '../../core/types';
import { compileIntent } from '../intent/compile';
import { generateLayouts } from '../layout/solver';

export interface SubModel { model: SpaceModel; spaceId: string; offset: Vec2 }

const TOL = 1e-3;
const isH = (a: Vec2, b: Vec2) => Math.abs(a.y - b.y) < TOL;
const isV = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < TOL;

/** Drop vertices that lie on a straight wall (merges split walls). */
function mergeCollinear(poly: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[(i - 1 + poly.length) % poly.length], b = poly[i], c = poly[(i + 1) % poly.length];
    if (Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) > 1e-9) out.push(b);
  }
  return out;
}

/** Thickness of another room's wall lying on segment a-b (0 when the segment is on the facade). */
function neighbourThickness(model: SpaceModel, spaceId: string, a: Vec2, b: Vec2): number {
  let t = 0;
  for (const s of model.spaces) {
    if (s.id === spaceId) continue;
    for (let i = 0; i < s.polygon.length; i++) {
      const p = s.polygon[i], q = s.polygon[(i + 1) % s.polygon.length];
      if (isH(a, b) && isH(p, q) && Math.abs(a.y - p.y) < TOL) {
        const o = Math.min(Math.max(a.x, b.x), Math.max(p.x, q.x)) - Math.max(Math.min(a.x, b.x), Math.min(p.x, q.x));
        if (o > 0.05) t = Math.max(t, s.walls[i]?.thicknessM ?? 0);
      } else if (isV(a, b) && isV(p, q) && Math.abs(a.x - p.x) < TOL) {
        const o = Math.min(Math.max(a.y, b.y), Math.max(p.y, q.y)) - Math.max(Math.min(a.y, b.y), Math.min(p.y, q.y));
        if (o > 0.05) t = Math.max(t, s.walls[i]?.thicknessM ?? 0);
      }
    }
  }
  return t;
}

/** Single-room model for one space of a building, translated so its top-left is at the origin. */
export function subModelFor(model: SpaceModel, spaceId: string): SubModel | null {
  const space = model.spaces.find((s) => s.id === spaceId);
  if (!space) return null;
  const merged = mergeCollinear(space.polygon);
  const rectilinear = merged.every((p, i) => { const q = merged[(i + 1) % merged.length]; return isH(p, q) || isV(p, q); });
  let poly = merged;
  if (rectilinear && merged.length >= 4) {
    // move every wall in by the thickness of the neighbour wall standing on it
    const n = merged.length;
    const tmp: Space = { ...space, polygon: merged, walls: merged.map(() => space.walls[0]) };
    const lines = merged.map((a, i) => {
      const b = merged[(i + 1) % n];
      const d = neighbourThickness(model, spaceId, a, b);
      const nrm = wallInwardNormal(tmp, i);
      return { h: isH(a, b), at: isH(a, b) ? a.y + nrm.y * d : a.x + nrm.x * d };
    });
    poly = merged.map((_, i) => {
      const prev = lines[(i - 1 + n) % n], cur = lines[i];
      return prev.h ? { x: cur.at, y: prev.at } : { x: prev.at, y: cur.at };
    });
  }
  const minX = Math.min(...poly.map((p) => p.x)), minY = Math.min(...poly.map((p) => p.y));
  const offset = { x: minX, y: minY };
  const local = poly.map((p) => ({ x: Math.round((p.x - minX) * 1000) / 1000, y: Math.round((p.y - minY) * 1000) / 1000 }));
  const walls = local.map((a, i) => {
    // keep the meta of the original wall under this one
    const b = local[(i + 1) % local.length];
    const mid = { x: (a.x + b.x) / 2 + minX, y: (a.y + b.y) / 2 + minY };
    let best = 0, bd = Infinity;
    space.polygon.forEach((p, j) => { const q = space.polygon[(j + 1) % space.polygon.length]; const d = dist(mid, closestPointOnSegment(mid, p, q).point); if (d < bd) { bd = d; best = j; } });
    return { ...space.walls[best] };
  });
  const sub: Space = { ...space, polygon: local, walls };
  const openings: Opening[] = [];
  for (const o of model.openings) {
    if (o.spaceId !== spaceId || o.wallIndex >= space.polygon.length) continue;
    const a = space.polygon[o.wallIndex], b = space.polygon[(o.wallIndex + 1) % space.polygon.length];
    const L = dist(a, b) || 1;
    const c = { x: a.x + (b.x - a.x) * o.offsetM / L - minX, y: a.y + (b.y - a.y) * o.offsetM / L - minY };
    let wi = 0, bd = Infinity, off = 0;
    local.forEach((p, j) => {
      const q = local[(j + 1) % local.length];
      const cp = closestPointOnSegment(c, p, q);
      const d = dist(c, cp.point);
      if (d < bd - 1e-9) { bd = d; wi = j; off = dist(p, cp.point); }
    });
    openings.push({ ...o, wallIndex: wi, offsetM: Math.round(off * 1000) / 1000 });
  }
  const furniture = model.furniture
    .filter((f) => pointInPolygon(f, space.polygon))
    .map((f) => ({ ...f, x: f.x - minX, y: f.y - minY, clearance: { ...f.clearance } }));
  return {
    spaceId, offset,
    model: { ...model, id: `${model.id}:${spaceId}`, name: space.name, spaces: [sub], openings, furniture, measurements: [], evidence: [] },
  };
}

/** Replace the furniture of one room with `items` given in that room's sub-model coordinates. */
export function mergeFurniture(model: SpaceModel, spaceId: string, items: FurnitureItem[], offset: Vec2): FurnitureItem[] {
  const space = model.spaces.find((s) => s.id === spaceId);
  if (!space) return model.furniture;
  const keep = model.furniture.filter((f) => !pointInPolygon(f, space.polygon));
  const ids = new Set(keep.map((f) => f.id));
  const placed = items.map((f) => {
    let id = f.id;
    for (let k = 2; ids.has(id); k++) id = `${f.id}-${k}`;
    ids.add(id);
    return { ...f, id, x: Math.round((f.x + offset.x) * 1000) / 1000, y: Math.round((f.y + offset.y) * 1000) / 1000 };
  });
  return [...keep, ...placed];
}

/** A furnishing brief from a room's purpose and size; null for rooms left empty. */
export function defaultBrief(space: Space): string | null {
  const a = area(space.polygon);
  const p = (space.purpose ?? '').toLowerCase();
  const n = (per: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(a / per)));
  switch (p) {
    case 'bedroom': return a >= 12 ? 'bedroom with a double bed, wardrobe and two lamps' : 'bedroom with a bed, wardrobe and a desk';
    case 'living': return 'living room with a sofa, armchair, coffee table and rug';
    case 'kitchen': return `dining table for ${n(3.5, 2, 8)} people`;
    case 'dining': return `dining table for ${n(2.5, 4, 10)} people`;
    case 'workspace': return `office with ${n(6, 2, 12)} desks and chairs`;
    case 'office': return `office with ${n(8, 1, 3)} desk${a >= 16 ? 's' : ''} and a bookshelf`;
    case 'meeting': return `meeting room with a table for ${n(2.2, 4, 14)} people`;
    case 'reception': return 'reception with a desk and a sofa for waiting';
    case 'cafe': return `cafe with tables for ${n(1.5, 4, 60)} people`;
    case 'clinic': return 'clinic treatment room with a treatment bed, desk and two chairs';
    case 'staff': return `dining table for ${n(2.5, 2, 8)} people`;
    default: return null;
  }
}

export type RoomStatus = 'waiting' | 'running' | 'done' | 'skipped' | 'failed';
export interface RoomProgress { spaceId: string; name: string; status: RoomStatus; items?: number; message?: string }

export interface FurnishOptions {
  onRoom?: (p: RoomProgress) => void;
  /** Rooms laid out at the same time (default 1: one after another). */
  parallel?: number;
  signal?: AbortSignal;
  seed?: number;
  timeBudgetMs?: number;
  /** Override the brief reader (defaults to compileIntent). */
  compile?: (brief: string, sub: SpaceModel) => Promise<Requirements>;
  /** Override the layout solver (defaults to generateLayouts). */
  solve?: (sub: SpaceModel, req: Requirements) => Promise<FurnitureItem[] | null>;
}

export interface FurnishResult { furniture: FurnitureItem[]; rooms: RoomProgress[] }

/** Lay out every room that has a brief. Returns the whole building's furniture. */
export async function furnishBuilding(model: SpaceModel, briefByRoom: Record<string, string> = {}, opts: FurnishOptions = {}): Promise<FurnishResult> {
  const compile = opts.compile ?? ((b: string, sub: SpaceModel) => compileIntent(b, sub));
  const solve = opts.solve ?? (async (sub: SpaceModel, req: Requirements) => {
    const res = await generateLayouts(sub, req, { variants: 1, seed: opts.seed ?? 1, timeBudgetMs: opts.timeBudgetMs ?? 1200 });
    return res.candidates[0]?.furniture ?? null;
  });
  const progress: RoomProgress[] = model.spaces.map((s) => ({ spaceId: s.id, name: s.name, status: 'waiting' }));
  const emit = (i: number, patch: Partial<RoomProgress>) => { progress[i] = { ...progress[i], ...patch }; opts.onRoom?.({ ...progress[i] }); };
  const results = new Map<string, { items: FurnitureItem[]; offset: Vec2 }>();
  const jobs = model.spaces.map((s, i) => async () => {
    if (opts.signal?.aborted) return;
    const brief = briefByRoom[s.id] ?? defaultBrief(s);
    if (!brief) { emit(i, { status: 'skipped', message: 'Nothing to furnish' }); return; }
    const sub = subModelFor(model, s.id);
    if (!sub) { emit(i, { status: 'failed', message: 'Room not found' }); return; }
    emit(i, { status: 'running', message: brief });
    try {
      const req = await compile(brief, sub.model);
      const items = await solve(sub.model, req);
      if (!items?.length) { emit(i, { status: 'failed', message: 'No layout fits this room' }); return; }
      results.set(s.id, { items, offset: sub.offset });
      emit(i, { status: 'done', items: items.length });
    } catch (e) {
      emit(i, { status: 'failed', message: (e as Error).message.slice(0, 80) });
    }
  });
  const width = Math.max(1, opts.parallel ?? 1);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => { while (next < jobs.length) await jobs[next++](); }));
  let furniture = model.furniture;
  for (const s of model.spaces) {
    const r = results.get(s.id);
    if (r) furniture = mergeFurniture({ ...model, furniture }, s.id, r.items, r.offset);
  }
  return { furniture, rooms: progress };
}

/** Centre of a room in building coordinates (for labels and camera targets). */
export const roomCentre = (s: Space) => centroid(s.polygon);
