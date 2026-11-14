import { bounds, centroid, openingSegment, pointInPolygon, itemCorners, add, mul } from '../../core/geometry';
import type { FurnitureItem, SpaceModel, Vec2 } from '../../core/types';
import { doorBridges, interiorSolids, spaceAt, wallEdges } from './walls';

export const CELL = 0.05;

export interface OccGrid {
  ox: number; oy: number; cols: number; rows: number; cell: number;
  free: Uint8Array;
  /** Distance in metres from each cell to the nearest obstacle (0 for blocked cells). */
  dist: Float32Array;
}

export const isRug = (f: FurnitureItem) => /rug|carpet/i.test(f.category + ' ' + f.name);

/**
 * Occupancy grid of the room polygon(s) minus furniture footprints and interior walls (door and
 * opening gaps stay open), plus a chamfer distance transform.
 */
export function buildGrid(model: SpaceModel, furniture: FurnitureItem[], cell = CELL): OccGrid {
  const polys = model.spaces.map((s) => s.polygon);
  const b = bounds(polys.flat());
  const ox = b.minX - cell, oy = b.minY - cell;
  const cols = Math.ceil((b.maxX - b.minX) / cell) + 2, rows = Math.ceil((b.maxY - b.minY) / cell) + 2;
  const free = new Uint8Array(cols * rows);
  // rasterise each room and each piece of furniture over its own bounding box only, so plans with
  // 100+ rooms cost about the same per cell as a single room
  const fill = (poly: Vec2[], v: 0 | 1) => {
    const bb = bounds(poly);
    const c0 = Math.max(0, Math.floor((bb.minX - ox) / cell)), c1 = Math.min(cols - 1, Math.ceil((bb.maxX - ox) / cell));
    const r0 = Math.max(0, Math.floor((bb.minY - oy) / cell)), r1 = Math.min(rows - 1, Math.ceil((bb.maxY - oy) / cell));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const i = r * cols + c;
      if (free[i] === v) continue;
      if (pointInPolygon({ x: ox + (c + 0.5) * cell, y: oy + (r + 0.5) * cell }, poly)) free[i] = v;
    }
  };
  for (const poly of polys) fill(poly, 1);
  const edges = model.spaces.length > 1 ? wallEdges(model) : [];
  for (const b of doorBridges(edges)) fill(b, 1);
  for (const f of furniture) if (!isRug(f)) fill(itemCorners(f), 0);
  // interior walls: block every cell whose centre is within the wall's half thickness (at least
  // one cell wide so nothing leaks through diagonally)
  if (model.spaces.length > 1) {
    for (const s of interiorSolids(model, edges)) {
      const half = Math.max(s.halfM, cell * 0.75);
      const c0 = Math.max(0, Math.floor((Math.min(s.a.x, s.b.x) - half - ox) / cell)), c1 = Math.min(cols - 1, Math.ceil((Math.max(s.a.x, s.b.x) + half - ox) / cell));
      const r0 = Math.max(0, Math.floor((Math.min(s.a.y, s.b.y) - half - oy) / cell)), r1 = Math.min(rows - 1, Math.ceil((Math.max(s.a.y, s.b.y) + half - oy) / cell));
      const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, L2 = dx * dx + dy * dy || 1;
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const px = ox + (c + 0.5) * cell, py = oy + (r + 0.5) * cell;
        const t = Math.max(0, Math.min(1, ((px - s.a.x) * dx + (py - s.a.y) * dy) / L2));
        if (Math.hypot(px - s.a.x - dx * t, py - s.a.y - dy * t) < half) free[r * cols + c] = 0;
      }
    }
  }
  const INF = 1e9, D = new Float32Array(cols * rows);
  for (let i = 0; i < D.length; i++) D[i] = free[i] ? INF : 0;
  const s2 = Math.SQRT2;
  const relax = (i: number, j: number, w: number) => { if (D[j] + w < D[i]) D[i] = D[j] + w; };
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c; if (!D[i]) continue;
    if (c > 0) relax(i, i - 1, 1);
    if (r > 0) { relax(i, i - cols, 1); if (c > 0) relax(i, i - cols - 1, s2); if (c < cols - 1) relax(i, i - cols + 1, s2); }
  }
  for (let r = rows - 1; r >= 0; r--) for (let c = cols - 1; c >= 0; c--) {
    const i = r * cols + c; if (!D[i]) continue;
    if (c < cols - 1) relax(i, i + 1, 1);
    if (r < rows - 1) { relax(i, i + cols, 1); if (c < cols - 1) relax(i, i + cols + 1, s2); if (c > 0) relax(i, i + cols - 1, s2); }
  }
  // centre-to-centre distance minus half a cell approximates distance to the obstacle edge
  for (let i = 0; i < D.length; i++) D[i] = D[i] ? Math.max(0, (D[i] - 0.5) * cell) : 0;
  return { ox, oy, cols, rows, cell, free, dist: D };
}

export const cellOf = (g: OccGrid, p: Vec2) => {
  const c = Math.floor((p.x - g.ox) / g.cell), r = Math.floor((p.y - g.oy) / g.cell);
  return c < 0 || r < 0 || c >= g.cols || r >= g.rows ? -1 : r * g.cols + c;
};
export const centreOf = (g: OccGrid, i: number): Vec2 => ({ x: g.ox + ((i % g.cols) + 0.5) * g.cell, y: g.oy + (Math.floor(i / g.cols) + 0.5) * g.cell });

