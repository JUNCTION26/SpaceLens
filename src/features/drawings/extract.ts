/**
 * Recovers building geometry from a vector floor plan: walls (filled wall polygons, or thick
 * strokes as a fallback), door swings, windows set into wall gaps, and rooms as the enclosed
 * free space between them. Pure code: no DOM, no pdf.js, so the same path runs in the app and
 * in the Node benchmark.
 *
 * Coordinates are PDF page points, y down, origin top-left (the viewport frame).
 */
import type { P, PagePaths, VPath } from './pdfPaths';
import type { TextItem } from './textCore';
import { extractRooms } from './answer';

export interface Door { hinge: P; tip: P; jamb: P; widthPt: number }
export interface ScaleEstimate { source: 'printed' | 'dimensions' | 'areas' | 'doors'; mPerPt: number; /** 0..1 */ confidence: number; used: number; rejected: number; note: string }
export interface WindowGeom { a: P; b: P; depthPt: number }
export interface RoomGeom {
  id: string;
  /** Printed room number ("2.10"), when there is one. */
  no?: string;
  label?: string;
  printedArea?: number;
  /** Text items that name this room (label, number, area). */
  items: TextItem[];
  /** Outline in page points (simplified, rectilinear when within tolerance). */
  polygon: P[];
  /** Area of the outline, page points squared. */
  areaPt2: number;
  /** Area counted on the raster (cross-check), page points squared. */
  rasterPt2: number;
  /** Seed point used for the fill. */
  seed: P;
  rectilinear: boolean;
  /** 'outline': the room's own boundary line drawn on the sheet; 'walls': the space enclosed by walls, doors and windows. */
  source: 'outline' | 'walls';
}
export interface PlanGeometry {
  page: number;
  pageW: number; pageH: number;
  /** Dominant wall direction, radians in [0, pi/2). */
  angle: number;
  mPerPt: number | null;
  scaleSource: 'printed' | 'areas' | 'none';
  scaleN?: number;
  /** Every independent scale estimate (printed ratio, dimension strings, printed areas, door widths) with its confidence. */
  scaleEvidence?: ScaleEstimate[];
  /** Largest relative gap between two estimates that carry weight, percent (0 when only one exists). */
  scaleDisagreementPct?: number;
  /** Segments excluded as non-wall linework, by reason. */
  excluded?: { border: number; titleBlock: number; furniture: number; hatch: number; dimension: number };
  /** Door leaves that sit in a gap with no drawn swing (symbol-less openings). */
  gaps?: Array<{ a: P; b: P; widthPt: number }>;
  /** Ratio fitted from printed room areas (metres per point), for cross-checking the printed scale. */
  areaFitMPerPt?: number;
  walls: P[][];
  wallSource: 'filled' | 'outlined' | 'strokes' | 'none';
  wallThicknessPt: number;
  doors: Door[];
  windows: WindowGeom[];
  rooms: RoomGeom[];
  /** Labelled rooms that could not be closed (the fill leaked or the label sat on a wall). */
  failed: Array<{ no?: string; label?: string; reason: string; items: TextItem[] }>;
  warnings: string[];
  ms: number;
}

const PAPER_M_PER_PT = 0.0254 / 72;
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
const luma = (c: [number, number, number]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

export function polyArea(poly: P[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a.x * b.y - b.x * a.y; }
  return s / 2;
}
function perimeter(poly: P[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) s += dist(poly[i], poly[(i + 1) % poly.length]);
  return s;
}
function bboxOf(pts: P[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; }
  return { x0, y0, x1, y1 };
}
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// ---------------------------------------------------------------------------------------------
// Raster: a coarse occupancy grid over the plan used to fill rooms. 0 free, 1 wall, 2 closure.

class Grid {
  data: Uint8Array;
  constructor(public x0: number, public y0: number, public cell: number, public cols: number, public rows: number) {
    this.data = new Uint8Array(cols * rows);
  }
  cx(x: number) { return Math.floor((x - this.x0) / this.cell); }
  cy(y: number) { return Math.floor((y - this.y0) / this.cell); }
  at(c: number, r: number) { return c < 0 || r < 0 || c >= this.cols || r >= this.rows ? 1 : this.data[r * this.cols + c]; }
  /** Even-odd scanline fill of a set of rings, sampling cell centres. */
  fillRings(rings: P[][], v: number) {
    let ymin = Infinity, ymax = -Infinity;
    for (const r of rings) for (const p of r) { if (p.y < ymin) ymin = p.y; if (p.y > ymax) ymax = p.y; }
    const r0 = Math.max(0, this.cy(ymin)), r1 = Math.min(this.rows - 1, this.cy(ymax));
    const xs: number[] = [];
    for (let row = r0; row <= r1; row++) {
      const y = this.y0 + (row + 0.5) * this.cell;
      xs.length = 0;
      for (const ring of rings) {
        for (let i = 0, n = ring.length; i < n; i++) {
          const a = ring[i], b = ring[(i + 1) % n];
          if ((a.y <= y) !== (b.y <= y)) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - this.x0) / this.cell - 0.5)), c1 = Math.min(this.cols - 1, Math.floor((xs[k + 1] - this.x0) / this.cell - 0.5));
        for (let c = c0; c <= c1; c++) if (this.data[row * this.cols + c] < v || v === 0) this.data[row * this.cols + c] = v;
      }
    }
  }
  /** Thick segment as a rectangle polygon. */
  fillSegment(a: P, b: P, width: number, v: number) {
    const L = dist(a, b) || 1e-9;
    const nx = (-(b.y - a.y) / L) * (width / 2), ny = ((b.x - a.x) / L) * (width / 2);
    const ex = ((b.x - a.x) / L) * (width / 4), ey = ((b.y - a.y) / L) * (width / 4);
    this.fillRings([[{ x: a.x + nx - ex, y: a.y + ny - ey }, { x: b.x + nx + ex, y: b.y + ny + ey }, { x: b.x - nx + ex, y: b.y - ny + ey }, { x: a.x - nx - ex, y: a.y - ny - ey }]], v);
  }
  /** True when any blocked cell lies within `rad` points of p. */
  blockedNear(p: P, rad: number, anyBarrier = false) {
    const c0 = this.cx(p.x - rad), c1 = this.cx(p.x + rad), r0 = this.cy(p.y - rad), r1 = this.cy(p.y + rad);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const v = this.at(c, r); if (v === 1 || (anyBarrier && v !== 0)) return true; }
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Wall detection

interface Shape { path: VPath; ring: P[]; area: number; t: number; bb: ReturnType<typeof bboxOf> }

function styleKey(p: VPath) {
  return `${p.paint}|${p.lw.toFixed(2)}|${p.stroke.join(',')}|${p.fill.join(',')}|${p.dashed ? 1 : 0}`;
}

function closedShapes(p: VPath): Shape[] {
  const out: Shape[] = [];
  p.subs.forEach((ring, i) => {
    if (ring.length < 3 || (!p.closed[i] && dist(ring[0], ring[ring.length - 1]) > 0.5)) return;
    const area = Math.abs(polyArea(ring));
    const per = perimeter(ring);
    if (per <= 0) return;
    out.push({ path: p, ring, area, t: (2 * area) / per, bb: bboxOf(ring) });
  });
  return out;
}

