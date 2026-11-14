// Walkable grid for escape-route analysis across every room in the model.
// Walls are obstacles; doors and openings are the only way between rooms or out of the building.
// Clearance per cell is the exact distance to the nearest wall or furniture edge, so widths are
// reported in real centimetres rather than grid steps.
import { area, bounds, cross, dist, distPointSegment, dot, itemCorners, mul, add, sub, norm, openingSegment, pointInPolygon } from '../../core/geometry';
import type { FurnitureItem, Opening, Space, SpaceModel, Vec2 } from '../../core/types';
import type { OccGrid } from '../sim/grid';
import { isRug } from '../sim/grid';

export interface Seg { a: Vec2; b: Vec2; itemId?: string }

export interface DoorInfo {
  idx: number;
  id: string;
  opening: Opening;
  space: Space;
  spaceIdx: number;
  a: Vec2; b: Vec2; c: Vec2; dir: Vec2; inward: Vec2; outward: Vec2;
  widthM: number;
  /** Index of the room on the other side, or -1 when it leads outside. */
  neighbour: number;
  /** Gap between this wall and the neighbouring room's wall (0 for shared walls). */
  depth: number;
  exit: boolean;
  /** True when the exit status came from geometry rather than the person's choice. */
  autoExit: boolean;
  label: string;
}

export interface SafetyGrid extends OccGrid {
  /** Room index per cell, -1 outside every room. */
  room: Int16Array;
  /** Door index per cell for cells in or right next to a doorway, -1 elsewhere. */
  door: Int16Array;
  segs: Seg[];
  doors: DoorInfo[];
  items: Array<{ f: FurnitureItem; poly: Vec2[] }>;
}

const CAP = 1.6; // clearance is only needed up to the turning-circle radius and a little more

export function isPassage(o: Opening) { return o.kind === 'door' || o.kind === 'opening'; }

/** Which room is on the far side of an opening, if any, and how far away its wall is. */
function neighbourOf(model: SpaceModel, hostIdx: number, c: Vec2, outward: Vec2): { idx: number; depth: number } {
  const host = model.spaces[hostIdx];
  const t = host.walls.reduce((m, w) => Math.max(m, w.thicknessM || 0), 0.1);
  const probes = [0.04, 0.08, 0.15, 0.25, 0.35, 0.5, t + 0.1, t + 0.25];
  for (const d of probes) {
    const p = add(c, mul(outward, d));
    const idx = model.spaces.findIndex((s, i) => i !== hostIdx && s.polygon.length >= 3 && pointInPolygon(p, s.polygon));
    if (idx >= 0) return { idx, depth: d < 0.06 ? 0 : d };
  }
  return { idx: -1, depth: 0 };
}

export function describeDoors(model: SpaceModel, exitOverrides: Record<string, boolean> = {}): DoorInfo[] {
  const out: DoorInfo[] = [];
  let n = 0;
  for (const o of model.openings) {
    if (!isPassage(o)) continue;
    const spaceIdx = model.spaces.findIndex((s) => s.id === o.spaceId);
    const space = model.spaces[spaceIdx];
    if (!space || o.wallIndex < 0 || o.wallIndex >= space.polygon.length) continue;
    const seg = openingSegment(space, o);
    const outward = mul(seg.inward, -1);
    const nb = neighbourOf(model, spaceIdx, seg.c, outward);
    const autoExit = nb.idx < 0;
    const exit = exitOverrides[o.id] ?? autoExit;
    n++;
    const kind = o.kind === 'door' ? 'Door' : 'Opening';
    const where = nb.idx >= 0 ? `${space.name} to ${model.spaces[nb.idx].name}` : space.name;
    out.push({
      idx: out.length, id: o.id, opening: o, space, spaceIdx, a: seg.a, b: seg.b, c: seg.c, dir: seg.dir, inward: seg.inward, outward,
      widthM: o.widthM, neighbour: nb.idx, depth: nb.depth, exit, autoExit: exitOverrides[o.id] === undefined, label: `${kind} ${n} (${where})`,
    });
  }
  return out;
}

/** Wall pieces with every door/opening gap removed (on both rooms' walls when they share one). */
function wallPieces(model: SpaceModel, doors: DoorInfo[]): Seg[] {
  const out: Seg[] = [];
  for (const s of model.spaces) {
    const P = s.polygon;
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length], L = dist(a, b);
      if (L < 1e-6) continue;
      const u = norm(sub(b, a));
      let keep: Array<[number, number]> = [[0, L]];
      for (const d of doors) {
        if (Math.abs(cross(u, d.dir)) > 0.03) continue;
        const off = dot(sub(a, d.c), d.outward);
        if (off < -0.06 || off > d.depth + 0.06) continue;
        const ua = dot(sub(d.a, a), u), ub = dot(sub(d.b, a), u);
        const lo = Math.min(ua, ub), hi = Math.max(ua, ub);
        const next: Array<[number, number]> = [];
        for (const [p, q] of keep) {
          if (hi <= p || lo >= q) { next.push([p, q]); continue; }
          if (lo > p) next.push([p, lo]);
          if (hi < q) next.push([hi, q]);
        }
        keep = next;
      }
      for (const [p, q] of keep) if (q - p > 1e-4) out.push({ a: add(a, mul(u, p)), b: add(a, mul(u, q)) });
    }
  }
  // Jambs of the short passage through a thick wall between two rooms.
  for (const d of doors) {
    if (d.neighbour < 0 || d.depth < 0.06) continue;
    out.push({ a: d.a, b: add(d.a, mul(d.outward, d.depth)) }, { a: d.b, b: add(d.b, mul(d.outward, d.depth)) });
  }
  return out;
}

