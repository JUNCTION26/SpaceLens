// Cut one room out of a building as its own single-room model (net of the neighbour's half of
// every shared wall, moved to the origin), and put furniture laid out there back into the building.
import { closestPointOnSegment, dist, pointInPolygon, wallInwardNormal } from '../../core/geometry';
import type { FurnitureItem, Opening, Space, SpaceModel, Vec2 } from '../../core/types';

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

