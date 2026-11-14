// Interior design rules. Each rule is a pure function of the room and the furniture and returns
// verdicts with a 0..1 score and a plain sentence with the measured numbers.
import type { FurnitureItem, Opening, OpeningKind, ObjectSemantics, Requirements, RuleVerdict, Space, SpaceModel } from '../../core/types';
import { distPointRect, distToBoundary, overlapDepth, pointInPolygon, rectOutside, signedArea, corners as rectCorners, type ORect, type P } from '../referee/geom';
import { isHostCategory, isSeatCategory, isSoftSeat, semanticsOf, zoneKindOf, type ZoneKind } from './semantics';

// ---------------------------------------------------------------- small maths
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : Number.isFinite(x) ? x : 0);
/** 1 inside [lo, hi], falling linearly to 0 at lo - soft and hi + soft. */
export function band(x: number, lo: number, hi: number, softLo: number, softHi = softLo): number {
  if (x < lo) return clamp01(1 - (lo - x) / (softLo || 1e-9));
  if (x > hi) return clamp01(1 - (x - hi) / (softHi || 1e-9));
  return 1;
}
export const cm = (m: number) => `${Math.round(m * 100)} cm`;
const mm = (m: number) => `${m.toFixed(1)} m`;
const dot = (a: P, b: P) => a.x * b.x + a.y * b.y;
const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
const addv = (a: P, b: P): P => ({ x: a.x + b.x, y: a.y + b.y });
const mulv = (a: P, s: number): P => ({ x: a.x * s, y: a.y * s });
const lenv = (a: P) => Math.hypot(a.x, a.y);
const normv = (a: P): P => { const l = lenv(a) || 1; return { x: a.x / l, y: a.y / l }; };
const distp = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

// ---------------------------------------------------------------- room context
export interface WallInfo { i: number; a: P; b: P; dir: P; n: P; len: number; rot: number; windows: Array<[number, number]>; doors: Array<[number, number]> }
export interface OpeningInfo { id: string; kind: OpeningKind; o: Opening; wall: number; c: P; a: P; b: P; inward: P; along: [number, number] }
export interface RoomCtx {
  model: SpaceModel; space: Space; poly: P[]; walls: WallInfo[];
  doors: OpeningInfo[]; windows: OpeningInfo[]; openings: OpeningInfo[];
  area: number; box: { minX: number; minY: number; maxX: number; maxY: number }; centre: P;
  swingZones: Array<{ id: string; z: ORect }>; approachZones: Array<{ id: string; z: ORect }>; windowZones: Array<{ id: string; z: ORect }>;
}

function wallFrame(poly: P[], i: number) {
  const a = poly[i], b = poly[(i + 1) % poly.length];
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1e-9;
  const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const sgn = signedArea(poly) >= 0 ? 1 : -1;
  return { a, b, len, dir, n: { x: -dir.y * sgn, y: dir.x * sgn }, rot: Math.atan2(dir.y, dir.x) };
}
export function openingZoneRect(w: WallInfo, offset: number, width: number, depth: number): ORect {
  const c = addv(w.a, mulv(w.dir, offset));
  return { cx: c.x + (w.n.x * depth) / 2, cy: c.y + (w.n.y * depth) / 2, hw: width / 2, hd: depth / 2, rot: w.rot };
}

/** Geometry of the first room, computed once and shared by every rule. */
export function buildRoom(model: SpaceModel): RoomCtx {
  const space = model.spaces[0];
  const poly = space.polygon;
  const walls: WallInfo[] = poly.map((_, i) => ({ i, ...wallFrame(poly, i), windows: [], doors: [] }));
  const openings: OpeningInfo[] = [];
  for (const o of model.openings) {
    if (o.spaceId !== space.id || o.wallIndex < 0 || o.wallIndex >= poly.length) continue;
    const w = walls[o.wallIndex];
    const c = addv(w.a, mulv(w.dir, o.offsetM));
    const along: [number, number] = [o.offsetM - o.widthM / 2, o.offsetM + o.widthM / 2];
    openings.push({ id: o.id, kind: o.kind, o, wall: o.wallIndex, c, a: addv(w.a, mulv(w.dir, along[0])), b: addv(w.a, mulv(w.dir, along[1])), inward: w.n, along });
    (o.kind === 'window' ? w.windows : w.doors).push(along);
  }
  const doors = openings.filter((x) => x.kind !== 'window');
  const windows = openings.filter((x) => x.kind === 'window');
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  const box = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  let cx = 0, cy = 0, a2 = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length], f = p.x * q.y - q.x * p.y; cx += (p.x + q.x) * f; cy += (p.y + q.y) * f; a2 += f; }
  const centre = Math.abs(a2) > 1e-9 ? { x: cx / (3 * a2), y: cy / (3 * a2) } : { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
  const swingZones: RoomCtx['swingZones'] = [], approachZones: RoomCtx['approachZones'] = [], windowZones: RoomCtx['windowZones'] = [];
  for (const op of openings) {
    const w = walls[op.wall];
    if (op.kind === 'door') {
      if (op.o.swing === 'in') swingZones.push({ id: op.id, z: openingZoneRect(w, op.o.offsetM, op.o.widthM, op.o.widthM) });
      approachZones.push({ id: op.id, z: openingZoneRect(w, op.o.offsetM, op.o.widthM, 0.8) });
    } else if (op.kind === 'opening') approachZones.push({ id: op.id, z: openingZoneRect(w, op.o.offsetM, op.o.widthM, 0.8) });
    else windowZones.push({ id: op.id, z: openingZoneRect(w, op.o.offsetM, op.o.widthM, 0.4) });
  }
  return { model, space, poly, walls, doors, windows, openings, area: Math.abs(signedArea(poly)), box, centre, swingZones, approachZones, windowZones };
}

// ---------------------------------------------------------------- item analysis
export const frontOf = (rot: number): P => ({ x: -Math.sin(rot), y: Math.cos(rot) });
export const rightOf = (rot: number): P => ({ x: Math.cos(rot), y: Math.sin(rot) });
export const rectOf = (f: Pick<FurnitureItem, 'x' | 'y' | 'w' | 'd' | 'rotation'>): ORect => ({ cx: f.x, cy: f.y, hw: f.w / 2, hd: f.d / 2, rot: f.rotation });
/** Rect in the item's local frame (front faces +y). */
export function localRect(f: Pick<FurnitureItem, 'x' | 'y' | 'rotation'>, x0: number, x1: number, y0: number, y1: number): ORect {
  const c = Math.cos(f.rotation), s = Math.sin(f.rotation), lx = (x0 + x1) / 2, ly = (y0 + y1) / 2;
  return { cx: f.x + lx * c - ly * s, cy: f.y + lx * s + ly * c, hw: (x1 - x0) / 2, hd: (y1 - y0) / 2, rot: f.rotation };
}
export function toPlanOf(f: Pick<FurnitureItem, 'x' | 'y' | 'rotation'>, lx: number, ly: number): P {
  const c = Math.cos(f.rotation), s = Math.sin(f.rotation);
  return { x: f.x + lx * c - ly * s, y: f.y + lx * s + ly * c };
}

export interface AItem {
  f: FurnitureItem; sem: ObjectSemantics; rect: ORect; poly: P[]; front: P; right: P; solid: boolean; zone: ZoneKind;
  /** Wall the back rests on (gap <= 5 cm), or the nearest wall it faces away from. */
  back: { wall: number; gap: number } | null;
}
export interface LayoutCtx { room: RoomCtx; items: AItem[]; byId: Map<string, AItem>; req?: Requirements | null; hostOf: Map<string, string>; zones: Map<string, ZoneKind> }

function backWall(room: RoomCtx, f: FurnitureItem, front: P): { wall: number; gap: number } | null {
  const backMid = { x: f.x - front.x * f.d / 2, y: f.y - front.y * f.d / 2 };
  let best: { wall: number; gap: number } | null = null;
  for (const w of room.walls) {
    if (dot(w.n, front) < 0.985) continue;
    const t = dot(sub(backMid, w.a), w.dir);
    if (t < -0.05 || t > w.len + 0.05) continue;
    const gap = dot(sub(backMid, w.a), w.n);
    if (gap < -0.05) continue;
    if (!best || gap < best.gap) best = { wall: w.i, gap: Math.max(0, gap) };
  }
  return best;
}

