import {
  add, centroid, closestPointOnSegment, convexOverlap, dist, doorSwingPolygon, dot, fmtCm, itemCorners, mul, norm,
  openingSegment, perp, pointInPolygon, polygonInside, rotate, sub, wallInwardNormal, wallSegment,
} from '../../core/geometry';
import type { FurnitureItem, Space, SpaceModel, Vec2 } from '../../core/types';

/** Drag-and-drop payload type for catalog items (library -> plan / 3D). Data = catalogId. */
export const CATALOG_DND = 'application/x-spacelens-catalog';

export interface Pose { x: number; y: number; rotation: number }
type ItemLike = Pick<FurnitureItem, 'x' | 'y' | 'w' | 'd' | 'rotation'> & Partial<FurnitureItem>;

/** Categories that normally stand with their back against a wall. */
export const WALL_CATEGORIES = new Set(['bed', 'sofa', 'desk', 'bookshelf', 'wardrobe', 'dresser', 'tv']);
export const isWallCategory = (category: string) => WALL_CATEGORIES.has(category.toLowerCase());

/** Rotation that makes an item's front (local +y) face direction `n`. */
export const rotationFacing = (n: Vec2) => Math.atan2(-n.x, n.y);

function spaceOf(model: SpaceModel, p: Vec2): Space | undefined {
  return model.spaces.find((s) => pointInPolygon(p, s.polygon)) ?? model.spaces[0];
}

/** Door swing polygons for every door in the model. */
export function doorZones(model: SpaceModel): Vec2[][] {
  const out: Vec2[][] = [];
  for (const o of model.openings) {
    const s = model.spaces.find((x) => x.id === o.spaceId);
    const z = s && doorSwingPolygon(s, o);
    if (z) out.push(z);
  }
  return out;
}

function poseFits(space: Space, item: ItemLike, pose: Pose, others: FurnitureItem[], zones: Vec2[][]): boolean {
  const it = { ...item, ...pose };
  const body = itemCorners(it);
  if (!polygonInside(body, space.polygon)) return false;
  const env = itemCorners(it, true);
  for (const z of zones) if (convexOverlap(body, z) > 0) return false;
  for (const o of others) {
    if (o.id === item.id || o.category === 'rug') continue;
    const ob = itemCorners(o);
    if (convexOverlap(body, ob) > 0) return false;
    // Keep clearance envelopes free of other bodies (both directions).
    if (convexOverlap(env, ob) > 1e-3 || convexOverlap(body, itemCorners(o, true)) > 1e-3) return false;
  }
  return true;
}

/** Wall-backed poses along every wall of a space, facing inward. */
function wallPoses(space: Space, item: ItemLike, step = 0.1): Pose[] {
  const out: Pose[] = [];
  const back = item.clearance?.back ?? 0;
  for (let i = 0; i < space.polygon.length; i++) {
    const [a, b] = wallSegment(space, i);
    const L = dist(a, b);
    if (L < item.w) continue;
    const dir = norm(sub(b, a)), n = wallInwardNormal(space, i);
    const rotation = rotationFacing(n);
    const ts: number[] = [];
    for (let t = item.w / 2; t <= L - item.w / 2 + 1e-9; t += step) ts.push(t);
    ts.sort((p, q) => Math.abs(p - L / 2) - Math.abs(q - L / 2)); // centred first
    for (const t of ts) {
      const c = add(add(a, mul(dir, t)), mul(n, item.d / 2 + back + 0.005));
      out.push({ x: c.x, y: c.y, rotation });
    }
  }
  return out;
}

/** First pose where `item` fits without overlapping `others`, clearance envelopes or door swings.
 *  Wall-type categories prefer wall-backed, inward-facing poses. Searches every space. Falls back to the first room centre. */
export function findFreeSpot(model: SpaceModel, item: FurnitureItem, others: FurnitureItem[] = model.furniture): { x: number; y: number; rotation: number } {
  const zones = doorZones(model);
  const spaces = [...model.spaces].sort((s, t) => (s === spaceOf(model, item) ? -1 : t === spaceOf(model, item) ? 1 : 0));
  for (const relaxed of [false, true]) {
    const zs = relaxed ? [] : zones;
    const oth = relaxed ? others.map((o) => ({ ...o, clearance: { front: 0, back: 0, left: 0, right: 0 } })) : others;
    const self = relaxed ? { ...item, clearance: { front: 0, back: 0, left: 0, right: 0 } } : item;
    for (const space of spaces) {
      if (isWallCategory(item.category)) {
        for (const p of wallPoses(space, self)) if (poseFits(space, self, p, oth, zs)) return p;
      }
      const c = centroid(space.polygon);
      for (let r = 0; r < 6; r += 0.1) {
        for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
          for (const rotation of [item.rotation, item.rotation + Math.PI / 2]) {
            const pose = { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r, rotation };
            if (poseFits(space, self, pose, oth, zs)) return pose;
          }
          if (r === 0) break;
        }
      }
    }
  }
  const c = centroid(model.spaces[0]?.polygon ?? [{ x: 0, y: 0 }]);
  return { x: c.x, y: c.y, rotation: item.rotation };
}

