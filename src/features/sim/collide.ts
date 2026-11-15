// Walking collision as pure functions: a standing body is a capsule, which on the plan is a disc
// of radius r. Obstacles are thick wall segments and convex or concave furniture polygons.
// A move is applied in short sub-steps and pushed back out of whatever it overlaps, so the body
// slides along surfaces instead of stopping dead and cannot tunnel through thin walls.
import { distPointSegment, pointInPolygon } from '../../core/geometry';
import type { FurnitureItem, Vec2 } from '../../core/types';
import type { SolidSegment } from './walls';
import { isRug } from './grid';

export type Obstacle =
  | { kind: 'segment'; a: Vec2; b: Vec2; halfM: number }
  | { kind: 'polygon'; pts: Vec2[] };

export const BODY = { stand: 0.25, wheelchair: 0.35 } as const;

export const segmentObstacles = (solids: SolidSegment[]): Obstacle[] => solids.map((s) => ({ kind: 'segment', a: s.a, b: s.b, halfM: s.halfM }));

/** Footprint corners of a furniture item. */
export function footprint(f: Pick<FurnitureItem, 'x' | 'y' | 'w' | 'd' | 'rotation'>): Vec2[] {
  const c = Math.cos(f.rotation), s = Math.sin(f.rotation);
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => {
    const lx = (sx * f.w) / 2, ly = (sy * f.d) / 2;
    return { x: f.x + lx * c - ly * s, y: f.y + lx * s + ly * c };
  });
}

/** Things a walker bumps into: not rugs, not flat things on the floor. */
export const furnitureObstacles = (items: FurnitureItem[], minHeightM = 0.15): Obstacle[] =>
  items.filter((f) => !isRug(f) && f.h >= minHeightM).map((f) => ({ kind: 'polygon', pts: footprint(f) }));

export interface Push { nx: number; ny: number; depth: number }

function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return { x: a.x + dx * t, y: a.y + dy * t };
}

/** How far a disc of radius r at p overlaps the obstacle, and the direction that frees it. */
export function overlap(p: Vec2, r: number, o: Obstacle): Push | null {
  if (o.kind === 'segment') {
    const reach = r + o.halfM;
    const c = closestOnSegment(p, o.a, o.b);
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (d >= reach) return null;
    if (d > 1e-9) return { nx: (p.x - c.x) / d, ny: (p.y - c.y) / d, depth: reach - d };
    const l = Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y) || 1;
    return { nx: -(o.b.y - o.a.y) / l, ny: (o.b.x - o.a.x) / l, depth: reach };
  }
  const pts = o.pts;
  let best = Infinity, bc: Vec2 = pts[0];
  for (let i = 0; i < pts.length; i++) {
    const c = closestOnSegment(p, pts[i], pts[(i + 1) % pts.length]);
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (d < best) { best = d; bc = c; }
  }
  const inside = pointInPolygon(p, pts);
  if (!inside && best >= r) return null;
  if (best < 1e-9) {
    const cx = pts.reduce((s, q) => s + q.x, 0) / pts.length, cy = pts.reduce((s, q) => s + q.y, 0) / pts.length;
    const l = Math.hypot(p.x - cx, p.y - cy) || 1;
    return { nx: (p.x - cx) / l, ny: (p.y - cy) / l, depth: r };
  }
  const sgn = inside ? -1 : 1;
  return { nx: (sgn * (p.x - bc.x)) / best, ny: (sgn * (p.y - bc.y)) / best, depth: inside ? best + r : r - best };
}

export function hits(p: Vec2, r: number, obstacles: Obstacle[]): boolean {
  return obstacles.some((o) => overlap(p, r, o) !== null);
}

/** Push p out of every obstacle it overlaps; a few rounds settle corners. */
function depenetrate(p: Vec2, r: number, obstacles: Obstacle[]): Vec2 {
  let q = p;
  for (let it = 0; it < 6; it++) {
    let moved = false;
    for (const o of obstacles) {
      const h = overlap(q, r, o);
      if (h) { q = { x: q.x + h.nx * (h.depth + 1e-4), y: q.y + h.ny * (h.depth + 1e-4) }; moved = true; }
    }
    if (!moved) break;
  }
  return q;
}

export interface MoveResult { pos: Vec2; blocked: boolean }

/**
 * Move `pos` by `d` and slide along whatever is in the way. `canStand` (optional) vetoes spots off
 * the floor. The move is cut into sub-steps shorter than half the radius so thin walls cannot be
 * skipped, and each sub-step is pushed out of what it overlaps; if the push-out still leaves an
 * overlap or an illegal spot, each axis is tried alone and then the step is dropped.
 */
export function moveSliding(pos: Vec2, d: Vec2, r: number, obstacles: Obstacle[], canStand: (p: Vec2) => boolean = () => true): MoveResult {
  const len = Math.hypot(d.x, d.y);
  if (len < 1e-9) return { pos, blocked: false };
  const n = Math.max(1, Math.ceil(len / (r * 0.5)));
  const sx = d.x / n, sy = d.y / n;
  const free = (q: Vec2) => canStand(q) && !hits(q, r - 0.002, obstacles);
  let p = pos, blocked = false;
  for (let i = 0; i < n; i++) {
    let q = depenetrate({ x: p.x + sx, y: p.y + sy }, r, obstacles);
    if (!free(q)) {
      const qx = depenetrate({ x: p.x + sx, y: p.y }, r, obstacles), qy = depenetrate({ x: p.x, y: p.y + sy }, r, obstacles);
      const okx = free(qx), oky = free(qy);
      q = okx && (!oky || Math.abs(sx) >= Math.abs(sy)) ? qx : oky ? qy : p;
    }
    if (Math.hypot(q.x - p.x - sx, q.y - p.y - sy) > 1e-6) blocked = true;
    p = q;
  }
  return { pos: p, blocked };
}

/** Distance from p to the nearest wall piece, for callers that want a margin. */
export const wallDistance = (p: Vec2, solids: SolidSegment[]) => solids.reduce((m, s) => Math.min(m, distPointSegment(p, s.a, s.b) - s.halfM), Infinity);