export function pickCell(model: SpaceModel): number {
  const total = model.spaces.reduce((s, sp) => s + area(sp.polygon), 0);
  return total > 400 ? 0.1 : total > 200 ? 0.075 : 0.05;
}

export function buildSafetyGrid(model: SpaceModel, furniture: FurnitureItem[], exitOverrides: Record<string, boolean> = {}, cellM?: number): SafetyGrid {
  const cell = cellM ?? pickCell(model);
  const doors = describeDoors(model, exitOverrides);
  const polys = model.spaces.map((s) => s.polygon);
  const b = bounds(polys.flat().length ? polys.flat() : [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  const ox = b.minX - 2 * cell, oy = b.minY - 2 * cell;
  const cols = Math.ceil(b.w / cell) + 4, rows = Math.ceil(b.h / cell) + 4, N = cols * rows;
  const room = new Int16Array(N).fill(-1), door = new Int16Array(N).fill(-1);
  const items = furniture.filter((f) => !isRug(f)).map((f) => ({ f, poly: itemCorners(f) }));
  const blocked = new Uint8Array(N);
  const P = (i: number): Vec2 => ({ x: ox + ((i % cols) + 0.5) * cell, y: oy + (Math.floor(i / cols) + 0.5) * cell });

  for (let i = 0; i < N; i++) {
    const p = P(i);
    let r = polys.findIndex((poly) => poly.length >= 3 && pointInPolygon(p, poly));
    if (r < 0) {
      for (const d of doors) {
        if (d.neighbour < 0 || d.depth < 0.06) continue;
        const t = dot(sub(p, d.c), d.dir), s = dot(sub(p, d.c), d.outward);
        if (Math.abs(t) <= d.widthM / 2 && s >= -1e-6 && s <= d.depth + 1e-6) { r = d.spaceIdx; break; }
      }
    }
    room[i] = r;
    if (r < 0) continue;
    for (const it of items) if (pointInPolygon(p, it.poly)) { blocked[i] = 1; break; }
    for (const d of doors) {
      const t = dot(sub(p, d.c), d.dir), s = dot(sub(p, d.c), d.outward);
      if (Math.abs(t) <= d.widthM / 2 + cell && s >= -0.3 && s <= d.depth + 0.3) { door[i] = d.idx; break; }
    }
  }

  const segs = wallPieces(model, doors);
  const wallSegCount = segs.length;
  for (const it of items) for (let k = 0; k < 4; k++) segs.push({ a: it.poly[k], b: it.poly[(k + 1) % 4], itemId: it.f.id });

  const D = new Float32Array(N).fill(CAP);
  const wallD = new Float32Array(N).fill(CAP);
  segs.forEach((sg, si) => {
    const c0 = Math.max(0, Math.floor((Math.min(sg.a.x, sg.b.x) - CAP - ox) / cell)), c1 = Math.min(cols - 1, Math.ceil((Math.max(sg.a.x, sg.b.x) + CAP - ox) / cell));
    const r0 = Math.max(0, Math.floor((Math.min(sg.a.y, sg.b.y) - CAP - oy) / cell)), r1 = Math.min(rows - 1, Math.ceil((Math.max(sg.a.y, sg.b.y) + CAP - oy) / cell));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const i = r * cols + c; if (room[i] < 0) continue;
      const d = distPointSegment(P(i), sg.a, sg.b);
      if (d < D[i]) D[i] = d;
      if (si < wallSegCount && d < wallD[i]) wallD[i] = d;
    }
  });
  const free = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (room[i] < 0 || blocked[i] || wallD[i] < cell * 0.75) { D[i] = 0; continue; }
    free[i] = 1;
  }
  return { ox, oy, cols, rows, cell, free, dist: D, room, door, segs, doors, items };
}

export const centre = (g: OccGrid, i: number): Vec2 => ({ x: g.ox + ((i % g.cols) + 0.5) * g.cell, y: g.oy + (Math.floor(i / g.cols) + 0.5) * g.cell });
export const cellAt = (g: OccGrid, p: Vec2) => {
  const c = Math.floor((p.x - g.ox) / g.cell), r = Math.floor((p.y - g.oy) / g.cell);
  return c < 0 || r < 0 || c >= g.cols || r >= g.rows ? -1 : r * g.cols + c;
};