/** Nearest cell to p with clearance >= minDist, or -1. */
export function snapFree(g: OccGrid, p: Vec2, minDist: number, maxR = 40): number {
  const c0 = Math.floor((p.x - g.ox) / g.cell), r0 = Math.floor((p.y - g.oy) / g.cell);
  let best = -1, bd = Infinity;
  for (let dr = -maxR; dr <= maxR; dr++) for (let dc = -maxR; dc <= maxR; dc++) {
    const r = r0 + dr, c = c0 + dc;
    if (r < 0 || c < 0 || r >= g.rows || c >= g.cols) continue;
    const i = r * g.cols + c; if (g.dist[i] < minDist) continue;
    const d = dr * dr + dc * dc; if (d < bd) { bd = d; best = i; }
  }
  return best;
}

class Heap {
  a: number[] = []; k: number[] = [];
  push(v: number, key: number) {
    const a = this.a, k = this.k; let i = a.length; a.push(v); k.push(key);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; a[i] = a[p]; k[i] = k[p]; i = p; }
    a[i] = v; k[i] = key;
  }
  pop(): number {
    const a = this.a, k = this.k, top = a[0], lv = a.pop()!, lk = k.pop()!; const n = a.length;
    if (n) {
      let i = 0;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; a[i] = a[c]; k[i] = k[c]; i = c; }
      a[i] = lv; k[i] = lk;
    }
    return top;
  }
  get size() { return this.a.length; }
}

export interface AStarOut { path: number[]; reached: boolean; closest: number }

/** 8-connected A* over cells with clearance >= minDist. Optional extra cost for tight cells. */
export function astar(g: OccGrid, start: number, goal: number, minDist: number, tightPenalty?: (d: number) => number): AStarOut {
  const n = g.cols * g.rows, G = new Float32Array(n).fill(Infinity), from = new Int32Array(n).fill(-1), closed = new Uint8Array(n);
  const gx = goal % g.cols, gy = Math.floor(goal / g.cols);
  const h = (i: number) => Math.hypot((i % g.cols) - gx, Math.floor(i / g.cols) - gy);
  const ok = (i: number) => g.dist[i] >= minDist;
  const heap = new Heap(); let closest = start, cd = h(start);
  if (!ok(start)) return { path: [start], reached: false, closest: start };
  G[start] = 0; heap.push(start, h(start));
  const dirs = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  while (heap.size) {
    const i = heap.pop(); if (closed[i]) continue; closed[i] = 1;
    const hi = h(i); if (hi < cd) { cd = hi; closest = i; }
    if (i === goal) break;
    const c = i % g.cols, r = Math.floor(i / g.cols);
    for (const [dc, dr, w] of dirs) {
      const cc = c + dc, rr = r + dr; if (cc < 0 || rr < 0 || cc >= g.cols || rr >= g.rows) continue;
      const j = rr * g.cols + cc; if (closed[j] || !ok(j)) continue;
      if (dc && dr && (!ok(r * g.cols + cc) || !ok(rr * g.cols + c))) continue;
      const ng = G[i] + w + (tightPenalty ? tightPenalty(g.dist[j]) : 0);
      if (ng < G[j]) { G[j] = ng; from[j] = i; heap.push(j, ng + h(j)); }
    }
  }
  const end = closed[goal] ? goal : closest, path: number[] = [];
  for (let i = end; i !== -1; i = from[i]) path.push(i);
  return { path: path.reverse(), reached: end === goal, closest };
}

export function lineClear(g: OccGrid, a: Vec2, b: Vec2, minDist: number): boolean {
  const L = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(L / (g.cell * 0.5)));
  for (let k = 0; k <= n; k++) {
    const i = cellOf(g, { x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
    if (i < 0 || g.dist[i] < minDist) return false;
  }
  return true;
}

/** Line-of-sight string pulling. */
export function smooth(g: OccGrid, pts: Vec2[], minDist: number): Vec2[] {
  if (pts.length < 3) return pts;
  const out = [pts[0]]; let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !lineClear(g, pts[i], pts[j], minDist)) j--;
    out.push(pts[j]); i = j;
  }
  return out;
}

export const pathLength = (p: Vec2[]) => p.reduce((s, q, i) => (i ? s + Math.hypot(q.x - p[i - 1].x, q.y - p[i - 1].y) : 0), 0);

/** Point `inset` metres inside the room in front of an opening's centre. */
export function doorInner(model: SpaceModel, id: string, inset: number): Vec2 | null {
  const o = model.openings.find((x) => x.id === id); const s = o && model.spaces.find((x) => x.id === o.spaceId);
  if (!o || !s) return null;
  const seg = openingSegment(s, o); return add(seg.c, mul(seg.inward, inset));
}
/** Centre of one room (the first room when none is named), nudged inside for L-shaped rooms. */
export function roomCentroid(model: SpaceModel, spaceId?: string): Vec2 {
  const s = (spaceId && model.spaces.find((x) => x.id === spaceId)) || model.spaces[0];
  if (!s) return { x: 0, y: 0 };
  const c = centroid(s.polygon);
  if (pointInPolygon(c, s.polygon)) return c;
  for (let r = 0.2; r < 10; r += 0.2) for (let k = 0; k < 16; k++) {
    const p = { x: c.x + Math.cos(k * Math.PI / 8) * r, y: c.y + Math.sin(k * Math.PI / 8) * r };
    if (pointInPolygon(p, s.polygon)) return p;
  }
  return c;
}

/** Room a point is in, for labelling routes. */
export const roomNameAt = (model: SpaceModel, p: Vec2) => spaceAt(model, p)?.name ?? null;