export interface WallHit { spaceId: string; wallIndex: number; distanceM: number; inward: Vec2; point: Vec2 }

/** Distance from the item's footprint to the nearest wall (any space), plus which wall. */
export function nearestWallDistance(model: SpaceModel, item: ItemLike): WallHit | null {
  const corners = itemCorners(item);
  let best: WallHit | null = null;
  for (const s of model.spaces) {
    for (let i = 0; i < s.polygon.length; i++) {
      const [a, b] = wallSegment(s, i);
      for (const p of corners) {
        const { point } = closestPointOnSegment(p, a, b);
        const d = dist(p, point);
        if (!best || d < best.distanceM) best = { spaceId: s.id, wallIndex: i, distanceM: d, inward: wallInwardNormal(s, i), point };
      }
    }
  }
  return best;
}

/** Pose that puts the item's back edge flush against the nearest wall, facing inward; null if none within threshold. */
export function snapToWall(model: SpaceModel, item: ItemLike, thresholdM = 0.15): Pose | null {
  const centre = { x: item.x, y: item.y };
  let best: { pose: Pose; gap: number } | null = null;
  for (const s of model.spaces) {
    for (let i = 0; i < s.polygon.length; i++) {
      const [a, b] = wallSegment(s, i);
      const n = wallInwardNormal(s, i);
      const rotation = rotationFacing(n);
      // Gap measured as if the item already faced inward.
      const { point, t } = closestPointOnSegment(centre, a, b);
      if (t <= 0 || t >= 1) continue;
      const along = dot(sub(centre, point), n);
      if (along < 0) continue;
      const gap = along - item.d / 2;
      if (gap > thresholdM || gap < -item.d) continue;
      const L = dist(a, b), dir = norm(sub(b, a));
      const tt = Math.min(Math.max(t * L, Math.min(item.w / 2, L / 2)), Math.max(L - item.w / 2, L / 2));
      const c = add(add(a, mul(dir, tt)), mul(n, item.d / 2));
      if (!best || Math.abs(gap) < best.gap) best = { pose: { x: c.x, y: c.y, rotation }, gap: Math.abs(gap) };
    }
  }
  return best?.pose ?? null;
}

export interface Guide { axis: 'x' | 'y'; value: number; from: number; to: number; kind: 'edge' | 'centre'; otherId: string }

function aabb(it: ItemLike) {
  const cs = itemCorners(it);
  const xs = cs.map((p) => p.x), ys = cs.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys), cx: it.x, cy: it.y };
}

/** Vertical (axis 'x', constant x) and horizontal (axis 'y', constant y) guide lines where edges or centres line up. */
export function alignmentGuides(item: ItemLike, others: FurnitureItem[], tol = 0.03): Guide[] {
  const A = aabb(item);
  const out: Guide[] = [];
  for (const o of others) {
    if (o.id === item.id) continue;
    const B = aabb(o);
    const check = (axis: 'x' | 'y', mine: [number, Guide['kind']][], theirs: [number, Guide['kind']][]) => {
      for (const [m, km] of mine) for (const [t, kt] of theirs) {
        if (km !== kt || Math.abs(m - t) > tol) continue;
        const [lo, hi] = axis === 'x' ? [Math.min(A.minY, B.minY), Math.max(A.maxY, B.maxY)] : [Math.min(A.minX, B.minX), Math.max(A.maxX, B.maxX)];
        out.push({ axis, value: t, from: lo, to: hi, kind: km, otherId: o.id });
      }
    };
    check('x', [[A.minX, 'edge'], [A.maxX, 'edge'], [A.cx, 'centre']], [[B.minX, 'edge'], [B.maxX, 'edge'], [B.cx, 'centre']]);
    check('y', [[A.minY, 'edge'], [A.maxY, 'edge'], [A.cy, 'centre']], [[B.minY, 'edge'], [B.maxY, 'edge'], [B.cy, 'centre']]);
  }
  return out;
}

/** SAT minimum translation vector pushing convex `a` out of convex `b`, or null when separate. */
export function mtv(a: Vec2[], b: Vec2[]): Vec2 | null {
  let best: { axis: Vec2; depth: number } | null = null;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const axis = norm(perp(sub(poly[(i + 1) % poly.length], poly[i])));
      const pa = a.map((p) => dot(p, axis)), pb = b.map((p) => dot(p, axis));
      const a0 = Math.min(...pa), a1 = Math.max(...pa), b0 = Math.min(...pb), b1 = Math.max(...pb);
      const o = Math.min(a1, b1) - Math.max(a0, b0);
      if (o <= 1e-6) return null;
      if (!best || o < best.depth) {
        const sign = (a0 + a1) / 2 < (b0 + b1) / 2 ? -1 : 1;
        best = { axis: mul(axis, sign), depth: o };
      }
    }
  }
  return best ? mul(best.axis, best.depth) : null;
}