/** Each seat belongs to the nearest desk, table or counter, centre to centre (the referee's pairing). */
export function pairSeatsOf(items: FurnitureItem[]): Map<string, string> {
  const hosts = items.filter((f) => isHostCategory(f.category)), out = new Map<string, string>();
  if (!hosts.length) return out;
  for (const f of items) {
    if (!isSeatCategory(f.category)) continue;
    let best = hosts[0], bd = Infinity;
    for (const h of hosts) { const d = Math.hypot(h.x - f.x, h.y - f.y); if (d < bd) { bd = d; best = h; } }
    out.set(f.id, best.id);
  }
  return out;
}

/** Zone per item: storage and decor join the functional zone they serve. */
export function assignZones(items: FurnitureItem[]): Map<string, ZoneKind> {
  const out = new Map<string, ZoneKind>();
  const has = (z: ZoneKind) => items.some((f) => zoneKindOf(f) === z);
  const hostOf = pairSeatsOf(items);
  for (const f of items) {
    let z = zoneKindOf(f);
    const c = f.category;
    if (isSeatCategory(c) && hostOf.has(f.id)) { const h = items.find((g) => g.id === hostOf.get(f.id)); if (h) z = zoneKindOf(h); }
    if (z === 'storage') z = ['wardrobe', 'dresser', 'toy-storage'].includes(c) && has('sleep') ? 'sleep' : c === 'bookshelf' && has('work') ? 'work' : c === 'bookshelf' && has('lounge') ? 'lounge' : 'storage';
    if (z === 'decor') z = c === 'rug' && has('lounge') ? 'lounge' : c === 'rug' && has('dining') ? 'dining' : 'decor';
    out.set(f.id, z);
  }
  return out;
}

export function analyseItem(room: RoomCtx, f: FurnitureItem): AItem {
  const rect = rectOf(f), front = frontOf(f.rotation), sem = semanticsOf(f);
  return { f, sem, rect, poly: rectCorners(rect), front, right: rightOf(f.rotation), solid: f.category !== 'rug', zone: zoneKindOf(f), back: backWall(room, f, front) };
}
export function analyse(room: RoomCtx, furniture: FurnitureItem[], req?: Requirements | null, cache?: Map<FurnitureItem, AItem>): LayoutCtx {
  const items = furniture.map((f) => { const hit = cache?.get(f); if (hit) return hit; const a = analyseItem(room, f); cache?.set(f, a); return a; });
  const zones = assignZones(furniture);
  for (const a of items) a.zone = zones.get(a.f.id) ?? a.zone;
  return { room, items, byId: new Map(items.map((a) => [a.f.id, a])), req, hostOf: pairSeatsOf(furniture), zones };
}

// ---------------------------------------------------------------- distances
function segRay(o: P, d: P, p: P, q: P): number {
  const e = sub(q, p), den = d.x * e.y - d.y * e.x;
  if (Math.abs(den) < 1e-12) return Infinity;
  const w = sub(p, o);
  const t = (w.x * e.y - w.y * e.x) / den, u = (w.x * d.y - w.y * d.x) / den;
  return t >= -1e-9 && u >= -1e-9 && u <= 1 + 1e-9 ? Math.max(0, t) : Infinity;
}
/** Free distance from `o` along unit `d` until a wall or a solid footprint (excluding `ignore`). */
export function rayFree(L: LayoutCtx, o: P, d: P, ignore: Set<string> | null = null, maxD = 6): number {
  let best = maxD;
  const poly = L.room.poly;
  for (let i = 0; i < poly.length; i++) best = Math.min(best, segRay(o, d, poly[i], poly[(i + 1) % poly.length]));
  for (const a of L.items) {
    if (!a.solid || (ignore && ignore.has(a.f.id))) continue;
    if (distPointRect(o, a.rect) > best) continue;
    const pts = a.poly;
    for (let i = 0; i < 4; i++) best = Math.min(best, segRay(o, d, pts[i], pts[(i + 1) % 4]));
  }
  return best;
}
/** Smallest free distance over several parallel rays. */
export function sweepFree(L: LayoutCtx, origins: P[], d: P, ignore: Set<string> | null, maxD = 6): number {
  let m = maxD;
  for (const o of origins) m = Math.min(m, rayFree(L, o, d, ignore, maxD));
  return m;
}
/** Exact distance between two convex polygons (0 when touching or overlapping). */
export function polyDist(a: P[], b: P[]): number {
  let m = Infinity;
  const seg = (p: P, s: P, t: P) => {
    const ab = sub(t, s), l2 = dot(ab, ab);
    const u = l2 ? Math.max(0, Math.min(1, dot(sub(p, s), ab) / l2)) : 0;
    return distp(p, addv(s, mulv(ab, u)));
  };
  for (const p of a) for (let i = 0; i < b.length; i++) m = Math.min(m, seg(p, b[i], b[(i + 1) % b.length]));
  for (const p of b) for (let i = 0; i < a.length; i++) m = Math.min(m, seg(p, a[i], a[(i + 1) % a.length]));
  if (pointInPolygon(a[0], b) || pointInPolygon(b[0], a)) return 0;
  return m;
}
const nearestWindow = (room: RoomCtx, p: P) => {
  let best: OpeningInfo | null = null, bd = Infinity;
  for (const w of room.windows) { const d = distp(w.c, p); if (d < bd) { bd = d; best = w; } }
  return best ? { w: best, d: bd } : null;
};
/** Point you stand on to use a door, 40 cm inside it. */
export const doorPoint = (op: OpeningInfo, inward = 0.4): P => addv(op.c, mulv(op.inward, inward));

