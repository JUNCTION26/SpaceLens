import type { FurnitureItem, Opening, Space, Vec2 } from './types';

export const EPS = 1e-9;

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
export const len = (a: Vec2) => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a: Vec2): Vec2 => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });
export const rotate = (a: Vec2, ang: number): Vec2 => {
  const c = Math.cos(ang), s = Math.sin(ang);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
};
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Signed area; positive when the polygon is clockwise on screen (y down). */
export function signedArea(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}
export const area = (poly: Vec2[]) => Math.abs(signedArea(poly));

export function perimeter(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) s += dist(poly[i], poly[(i + 1) % poly.length]);
  return s;
}

export function centroid(poly: Vec2[]): Vec2 {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f; cy += (p.y + q.y) * f; a += f;
  }
  if (Math.abs(a) < EPS) return poly[0] ?? v(0, 0);
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

export function bounds(points: Vec2[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function segmentsIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d1 = cross(sub(p4, p3), sub(p1, p3));
  const d2 = cross(sub(p4, p3), sub(p2, p3));
  const d3 = cross(sub(p2, p1), sub(p3, p1));
  const d4 = cross(sub(p2, p1), sub(p4, p1));
  return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
}

/** True when no two non-adjacent edges cross and the polygon has at least 3 vertices and non-zero area. */
export function isSimplePolygon(poly: Vec2[]): boolean {
  const n = poly.length;
  if (n < 3 || area(poly) < 1e-6) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsIntersect(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return false;
    }
  }
  return true;
}

export function distPointSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
  return dist(p, add(a, mul(ab, t)));
}

export function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number } {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
  return { point: add(a, mul(ab, t)), t };
}

export function distPointPolygonEdges(p: Vec2, poly: Vec2[]): number {
  let m = Infinity;
  for (let i = 0; i < poly.length; i++) m = Math.min(m, distPointSegment(p, poly[i], poly[(i + 1) % poly.length]));
  return m;
}

export function wallSegment(space: Space, i: number): [Vec2, Vec2] {
  const n = space.polygon.length;
  return [space.polygon[i], space.polygon[(i + 1) % n]];
}
export const wallLength = (space: Space, i: number) => { const [a, b] = wallSegment(space, i); return dist(a, b); };
export const wallId = (spaceId: string, i: number) => `${spaceId}:${i}`;
export function parseWallId(id: string): { spaceId: string; wallIndex: number } | null {
  const k = id.lastIndexOf(':');
  if (k < 0) return null;
  const wallIndex = Number(id.slice(k + 1));
  return Number.isFinite(wallIndex) ? { spaceId: id.slice(0, k), wallIndex } : null;
}

/** Inward normal of wall i (for a clockwise-on-screen polygon). */
export function wallInwardNormal(space: Space, i: number): Vec2 {
  const [a, b] = wallSegment(space, i);
  const d = norm(sub(b, a));
  const n = perp(d); // (-dy, dx)
  const mid = lerp(a, b, 0.5);
  return pointInPolygon(add(mid, mul(n, 0.01)), space.polygon) ? n : mul(n, -1);
}

/** Endpoints of an opening along its host wall plus its centre. */
export function openingSegment(space: Space, o: Opening): { a: Vec2; b: Vec2; c: Vec2; dir: Vec2; inward: Vec2 } {
  const [p, q] = wallSegment(space, o.wallIndex);
  const dir = norm(sub(q, p));
  const c = add(p, mul(dir, o.offsetM));
  return { a: add(c, mul(dir, -o.widthM / 2)), b: add(c, mul(dir, o.widthM / 2)), c, dir, inward: wallInwardNormal(space, o.wallIndex) };
}

/** The four corners of a furniture footprint, optionally grown by its clearance envelope. */
export function itemCorners(item: Pick<FurnitureItem, 'x' | 'y' | 'w' | 'd' | 'rotation'> & { clearance?: FurnitureItem['clearance'] }, withClearance = false, unfolded?: number): Vec2[] {
  const d = unfolded ?? item.d;
  let l = -item.w / 2, r = item.w / 2, t = -d / 2, b = d / 2; // front faces +y
  if (withClearance && item.clearance) {
    l -= item.clearance.left; r += item.clearance.right; t -= item.clearance.back; b += item.clearance.front;
  }
  const local = [v(l, t), v(r, t), v(r, b), v(l, b)];
  return local.map((p) => add(rotate(p, item.rotation), v(item.x, item.y)));
}

function project(poly: Vec2[], axis: Vec2): [number, number] {
  let mn = Infinity, mx = -Infinity;
  for (const p of poly) { const d = dot(p, axis); if (d < mn) mn = d; if (d > mx) mx = d; }
  return [mn, mx];
}

/** Separating-axis overlap depth for two convex polygons (0 when separate or merely touching). */
export function convexOverlap(a: Vec2[], b: Vec2[]): number {
  let minDepth = Infinity;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const e = sub(poly[(i + 1) % poly.length], poly[i]);
      const axis = norm(perp(e));
      const [a0, a1] = project(a, axis), [b0, b1] = project(b, axis);
      const o = Math.min(a1, b1) - Math.max(a0, b0);
      if (o <= 1e-6) return 0;
      if (o < minDepth) minDepth = o;
    }
  }
  return minDepth;
}

/** True when every corner of `inner` is inside `outer` and no edges cross. */
export function polygonInside(inner: Vec2[], outer: Vec2[]): boolean {
  for (const p of inner) if (!pointInPolygon(p, outer)) return false;
  for (let i = 0; i < inner.length; i++) {
    for (let j = 0; j < outer.length; j++) {
      if (segmentsIntersect(inner[i], inner[(i + 1) % inner.length], outer[j], outer[(j + 1) % outer.length])) return false;
    }
  }
  return true;
}

/** Door leaf swing area approximated as a square of side = width, on the swing side. */
export function doorSwingPolygon(space: Space, o: Opening): Vec2[] | null {
  if (o.kind !== 'door' || o.swing === 'none') return null;
  const { a, b, inward } = openingSegment(space, o);
  const n = o.swing === 'in' ? inward : mul(inward, -1);
  const w = o.widthM;
  return [a, b, add(b, mul(n, w)), add(a, mul(n, w))];
}

export const fmtM = (m: number, digits = 2) => `${m.toFixed(digits)} m`;
export const fmtCm = (m: number) => `${Math.round(m * 100)} cm`;
export const fmtM2 = (m2: number) => `${m2.toFixed(1)} m²`;
export const fmtSek = (n: number) => `${Math.round(n).toLocaleString('sv-SE')} kr`;

let counter = 0;
export const uid = (prefix = 'id') => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