/** Smallest translation (iterated MTV) that clears overlap with `others`; null if no overlap or unresolved. */
export function resolveOverlap(model: SpaceModel, item: ItemLike, others: FurnitureItem[]): { x: number; y: number } | null {
  void model;
  let x = item.x, y = item.y, moved = false;
  for (let iter = 0; iter < 12; iter++) {
    let hit = false;
    for (const o of others) {
      if (o.id === item.id || o.category === 'rug') continue;
      const m = mtv(itemCorners({ ...item, x, y }), itemCorners(o));
      if (m) { x += m.x * 1.001; y += m.y * 1.001; hit = moved = true; }
    }
    if (!hit) return moved ? { x, y } : null;
  }
  return null;
}

/** Pose pushed so the footprint lies fully inside its room (best effort for concave rooms). */
export function clampInside(model: SpaceModel, item: ItemLike): Pose {
  const space = spaceOf(model, { x: item.x, y: item.y });
  let x = item.x, y = item.y;
  if (!space) return { x, y, rotation: item.rotation };
  const c = centroid(space.polygon);
  for (let iter = 0; iter < 40; iter++) {
    const cs = itemCorners({ ...item, x, y });
    if (polygonInside(cs, space.polygon)) break;
    let push = { x: 0, y: 0 };
    for (let i = 0; i < space.polygon.length; i++) {
      const [a, b] = wallSegment(space, i);
      const n = wallInwardNormal(space, i);
      for (const p of cs) {
        const pen = -dot(sub(p, a), n);
        const { t } = closestPointOnSegment(p, a, b);
        if (pen > 1e-6 && t > 0 && t < 1 && pen > dot(push, n)) push = add(push, mul(n, pen - Math.max(0, dot(push, n))));
      }
    }
    if (Math.hypot(push.x, push.y) < 1e-6) { const d = norm(sub(c, { x, y })); push = mul(d, 0.05); }
    x += push.x * 1.0001; y += push.y * 1.0001;
  }
  return { x, y, rotation: item.rotation };
}

export function groupBounds(items: ItemLike[]): { minX: number; minY: number; maxX: number; maxY: number; cx: number; cy: number; w: number; h: number } {
  if (!items.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, cx: 0, cy: 0, w: 0, h: 0 };
  const ps = items.flatMap((i) => itemCorners(i));
  const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
}

export function moveGroup<T extends ItemLike>(items: T[], dx: number, dy: number): T[] {
  return items.map((i) => (i.locked ? i : { ...i, x: i.x + dx, y: i.y + dy }));
}

export function rotateGroup<T extends ItemLike>(items: T[], angle: number, pivot?: Vec2): T[] {
  const pv = pivot ?? (() => { const b = groupBounds(items); return { x: b.cx, y: b.cy }; })();
  return items.map((i) => {
    if (i.locked) return i;
    const p = add(rotate(sub({ x: i.x, y: i.y }, pv), angle), pv);
    return { ...i, x: p.x, y: p.y, rotation: i.rotation + angle };
  });
}

/** Compass name of a wall from its inward normal (north = -y on the plan). */
export function wallCompass(inward: Vec2): 'north' | 'south' | 'east' | 'west' {
  const out = { x: -inward.x, y: -inward.y };
  return Math.abs(out.x) > Math.abs(out.y) ? (out.x > 0 ? 'east' : 'west') : (out.y > 0 ? 'south' : 'north');
}

/** Plain-language placement, e.g. "Against the north wall, 40 cm from the window". */
export function describeItemPlacement(model: SpaceModel, item: ItemLike): string {
  const w = nearestWallDistance(model, item);
  const corners = itemCorners(item);
  let head: string;
  if (!w) head = 'Free-standing';
  else if (w.distanceM <= 0.05) head = `Against the ${wallCompass(w.inward)} wall`;
  else if (w.distanceM <= 0.6) head = `${fmtCm(w.distanceM)} from the ${wallCompass(w.inward)} wall`;
  else head = 'In the middle of the room';
  let near: { d: number; kind: string } | null = null;
  for (const o of model.openings) {
    const s = model.spaces.find((x) => x.id === o.spaceId);
    if (!s) continue;
    const { a, b } = openingSegment(s, o);
    for (const p of corners) {
      const d = dist(p, closestPointOnSegment(p, a, b).point);
      if (!near || d < near.d) near = { d, kind: o.kind === 'opening' ? 'opening' : o.kind };
    }
  }
  if (near && near.d < 1.5) return `${head}, ${fmtCm(near.d)} from the ${near.kind}`;
  return head;
}