// ---------------------------------------------------------------- walkway grid (the one costly part)
export interface FloorGrid { ox: number; oy: number; cols: number; rows: number; cell: number; clr: Float32Array }
/** Distance from each cell to the nearest wall or solid footprint (-1 outside the room). Walls do not count near `freeNear` points. */
export function floorGrid(L: LayoutCtx, cell = 0.1, freeNear: P[] = []): FloorGrid {
  const { box, poly } = L.room;
  const cols = Math.max(1, Math.ceil((box.maxX - box.minX) / cell)), rows = Math.max(1, Math.ceil((box.maxY - box.minY) / cell));
  const clr = new Float32Array(cols * rows).fill(-1);
  const solids = L.items.filter((a) => a.solid);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const p = { x: box.minX + (c + 0.5) * cell, y: box.minY + (r + 0.5) * cell };
    if (!pointInPolygon(p, poly)) continue;
    let m = freeNear.some((q) => distp(p, q) < 0.5) ? 9 : distToBoundary(p, poly);
    for (const a of solids) { const d = distPointRect(p, a.rect); if (d < m) m = d; }
    clr[r * cols + c] = m;
  }
  return { ox: box.minX, oy: box.minY, cols, rows, cell, clr };
}
const cellOf = (g: FloorGrid, p: P) => {
  const c = Math.min(g.cols - 1, Math.max(0, Math.floor((p.x - g.ox) / g.cell))), r = Math.min(g.rows - 1, Math.max(0, Math.floor((p.y - g.oy) / g.cell)));
  return r * g.cols + c;
};
/** Widest-path bottleneck clearance from `start` to every cell (max-min Dijkstra). */
export function widestFrom(g: FloorGrid, start: P): Float32Array {
  const n = g.cols * g.rows, best = new Float32Array(n).fill(-1);
  const s = cellOf(g, start);
  if (g.clr[s] < 0) return best;
  // Binary max-heap of [value, index].
  const hv: number[] = [], hi: number[] = [];
  const push = (v: number, i: number) => { hv.push(v); hi.push(i); let k = hv.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (hv[p] >= hv[k]) break; [hv[p], hv[k]] = [hv[k], hv[p]]; [hi[p], hi[k]] = [hi[k], hi[p]]; k = p; } };
  const pop = () => { const v = hv[0], i = hi[0], lv = hv.pop()!, li = hi.pop()!; if (hv.length) { hv[0] = lv; hi[0] = li; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < hv.length && hv[l] > hv[m]) m = l; if (r < hv.length && hv[r] > hv[m]) m = r; if (m === k) break; [hv[m], hv[k]] = [hv[k], hv[m]]; [hi[m], hi[k]] = [hi[k], hi[m]]; k = m; } } return [v, i]; };
  best[s] = g.clr[s]; push(best[s], s);
  while (hv.length) {
    const [v, i] = pop();
    if (v < best[i]) continue;
    const r = Math.floor(i / g.cols), c = i % g.cols;
    const nb = [r > 0 ? i - g.cols : -1, r < g.rows - 1 ? i + g.cols : -1, c > 0 ? i - 1 : -1, c < g.cols - 1 ? i + 1 : -1];
    for (const j of nb) {
      if (j < 0 || g.clr[j] < 0) continue;
      const w = Math.min(v, g.clr[j]);
      if (w > best[j]) { best[j] = w; push(w, j); }
    }
  }
  return best;
}
/** Best bottleneck clearance of any cell within `radius` of p. */
function bestNear(g: FloorGrid, best: Float32Array, p: P, radius: number): number {
  let m = -1;
  const c0 = Math.floor((p.x - radius - g.ox) / g.cell), c1 = Math.floor((p.x + radius - g.ox) / g.cell);
  const r0 = Math.floor((p.y - radius - g.oy) / g.cell), r1 = Math.floor((p.y + radius - g.oy) / g.cell);
  for (let r = Math.max(0, r0); r <= Math.min(g.rows - 1, r1); r++) for (let c = Math.max(0, c0); c <= Math.min(g.cols - 1, c1); c++) {
    const q = { x: g.ox + (c + 0.5) * g.cell, y: g.oy + (r + 0.5) * g.cell };
    if (distp(q, p) <= radius) m = Math.max(m, best[r * g.cols + c]);
  }
  return m;
}
/** Largest axis-aligned free rectangle (m²) on the grid, cells free when clearance > 0. */
export function largestOpenRect(g: FloorGrid): number {
  const h = new Array(g.cols).fill(0); let best = 0;
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) h[c] = g.clr[r * g.cols + c] > g.cell * 0.5 ? h[c] + 1 : 0;
    const st: number[] = [];
    for (let c = 0; c <= g.cols; c++) {
      const hc = c === g.cols ? 0 : h[c];
      while (st.length && h[st[st.length - 1]] >= hc) { const top = st.pop()!; const left = st.length ? st[st.length - 1] + 1 : 0; best = Math.max(best, h[top] * (c - left)); }
      st.push(c);
    }
  }
  return best * g.cell * g.cell;
}

// ---------------------------------------------------------------- rule plumbing
export interface DesignRule {
  id: string;
  name: string;
  severity: RuleVerdict['severity'];
  /** Where the number comes from, in a few words. */
  source: string;
  /** Needs the floor grid (skipped in the solver's fast inner loop). */
  costly?: boolean;
  evaluate: (L: LayoutCtx) => RuleVerdict[];
}
type Def = Omit<DesignRule, 'evaluate'> & { evaluate: (L: LayoutCtx, v: Mk) => RuleVerdict[] };
type Mk = (itemIds: string[], score: number, message: string, pass?: boolean) => RuleVerdict;
function rule(def: Def): DesignRule {
  const mk = (itemIds: string[], score: number, message: string, pass?: boolean): RuleVerdict => {
    const s = Math.round(clamp01(score) * 1000) / 1000;
    return { ruleId: def.id, name: def.name, itemIds, score: s, pass: pass ?? s >= (def.severity === 'hard' ? 1 : 0.6), severity: def.severity, message };
  };
  return { ...def, evaluate: (L) => def.evaluate(L, mk) };
}
const of = (L: LayoutCtx, ...cats: string[]) => L.items.filter((a) => cats.includes(a.f.category));
const solids = (L: LayoutCtx) => L.items.filter((a) => a.solid);
const isBed = (a: AItem) => a.f.category === 'bed' || a.f.category === 'bunk-bed';
const isDouble = (a: AItem) => a.f.w >= 1.2;
const ids = (as: AItem[]) => as.map((a) => a.f.id);
const seatsOfHost = (L: LayoutCtx, h: AItem) => L.items.filter((a) => L.hostOf.get(a.f.id) === h.f.id);
function focalOf(L: LayoutCtx): { kind: 'item'; a: AItem } | { kind: 'window'; p: P } | null {
  const tv = of(L, 'tv-unit')[0];
  if (tv) return { kind: 'item', a: tv };
  const w = L.room.windows[0];
  return w ? { kind: 'window', p: w.c } : null;
}
const nameOf = (a: AItem) => a.f.name;
/** Free distance straight out from an item's side, sampled along that side. */
function sideFree(L: LayoutCtx, a: AItem, side: 'front' | 'left' | 'right' | 'back', from = 0, to = 1, ignore?: Set<string>): number {
  const f = a.f, hw = f.w / 2, hd = f.d / 2, e = 0.002;
  const ig = ignore ?? new Set([f.id]);
  ig.add(f.id);
  const pts: P[] = [];
  for (const k of [0.1, 0.5, 0.9]) {
    const u = from + (to - from) * k;
    if (side === 'front') pts.push(toPlanOf(f, -hw + u * f.w, hd + e));
    else if (side === 'back') pts.push(toPlanOf(f, -hw + u * f.w, -hd - e));
    else if (side === 'left') pts.push(toPlanOf(f, -hw - e, -hd + u * f.d));
    else pts.push(toPlanOf(f, hw + e, -hd + u * f.d));
  }
  const d = side === 'front' ? a.front : side === 'back' ? mulv(a.front, -1) : side === 'left' ? mulv(a.right, -1) : a.right;
  return sweepFree(L, pts, d, ig);
}

