import { add, bounds, dist, dot, mul, norm, pointInPolygon, sub, itemCorners } from './geometry';
import type { FurnitureItem, Op, SpaceModel, Vec2 } from './types';

const bump = (m: SpaceModel): SpaceModel => ({ ...m, version: m.version + 1 });

/** Pure reducer: every edit to the space goes through here. */
export function applyOp(model: SpaceModel, op: Op): SpaceModel {
  switch (op.type) {
    case 'REPLACE_MODEL':
      return { ...op.model, version: model.version + 1 };

    case 'SET_WALL_LENGTH': {
      const spaces = model.spaces.map((s) => {
        if (s.id !== op.spaceId) return s;
        const n = s.polygon.length;
        const a = s.polygon[op.wallIndex], b = s.polygon[(op.wallIndex + 1) % n];
        const cur = dist(a, b);
        if (cur < 1e-9 || op.lengthM <= 0) return s;
        const dir = norm(sub(b, a));
        const delta = op.lengthM - cur;
        const far = dot(sub(b, a), dir);
        // Shift every vertex at or beyond the wall's far end along the wall direction.
        // Keeps rectangles and orthogonal L-shapes rectangular.
        const polygon = s.polygon.map((p) => (dot(sub(p, a), dir) >= far - 1e-6 ? add(p, mul(dir, delta)) : p));
        const walls = s.walls.map((w, i) => (i === op.wallIndex ? { ...w, sourceKind: op.sourceKind ?? 'manual', status: 'verified' as const } : w));
        return { ...s, polygon, walls };
      });
      return bump({ ...model, spaces });
    }

    case 'MOVE_VERTEX':
      return bump({
        ...model,
        spaces: model.spaces.map((s) => (s.id !== op.spaceId ? s : { ...s, polygon: s.polygon.map((p, i) => (i === op.index ? op.to : p)) })),
      });

    case 'INSERT_VERTEX':
      return bump({
        ...model,
        spaces: model.spaces.map((s) => {
          if (s.id !== op.spaceId) return s;
          const polygon = [...s.polygon]; polygon.splice(op.afterIndex + 1, 0, op.at);
          const walls = [...s.walls]; walls.splice(op.afterIndex + 1, 0, { ...s.walls[op.afterIndex] });
          return { ...s, polygon, walls };
        }),
        openings: model.openings.map((o) => (o.spaceId === op.spaceId && o.wallIndex > op.afterIndex ? { ...o, wallIndex: o.wallIndex + 1 } : o)),
      });

    case 'REMOVE_VERTEX':
      return bump({
        ...model,
        spaces: model.spaces.map((s) => {
          if (s.id !== op.spaceId || s.polygon.length <= 3) return s;
          return { ...s, polygon: s.polygon.filter((_, i) => i !== op.index), walls: s.walls.filter((_, i) => i !== op.index) };
        }),
        openings: model.openings
          .filter((o) => !(o.spaceId === op.spaceId && o.wallIndex === op.index))
          .map((o) => (o.spaceId === op.spaceId && o.wallIndex > op.index ? { ...o, wallIndex: o.wallIndex - 1 } : o)),
      });

    case 'RESIZE_SPACE':
      return bump(resizeSpace(model, op.spaceId, op).model);

    case 'SET_CEILING':
      return bump({ ...model, ceilingM: op.heightM });

    case 'ADD_OPENING':
      return bump({ ...model, openings: [...model.openings, op.opening] });
    case 'UPDATE_OPENING':
      return bump({ ...model, openings: model.openings.map((o) => (o.id === op.id ? { ...o, ...op.patch } : o)) });
    case 'REMOVE_OPENING':
      return bump({ ...model, openings: model.openings.filter((o) => o.id !== op.id) });

    case 'PLACE_OBJECT':
      return bump({ ...model, furniture: [...model.furniture, op.item] });
    case 'UPDATE_OBJECT':
      return bump({ ...model, furniture: model.furniture.map((f) => (f.id === op.id ? { ...f, ...op.patch } : f)) });
    case 'REMOVE_OBJECT':
      return bump({ ...model, furniture: model.furniture.filter((f) => f.id !== op.id) });
    case 'SET_FURNITURE':
      return bump({ ...model, furniture: op.items });

    case 'ADD_EVIDENCE':
      return bump({ ...model, evidence: [...model.evidence.filter((e) => e.id !== op.evidence.id), op.evidence] });
    case 'SET_MEASUREMENT':
      return bump({ ...model, measurements: [...model.measurements.filter((m) => m.id !== op.measurement.id), op.measurement] });

    case 'RENAME':
      return bump({ ...model, name: op.name });
  }
}