function findWalls(paths: VPath[], tMin: number, tMax: number, pageArea: number, mPerPt: number | null = null, W = 0, H = 0): { rings: P[][]; source: PlanGeometry['wallSource']; thickness: number; thick90: number; styles: Set<string>; excluded?: PlanGeometry['excluded'] } {
  const groups = new Map<string, { shapes: Shape[]; key: string; filled: boolean }>();
  for (const p of paths) {
    const filled = p.paint !== 'stroke';
    if (filled && luma(p.fill) > 248) continue;
    const key = styleKey(p);
    const g = groups.get(key) ?? { shapes: [], key, filled };
    g.shapes.push(...closedShapes(p));
    groups.set(key, g);
  }
  // Score groups by the wall-like area they contribute: long thin closed shapes.
  const scored = [...groups.values()].map((g) => {
    const wallish = g.shapes.filter((s) => s.t >= tMin && s.t <= tMax && s.area < pageArea * 0.2);
    const area = wallish.reduce((s, x) => s + x.area, 0);
    // A wall group draws long runs: total length of its pieces (area / thickness) must be large.
    const run = wallish.reduce((s, x) => s + x.area / Math.max(x.t, 1e-6), 0);
    return { g, wallish, area, run };
  }).filter((x) => x.wallish.length > 0);
  const filled = scored.filter((x) => x.g.filled).sort((a, b) => b.run - a.run);
  const best = filled[0];
  if (best && best.run > Math.sqrt(pageArea) * 0.8) {
    // Also take other filled groups that are clearly the same kind (e.g. load-bearing vs partition walls).
    const keep = filled.filter((x) => x.run > best.run * 0.15 && Math.abs(median(x.wallish.map((s) => s.t)) - median(best.wallish.map((s) => s.t))) < median(best.wallish.map((s) => s.t)) * 2.5);
    const rings = keep.flatMap((x) => x.g.shapes.filter((s) => s.area < pageArea * 0.2).map((s) => s.ring));
    const ts = keep.flatMap((x) => x.wallish.map((s) => s.t)).sort((a, b) => a - b);
    return { rings, source: 'filled', thickness: median(ts), thick90: ts[Math.floor(ts.length * 0.9)] ?? 0, styles: new Set(keep.map((x) => x.g.key)) };
  }
  const outlined = scored.filter((x) => !x.g.filled).sort((a, b) => b.run - a.run)[0];
  // double lines: two parallel strokes a wall-thickness apart
  if (W > 0) {
    const pl = pairedLineWalls(paths, tMin, tMax, mPerPt, W, H);
    if (pl.rings.length && pl.length > Math.sqrt(pageArea) * 0.8 && (!outlined || pl.length > outlined.run * 0.7)) {
      return { rings: pl.rings, source: 'strokes', thickness: pl.thickness, thick90: pl.thickness, styles: new Set(), excluded: pl.excluded };
    }
  }
  if (outlined && outlined.run > Math.sqrt(pageArea) * 0.8) {
    const ts = outlined.wallish.map((s) => s.t).sort((a, b) => a - b);
    return { rings: outlined.wallish.map((s) => s.ring), source: 'outlined', thickness: median(ts), thick90: ts[Math.floor(ts.length * 0.9)] ?? 0, styles: new Set([outlined.g.key]) };
  }
  // Fallback: the thickest common stroke weight drawn as straight lines is the wall centre line.
  const strokes = paths.filter((p) => p.paint === 'stroke' && p.curves === 0 && p.lw >= tMin);
  if (strokes.length) {
    const lws = strokes.map((p) => p.lw);
    const thick = Math.max(...lws);
    const chosen = strokes.filter((p) => p.lw >= thick * 0.7);
    const rings: P[][] = [];
    for (const p of chosen) for (const s of p.subs) for (let i = 0; i + 1 < s.length; i++) rings.push(segRing(s[i], s[i + 1], p.lw));
    return { rings, source: 'strokes', thickness: thick, thick90: thick, styles: new Set(chosen.map(styleKey)) };
  }
  return { rings: [], source: 'none', thickness: 0, thick90: 0, styles: new Set() };
}


/**
 * Double-line walls: two long parallel strokes a wall-thickness apart. Each pair becomes one
 * rectangle (the wall's centre band with its thickness). Short strokes (hatching, symbols),
 * strokes belonging to small closed shapes (furniture, fixtures) and clusters that sit in the
 * sheet margin (border, title block) are left out and counted.
 */