/** Cells just inside an exit doorway: where an escape route ends. */
export function exitCells(g: SafetyGrid, d: DoorInfo): number[] {
  const out: number[] = [];
  for (let i = 0; i < g.free.length; i++) {
    if (g.door[i] !== d.idx || !g.free[i]) continue;
    const p = centre(g, i), s = dot(sub(p, d.c), d.outward), t = dot(sub(p, d.c), d.dir);
    if (s >= -0.2 && s <= 0.02 && Math.abs(t) <= d.widthM / 2) out.push(i);
  }
  return out;
}

// ---- Graph searches ---------------------------------------------------------------------------

class MinHeap {
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

const DIRS: Array<[number, number, number]> = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

export interface Field { cost: Float32Array; len: Float32Array; parent: Int32Array; src: Int32Array }

/** Multi-source Dijkstra. `len` is the walked distance in metres; `cost` adds a penalty for tight cells. */
export function shortest(g: OccGrid, sources: number[], ok: (i: number) => boolean, penalty?: (i: number) => number): Field {
  const N = g.cols * g.rows;
  const cost = new Float32Array(N).fill(Infinity), len = new Float32Array(N).fill(Infinity);
  const parent = new Int32Array(N).fill(-1), src = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  const h = new MinHeap();
  for (const s of sources) if (ok(s)) { cost[s] = 0; len[s] = 0; src[s] = s; h.push(s, 0); }
  while (h.size) {
    const i = h.pop(); if (done[i]) continue; done[i] = 1;
    const c = i % g.cols, r = (i - c) / g.cols;
    for (const [dc, dr, w] of DIRS) {
      const cc = c + dc, rr = r + dr; if (cc < 0 || rr < 0 || cc >= g.cols || rr >= g.rows) continue;
      const j = rr * g.cols + cc; if (done[j] || !ok(j)) continue;
      if (dc && dr && (!ok(r * g.cols + cc) || !ok(rr * g.cols + c))) continue;
      const nc = cost[i] + w * g.cell + (penalty ? penalty(j) * w * g.cell : 0);
      if (nc < cost[j]) { cost[j] = nc; len[j] = len[i] + w * g.cell; parent[j] = i; src[j] = src[i]; h.push(j, nc); }
    }
  }
  return { cost, len, parent, src };
}

export interface Widest { B: Float32Array; choke: Int32Array }

/** Widest-path (maximin) search: B[i] is the best bottleneck ratio of any route from i to a source. */
export function widest(g: OccGrid, sources: number[], ratio: Float32Array): Widest {
  const N = g.cols * g.rows;
  const B = new Float32Array(N).fill(-1), choke = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  const h = new MinHeap();
  for (const s of sources) if (ratio[s] > 0) { B[s] = ratio[s]; choke[s] = s; h.push(s, -ratio[s]); }
  while (h.size) {
    const i = h.pop(); if (done[i]) continue; done[i] = 1;
    const c = i % g.cols, r = (i - c) / g.cols;
    for (const [dc, dr] of DIRS) {
      const cc = c + dc, rr = r + dr; if (cc < 0 || rr < 0 || cc >= g.cols || rr >= g.rows) continue;
      const j = rr * g.cols + cc; if (done[j] || ratio[j] <= 0) continue;
      if (dc && dr && (ratio[r * g.cols + cc] <= 0 || ratio[rr * g.cols + c] <= 0)) continue;
      const cand = Math.min(B[i], ratio[j]);
      if (cand > B[j]) { B[j] = cand; choke[j] = ratio[j] < B[i] ? j : choke[i]; h.push(j, -cand); }
    }
  }
  return { B, choke };
}

/** Cells from i back to its source, following the search tree. */
export function chain(f: Field, i: number): number[] {
  const out: number[] = [];
  for (let k = i, guard = 0; k >= 0 && guard < 1e6; k = f.parent[k], guard++) { out.push(k); if (f.parent[k] === k) break; }
  return out;
}

/** Exact clear width through point p: distance to the nearest edge plus the distance to the next edge straight across. */
export function widthAt(g: SafetyGrid, p: Vec2): { width: number; near: Seg | null; far: Seg | null } {
  let d1 = Infinity, near: Seg | null = null, q1 = p;
  for (const s of g.segs) {
    const ab = sub(s.b, s.a), t = Math.max(0, Math.min(1, dot(sub(p, s.a), ab) / (dot(ab, ab) || 1)));
    const q = add(s.a, mul(ab, t)), d = dist(p, q);
    if (d < d1) { d1 = d; near = s; q1 = q; }
  }
  if (!near || d1 < 1e-6) return { width: 0, near, far: null };
  const u = norm(sub(p, q1));
  let t2 = Infinity, far: Seg | null = null;
  for (const s of g.segs) {
    if (s === near) continue;
    const e = sub(s.b, s.a), den = cross(u, e);
    if (Math.abs(den) < 1e-9) continue;
    const w = sub(s.a, p), t = cross(w, e) / den, k = cross(w, u) / den;
    if (t > 1e-6 && k >= -1e-6 && k <= 1 + 1e-6 && t < t2) { t2 = t; far = s; }
  }
  return { width: Number.isFinite(t2) ? d1 + t2 : 2 * d1, near, far };
}