// ---------------------------------------------------------------- the rules
export const RULES: DesignRule[] = [
  // ---- hard: mirrors of the independent referee, so every verdict list explains validity too
  rule({
    id: 'inside-room', name: 'Inside the room', severity: 'hard', source: 'Measured outline',
    evaluate: (L, v) => {
      const bad = L.items.filter((a) => rectOutside(a.rect, L.room.poly) > 0.01);
      return [bad.length ? v(ids(bad), 0, `${bad.map(nameOf).join(', ')} stick${bad.length === 1 ? 's' : ''} out of the room.`) : v([], 1, 'Every piece sits inside the walls.')];
    },
  }),
  rule({
    id: 'no-overlap', name: 'No overlaps', severity: 'hard', source: 'Footprints',
    evaluate: (L, v) => {
      const s = solids(L), out: RuleVerdict[] = [];
      for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) {
        const d = overlapDepth(s[i].rect, s[j].rect);
        if (d > 0.01) out.push(v([s[i].f.id, s[j].f.id], 0, `${nameOf(s[i])} and ${nameOf(s[j])} overlap by ${cm(d)}.`));
      }
      return out.length ? out : [v([], 1, 'No two pieces overlap.')];
    },
  }),
  rule({
    id: 'use-zones', name: 'Use space kept free', severity: 'hard', source: 'Catalogue use zones',
    evaluate: (L, v) => {
      const out: RuleVerdict[] = [];
      const s = solids(L);
      for (const a of s) {
        const f = a.f, c = f.clearance, hw = f.w / 2, hd = f.d / 2;
        const host = L.hostOf.get(f.id);
        const hostA = host ? L.byId.get(host) : undefined;
        const sides: Array<[string, number, ORect]> = [
          ['front', c.front, localRect(f, -hw, hw, hd, hd + c.front)], ['back', c.back, localRect(f, -hw, hw, -hd - c.back, -hd)],
          ['left', c.left, localRect(f, -hw - c.left, -hw, -hd, hd)], ['right', c.right, localRect(f, hw, hw + c.right, -hd, hd)],
        ];
        for (const [side, need, r] of sides) {
          if (need <= 0.01) continue;
          const hit = s.filter((g) => g !== a && L.hostOf.get(g.f.id) !== f.id && host !== g.f.id && overlapDepth(r, g.rect) > 0.01);
          const facesHost = !!hostA && overlapDepth(r, hostA.rect) > 0.01;
          const wall = !facesHost && rectOutside(r, L.room.poly) > 0.01;
          if (hit.length || wall) out.push(v([f.id, ...ids(hit)], 0, `${nameOf(a)} needs ${cm(need)} free at the ${side}; ${[...hit.map(nameOf), ...(wall ? ['a wall'] : [])].join(', ')} ${hit.length + (wall ? 1 : 0) > 1 ? 'are' : 'is'} in the way.`));
        }
      }
      return out.length ? out : [v([], 1, 'Every use zone (chair pull-out, drawers, doors) is free.')];
    },
  }),
  rule({
    id: 'door-swing', name: 'Door swing clear', severity: 'hard', source: 'Door leaf width',
    evaluate: (L, v) => L.room.swingZones.map(({ id, z }) => {
      const hit = solids(L).filter((a) => overlapDepth(z, a.rect) > 0.01);
      return hit.length ? v([...ids(hit), id], 0, `The door cannot open fully: ${hit.map(nameOf).join(', ')} ${hit.length > 1 ? 'are' : 'is'} in its ${cm(z.hw * 2)} swing.`)
        : v([id], 1, `The door swings open its full ${cm(z.hw * 2)}.`);
    }),
  }),
  rule({
    id: 'door-approach', name: 'Door approach clear', severity: 'hard', source: '80 cm landing inside doors',
    evaluate: (L, v) => L.room.approachZones.map(({ id, z }) => {
      const hit = solids(L).filter((a) => overlapDepth(z, a.rect) > 0.01);
      return hit.length ? v([...ids(hit), id], 0, `${hit.map(nameOf).join(', ')} stand${hit.length > 1 ? '' : 's'} in the 80 cm landing inside the door.`)
        : v([id], 1, 'The 80 cm landing inside the door is clear.');
    }),
  }),
  rule({
    id: 'window-access', name: 'Windows reachable', severity: 'hard', source: 'Tall pieces kept 40 cm off windows',
    evaluate: (L, v) => L.room.windowZones.map(({ id, z }) => {
      const hit = solids(L).filter((a) => a.f.h > 1.0 && overlapDepth(z, a.rect) > 0.01);
      return hit.length ? v([...ids(hit), id], 0, `${hit.map(nameOf).join(', ')} block${hit.length > 1 ? '' : 's'} the window (taller than 1 m within 40 cm).`)
        : v([id], 1, 'Nothing tall stands in front of the window.');
    }),
  }),
  rule({
    id: 'unfold', name: 'Unfolds freely', severity: 'hard', source: 'Unfolded depth',
    evaluate: (L, v) => L.items.filter((a) => a.f.unfoldedD && a.f.unfoldedD > a.f.d).map((a) => {
      const f = a.f, r = localRect(f, -f.w / 2, f.w / 2, -f.d / 2, f.d / 2 + (f.unfoldedD! - f.d));
      const hit = solids(L).filter((g) => g !== a && overlapDepth(r, g.rect) > 0.01);
      const wall = rectOutside(r, L.room.poly) > 0.01;
      return hit.length || wall ? v([f.id, ...ids(hit)], 0, `${nameOf(a)} cannot unfold to ${cm(f.unfoldedD!)}: ${[...hit.map(nameOf), ...(wall ? ['a wall'] : [])].join(', ')} in the way.`)
        : v([f.id], 1, `${nameOf(a)} unfolds to ${cm(f.unfoldedD!)} without hitting anything.`);
    }),
  }),

  // ---- circulation
  rule({
    id: 'walkway-main', name: 'Main walkway', severity: 'strong', source: '80 cm main circulation', costly: true,
    evaluate: (L, v) => {
      const doors = L.room.doors;
      if (!doors.length) return [];
      const need = Math.max(0.8, L.req?.minRouteWidthM ?? 0.8);
      const targets = L.room.openings.filter((o) => o !== doors[0] && (L.req?.routeTargets?.length ? L.req.routeTargets.some((t) => t.kind === o.kind && (!t.id || t.id === o.id)) || o.kind !== 'window' : true));
      if (!targets.length) return [];
      const start = doorPoint(doors[0]);
      const ends = targets.map((t) => doorPoint(t, t.kind === 'window' ? 0.5 : 0.4));
      const g = floorGrid(L, 0.1, [start, ...ends]);
      const best = widestFrom(g, start);
      return targets.map((t, k) => {
        const w = Math.max(0, 2 * bestNear(g, best, ends[k], 0.12));
        const label = t.kind === 'window' ? 'the window' : 'the other door';
        return v([t.id], band(w, need, 9, 0.3), w >= need ? `A ${cm(w)} wide way runs from the door to ${label} (needs ${cm(need)}).` : `The way from the door to ${label} narrows to ${cm(w)}; a main walkway wants ${cm(need)}.`, w + 1e-6 >= need);
      });
    },
  }),
  rule({
    id: 'walkway-secondary', name: 'Every piece reachable', severity: 'strong', source: '60 cm secondary paths', costly: true,
    evaluate: (L, v) => {
      const door = L.room.doors[0];
      if (!door) return [];
      const start = doorPoint(door);
      const g = floorGrid(L, 0.1, [start]);
      const best = widestFrom(g, start);
      const out: RuleVerdict[] = [];
      for (const a of L.items) {
        if (!a.solid || L.hostOf.has(a.f.id) || a.sem.role === 'decor' || a.sem.role === 'lighting' || a.f.category === 'nightstand') continue;
        const pts: P[] = isBed(a)
          ? [toPlanOf(a.f, -a.f.w / 2 - 0.3, 0.2), toPlanOf(a.f, a.f.w / 2 + 0.3, 0.2), toPlanOf(a.f, 0, a.f.d / 2 + 0.3)]
          : [toPlanOf(a.f, 0, a.f.d / 2 + Math.max(0.3, Math.min(0.6, a.f.clearance.front)))];
        if (isHostCategory(a.f.category)) for (const s of seatsOfHost(L, a)) pts.push(toPlanOf(s.f, 0, -s.f.d / 2 - 0.3));
        const w = Math.max(0, ...pts.map((p) => 2 * bestNear(g, best, p, 0.35)));
        out.push(v([a.f.id], band(w, 0.6, 9, 0.25), w >= 0.6 ? `${a.f.name} is reachable along a ${cm(Math.min(w, 2))}${w >= 2 ? '+' : ''} path.` : `Getting to ${lc(a.f.name)} means squeezing through ${cm(w)}; aim for 60 cm.`, w + 1e-6 >= 0.6));
      }
      return out;
    },
  }),
  rule({
    id: 'open-floor', name: 'Open floor', severity: 'preference', source: 'One usable open area', costly: true,
    evaluate: (L, v) => {
      const s = solids(L);
      if (s.length < 2) return [];
      const g = floorGrid(L, 0.1);
      const open = largestOpenRect(g);
      const free = Math.max(0.1, L.room.area - s.reduce((t, a) => t + a.f.w * a.f.d, 0));
      const ratio = open / free;
      return [v([], band(ratio, 0.35, 1, 0.25), `The largest open rectangle is ${open.toFixed(1)} m², ${Math.round(ratio * 100)}% of the free floor.`)];
    },
  }),

  // ---- beds
  rule({
    id: 'bed-headboard', name: 'Headboard on a wall', severity: 'strong', source: 'Bedroom planning practice',
    evaluate: (L, v) => L.items.filter(isBed).map((a) => {
      const g = a.back?.gap ?? 9;
      return v([a.f.id], g <= 0.05 ? 1 : band(g, 0, 0.05, 0.5), g <= 0.05 ? `The headboard of ${lc(a.f.name)} rests on a solid wall.` : `The headboard floats ${cm(Math.min(g, 9))} off the wall.`);
    }),
  }),
  rule({
    id: 'bed-access', name: 'Bed access', severity: 'strong', source: '60 cm beside a double, one side for a single',
    evaluate: (L, v) => L.items.filter(isBed).map((a) => {
      const flank = new Set(of(L, 'nightstand').map((n) => n.f.id));
      const from = Math.min(0.5, 0.45 / a.f.d + 0.02);
      const left = sideFree(L, a, 'left', from, 1, new Set(flank)), right = sideFree(L, a, 'right', from, 1, new Set(flank));
      const foot = sideFree(L, a, 'front');
      if (isDouble(a)) {
        const m = Math.min(left, right);
        return v([a.f.id], band(m, 0.6, 9, 0.25) * 0.85 + band(foot, 0.6, 9, 0.4) * 0.15,
          m >= 0.6 ? `Both sides of ${lc(a.f.name)} have room to get in: ${cm(Math.min(left, 3))} and ${cm(Math.min(right, 3))}.` : `One side of ${lc(a.f.name)} has only ${cm(m)}; a double wants 60 cm on both sides.`);
      }
      const m = Math.max(left, right);
      return v([a.f.id], band(m, 0.6, 9, 0.25), m >= 0.6 ? `${a.f.name} has ${cm(Math.min(m, 3))} free on its open side.` : `${a.f.name} has only ${cm(m)} to get in.`);
    }),
  }),
  rule({
    id: 'bed-command', name: 'Bed sees the door', severity: 'preference', source: 'Command position',
    evaluate: (L, v) => {
      const door = L.room.doors[0];
      if (!door) return [];
      return L.items.filter(isBed).map((a) => {
        const toDoor = normv(sub(door.c, { x: a.f.x, y: a.f.y })), c = dot(toDoor, a.front);
        // Foot pointing straight at the door, or door hidden behind the headboard wall.
        const lateral = Math.abs(dot(sub(door.c, { x: a.f.x, y: a.f.y }), a.right));
        const inLine = c > 0.8 && lateral < a.f.w / 2 + door.o.widthM / 2;
        if (inLine) return v([a.f.id, door.id], 0.45, `The foot of ${lc(a.f.name)} points straight at the door; offset it so the bed is not in the doorway line.`);
        if (c < -0.3) return v([a.f.id, door.id], 0.5, `The door is behind the headboard, out of sight from the bed.`);
        return v([a.f.id, door.id], 1, `From ${lc(a.f.name)} you see the door without lying in line with it.`);
      });
    },
  }),
  rule({
    id: 'bed-window', name: 'Headboard off the window', severity: 'preference', source: 'Draughts and light at the head',
    evaluate: (L, v) => L.items.filter(isBed).map((a) => {
      const w = a.back && a.back.gap < 0.1 ? L.room.walls[a.back.wall] : null;
      if (!w || !w.windows.length) return v([a.f.id], 1, `The headboard of ${lc(a.f.name)} is on a wall without a window.`);
      const t = dot(sub({ x: a.f.x, y: a.f.y }, w.a), w.dir);
      const hit = w.windows.some(([s, e]) => t + a.f.w / 2 > s && t - a.f.w / 2 < e);
      return hit ? v([a.f.id], 0.5, `The headboard sits under the window: draughty, and light falls on the pillow.`) : v([a.f.id], 0.85, `The headboard shares a wall with the window but is not under it.`);
    }),
  }),
  rule({
    id: 'nightstands', name: 'Nightstands flank the bed', severity: 'strong', source: 'Reach from the pillow',
    evaluate: (L, v) => {
      const beds = L.items.filter(isBed), ns = of(L, 'nightstand');
      if (!beds.length || !ns.length) return [];
      const out: RuleVerdict[] = [];
      const sides = new Map<string, number[]>();
      for (const n of ns) {
        const bed = beds.reduce((p, q) => (polyDist(n.poly, q.poly) < polyDist(n.poly, p.poly) ? q : p));
        const local = { x: dot(sub({ x: n.f.x, y: n.f.y }, { x: bed.f.x, y: bed.f.y }), bed.right), y: dot(sub({ x: n.f.x, y: n.f.y }, { x: bed.f.x, y: bed.f.y }), bed.front) };
        const sideGap = Math.abs(local.x) - bed.f.w / 2 - n.f.w / 2;
        const headOff = Math.abs((local.y - n.f.d / 2) - (-bed.f.d / 2));
        const s = band(sideGap, -0.01, 0.08, 0.3) * band(headOff, 0, 0.1, 0.4);
        (sides.get(bed.f.id) ?? sides.set(bed.f.id, []).get(bed.f.id)!).push(Math.sign(local.x));
        out.push(v([n.f.id, bed.f.id], s, s >= 0.6 ? `${n.f.name} sits at the head of ${lc(bed.f.name)}, in reach from the pillow.` : `${n.f.name} is ${cm(Math.max(sideGap, headOff))} away from the head of the bed.`));
      }
      for (const [bedId, ss] of sides) if (ss.length >= 2 && new Set(ss).size === 1) out.push(v([bedId], 0.3, 'Both nightstands are on the same side of the bed.'));
      return out;
    },
  }),

  // ---- desks
  rule({
    id: 'desk-pullout', name: 'Desk chair pull-out', severity: 'strong', source: '75-90 cm behind the desk edge',
    evaluate: (L, v) => of(L, 'desk', 'reception-desk').map((a) => {
      const own = new Set(seatsOfHost(L, a).map((s) => s.f.id));
      const free = sideFree(L, a, 'front', 0.2, 0.8, own);
      return v([a.f.id], band(free, 0.9, 9, 0.3), free >= 0.75 ? `${cm(Math.min(free, 3))} behind ${lc(a.f.name)} to pull the chair out (75-90 cm wanted).` : `Only ${cm(free)} behind ${lc(a.f.name)}; a chair needs 75-90 cm to pull out.`, free >= 0.75);
    }),
  }),
  rule({
    id: 'desk-glare', name: 'Daylight from the side', severity: 'preference', source: 'Screen glare',
    evaluate: (L, v) => of(L, 'desk').flatMap((a) => {
      const nw = nearestWindow(L.room, { x: a.f.x, y: a.f.y });
      if (!nw || nw.d > 4.5) return [];
      const view = mulv(a.front, -1), toW = normv(sub(nw.w.c, { x: a.f.x, y: a.f.y })), c = dot(view, toW);
      if (c < -0.5) return [v([a.f.id], 0.3, `The window is behind whoever sits at ${lc(a.f.name)}: it reflects in the screen.`)];
      if (c > 0.6) return [v([a.f.id], 0.8, `${a.f.name} faces the window: good light, some glare on bright days.`)];
      return [v([a.f.id], 1, `Daylight falls on ${lc(a.f.name)} from the side, no screen glare.`)];
    }),
  }),
  rule({
    id: 'desk-door', name: 'Back not to the door', severity: 'preference', source: 'Seated with a view of the entrance',
    evaluate: (L, v) => {
      const door = L.room.doors[0];
      if (!door) return [];
      return of(L, 'desk').map((a) => {
        const seat = toPlanOf(a.f, 0, a.f.d / 2 + 0.45);
        const view = mulv(a.front, -1), c = dot(view, normv(sub(door.c, seat)));
        return c < -0.6 ? v([a.f.id, door.id], 0.4, `Whoever sits at ${lc(a.f.name)} has their back to the door.`)
          : v([a.f.id, door.id], c > 0.3 ? 1 : 0.85, c > 0.3 ? `${a.f.name} looks towards the door.` : `The door is to the side of ${lc(a.f.name)}, in peripheral view.`);
      });
    },
  }),
  rule({
    id: 'desk-daylight', name: 'Desk near daylight', severity: 'preference', source: 'Task light',
    evaluate: (L, v) => {
      if (!L.room.windows.length) return [];
      return of(L, 'desk').map((a) => {
        const d = Math.min(...L.room.windows.map((w) => polyDist(a.poly, [w.a, w.b, addv(w.b, mulv(w.inward, 0.01)), addv(w.a, mulv(w.inward, 0.01))])));
        return v([a.f.id], band(d, 0, 1.5, 2.5), d <= 1.5 ? `${a.f.name} is ${cm(d)} from the window.` : `${a.f.name} is ${mm(d)} from the nearest window.`);
      });
    },
  }),

  // ---- seats at tables and desks
  rule({
    id: 'seats-face', name: 'Seats face their table', severity: 'strong', source: 'Chair belongs to a surface',
    evaluate: (L, v) => L.items.filter((a) => L.hostOf.has(a.f.id)).map((s) => {
      const h = L.byId.get(L.hostOf.get(s.f.id)!)!;
      const c = dot(s.front, normv(sub({ x: h.f.x, y: h.f.y }, { x: s.f.x, y: s.f.y })));
      const gap = polyDist(s.poly, h.poly);
      const sc = band(c, 0.9, 1, 0.6) * band(gap, 0, 0.15, 0.4);
      return v([s.f.id, h.f.id], sc, sc >= 0.6 ? `${s.f.name} is drawn up to ${lc(h.f.name)}.` : `${s.f.name} is ${cm(gap)} from ${lc(h.f.name)} and turned ${Math.round(Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI)}° away.`);
    }),
  }),
  rule({
    id: 'seats-even', name: 'Seats evenly spaced', severity: 'preference', source: 'Symmetry around a table',
    evaluate: (L, v) => L.items.filter((a) => isHostCategory(a.f.category)).flatMap((h) => {
      const seats = seatsOfHost(L, h);
      if (seats.length < 2) return [];
      // Balanced when the seat centroid sits on the table centre.
      const cx = seats.reduce((t, s) => t + s.f.x, 0) / seats.length - h.f.x, cy = seats.reduce((t, s) => t + s.f.y, 0) / seats.length - h.f.y;
      const off = Math.hypot(cx, cy), span = Math.max(h.f.w, h.f.d) / 2 + 0.4;
      const sc = h.f.category === 'desk' ? 1 - Math.min(1, off / span) * 0.3 : 1 - Math.min(1, off / span);
      return [v([h.f.id, ...ids(seats)], sc, sc >= 0.6 ? `The ${seats.length} seats at ${lc(h.f.name)} are balanced around it.` : `The seats at ${lc(h.f.name)} bunch up on one side.`)];
    }),
  }),
  rule({
    id: 'dining-pullout', name: 'Room to pull chairs out', severity: 'strong', source: '75-90 cm behind table edges',
    evaluate: (L, v) => L.items.filter((a) => /table|counter/.test(a.f.category) && !/coffee|side/.test(a.f.category)).flatMap((h) => {
      const seats = seatsOfHost(L, h);
      if (!seats.length) return [];
      let worst = 9;
      for (const s of seats) {
        const back = mulv(s.front, -1);
        const free = rayFree(L, toPlanOf(s.f, 0, -s.f.d / 2 - 0.002), back, null) + s.f.d + Math.max(0, polyDist(s.poly, h.poly));
        worst = Math.min(worst, free);
      }
      return [v([h.f.id, ...ids(seats)], band(worst, 0.9, 9, 0.3), worst >= 0.75 ? `Every chair at ${lc(h.f.name)} has at least ${cm(Math.min(worst, 3))} from the table edge to pull out.` : `A chair at ${lc(h.f.name)} has only ${cm(worst)} from the table edge; 75-90 cm is comfortable.`, worst >= 0.75)];
    }),
  }),
  rule({
    id: 'table-centred', name: 'Table centred in its zone', severity: 'preference', source: 'Even circulation round a table',
    evaluate: (L, v) => {
      const tables = of(L, 'table', 'kitchen-island');
      if (tables.length !== 1) return [];
      const t = tables[0], own = new Set([t.f.id, ...seatsOfHost(L, t).map((s) => s.f.id)]);
      const o = { x: t.f.x, y: t.f.y };
      const free = [t.front, mulv(t.front, -1), t.right, mulv(t.right, -1)].map((d) => rayFree(L, o, d, own));
      const bal = (Math.min(free[0], free[1]) / Math.max(free[0], free[1]) + Math.min(free[2], free[3]) / Math.max(free[2], free[3])) / 2;
      return [v([t.f.id], bal, bal >= 0.6 ? `${t.f.name} sits centred in its space.` : `${t.f.name} is pushed to one side of its space.`)];
    },
  }),
  rule({
    id: 'aligned', name: 'Repeated pieces line up', severity: 'preference', source: 'Order through alignment',
    evaluate: (L, v) => {
      const groups = new Map<string, AItem[]>();
      for (const a of L.items) if (['table', 'cafe-table', 'desk'].includes(a.f.category)) (groups.get(a.f.catalogId) ?? groups.set(a.f.catalogId, []).get(a.f.catalogId)!).push(a);
      const out: RuleVerdict[] = [];
      for (const g of groups.values()) {
        if (g.length < 2) continue;
        let ok = 0;
        for (const a of g) if (g.some((b) => b !== a && (Math.abs(a.f.x - b.f.x) < 0.05 || Math.abs(a.f.y - b.f.y) < 0.05))) ok++;
        out.push(v(ids(g), ok / g.length, ok === g.length ? `The ${g.length} ${lc(g[0].f.name)}s line up in rows.` : `${g.length - ok} of the ${g.length} ${lc(g[0].f.name)}s are out of line.`));
      }
      return out;
    },
  }),

  // ---- lounge
  rule({
    id: 'sofa-focal', name: 'Sofa faces the focal point', severity: 'strong', source: 'Seating faces what you look at',
    evaluate: (L, v) => {
      const focal = focalOf(L), ct = of(L, 'coffee-table')[0];
      return of(L, 'sofa', 'sofa-bed').map((a) => {
        const target = focal?.kind === 'item' ? { x: focal.a.f.x, y: focal.a.f.y } : ct ? { x: ct.f.x, y: ct.f.y } : focal?.kind === 'window' ? focal.p : L.room.centre;
        const what = focal?.kind === 'item' ? lc(focal.a.f.name) : ct ? 'the coffee table' : focal?.kind === 'window' ? 'the window' : 'the room';
        const c = dot(a.front, normv(sub(target, { x: a.f.x, y: a.f.y })));
        return v([a.f.id], band(c, 0.92, 1, 0.8), c >= 0.92 ? `${a.f.name} faces ${what}.` : `${a.f.name} is turned ${Math.round(Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI)}° away from ${what}.`);
      });
    },
  }),
  rule({
    id: 'tv-distance', name: 'TV viewing distance', severity: 'strong', source: '1.5-2.5 x screen diagonal',
    evaluate: (L, v) => {
      const tv = of(L, 'tv-unit')[0];
      if (!tv) return [];
      const diag = Math.max(0.8, Math.min(1.9, tv.f.w * 0.9));
      return of(L, 'sofa', 'sofa-bed').map((a) => {
        const eye = toPlanOf(a.f, 0, -a.f.d / 2 + 0.35);
        const screen = toPlanOf(tv.f, 0, -tv.f.d / 2 + 0.05);
        const d = distp(eye, screen), lo = 1.5 * diag, hi = 2.5 * diag;
        const facing = dot(tv.front, normv(sub(eye, screen)));
        const sc = band(d, lo, hi, 0.8) * band(facing, 0.9, 1, 0.7);
        return v([a.f.id, tv.f.id], sc, d >= lo && d <= hi ? `${mm(d)} from the sofa to a ${Math.round(diag / 0.0254)}" screen: inside the ${mm(lo)}-${mm(hi)} range.` : `${mm(d)} from the sofa to the screen; a ${Math.round(diag / 0.0254)}" screen is best seen from ${mm(lo)}-${mm(hi)}.`);
      });
    },
  }),
  rule({
    id: 'coffee-reach', name: 'Coffee table in reach', severity: 'strong', source: '35-50 cm from the sofa front',
    evaluate: (L, v) => {
      const sofas = of(L, 'sofa', 'sofa-bed');
      return of(L, 'coffee-table').flatMap((ct) => {
        if (!sofas.length) return [];
        const s = sofas.reduce((p, q) => (polyDist(q.poly, ct.poly) < polyDist(p.poly, ct.poly) ? q : p));
        const rel = sub({ x: ct.f.x, y: ct.f.y }, { x: s.f.x, y: s.f.y });
        const along = dot(rel, s.front), lat = Math.abs(dot(rel, s.right));
        const ctHalf = Math.abs(dot(s.front, frontOf(ct.f.rotation))) > 0.7 ? ct.f.d / 2 : ct.f.w / 2;
        const gap = along - s.f.d / 2 - ctHalf;
        const sc = band(gap, 0.35, 0.5, 0.3) * band(lat, 0, 0.15, 0.6);
        return [v([ct.f.id, s.f.id], sc, gap >= 0.35 && gap <= 0.5 && lat <= 0.15 ? `${ct.f.name} is ${cm(gap)} from the sofa, centred: in reach without bumping knees.` : `${ct.f.name} is ${cm(gap)} from the sofa${lat > 0.15 ? ` and ${cm(lat)} off centre` : ''}; 35-50 cm is right.`)];
      });
    },
  }),
  rule({
    id: 'conversation', name: 'Conversation distance', severity: 'preference', source: '1.8-3.0 m between seats',
    evaluate: (L, v) => {
      const seats = L.items.filter((a) => isSoftSeat(a.f.category));
      if (seats.length < 2) return [];
      const out: RuleVerdict[] = [];
      for (let i = 0; i < seats.length; i++) for (let j = i + 1; j < seats.length; j++) {
        const a = seats[i], b = seats[j], d = distp({ x: a.f.x, y: a.f.y }, { x: b.f.x, y: b.f.y });
        const facing = (dot(a.front, normv(sub({ x: b.f.x, y: b.f.y }, { x: a.f.x, y: a.f.y }))) + dot(b.front, normv(sub({ x: a.f.x, y: a.f.y }, { x: b.f.x, y: b.f.y })))) / 2;
        const sc = band(d, 1.8, 3.0, 0.6, 1.2) * (0.5 + 0.5 * band(facing, 0.2, 1, 0.8));
        out.push(v([a.f.id, b.f.id], sc, d >= 1.8 && d <= 3 ? `${a.f.name} and ${lc(b.f.name)} are ${mm(d)} apart and turned to each other: easy conversation.` : `${a.f.name} and ${lc(b.f.name)} are ${mm(d)} apart; 1.8-3.0 m suits conversation.`));
      }
      return out;
    },
  }),
  rule({
    id: 'armchair-group', name: 'Armchair joins the group', severity: 'preference', source: 'Closed conversation circle',
    evaluate: (L, v) => {
      const centre = of(L, 'coffee-table')[0] ?? of(L, 'sofa', 'sofa-bed')[0];
      if (!centre) return [];
      return of(L, 'armchair').map((a) => {
        const c = dot(a.front, normv(sub({ x: centre.f.x, y: centre.f.y }, { x: a.f.x, y: a.f.y })));
        return v([a.f.id], band(c, 0.7, 1, 0.8), c >= 0.7 ? `${a.f.name} turns into the seating group.` : `${a.f.name} faces away from the seating group.`);
      });
    },
  }),
  rule({
    id: 'rug-anchor', name: 'Rug under the front legs', severity: 'preference', source: 'Rug ties the group together',
    evaluate: (L, v) => of(L, 'rug').map((r) => {
      const seats = L.items.filter((a) => isSoftSeat(a.f.category) && polyDist(a.poly, r.poly) < 0.6);
      const tables = L.items.filter((a) => (a.f.category === 'table' || a.f.category === 'cafe-table') && pointInPolygon({ x: a.f.x, y: a.f.y }, r.poly));
      if (tables.length) {
        const t = tables[0], seatsT = seatsOfHost(L, t);
        const okSeats = seatsT.filter((s) => s.poly.every((p) => pointInPolygon(p, r.poly))).length;
        const sc = seatsT.length ? okSeats / seatsT.length : 1;
        return v([r.f.id, t.f.id], sc, sc >= 0.99 ? `${r.f.name} is big enough that chairs stay on it when pulled out.` : `${seatsT.length - okSeats} chairs at ${lc(t.f.name)} hang off ${lc(r.f.name)}.`);
      }
      const ct = of(L, 'coffee-table').find((c) => c.poly.every((p) => pointInPolygon(p, r.poly)));
      if (!seats.length) return v([r.f.id], ct ? 0.7 : 0.4, ct ? `${r.f.name} sits under the coffee table.` : `${r.f.name} floats with no furniture on it.`);
      let ok = 0;
      for (const s of seats) {
        const fl = toPlanOf(s.f, -s.f.w / 2 + 0.08, s.f.d / 2 - 0.08), fr = toPlanOf(s.f, s.f.w / 2 - 0.08, s.f.d / 2 - 0.08);
        if (pointInPolygon(fl, r.poly) && pointInPolygon(fr, r.poly)) ok++;
      }
      const sc = (ok / seats.length) * 0.8 + (ct ? 0.2 : 0);
      return v([r.f.id, ...ids(seats)], sc, ok === seats.length ? `The front legs of ${seats.map((s) => lc(s.f.name)).join(' and ')} rest on ${lc(r.f.name)}, tying the group together.` : `${seats.length - ok} of the seats around ${lc(r.f.name)} do not reach it with their front legs.`);
    }),
  }),
  rule({
    id: 'rug-door', name: 'Rug clear of the door', severity: 'preference', source: 'Door catches on rug edges',
    evaluate: (L, v) => of(L, 'rug').flatMap((r) => L.room.swingZones.filter(({ z }) => overlapDepth(z, r.rect) > 0.01).map(({ id }) => v([r.f.id, id], 0.3, `${r.f.name} reaches into the door swing; the door will catch on it.`))),
  }),
  rule({
    id: 'lamp-seat', name: 'Lamp beside a seat', severity: 'preference', source: 'Reading light',
    evaluate: (L, v) => of(L, 'lamp').map((l) => {
      const near = L.items.filter((a) => (isSoftSeat(a.f.category) || a.f.category === 'desk' || isBed(a)) && polyDist(a.poly, l.poly) < 0.4);
      return near.length ? v([l.f.id, near[0].f.id], 1, `${l.f.name} stands beside ${lc(near[0].f.name)}.`) : v([l.f.id], 0.4, `${l.f.name} is not next to anything you sit at.`);
    }),
  }),

  // ---- storage
  rule({
    id: 'storage-access', name: 'Storage opens freely', severity: 'strong', source: 'Door and drawer swing',
    evaluate: (L, v) => L.items.filter((a) => a.sem.role === 'storage' && a.f.category !== 'nightstand').map((a) => {
      const need = Math.max(0.3, Math.min(a.sem.frontClearanceM, a.f.clearance.front || a.sem.frontClearanceM));
      const free = sideFree(L, a, 'front');
      return v([a.f.id], band(free, need, 9, need * 0.6), free >= need ? `${a.f.name} has ${cm(Math.min(free, 3))} in front to open.` : `${a.f.name} has ${cm(free)} in front; it needs ${cm(need)} to open.`, free + 1e-6 >= need * 0.9);
    }),
  }),
  rule({
    id: 'tall-walls', name: 'Tall pieces on solid walls', severity: 'preference', source: 'Keep daylight',
    evaluate: (L, v) => L.items.filter((a) => a.solid && a.f.h > 1.2 && a.sem.role === 'storage').map((a) => {
      const w = a.back && a.back.gap < 0.1 ? L.room.walls[a.back.wall] : null;
      if (!w) return v([a.f.id], 0.5, `${a.f.name} is tall and stands away from the walls.`);
      return w.windows.length ? v([a.f.id], 0.5, `${a.f.name} is tall and shares the window wall, cutting the light.`) : v([a.f.id], 1, `${a.f.name} stands on a windowless wall.`);
    }),
  }),
  rule({
    id: 'wardrobe-bed', name: 'Wardrobe near the bed', severity: 'preference', source: 'Short dressing route',
    evaluate: (L, v) => {
      const beds = L.items.filter(isBed);
      if (!beds.length) return [];
      return of(L, 'wardrobe', 'dresser').map((a) => {
        const d = Math.min(...beds.map((b) => polyDist(a.poly, b.poly)));
        return v([a.f.id], band(d, 0, 2.0, 2.0), d <= 2 ? `${a.f.name} is ${cm(d)} from the bed.` : `${a.f.name} is ${mm(d)} from the bed.`);
      });
    },
  }),

  // ---- composition
  rule({
    id: 'balance', name: 'Visual balance', severity: 'preference', source: 'Mass spread across the room',
    evaluate: (L, v) => {
      const s = solids(L);
      if (s.length < 2) return [];
      let m = 0, x = 0, y = 0;
      for (const a of s) { const k = a.f.w * a.f.d * (0.4 + a.f.h); m += k; x += a.f.x * k; y += a.f.y * k; }
      const off = distp({ x: x / m, y: y / m }, L.room.centre);
      const half = Math.hypot(L.room.box.maxX - L.room.box.minX, L.room.box.maxY - L.room.box.minY) / 2;
      const sc = 1 - Math.min(1, off / (half * 0.6));
      return [v([], sc, sc >= 0.6 ? `Furniture weight is spread evenly; its centre is ${cm(off)} from the middle of the room.` : `The heavy pieces crowd one side; their centre is ${mm(off)} from the middle of the room.`)];
    },
  }),
  rule({
    id: 'focal-point', name: 'Clear focal point', severity: 'preference', source: 'A room needs one thing to look at',
    evaluate: (L, v) => {
      const bed = L.items.find(isBed), tv = of(L, 'tv-unit')[0], counter = of(L, 'counter', 'reception-desk')[0];
      const f = tv ?? bed ?? counter;
      const door = L.room.doors[0];
      if (!f) return L.room.windows.length ? [v([], 0.8, 'The window is the focal point.')] : [v([], 0.5, 'Nothing anchors the room as a focal point.')];
      if (!door) return [v([f.f.id], 1, `${f.f.name} anchors the room.`)];
      // Visible from the door: no tall piece between the doorway and the focal piece.
      const p = doorPoint(door), q = { x: f.f.x, y: f.f.y }, d = normv(sub(q, p)), D = distp(p, q);
      const ig = new Set([f.f.id, ...L.items.filter((a) => a.f.h <= 1.2).map((a) => a.f.id)]);
      const blocked = rayFree(L, p, d, ig, D) < D - 0.05;
      return [v([f.f.id], blocked ? 0.5 : 1, blocked ? `${f.f.name} is hidden from the doorway by a tall piece.` : `${f.f.name} anchors the room and is the first thing you see from the door.`)];
    },
  }),
  rule({
    id: 'zones', name: 'Zones stay apart', severity: 'strong', source: 'Sleep, work, lounge and dining do not interleave',
    evaluate: (L, v) => {
      const kinds: ZoneKind[] = ['sleep', 'work', 'lounge', 'dining', 'service'];
      const box = new Map<ZoneKind, { x0: number; y0: number; x1: number; y1: number; ids: string[] }>();
      for (const a of L.items) {
        if (!a.solid || !kinds.includes(a.zone) || a.f.category === 'nightstand') continue;
        const xs = a.poly.map((p) => p.x), ys = a.poly.map((p) => p.y);
        const b = box.get(a.zone) ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, ids: [] };
        b.x0 = Math.min(b.x0, ...xs); b.y0 = Math.min(b.y0, ...ys); b.x1 = Math.max(b.x1, ...xs); b.y1 = Math.max(b.y1, ...ys); b.ids.push(a.f.id);
        box.set(a.zone, b);
      }
      const zs = [...box.entries()];
      if (zs.length < 2) return [];
      const out: RuleVerdict[] = [];
      for (let i = 0; i < zs.length; i++) for (let j = i + 1; j < zs.length; j++) {
        const [ka, a] = zs[i], [kb, b] = zs[j];
        const ox = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), oy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
        const area = (r: typeof a) => Math.max(0.01, (r.x1 - r.x0) * (r.y1 - r.y0));
        const ov = (ox * oy) / Math.min(area(a), area(b));
        out.push(v([...a.ids, ...b.ids], 1 - Math.min(1, ov * 1.5), ov < 0.1 ? `The ${ka} and ${kb} areas are separate.` : `The ${ka} and ${kb} areas interleave (${Math.round(ov * 100)}% overlap).`));
      }
      return out;
    },
  }),
  rule({
    id: 'parallel', name: 'Square to the walls', severity: 'strong', source: 'Furniture follows the architecture',
    evaluate: (L, v) => {
      const bad = solids(L).filter((a) => {
        const best = Math.min(...L.room.walls.map((w) => { let d = Math.abs(((a.f.rotation - w.rot) % (Math.PI / 2) + Math.PI / 2) % (Math.PI / 2)); return Math.min(d, Math.PI / 2 - d); }));
        return best > 0.035;
      });
      return [bad.length ? v(ids(bad), 1 - bad.length / Math.max(1, solids(L).length), `${bad.map(nameOf).join(', ')} sit${bad.length === 1 ? 's' : ''} at an angle to the walls.`) : v([], 1, 'Everything is square to the walls.')];
    },
  }),
  rule({
    id: 'wall-backed', name: 'Backs to the wall', severity: 'strong', source: 'Wall-backed pieces',
    evaluate: (L, v) => L.items.filter((a) => a.solid && a.sem.wallBacked && !isBed(a) && a.f.category !== 'nightstand').map((a) => {
      const g = a.back?.gap ?? 9;
      const sofa = a.f.category === 'sofa' || a.f.category === 'sofa-bed';
      if (g <= 0.05) return v([a.f.id], 1, `${a.f.name} stands against the wall.`);
      if (sofa) {
        const behind = sideFree(L, a, 'back');
        return v([a.f.id], behind >= 0.8 ? 0.8 : 0.35, behind >= 0.8 ? `${a.f.name} floats with a ${cm(Math.min(behind, 3))} walkway behind it.` : `${a.f.name} floats ${cm(behind)} off the wall: too little to walk behind, too much to look intended.`);
      }
      return v([a.f.id], band(g, 0, 0.05, 0.4), `${a.f.name} stands ${cm(Math.min(g, 9))} off the wall.`);
    }),
  }),
  rule({
    id: 'dead-gaps', name: 'No awkward gaps', severity: 'preference', source: '10-45 cm slivers are wasted floor',
    evaluate: (L, v) => {
      const out: RuleVerdict[] = [];
      for (const a of L.items) {
        if (!a.solid || !a.back || a.back.gap > 0.05 || L.hostOf.has(a.f.id) || a.f.w < 0.6) continue;
        const ig = new Set([a.f.id, ...of(L, 'nightstand', 'lamp', 'plant').map((n) => n.f.id)]);
        const lft = sideFree(L, a, 'left', 0.05, 0.4, ig), rgt = sideFree(L, a, 'right', 0.05, 0.4, ig);
        const bad = [lft, rgt].filter((g) => g > 0.08 && g < 0.45);
        if (bad.length) out.push(v([a.f.id], 0.4, `${a.f.name} leaves a ${cm(bad[0])} sliver beside it: push it into the corner or leave a usable gap.`));
      }
      return out.length ? out : [v([], 1, 'No wasted slivers between furniture and walls.')];
    },
  }),
  rule({
    id: 'services', name: 'Radiators and sockets', severity: 'preference', source: 'Not measured',
    evaluate: (_L, v) => [v([], 1, 'Radiators and sockets are not in the measurements, so they were not considered.')],
  }),
];

export const RULE_COUNT = RULES.length;

export interface EvalOptions { fast?: boolean; cache?: Map<FurnitureItem, AItem> }

/** Verdicts for an analysed layout (used by the solver to avoid rebuilding the room). */
export function evaluateCtx(L: LayoutCtx, opts: EvalOptions = {}): RuleVerdict[] {
  const out: RuleVerdict[] = [];
  for (const r of RULES) if (!(opts.fast && r.costly)) out.push(...r.evaluate(L));
  return out;
}

/** Every rule against the furniture. `req` adds the person's route targets and widths. */
export function evaluateRules(model: SpaceModel, furniture: FurnitureItem[], req?: Requirements | null, opts: EvalOptions = {}): RuleVerdict[] {
  if (!model.spaces.length || model.spaces[0].polygon.length < 3) return [];
  const room = buildRoom(model);
  return evaluateCtx(analyse(room, furniture, req, opts.cache), opts);
}