export function pairedLineWalls(paths: VPath[], tMin: number, tMax: number, mPerPt: number | null, W: number, H: number): { rings: P[][]; thickness: number; length: number; excluded: NonNullable<PlanGeometry['excluded']> } {
  const excluded = { border: 0, titleBlock: 0, furniture: 0, hatch: 0, dimension: 0 };
  const minLen = Math.max(tMax * 1.2, mPerPt ? 0.7 / mPerPt : tMax * 1.2);
  const smallShape = mPerPt ? 3.2 / mPerPt : tMax * 4;
  const none = { rings: [] as P[][], thickness: 0, length: 0, excluded };
  interface Seg { a: P; b: P; ang: number; len: number }
  const segs: Seg[] = [];
  for (const p of paths) {
    if (p.paint === 'fill' || p.dashed || p.curves > 0 || p.lw > tMax) continue;
    p.subs.forEach((sub, si) => {
      const bb = bboxOf(sub);
      const isClosed = p.closed[si] || (sub.length > 3 && dist(sub[0], sub[sub.length - 1]) < 0.5);
      const diag = Math.hypot(bb.x1 - bb.x0, bb.y1 - bb.y0);
      if (isClosed && diag > Math.hypot(W, H) * 0.7) { excluded.border++; return; }
      if (isClosed && diag < smallShape) { excluded.furniture++; return; }
      for (let i = 0; i + 1 < sub.length; i++) {
        const a = sub[i], b = sub[i + 1], len = dist(a, b);
        if (len < minLen) { if (len > 0.5) excluded.hatch++; continue; }
        let ang = Math.atan2(b.y - a.y, b.x - a.x); if (ang < 0) ang += Math.PI; if (ang >= Math.PI) ang -= Math.PI;
        segs.push({ a, b, ang, len });
      }
    });
  }
  if (segs.length > 9000 || segs.length < 2) return none;
  const tolA = (1.5 * Math.PI) / 180;
  const pairs: Array<{ a: P; b: P; t: number; len: number }> = [];
  for (let i = 0; i < segs.length; i++) {
    const si = segs[i];
    const ux = Math.cos(si.ang), uy = Math.sin(si.ang), nx = -uy, ny = ux;
    const i0 = si.a.x * ux + si.a.y * uy, i1 = si.b.x * ux + si.b.y * uy;
    const io = si.a.x * nx + si.a.y * ny;
    const ilo = Math.min(i0, i1), ihi = Math.max(i0, i1);
    for (let j = i + 1; j < segs.length; j++) {
      const sj = segs[j];
      const da = Math.abs(sj.ang - si.ang);
      if (Math.min(da, Math.PI - da) > tolA) continue;
      const jo = (sj.a.x * nx + sj.a.y * ny + sj.b.x * nx + sj.b.y * ny) / 2;
      const d = Math.abs(jo - io);
      if (d < tMin || d > tMax) continue;
      const j0 = sj.a.x * ux + sj.a.y * uy, j1 = sj.b.x * ux + sj.b.y * uy;
      const lo = Math.max(ilo, Math.min(j0, j1)), hi = Math.min(ihi, Math.max(j0, j1));
      if (hi - lo < minLen * 0.6) continue;
      const mid = (io + jo) / 2;
      pairs.push({ a: { x: lo * ux + mid * nx, y: lo * uy + mid * ny }, b: { x: hi * ux + mid * nx, y: hi * uy + mid * ny }, t: d, len: hi - lo });
    }
  }
  if (!pairs.length) return none;
  // cluster rectangles that touch; drop clusters in the margin or much smaller than the main one
  const n = pairs.length;
  const parent = Array.from({ length: n }, (_, k) => k);
  const find = (k: number): number => { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
  const boxes = pairs.map((q) => { const e = q.t * 1.2; return { x0: Math.min(q.a.x, q.b.x) - e, y0: Math.min(q.a.y, q.b.y) - e, x1: Math.max(q.a.x, q.b.x) + e, y1: Math.max(q.a.y, q.b.y) + e }; });
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const A = boxes[i], B = boxes[j];
    if (A.x0 <= B.x1 && B.x0 <= A.x1 && A.y0 <= B.y1 && B.y0 <= A.y1) parent[find(i)] = find(j);
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) { const r = find(i); const g = groups.get(r); if (g) g.push(i); else groups.set(r, [i]); }
  const lenOf = (g: number[]) => g.reduce((s, k) => s + pairs[k].len, 0);
  const biggest = Math.max(...[...groups.values()].map(lenOf));
  const keep: number[] = [];
  for (const g of groups.values()) {
    const L = lenOf(g);
    const bx0 = Math.min(...g.map((k) => boxes[k].x0)), bx1 = Math.max(...g.map((k) => boxes[k].x1)), by0 = Math.min(...g.map((k) => boxes[k].y0)), by1 = Math.max(...g.map((k) => boxes[k].y1));
    const inMargin = bx1 < W * 0.05 || bx0 > W * 0.95 || by1 < H * 0.05 || by0 > H * 0.95;
    const title = L < biggest && bx0 > W * 0.55 && by0 > H * 0.78 && bx1 - bx0 < W * 0.45;
    if (inMargin) { excluded.border += g.length; continue; }
    if (title) { excluded.titleBlock += g.length; continue; }
    if (L < biggest * 0.15) { excluded.dimension += g.length; continue; }
    keep.push(...g);
  }
  const ts = keep.map((k) => pairs[k].t).sort((x, y) => x - y);
  return { rings: keep.map((k) => segRing(pairs[k].a, pairs[k].b, pairs[k].t)), thickness: ts.length ? ts[Math.floor(ts.length / 2)] : 0, length: keep.reduce((s, k) => s + pairs[k].len, 0), excluded };
}

function segRing(a: P, b: P, w: number): P[] {
  const L = dist(a, b) || 1e-9;
  const nx = (-(b.y - a.y) / L) * (w / 2), ny = ((b.x - a.x) / L) * (w / 2);
  const ex = ((b.x - a.x) / L) * (w / 2), ey = ((b.y - a.y) / L) * (w / 2);
  return [{ x: a.x + nx - ex, y: a.y + ny - ey }, { x: b.x + nx + ex, y: b.y + ny + ey }, { x: b.x - nx + ex, y: b.y - ny + ey }, { x: a.x - nx - ex, y: a.y - ny - ey }];
}