export function describeOp(op: Op): string {
  switch (op.type) {
    case 'REPLACE_MODEL': return `Loaded "${op.model.name}"`;
    case 'SET_WALL_LENGTH': return `Wall set to ${op.lengthM.toFixed(2)} m`;
    case 'MOVE_VERTEX': return 'Corner moved';
    case 'INSERT_VERTEX': return 'Corner added';
    case 'REMOVE_VERTEX': return 'Corner removed';
    case 'RESIZE_SPACE': return resizeLabel(op);
    case 'SET_CEILING': return `Ceiling set to ${op.heightM.toFixed(2)} m`;
    case 'ADD_OPENING': return `${op.opening.kind} added`;
    case 'UPDATE_OPENING': return 'Opening changed';
    case 'REMOVE_OPENING': return 'Opening removed';
    case 'PLACE_OBJECT': return `${op.item.name} placed`;
    case 'UPDATE_OBJECT': return 'Object changed';
    case 'REMOVE_OBJECT': return 'Object removed';
    case 'SET_FURNITURE': return op.label ?? 'Layout applied';
    case 'ADD_EVIDENCE': return 'Evidence added';
    case 'SET_MEASUREMENT': return `Measurement "${op.measurement.label}" set`;
    case 'RENAME': return `Renamed to "${op.name}"`;
  }
}

export interface ResizeSize { widthM?: number; depthM?: number; heightM?: number }
const okSize = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0.2 && n < 200;

function resizeLabel(o: ResizeSize): string {
  const f = (n: number) => +n.toFixed(2);
  if (o.widthM && o.depthM) return `${f(o.widthM)} × ${f(o.depthM)} m`;
  if (o.widthM) return `Width ${f(o.widthM)} m`;
  if (o.depthM) return `Depth ${f(o.depthM)} m`;
  return `Ceiling ${f(o.heightM ?? 0)} m`;
}

/**
 * Set a room's size. The room's top-left corner (its bounding box minimum) stays put and the polygon is scaled
 * about it, so a rectangle gets exactly the requested size. Openings keep their width and slide proportionally
 * along their wall; furniture positions scale (sizes never do) and anything left outside is nudged back in.
 * Other rooms never move; a returned warning says when the new footprint overlaps one.
 */
export function resizeSpace(model: SpaceModel, spaceId: string, size: ResizeSize): { model: SpaceModel; warning?: string } {
  const space = model.spaces.find((s) => s.id === spaceId);
  if (!space) return { model };
  const bb = bounds(space.polygon);
  const sx = okSize(size.widthM) && bb.w > 1e-9 ? size.widthM / bb.w : 1;
  const sy = okSize(size.depthM) && bb.h > 1e-9 ? size.depthM / bb.h : 1;
  const ceilingM = okSize(size.heightM) ? size.heightM : model.ceilingM;
  if (sx === 1 && sy === 1) return { model: { ...model, ceilingM } };

  const at = (p: Vec2): Vec2 => ({ x: bb.minX + (p.x - bb.minX) * sx, y: bb.minY + (p.y - bb.minY) * sy });
  const polygon = space.polygon.map(at);
  const n = polygon.length;
  const wallLen = (poly: Vec2[], i: number) => dist(poly[i], poly[(i + 1) % n]);

  const openings = model.openings.map((o) => {
    if (o.spaceId !== spaceId) return o;
    const oldL = wallLen(space.polygon, o.wallIndex), newL = wallLen(polygon, o.wallIndex);
    if (oldL < 1e-9) return o;
    const half = o.widthM / 2;
    const want = (o.offsetM / oldL) * newL;
    const offsetM = newL <= o.widthM ? newL / 2 : Math.min(newL - half, Math.max(half, want));
    return { ...o, offsetM };
  });

  const owned = (f: FurnitureItem) => (model.spaces.length === 1 ? true : pointInPolygon({ x: f.x, y: f.y }, space.polygon));
  const nb = bounds(polygon);
  const furniture = model.furniture.map((f) => {
    if (!owned(f)) return f;
    let { x, y } = at({ x: f.x, y: f.y });
    const c = bounds(itemCorners({ ...f, x, y }));
    if (c.w <= nb.w) { if (c.minX < nb.minX) x += nb.minX - c.minX; else if (c.maxX > nb.maxX) x -= c.maxX - nb.maxX; }
    if (c.h <= nb.h) { if (c.minY < nb.minY) y += nb.minY - c.minY; else if (c.maxY > nb.maxY) y -= c.maxY - nb.maxY; }
    return { ...f, x, y };
  });

  const spaces = model.spaces.map((s) => (s.id === spaceId ? { ...s, polygon } : s));
  let warning: string | undefined;
  for (const o of model.spaces) {
    if (o.id === spaceId) continue;
    const ob = bounds(o.polygon);
    if (nb.minX < ob.maxX - 0.01 && nb.maxX > ob.minX + 0.01 && nb.minY < ob.maxY - 0.01 && nb.maxY > ob.minY + 0.01) { warning = `Overlaps ${o.name}`; break; }
  }
  return { model: { ...model, ceilingM, spaces, openings, furniture }, warning };
}