/** Dominant wall direction from edge lengths, folded into [0, 90) degrees. */
export function dominantAngle(rings: P[][]): number {
  const bins = new Float64Array(180); // half-degree bins over 0..90
  for (const r of rings) for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    const L = dist(a, b); if (L < 1e-6) continue;
    let ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    ang = ((ang % 90) + 90) % 90;
    bins[Math.floor(ang * 2) % 180] += L;
  }
  let bi = 0;
  for (let i = 1; i < 180; i++) if (bins[i] > bins[bi]) bi = i;
  // refine with a circular weighted mean around the peak (period 90 degrees -> multiply by 4)
  let sx = 0, sy = 0;
  for (let d = -4; d <= 4; d++) {
    const k = (bi + d + 180) % 180;
    const rad = (((k + 0.5) / 2) * Math.PI) / 180;
    sx += bins[k] * Math.cos(rad * 4); sy += bins[k] * Math.sin(rad * 4);
  }
  let rad = Math.atan2(sy, sx) / 4;
  rad = ((rad % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
  return rad;
}

// ---------------------------------------------------------------------------------------------
// Doors: quarter-circle swings. The hinge is the arc centre; the closed leaf lies along the wall.

function circleFrom3(a: P, b: P, c: P): { c: P; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const ux = ((a.x ** 2 + a.y ** 2) * (b.y - c.y) + (b.x ** 2 + b.y ** 2) * (c.y - a.y) + (c.x ** 2 + c.y ** 2) * (a.y - b.y)) / d;
  const uy = ((a.x ** 2 + a.y ** 2) * (c.x - b.x) + (b.x ** 2 + b.y ** 2) * (a.x - c.x) + (c.x ** 2 + c.y ** 2) * (b.x - a.x)) / d;
  const cc = { x: ux, y: uy };
  return { c: cc, r: dist(cc, a) };
}

function findDoors(paths: VPath[], rMin: number, rMax: number, wallStyles: Set<string>, grid: Grid, wallT: number): Door[] {
  // Straight segments of door-length, to find a drawn leaf when the wall test is ambiguous.
  const segs: Array<[P, P]> = [];
  for (const p of paths) {
    if (wallStyles.has(styleKey(p))) continue;
    for (const s of p.subs) for (let i = 0; i + 1 < s.length; i++) { const L = dist(s[i], s[i + 1]); if (L > rMin * 0.8 && L < rMax * 1.2) segs.push([s[i], s[i + 1]]); }
  }
  const doors: Door[] = [];
  for (const p of paths) {
    if (p.curves === 0) continue;
    for (const s of p.arcs) {
      if (s.length < 5) continue;
      // split polylines into arc runs: take the whole sub if it is one arc
      const a = s[0], m = s[Math.floor(s.length / 2)], b = s[s.length - 1];
      const circ = circleFrom3(a, m, b);
      if (!circ || circ.r < rMin || circ.r > rMax) continue;
      // every point must sit on the circle
      if (s.some((q) => Math.abs(dist(q, circ.c) - circ.r) > circ.r * 0.06)) continue;
      const ang = Math.acos(Math.max(-1, Math.min(1, ((a.x - circ.c.x) * (b.x - circ.c.x) + (a.y - circ.c.y) * (b.y - circ.c.y)) / (circ.r * circ.r))));
      if (ang < (60 * Math.PI) / 180 || ang > (120 * Math.PI) / 180) continue;
      // The closed position ends on the wall (the jamb); the open leaf tip stands free in the room.
      const near = wallT * 0.7;
      const aWall = grid.blockedNear(a, near), bWall = grid.blockedNear(b, near);
      let tip = b, jamb = a;
      if (bWall && !aWall) { tip = a; jamb = b; }
      else if (aWall === bWall) {
        // Behind the hinge, the wall carries on along the closed leaf's line; across the open
        // leaf's line it ends after one wall thickness. Sample both lines.
        const behind = (e: P) => {
          const ux = (e.x - circ.c.x) / circ.r, uy = (e.y - circ.c.y) / circ.r;
          let hit = 0;
          for (let k = 1; k <= 12; k++) { const s = (k / 12) * wallT * 3; if (grid.blockedNear({ x: circ.c.x - ux * s, y: circ.c.y - uy * s }, grid.cell)) hit++; }
          return hit;
        };
        const sa = behind(a), sb = behind(b);
        if (sa !== sb) { if (sb > sa) { tip = a; jamb = b; } }
        else {
          // last resort: the drawn leaf, a straight line from the hinge to the tip
          const tol = circ.r * 0.12;
          const leafTo = (e: P) => segs.some(([u, v]) => (dist(u, circ.c) < tol && dist(v, e) < tol) || (dist(v, circ.c) < tol && dist(u, e) < tol));
          if (leafTo(a) && !leafTo(b)) { tip = a; jamb = b; }
        }
      }
      doors.push({ hinge: circ.c, tip, jamb, widthPt: circ.r });
    }
  }
  // Every drawn swing is kept, as printed (a swing drawn twice usually marks two leaves);
  // the model builder places each position once.
  return doors;
}

// ---------------------------------------------------------------------------------------------
// Windows: thin rectangles whose two short ends sit against wall material (a frame in a wall gap).

function findWindows(paths: VPath[], grid: Grid, wallT: number, maxDepth: number, wallStyles: Set<string>, minLen: number, doors: Door[]): WindowGeom[] {
  const cands: WindowGeom[] = [];
  const nearDoor = (q: P) => doors.some((d) => dist(q, d.tip) < d.widthPt * 0.15 || dist(q, d.hinge) < d.widthPt * 0.15);
  for (const p of paths) {
    if (p.curves > 0 || wallStyles.has(styleKey(p)) || p.dashed) continue;
    for (const s of closedShapes(p)) {
      const r = s.ring;
      const pts = r.length === 5 && dist(r[0], r[4]) < 0.01 ? r.slice(0, 4) : r;
      if (pts.length !== 4) continue;
      const e0 = dist(pts[0], pts[1]), e1 = dist(pts[1], pts[2]);
      const [long, short] = e0 >= e1 ? [e0, e1] : [e1, e0];
      if (long < minLen || short > maxDepth || short < wallT * 0.15 || long < short * 2.2) continue;
      if (pts.some(nearDoor)) continue; // an open door leaf, not a window
      // centre line along the long axis
      const mid = (u: P, v: P) => ({ x: (u.x + v.x) / 2, y: (u.y + v.y) / 2 });
      const [a, b] = e0 >= e1 ? [mid(pts[1], pts[2]), mid(pts[3], pts[0])] : [mid(pts[0], pts[1]), mid(pts[2], pts[3])];
      const dirx = (b.x - a.x) / long, diry = (b.y - a.y) / long;
      const probe = wallT * 0.6;
      // both short ends sit against wall material...
      // (a door closure counts: a window often runs into a balcony door)
      const okA = grid.blockedNear({ x: a.x - dirx * probe, y: a.y - diry * probe }, wallT * 0.35, true);
      const okB = grid.blockedNear({ x: b.x + dirx * probe, y: b.y + diry * probe }, wallT * 0.35, true);
      if (!okA || !okB) continue;
      // ...and both long sides face open space (a counter or shelf has one side against a wall)
      const c = mid(a, b), off = short / 2 + grid.cell * 3;
      const side1 = grid.blockedNear({ x: c.x - diry * off, y: c.y + dirx * off }, grid.cell * 1.5);
      const side2 = grid.blockedNear({ x: c.x + diry * off, y: c.y - dirx * off }, grid.cell * 1.5);
      if (side1 || side2) continue;
      cands.push({ a, b, depthPt: short });
    }
  }
  // stair treads: many parallel copies stacked side by side
  const axis = (w: WindowGeom) => { const L = dist(w.a, w.b) || 1; return { ux: (w.b.x - w.a.x) / L, uy: (w.b.y - w.a.y) / L, L }; };
  const tread = cands.map((w) => {
    const { ux, uy, L } = axis(w);
    const c = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
    let n = 0;
    for (const o of cands) {
      if (o === w) continue;
      const q = axis(o);
      if (Math.abs(ux * q.ux + uy * q.uy) < 0.98 || Math.abs(q.L - L) > L * 0.3) continue;
      const oc = { x: (o.a.x + o.b.x) / 2, y: (o.a.y + o.b.y) / 2 };
      const along = (oc.x - c.x) * ux + (oc.y - c.y) * uy, perp = Math.abs(-(oc.x - c.x) * uy + (oc.y - c.y) * ux);
      if (Math.abs(along) < L * 0.3 && perp > w.depthPt * 0.5 && perp < Math.max(w.depthPt * 4, wallT * 3)) n++;
    }
    return n >= 2;
  });
  const kept = cands.filter((_, i) => !tread[i]);
  // merge nested frames / glass lines of the same window
  const out: WindowGeom[] = [];
  for (const w of kept.sort((x, y) => dist(y.a, y.b) - dist(x.a, x.b))) {
    const c = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
    if (out.some((o) => { const oc = { x: (o.a.x + o.b.x) / 2, y: (o.a.y + o.b.y) / 2 }; return dist(oc, c) < Math.max(wallT, dist(o.a, o.b) * 0.3); })) continue;
    out.push(w);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Room fill and outline

function floodFill(grid: Grid, seed: [number, number], label: Int32Array, id: number, maxCells: number): { cells: number; leaked: boolean; c0: number; r0: number; c1: number; r1: number } {
  const { cols, rows, data } = grid;
  const stack = [seed[1] * cols + seed[0]];
  label[stack[0]] = id;
  let cells = 0, leaked = false, c0 = cols, r0 = rows, c1 = 0, r1 = 0;
  while (stack.length) {
    const k = stack.pop()!;
    cells++;
    const c = k % cols, r = (k - c) / cols;
    if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r;
    if (c === 0 || r === 0 || c === cols - 1 || r === rows - 1) leaked = true;
    if (cells > maxCells) leaked = true; // keep filling so every cell is visited once
    const nb = [k - 1, k + 1, k - cols, k + cols];
    for (let i = 0; i < 4; i++) {
      const q = nb[i];
      if (i === 0 && c === 0) continue; if (i === 1 && c === cols - 1) continue;
      if (q < 0 || q >= data.length) continue;
      if (data[q] === 0 && label[q] === 0) { label[q] = id; stack.push(q); }
    }
  }
  return { cells, leaked, c0, r0, c1, r1 };
}

/** Outer boundary of a labelled region as a closed polygon of cell corners (crack following). */
function traceOutline(label: Int32Array, cols: number, rows: number, id: number, startC: number, startR: number): P[] {
  const inside = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows && label[r * cols + c] === id;
  // start at the top-left-most cell's top edge, walking clockwise (x right, y down)
  let c = startC, r = startR;
  // move up while inside to reach the top boundary of this column
  while (inside(c, r - 1)) r--;
  while (inside(c - 1, r) && !inside(c - 1, r - 1)) c--;
  const pts: P[] = [];
  // corner coordinates: (x, y) vertex grid; direction 0 right,1 down,2 left,3 up
  let x = c, y = r, dir = 0;
  const x0 = x, y0 = y;
  const cellAt = (vx: number, vy: number, d: number) => {
    // returns [leftCell, rightCell] relative to walking direction from vertex (vx,vy)
    switch (d) {
      case 0: return [inside(vx, vy - 1), inside(vx, vy)];
      case 1: return [inside(vx, vy), inside(vx - 1, vy)];
      case 2: return [inside(vx - 1, vy), inside(vx - 1, vy - 1)];
      default: return [inside(vx - 1, vy - 1), inside(vx, vy - 1)];
    }
  };
  const step = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  let guard = 0;
  do {
    pts.push({ x, y });
    // walk with the region on the right-hand side
    x += step[dir][0]; y += step[dir][1];
    // choose next direction: try turning left (outer), straight, right
    for (const turn of [3, 0, 1, 2]) {
      const nd = (dir + turn) % 4;
      const [l, rr] = cellAt(x, y, nd);
      if (rr && !l) { dir = nd; break; }
    }
    if (++guard > 4 * (cols + rows) * 50) break;
  } while (x !== x0 || y !== y0);
  // drop collinear points
  const out: P[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], d = pts[(i + 1) % pts.length];
    if ((a.x === b.x && b.x === d.x) || (a.y === b.y && b.y === d.y)) continue;
    out.push(b);
  }
  return out;
}

function douglas(pts: P[], eps: number): P[] {
  if (pts.length < 4) return pts;
  // closed: split at the two farthest points
  let ia = 0, ib = 0, best = -1;
  for (let i = 0; i < pts.length; i++) { const d = dist(pts[0], pts[i]); if (d > best) { best = d; ib = i; } }
  best = -1;
  for (let i = 0; i < pts.length; i++) { const d = dist(pts[ib], pts[i]); if (d > best) { best = d; ia = i; } }
  const [s, e] = ia < ib ? [ia, ib] : [ib, ia];
  const rec = (arr: P[]): P[] => {
    if (arr.length < 3) return arr;
    const a = arr[0], b = arr[arr.length - 1];
    const L = dist(a, b) || 1e-9;
    let im = 0, dm = -1;
    for (let i = 1; i < arr.length - 1; i++) {
      const d = Math.abs((b.x - a.x) * (a.y - arr[i].y) - (a.x - arr[i].x) * (b.y - a.y)) / L;
      if (d > dm) { dm = d; im = i; }
    }
    if (dm <= eps) return [a, b];
    const l = rec(arr.slice(0, im + 1)), r = rec(arr.slice(im));
    return [...l.slice(0, -1), ...r];
  };
  const first = rec(pts.slice(s, e + 1));
  const second = rec([...pts.slice(e), ...pts.slice(0, s + 1)]);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

const rot = (p: P, ang: number): P => ({ x: p.x * Math.cos(ang) - p.y * Math.sin(ang), y: p.x * Math.sin(ang) + p.y * Math.cos(ang) });

/**
 * Makes a simplified outline rectilinear in the wall frame when every edge is within `tolDeg`
 * of an axis, and snaps each edge onto the nearest parallel wall face.
 */
function rectilinearise(poly: P[], angle: number, faces: { h: number[]; v: number[] }, snap: number, tolDeg = 12): { poly: P[]; ok: boolean } {
  const local = poly.map((p) => rot(p, -angle));
  const n = local.length;
  const kinds: Array<'h' | 'v'> = [];
  for (let i = 0; i < n; i++) {
    const a = local[i], b = local[(i + 1) % n];
    const deg = (Math.abs(Math.atan2(b.y - a.y, b.x - a.x)) * 180) / Math.PI;
    const off = Math.min(deg, 180 - deg); // 0 = horizontal
    if (off <= tolDeg) kinds.push('h'); else if (Math.abs(off - 90) <= tolDeg) kinds.push('v'); else return { poly, ok: false };
  }
  // merge consecutive edges of the same kind
  const edges: Array<{ k: 'h' | 'v'; v: number; w: number }> = [];
  for (let i = 0; i < n; i++) {
    const a = local[i], b = local[(i + 1) % n];
    const k = kinds[i], L = dist(a, b);
    const v = k === 'h' ? (a.y + b.y) / 2 : (a.x + b.x) / 2;
    const last = edges[edges.length - 1];
    if (last && last.k === k) { last.v = (last.v * last.w + v * L) / (last.w + L); last.w += L; } else edges.push({ k, v, w: L });
  }
  if (edges.length > 1 && edges[0].k === edges[edges.length - 1].k) {
    const f = edges.shift()!, l = edges[edges.length - 1];
    l.v = (l.v * l.w + f.v * f.w) / (l.w + f.w); l.w += f.w;
  }
  if (edges.length < 4 || edges.length % 2) return { poly, ok: false };
  for (const e of edges) {
    const pool = e.k === 'h' ? faces.h : faces.v;
    let best = e.v, bd = snap;
    for (const f of pool) { const d = Math.abs(f - e.v); if (d < bd) { bd = d; best = f; } }
    e.v = best;
  }
  const pts: P[] = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i], f = edges[(i + 1) % edges.length];
    pts.push(e.k === 'h' ? { x: f.v, y: e.v } : { x: e.v, y: f.v });
  }
  // remove zero-length edges created by snapping
  const clean = pts.filter((p, i) => dist(p, pts[(i + 1) % pts.length]) > 1e-6);
  return { poly: clean.map((p) => rot(p, angle)), ok: clean.length >= 4 };
}

/** Wall-face coordinates in the rotated frame (horizontal faces as y values, vertical as x). */
function wallFaces(rings: P[][], angle: number, minLen: number) {
  const h: number[] = [], v: number[] = [];
  for (const r of rings) for (let i = 0; i < r.length; i++) {
    const a = rot(r[i], -angle), b = rot(r[(i + 1) % r.length], -angle);
    const L = dist(a, b); if (L < minLen) continue;
    if (Math.abs(a.y - b.y) < L * 0.02) h.push((a.y + b.y) / 2);
    else if (Math.abs(a.x - b.x) < L * 0.02) v.push((a.x + b.x) / 2);
  }
  return { h, v };
}

// ---------------------------------------------------------------------------------------------
// Room outlines: many CAD exports draw each room's boundary as its own thin closed polygon.

function pointInRing(p: P, ring: P[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * For each seed, the smallest drawn closed polygon that holds it and no other room number.
 * Only polygon styles shared by several rooms count, so a bathtub under a label is ignored.
 */
function findOutlines(paths: VPath[], seeds: P[], wallStyles: Set<string>, minArea: number, maxArea: number): Map<number, P[]> {
  const shapes: Array<{ ring: P[]; area: number; key: string; bb: ReturnType<typeof bboxOf> }> = [];
  for (const p of paths) {
    if (wallStyles.has(styleKey(p)) || p.curves > 0 || p.dashed) continue;
    const key = `${p.paint === 'stroke' ? 's' : 'f'}|${p.lw.toFixed(2)}|${p.stroke.join(',')}`;
    for (const sh of closedShapes(p)) if (sh.area >= minArea && sh.area <= maxArea && sh.ring.length >= 4) shapes.push({ ring: sh.ring, area: sh.area, key, bb: sh.bb });
  }
  const pick = new Map<number, { ring: P[]; key: string }>();
  seeds.forEach((sd, i) => {
    let best: (typeof shapes)[number] | null = null;
    for (const sh of shapes) {
      if (sd.x < sh.bb.x0 || sd.x > sh.bb.x1 || sd.y < sh.bb.y0 || sd.y > sh.bb.y1) continue;
      if (best && sh.area >= best.area) continue;
      if (!pointInRing(sd, sh.ring)) continue;
      if (seeds.some((o, j) => j !== i && o.x >= sh.bb.x0 && o.x <= sh.bb.x1 && o.y >= sh.bb.y0 && o.y <= sh.bb.y1 && pointInRing(o, sh.ring))) continue;
      best = sh;
    }
    if (best) pick.set(i, { ring: best.ring, key: best.key });
  });
  const counts = new Map<string, number>();
  for (const v of pick.values()) counts.set(v.key, (counts.get(v.key) ?? 0) + 1);
  const top = Math.max(0, ...counts.values());
  const out = new Map<number, P[]>();
  if (top < 3) return out;
  for (const [i, v] of pick) if ((counts.get(v.key) ?? 0) >= Math.max(3, top * 0.3)) out.set(i, v.ring);
  return out;
}

function cleanRing(ring: P[], eps: number): P[] {
  let r = ring.filter((p, i) => dist(p, ring[(i + 1) % ring.length]) > eps);
  r = r.filter((b, i) => {
    const a = r[(i + r.length - 1) % r.length], c = r[(i + 1) % r.length];
    const cr = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    return Math.abs(cr) / (dist(a, c) || 1) > eps;
  });
  return r.length >= 3 ? r : ring;
}


// ---------------------------------------------------------------------------------------------
// Scale: independent estimates, each with confidence, compared with one another.

/** Least squares through the origin (value = k * length) with iterative outlier rejection. */
export function robustRatio(samples: Array<{ len: number; val: number }>, tol = 0.1): { k: number; used: number; rejected: number; spreadPct: number } | null {
  let pts = samples.filter((s) => s.len > 0 && s.val > 0);
  if (!pts.length) return null;
  const fit = (a: typeof pts) => a.reduce((s, x) => s + x.len * x.val, 0) / a.reduce((s, x) => s + x.len * x.len, 0);
  let k = fit(pts);
  for (let it = 0; it < 6 && pts.length > 2; it++) {
    const res = pts.map((p) => Math.abs((p.len * k) / p.val - 1));
    const med = median(res);
    const cut = Math.max(tol, med * 3);
    const next = pts.filter((_, i) => res[i] <= cut);
    if (next.length === pts.length || next.length < 2) break;
    pts = next; k = fit(pts);
  }
  const spread = pts.length > 1 ? Math.sqrt(pts.reduce((s, p) => s + ((p.len * k) / p.val - 1) ** 2, 0) / pts.length) * 100 : 0;
  return { k, used: pts.length, rejected: samples.length - pts.length, spreadPct: spread };
}

function scaleEvidenceFor(o: { scaleN?: number; areaPairs: number[]; rooms: RoomGeom[]; doors: Door[]; items: TextItem[]; W: number; H: number; ref: number | null }): ScaleEstimate[] {
  const out: ScaleEstimate[] = [];
  if (o.scaleN) out.push({ source: 'printed', mPerPt: o.scaleN * PAPER_M_PER_PT, confidence: 0.7, used: 1, rejected: 0, note: `1:${o.scaleN}` });
  if (o.areaPairs.length >= 1) {
    const m = median(o.areaPairs);
    const spread = o.areaPairs.length > 1 ? median(o.areaPairs.map((v) => Math.abs(v / m - 1))) : 0.1;
    out.push({ source: 'areas', mPerPt: m, confidence: Math.max(0.15, Math.min(0.9, (0.4 + 0.1 * Math.min(o.areaPairs.length, 5)) * (1 - Math.min(0.8, spread * 6)))), used: o.areaPairs.length, rejected: 0, note: `${o.areaPairs.length} printed area${o.areaPairs.length > 1 ? 's' : ''}, spread ${(spread * 100).toFixed(1)}%` });
  }
  // dimension strings matched to room edges, guided by the best scale so far
  const ref = o.ref ?? (out.length ? out[0].mPerPt : null);
  if (ref) {
    const dims = o.items.filter((i) => i.kind === 'dimension' && i.value && i.value >= 0.5 && i.value <= 30);
    const samples: Array<{ len: number; val: number }> = [];
    const edges: Array<{ a: P; b: P; len: number }> = [];
    for (const r of o.rooms) for (let i = 0; i < r.polygon.length; i++) { const a = r.polygon[i], b = r.polygon[(i + 1) % r.polygon.length]; edges.push({ a, b, len: dist(a, b) }); }
    for (const d of dims) {
      const c = { x: (d.x + d.w / 2) * o.W, y: (d.y + d.h / 2) * o.H };
      let best: { len: number; score: number } | null = null;
      for (const e of edges) {
        const r = (e.len * ref) / d.value!;
        if (r < 0.85 || r > 1.18) continue;
        const mid = { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 };
        const dd = dist(mid, c) * ref;
        if (dd > 2.5) continue;
        const score = Math.abs(r - 1) + dd * 0.05;
        if (!best || score < best.score) best = { len: e.len, score };
      }
      if (best) samples.push({ len: best.len, val: d.value! });
    }
    const f = samples.length >= 2 ? robustRatio(samples, 0.06) : null;
    if (f && f.used >= 2) out.push({ source: 'dimensions', mPerPt: f.k, confidence: Math.max(0.2, Math.min(0.95, 0.5 + 0.1 * f.used - f.spreadPct / 20)), used: f.used, rejected: f.rejected, note: `${f.used} dimension strings matched to walls, spread ${f.spreadPct.toFixed(1)}%` });
  }
  if (o.doors.length >= 2) {
    // swing radius = leaf width; interior doors are 0.8 to 0.9 m, so this is only a weak check
    const w = median(o.doors.map((d) => d.widthPt));
    if (w > 0) out.push({ source: 'doors', mPerPt: 0.85 / w, confidence: Math.min(0.25, 0.1 + 0.03 * o.doors.length), used: o.doors.length, rejected: 0, note: `median leaf ${Math.round(w)} pt taken as 0.85 m` });
  }
  return out;
}

function disagreement(e: ScaleEstimate[]): number {
  const w = e.filter((x) => x.confidence >= 0.3);
  if (w.length < 2) return 0;
  const lo = Math.min(...w.map((x) => x.mPerPt)), hi = Math.max(...w.map((x) => x.mPerPt));
  return (hi / lo - 1) * 100;
}

export interface ExtractOptions {
  /** Metres per page point, when the caller knows it (overrides the printed scale). */
  mPerPt?: number;
  /** Raster cell size in metres (default 2 cm). */
  cellM?: number;
  /** Max raster cells (keeps phones responsive). */
  maxCells?: number;
}

/** Extracts walls, doors, windows and rooms from one page. `items` are the page's text items (normalised). */
export function extractPlan(pp: PagePaths, items: TextItem[], page: number, opts: ExtractOptions = {}): PlanGeometry {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const warnings: string[] = [];
  const W = pp.w, H = pp.h;
  const pageItems = items.filter((i) => i.page === page);
  const toPt = (i: TextItem): P => ({ x: (i.x + i.w / 2) * W, y: (i.y + i.h / 2) * H });

  // 1. scale from the printed "1:N"
  const scales = pageItems.filter((i) => i.kind === 'scale' && i.value && i.value >= 10 && i.value <= 5000).map((i) => i.value!);
  const scaleN = scales.length ? median(scales) : undefined;
  let mPerPt: number | null = opts.mPerPt ?? (scaleN ? scaleN * PAPER_M_PER_PT : null);
  let scaleSource: PlanGeometry['scaleSource'] = opts.mPerPt ? 'printed' : scaleN ? 'printed' : 'none';

  // 2. walls
  const pageArea = W * H;
  const diag = Math.hypot(W, H);
  const tMin = mPerPt ? 0.04 / mPerPt : diag * 0.0006;
  const tMax = mPerPt ? 0.9 / mPerPt : diag * 0.02;
  const wall = findWalls(pp.paths, tMin, tMax, pageArea, mPerPt, W, H);
  const empty = (reason: string): PlanGeometry => ({
    page, pageW: W, pageH: H, angle: 0, mPerPt, scaleSource, scaleN, walls: [], wallSource: 'none', wallThicknessPt: 0,
    doors: [], windows: [], rooms: [], failed: [], warnings: [...warnings, reason], ms: 0,
  });
  if (!wall.rings.length) return empty('No walls found in the drawing lines.');
  const wallT = wall.thickness || tMin * 2;
  const angle = dominantAngle(wall.rings);

  // 3. grid over the walls' extent
  const all = wall.rings.flat();
  const bb = bboxOf(all);
  const margin = wallT * 4;
  const cellM = opts.cellM ?? 0.02;
  const maxCells = opts.maxCells ?? 9_000_000;
  let cell = mPerPt ? cellM / mPerPt : wallT / 6;
  const spanX = bb.x1 - bb.x0 + 2 * margin, spanY = bb.y1 - bb.y0 + 2 * margin;
  if ((spanX / cell) * (spanY / cell) > maxCells) cell = Math.sqrt((spanX * spanY) / maxCells);
  const grid = new Grid(bb.x0 - margin, bb.y0 - margin, cell, Math.ceil(spanX / cell), Math.ceil(spanY / cell));
  for (const p of pp.paths) {
    if (!wall.styles.has(styleKey(p))) continue;
    const rings = closedShapes(p).filter((s) => s.area < pageArea * 0.2).map((s) => s.ring);
    if (rings.length) grid.fillRings(rings, 1);
  }
  if (wall.source === 'strokes') for (const r of wall.rings) grid.fillRings([r], 1);

  // 4. doors and windows close the wall gaps
  const doorR = mPerPt ? [0.45 / mPerPt, 1.4 / mPerPt] : [wallT * 3, wallT * 14];
  // swings away from the walls (a legend symbol, a north arrow) are not doors
  const inPlan = (q: P) => q.x > bb.x0 - wallT && q.x < bb.x1 + wallT && q.y > bb.y0 - wallT && q.y < bb.y1 + wallT;
  const doors = findDoors(pp.paths, doorR[0], doorR[1], wall.styles, grid, wallT)
    .filter((d) => inPlan(d.hinge) && inPlan(d.jamb) && (grid.blockedNear(d.hinge, wallT) || grid.blockedNear(d.jamb, wallT)));
  for (const d of doors) {
    // the hinge line sits on the wall face on the swing side: fill the band behind it, away from the leaf
    const L = dist(d.hinge, d.tip) || 1;
    const bx = -(d.tip.x - d.hinge.x) / L, by = -(d.tip.y - d.hinge.y) / L;
    // local wall thickness: step into the wall just past the jamb and walk across it
    const J = dist(d.hinge, d.jamb) || 1;
    const ux = (d.jamb.x - d.hinge.x) / J, uy = (d.jamb.y - d.hinge.y) / J;
    const probe = { x: d.jamb.x + ux * cell * 3, y: d.jamb.y + uy * cell * 3 };
    let k = 0, seen = false;
    for (let s = 0; s < (wall.thick90 * 2.5) / cell; s++) {
      const blocked = grid.at(grid.cx(probe.x + bx * s * cell), grid.cy(probe.y + by * s * cell)) === 1;
      if (blocked) { seen = true; k = s + 1; } else if (seen) break;
    }
    const t = seen ? Math.max(cell * 2, k * cell) : wallT;
    grid.fillSegment({ x: d.hinge.x + bx * t / 2, y: d.hinge.y + by * t / 2 }, { x: d.jamb.x + bx * t / 2, y: d.jamb.y + by * t / 2 }, t, 2);
  }
  const windows = findWindows(pp.paths, grid, wallT, Math.max(wallT * 2.5, wall.thick90 * 1.6, mPerPt ? 0.8 / mPerPt : 0), wall.styles, mPerPt ? 0.3 / mPerPt : wallT * 2, doors);
  for (const w of windows) grid.fillSegment(w.a, w.b, Math.max(w.depthPt, wallT * 0.5), 2);

  // 5. rooms: fill from every printed room number, then any other enclosed space
  const { rooms: records } = extractRooms(pageItems);
  const label = new Int32Array(grid.cols * grid.rows);
  const rooms: RoomGeom[] = [];
  const failed: PlanGeometry['failed'] = [];
  const faces = wallFaces(wall.rings, angle, wallT * 0.5);
  const regionInfo = new Map<number, { cells: number; c0: number; r0: number; c1: number; r1: number; leaked: boolean }>();
  const maxRoomCells = Math.floor(grid.cols * grid.rows * 0.5);
  const seedCell = (p: P): [number, number] | null => {
    const c = grid.cx(p.x), r = grid.cy(p.y);
    for (let rad = 0; rad < 12; rad++) for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
      if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
      if (grid.at(c + dc, r + dr) === 0) return [c + dc, r + dr];
    }
    return null;
  };
  const numberOnly = pageItems.filter((i) => /^[A-Z]{0,2}\d{1,2}\.\d{2,3}$/.test(i.str) && !records.some((r) => r.no === i.str));
  const seeds: Array<{ no?: string; label?: string; area?: number; items: TextItem[]; at: P }> = [
    ...records.map((r) => ({ no: r.no, label: r.label, area: r.area, items: r.items, at: toPt(r.items[1]) })),
    ...numberOnly.map((i) => ({ no: i.str, items: [i], at: toPt(i) })),
  ];
  let nextId = 1;
  const regionOf = new Map<number, number>(); // region id -> room index
  const areaRange = mPerPt ? [0.4 / (mPerPt * mPerPt), 3000 / (mPerPt * mPerPt)] : [wallT * wallT * 20, pageArea * 0.3];
  const outlines = findOutlines(pp.paths, seeds.map((s) => s.at), wall.styles, areaRange[0], areaRange[1]);
  const taken = new Grid(grid.x0, grid.y0, grid.cell, grid.cols, grid.rows);
  for (const ring of outlines.values()) taken.fillRings([ring], 1);
  for (const [si, s] of seeds.entries()) {
    const sc = seedCell(s.at);
    const outline = outlines.get(si);
    if (outline) {
      // the drawn room boundary is exact; the wall fill only cross-checks it
      let raster = 0;
      if (sc && label[sc[1] * grid.cols + sc[0]] === 0) {
        const id = nextId++;
        const info = floodFill(grid, sc, label, id, maxRoomCells);
        if (!info.leaked) raster = info.cells * cell * cell;
      }
      const poly = cleanRing(outline, cell * 0.25);
      const rect = rectilinearise(poly, angle, { h: [], v: [] }, 0, 3);
      rooms.push({ id: `o${si}`, no: s.no, label: s.label, printedArea: s.area, items: s.items, polygon: poly, areaPt2: Math.abs(polyArea(poly)), rasterPt2: raster, seed: s.at, rectilinear: rect.ok, source: 'outline' });
      continue;
    }
    if (!sc) { failed.push({ no: s.no, label: s.label, reason: 'label sits on a wall', items: s.items }); continue; }
    const k = sc[1] * grid.cols + sc[0];
    if (label[k] !== 0) {
      const ri = regionOf.get(label[k]);
      const other = ri != null ? rooms[ri] : undefined;
      failed.push({ no: s.no, label: s.label, reason: other ? `shares one open space with ${other.no ?? other.label} (an opening without a door)` : 'outside the closed walls', items: s.items });
      continue;
    }
    const id = nextId++;
    const info = floodFill(grid, sc, label, id, maxRoomCells);
    regionInfo.set(id, info);
    if (info.leaked) { failed.push({ no: s.no, label: s.label, reason: 'walls do not close around it', items: s.items }); continue; }
    regionOf.set(id, rooms.length);
    rooms.push({ id: `r${id}`, no: s.no, label: s.label, printedArea: s.area, items: s.items, polygon: [], areaPt2: 0, rasterPt2: info.cells * cell * cell, seed: s.at, rectilinear: false, source: 'walls' });
  }
  // unlabelled enclosed spaces larger than 1 m²
  const minCells = mPerPt ? 1.0 / (mPerPt * mPerPt) / (cell * cell) : 2000;
  for (let r = 1; r < grid.rows - 1; r += 3) for (let c = 1; c < grid.cols - 1; c += 3) {
    const k = r * grid.cols + c;
    if (grid.data[k] !== 0 || label[k] !== 0 || taken.data[k] !== 0) continue;
    const id = nextId++;
    const info = floodFill(grid, [c, r], label, id, maxRoomCells);
    regionInfo.set(id, info);
    if (info.leaked || info.cells < minCells) continue;
    regionOf.set(id, rooms.length);
    const at = { x: grid.x0 + (c + 0.5) * cell, y: grid.y0 + (r + 0.5) * cell };
    rooms.push({ id: `r${id}`, items: [], polygon: [], areaPt2: 0, rasterPt2: info.cells * cell * cell, seed: at, rectilinear: false, source: 'walls' });
  }

  // 6. outlines
  for (const [id, ri] of regionOf) {
    const room = rooms[ri];
    const info = regionInfo.get(id)!;
    // first cell of the region in scan order
    let sc = -1, sr = -1;
    outer: for (let r = info.r0; r <= info.r1; r++) for (let c = info.c0; c <= info.c1; c++) if (label[r * grid.cols + c] === id) { sc = c; sr = r; break outer; }
    const raw = traceOutline(label, grid.cols, grid.rows, id, sc, sr).map((p) => ({ x: grid.x0 + p.x * cell, y: grid.y0 + p.y * cell }));
    const simple = douglas(raw, cell * 1.6);
    const rect = rectilinearise(simple, angle, faces, cell * 2.5);
    room.polygon = rect.ok ? rect.poly : simple;
    room.rectilinear = rect.ok;
    room.areaPt2 = Math.abs(polyArea(room.polygon));
  }

  // 7. calibrate against printed areas: fit metres-per-point from rooms with a printed net area
  const pairs = rooms.filter((r) => r.printedArea && r.areaPt2 > 0).map((r) => Math.sqrt(r.printedArea! / r.areaPt2));
  let areaFit: number | undefined;
  if (pairs.length >= 2) areaFit = median(pairs);
  if (!mPerPt && areaFit) { mPerPt = areaFit; scaleSource = 'areas'; }
  else if (mPerPt && areaFit && Math.abs(areaFit / mPerPt - 1) > 0.08) {
    warnings.push(`The printed scale and the printed room areas disagree by ${Math.round(Math.abs(areaFit / mPerPt - 1) * 100)}%. Using the room areas.`);
    mPerPt = areaFit; scaleSource = 'areas';
  }
  const evidence = scaleEvidenceFor({ scaleN, areaPairs: pairs, rooms, doors, items: pageItems, W, H, ref: mPerPt });
  const scaleDisagreementPct = evidence.length > 1 ? disagreement(evidence) : 0;
  if (scaleDisagreementPct > 8 && !warnings.some((w) => w.includes('disagree'))) warnings.push(`Scale estimates disagree by ${Math.round(scaleDisagreementPct)}%: ${evidence.map((e) => `${e.source} ${e.note}`).join('; ')}.`);
  if (!mPerPt) {
    const best = [...evidence].sort((a, b) => b.confidence - a.confidence)[0];
    if (best && best.confidence >= 0.3) { mPerPt = best.mPerPt; scaleSource = best.source === 'areas' ? 'areas' : 'printed'; warnings.push(`Scale taken from ${best.source} (${best.note}); confidence ${Math.round(best.confidence * 100)}%.`); }
  }
  if (!mPerPt) warnings.push('No printed scale and no printed room areas: sizes are unknown.');
  if (failed.length) warnings.push(`${failed.length} labelled room${failed.length > 1 ? 's' : ''} could not be closed.`);

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    page, pageW: W, pageH: H, angle, mPerPt, scaleSource, scaleN, areaFitMPerPt: areaFit,
    walls: wall.rings, wallSource: wall.source, wallThicknessPt: wallT,
    scaleEvidence: evidence, scaleDisagreementPct, excluded: wall.excluded,
    doors, windows, rooms, failed, warnings, ms: Math.round(t1 - t0),
  };
}
