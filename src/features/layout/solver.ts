import type { FurnitureItem, Infeasibility, LayoutCandidate, Requirements, Space, SpaceModel, ValidationResult, Vec2 } from '../../core/types';
import {
  add, area, bounds, convexOverlap, dist, distPointSegment, doorSwingPolygon, itemCorners, mul, openingSegment,
  pointInPolygon, polygonInside, uid, wallInwardNormal, wallSegment, fmtSek,
} from '../../core/geometry';
import { CATALOG, catalogEntry, makeItem } from '../furniture/catalog';
import { validateLayout } from '../referee/validate';

export interface SolveOptions { variants?: number; seed?: number; timeBudgetMs?: number; onProgress?: (p: number) => void }

const WALL_TOL = 0.02;
const WALL_BACKED = new Set(['bed', 'sofa', 'sofa-bed', 'storage', 'wardrobe', 'shelf', 'desk', 'dresser', 'bookcase', 'tv']);
const SLEEP = new Set(['bed', 'sofa-bed']);
const WORK = new Set(['desk']);
const OPTIONAL = new Set(['rug', 'plant', 'lamp', 'decor', 'side-table', 'armchair', 'shelf']);

// ---------- deterministic RNG ----------
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const tick = () => new Promise<void>((r) => setTimeout(r));

// ---------- geometry helpers ----------
function shrink(poly: Vec2[], by: number): Vec2[] {
  const c = poly.reduce((a, p) => ({ x: a.x + p.x / poly.length, y: a.y + p.y / poly.length }), { x: 0, y: 0 });
  return poly.map((p) => { const dx = p.x - c.x, dy = p.y - c.y, l = Math.hypot(dx, dy) || 1; return { x: p.x - (dx / l) * by, y: p.y - (dy / l) * by }; });
}
function rectZone(a: Vec2, b: Vec2, n: Vec2, depth: number): Vec2[] { return [a, b, add(b, mul(n, depth)), add(a, mul(n, depth))]; }

interface Ctx {
  model: SpaceModel; space: Space; req: Requirements;
  doorZones: Vec2[][]; windowZones: Vec2[][]; windowCentres: Vec2[];
}

function makeCtx(model: SpaceModel, req: Requirements): Ctx {
  const space = model.spaces[0];
  const doorZones: Vec2[][] = [], windowZones: Vec2[][] = [], windowCentres: Vec2[] = [];
  for (const o of model.openings.filter((o) => o.spaceId === space.id)) {
    const seg = openingSegment(space, o);
    if (o.kind === 'door' || o.kind === 'opening') {
      const sw = doorSwingPolygon(space, o); if (sw) doorZones.push(sw);
      doorZones.push(rectZone(seg.a, seg.b, seg.inward, 0.9));
    } else if (o.kind === 'window') {
      windowZones.push(rectZone(seg.a, seg.b, seg.inward, 0.4));
      windowCentres.push(seg.c);
    }
  }
  return { model, space, req, doorZones, windowZones, windowCentres };
}

const isRug = (f: FurnitureItem) => f.category === 'rug';

/** Hard-constraint violations as a list of human readable strings (empty = feasible). */
export function hardViolations(ctx: Ctx, items: FurnitureItem[]): string[] {
  const out: string[] = [];
  const poly = ctx.space.polygon;
  for (let i = 0; i < items.length; i++) {
    const f = items[i];
    const fp = itemCorners(f);
    if (!polygonInside(shrink(fp, WALL_TOL), poly)) out.push(`${f.name} is outside the room`);
    if (!isRug(f)) {
      const env = itemCorners(f, true);
      if (!polygonInside(shrink(env, WALL_TOL), poly)) out.push(`${f.name} has no room for its use space`);
      if (f.unfoldedD && !polygonInside(shrink(itemCorners(f, false, f.unfoldedD), WALL_TOL), poly)) out.push(`${f.name} cannot unfold`);
      for (const z of ctx.doorZones) if (convexOverlap(fp, z) > 0.01) out.push(`${f.name} blocks a door`);
      if (f.h > 1.0) for (const z of ctx.windowZones) if (convexOverlap(fp, z) > 0.01) out.push(`${f.name} blocks a window`);
      for (let j = 0; j < items.length; j++) {
        if (i === j || isRug(items[j])) continue;
        const g = itemCorners(items[j]);
        if (j > i && convexOverlap(fp, g) > 0.005) out.push(`${f.name} overlaps ${items[j].name}`);
        if (convexOverlap(env, g) > 0.01) out.push(`${items[j].name} is in the use space of ${f.name}`);
      }
    }
  }
  return out;
}

function penalty(ctx: Ctx, items: FurnitureItem[]): number {
  let p = 0;
  const poly = ctx.space.polygon;
  const outside = (pts: Vec2[]) => pts.reduce((s, q) => s + (pointInPolygon(q, poly) ? 0 : 0.2 + distOut(q, poly)), 0) + (polygonInside(shrink(pts, WALL_TOL), poly) ? 0 : 0.1);
  for (let i = 0; i < items.length; i++) {
    const f = items[i], fp = itemCorners(f);
    p += outside(fp) * 4;
    if (isRug(f)) continue;
    p += outside(itemCorners(f, true)) * 2;
    if (f.unfoldedD) p += outside(itemCorners(f, false, f.unfoldedD)) * 2;
    for (const z of ctx.doorZones) p += convexOverlap(fp, z) * 3;
    if (f.h > 1.0) for (const z of ctx.windowZones) p += convexOverlap(fp, z) * 2;
    const env = itemCorners(f, true);
    for (let j = 0; j < items.length; j++) {
      if (i === j || isRug(items[j])) continue;
      const g = itemCorners(items[j]);
      if (j > i) p += convexOverlap(fp, g) * 5 + (convexOverlap(fp, g) > 0 ? 0.1 : 0);
      const e = convexOverlap(env, g); p += e * 2 + (e > 0 ? 0.05 : 0);
    }
  }
  return p;
}
function distOut(q: Vec2, poly: Vec2[]) { let m = Infinity; for (let i = 0; i < poly.length; i++) m = Math.min(m, distPointSegment(q, poly[i], poly[(i + 1) % poly.length])); return m; }

/** Distance from the item's back edge to the nearest wall (0 when backed). */
function backGap(space: Space, f: FurnitureItem): number {
  const c = itemCorners(f); // c[0], c[1] are the back corners
  return (distOut(c[0], space.polygon) + distOut(c[1], space.polygon)) / 2;
}

export interface Weights { open: number; window: number; zones: number; cost: number; wall: number }
const VARIANTS: Array<{ name: string; w: Weights }> = [
  { name: 'Open floor', w: { open: 3, window: 0.3, zones: 0.3, cost: 0, wall: 1.5 } },
  { name: 'Work by the window', w: { open: 1, window: 3, zones: 0.3, cost: 0, wall: 1.2 } },
  { name: 'Separate zones', w: { open: 1, window: 0.5, zones: 3, cost: 0, wall: 1.2 } },
  { name: 'Lowest cost', w: { open: 1, window: 0.5, zones: 0.5, cost: 2, wall: 1.2 } },
];

function softScore(ctx: Ctx, items: FurnitureItem[], w: Weights): number {
  let s = 0;
  for (const f of items) {
    if (WALL_BACKED.has(f.category)) s -= w.wall * Math.min(backGap(ctx.space, f), 1.5);
    else if (!isRug(f)) s -= 0.2 * Math.min(backGap(ctx.space, f), 1.5);
    if (WORK.has(f.category) && ctx.windowCentres.length) s -= w.window * Math.min(...ctx.windowCentres.map((c) => dist(c, f))) * 0.5;
  }
  const sleep = items.filter((f) => SLEEP.has(f.category)), work = items.filter((f) => WORK.has(f.category));
  if (sleep.length && work.length) s += w.zones * Math.min(dist(sleep[0], work[0]), 4) * 0.4;
  // open floor proxy: spread of the item centroid from the room centre (items pushed to edges)
  const b = bounds(ctx.space.polygon), cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  for (const f of items) if (!isRug(f)) s += w.open * 0.15 * Math.hypot(f.x - cx, f.y - cy);
  return s;
}

// ---------- proposals ----------
function wallSnap(ctx: Ctx, f: FurnitureItem, r: () => number): void {
  const sp = ctx.space, i = Math.floor(r() * sp.polygon.length);
  const [a, b] = wallSegment(sp, i), L = dist(a, b);
  if (L < f.w) return;
  const n = wallInwardNormal(sp, i);
  const t = f.w / 2 + r() * (L - f.w), dir = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
  const backOff = (f.clearance?.back ?? 0) + f.d / 2 + 0.005;
  const p = add(add(a, mul(dir, t)), mul(n, backOff));
  f.x = p.x; f.y = p.y; f.rotation = Math.atan2(-n.x, n.y); // front (+y local) faces inward normal
}
function randomPlace(ctx: Ctx, f: FurnitureItem, r: () => number) {
  const b = bounds(ctx.space.polygon);
  f.x = b.minX + r() * (b.maxX - b.minX); f.y = b.minY + r() * (b.maxY - b.minY);
  f.rotation = Math.floor(r() * 4) * (Math.PI / 2);
}

// ---------- metrics ----------
const CELL = 0.05;
interface Grid { ox: number; oy: number; cols: number; rows: number; blocked: Uint8Array; inside: Uint8Array }
function rasterize(ctx: Ctx, items: FurnitureItem[], inflate: number): Grid {
  const b = bounds(ctx.space.polygon);
  const cols = Math.ceil((b.maxX - b.minX) / CELL), rows = Math.ceil((b.maxY - b.minY) / CELL);
  const blocked = new Uint8Array(cols * rows), inside = new Uint8Array(cols * rows);
  const polys = items.filter((f) => !isRug(f)).map((f) => itemCorners(f));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const p = { x: b.minX + (c + 0.5) * CELL, y: b.minY + (r + 0.5) * CELL };
    const k = r * cols + c;
    if (!pointInPolygon(p, ctx.space.polygon)) { blocked[k] = 1; continue; }
    inside[k] = 1;
    if (inflate > 0 && distOut(p, ctx.space.polygon) < inflate) blocked[k] = 1;
    for (const q of polys) if (pointInPolygon(p, q) || (inflate > 0 && distToPoly(p, q) < inflate)) { blocked[k] = 1; break; }
  }
  return { ox: b.minX, oy: b.minY, cols, rows, blocked, inside };
}
function distToPoly(p: Vec2, q: Vec2[]) { let m = Infinity; for (let i = 0; i < q.length; i++) m = Math.min(m, distPointSegment(p, q[i], q[(i + 1) % q.length])); return m; }

/** Largest free axis-aligned rectangle on the occupancy grid (histogram method). */
function largestFreeRect(g: Grid): number {
  const h = new Array(g.cols).fill(0); let best = 0;
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) h[c] = g.blocked[r * g.cols + c] ? 0 : h[c] + 1;
    const st: number[] = [];
    for (let c = 0; c <= g.cols; c++) {
      const hc = c === g.cols ? 0 : h[c];
      while (st.length && h[st[st.length - 1]] >= hc) { const top = st.pop()!; const left = st.length ? st[st.length - 1] + 1 : 0; best = Math.max(best, h[top] * (c - left)); }
      st.push(c);
    }
  }
  return best * CELL * CELL;
}

function cellOf(g: Grid, p: Vec2) { return { c: Math.min(g.cols - 1, Math.max(0, Math.floor((p.x - g.ox) / CELL))), r: Math.min(g.rows - 1, Math.max(0, Math.floor((p.y - g.oy) / CELL))) }; }
function nearestFree(g: Grid, p: Vec2, maxR = 24): number | null {
  const { c, r } = cellOf(g, p);
  for (let rad = 0; rad <= maxR; rad++) for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
    const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= g.rows || cc >= g.cols) continue;
    if (!g.blocked[rr * g.cols + cc]) return rr * g.cols + cc;
  }
  return null;
}
function bfs(g: Grid, s: number, t: number): number | null {
  const d = new Int32Array(g.cols * g.rows).fill(-1); d[s] = 0; const q = [s];
  for (let qi = 0; qi < q.length; qi++) {
    const k = q[qi]; if (k === t) return d[k] * CELL;
    const r = Math.floor(k / g.cols), c = k % g.cols;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= g.rows || cc >= g.cols) continue;
      const n = rr * g.cols + cc; if (g.blocked[n] || d[n] >= 0) continue; d[n] = d[k] + 1; q.push(n);
    }
  }
  return null;
}

/** Route from each door to every target, keeping half the route width from obstacles. Returns total length or null if blocked. */
export function routeCheck(ctx: Ctx, items: FurnitureItem[], width: number): { ok: boolean; lengthM: number | null } {
  const sp = ctx.space;
  const doors = ctx.model.openings.filter((o) => o.spaceId === sp.id && o.kind === 'door');
  const targets = ctx.req.routeTargets.flatMap((t) => ctx.model.openings.filter((o) => o.spaceId === sp.id && o.kind === t.kind && (!t.id || o.id === t.id)));
  if (!doors.length || !targets.length) return { ok: true, lengthM: null };
  const g = rasterize(ctx, items, width / 2 - 0.001);
  let total = 0;
  for (const d of doors) {
    const ds = openingSegment(sp, d), s = nearestFree(g, add(ds.c, mul(ds.inward, width / 2 + 0.05)));
    for (const t of targets) {
      if (t.id === d.id) continue;
      const ts = openingSegment(sp, t), e = nearestFree(g, add(ts.c, mul(ts.inward, width / 2 + 0.05)));
      if (s == null || e == null) return { ok: false, lengthM: null };
      const L = bfs(g, s, e); if (L == null) return { ok: false, lengthM: null };
      total += L;
    }
  }
  return { ok: true, lengthM: total };
}

function minClearance(ctx: Ctx, items: FurnitureItem[]): number | null {
  const solid = items.filter((f) => !isRug(f)); if (solid.length < 2) return null;
  let m = Infinity;
  for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
    const a = itemCorners(solid[i]), b = itemCorners(solid[j]);
    for (const p of a) m = Math.min(m, distToPoly(p, b));
    for (const p of b) m = Math.min(m, distToPoly(p, a));
  }
  return Math.round(m * 100) / 100;
}

// ---------- items ----------
interface Built { items: FurnitureItem[]; fixed: Set<string>; optional: Set<string>; assumptions: string[] }
function buildItems(model: SpaceModel, req: Requirements, cheap: boolean): Built {
  const items: FurnitureItem[] = [], fixed = new Set<string>(), optional = new Set<string>(), assumptions: string[] = [];
  const locked = new Set(req.lockedIds);
  for (const ri of req.items) {
    for (let k = 0; k < Math.max(1, ri.qty); k++) {
      const existing = k === 0 && ri.keepExistingId ? model.furniture.find((f) => f.id === ri.keepExistingId) : undefined;
      if (existing) {
        const f = { ...existing, clearance: { ...existing.clearance } };
        if (f.locked || locked.has(f.id)) fixed.add(f.id);
        items.push(f); continue;
      }
      let id = ri.catalogId;
      const base = catalogEntry(id);
      if (cheap && base) {
        const alt = CATALOG.filter((c) => c.category === base.category && c.w <= base.w + 0.01 && c.d <= base.d + 0.01).sort((a, b) => a.priceSek - b.priceSek)[0];
        if (alt && alt.id !== id) { assumptions.push(`${base.name} swapped for cheaper ${alt.name}`); id = alt.id; }
      }
      if (!base) assumptions.push(`Unknown catalog item ${id}, used a default`);
      const f = makeItem(id); items.push(f);
      if (OPTIONAL.has(f.category)) optional.add(f.id);
    }
  }
  for (const f of model.furniture) if ((f.locked || locked.has(f.id)) && !items.some((i) => i.id === f.id)) { items.push({ ...f }); fixed.add(f.id); }
  return { items, fixed, optional, assumptions };
}
const costOf = (items: FurnitureItem[]) => items.reduce((s, f) => s + (f.owned ? 0 : f.priceSek), 0);

// ---------- annealing ----------
async function anneal(ctx: Ctx, start: FurnitureItem[], fixed: Set<string>, w: Weights, seed: number, ms: number): Promise<FurnitureItem[] | null> {
  const r = rng(seed);
  const free = start.map((f, i) => (fixed.has(f.id) ? -1 : i)).filter((i) => i >= 0);
  let cur = start.map((f) => ({ ...f }));
  if (!free.length) return hardViolations(ctx, cur).length ? null : cur;
  // greedy init: largest first, best of several wall snaps
  const order = [...free].sort((a, b) => cur[b].w * cur[b].d - cur[a].w * cur[a].d);
  for (const i of order) {
    let best = { x: 0, y: 0, rotation: 0 }, bv = Infinity;
    for (let t = 0; t < 40; t++) {
      if (r() < 0.75) wallSnap(ctx, cur[i], r); else randomPlace(ctx, cur[i], r);
      const v = penalty(ctx, cur);
      if (v < bv) { bv = v; best = { x: cur[i].x, y: cur[i].y, rotation: cur[i].rotation }; }
    }
    Object.assign(cur[i], best);
  }
  const energy = (s: FurnitureItem[]) => penalty(ctx, s) * 50 - softScore(ctx, s, w);
  let e = energy(cur), best = cur.map((f) => ({ ...f })), be = e;
  const t0 = performance.now(); let lastYield = t0; let T = 2;
  for (let it = 0; ; it++) {
    const now = performance.now();
    if (now - t0 > ms) break;
    if (now - lastYield > 30) { await tick(); lastYield = performance.now(); }
    T = 2 * Math.pow(0.002, (now - t0) / ms);
    const nxt = cur.map((f) => ({ ...f }));
    const i = free[Math.floor(r() * free.length)], f = nxt[i], m = r();
    if (m < 0.35) wallSnap(ctx, f, r);
    else if (m < 0.75) { const s = 0.05 + T * 0.3; f.x += (r() - 0.5) * s; f.y += (r() - 0.5) * s; }
    else if (m < 0.88) f.rotation += (r() < 0.5 ? 1 : -1) * Math.PI / 2;
    else if (free.length > 1) { const j = free[Math.floor(r() * free.length)]; const g = nxt[j]; [f.x, g.x] = [g.x, f.x]; [f.y, g.y] = [g.y, f.y]; [f.rotation, g.rotation] = [g.rotation, f.rotation]; }
    else randomPlace(ctx, f, r);
    const ne = energy(nxt);
    if (ne < e || r() < Math.exp((e - ne) / T)) { cur = nxt; e = ne; if (e < be) { be = e; best = cur.map((x) => ({ ...x })); } }
  }
  return hardViolations(ctx, best).length ? null : best;
}

function meanDisplacement(a: FurnitureItem[], b: FurnitureItem[]): number {
  if (a.length !== b.length) return Infinity;
  let s = 0; for (let i = 0; i < a.length; i++) s += dist(a[i], b[i]); return s / a.length;
}

function finalize(ctx: Ctx, items: FurnitureItem[], name: string, seed: number, assumptions: string[]): LayoutCandidate | null {
  const route = routeCheck(ctx, items, ctx.req.minRouteWidthM);
  if (!route.ok) return null;
  const openAreaM2 = Math.round(largestFreeRect(rasterize(ctx, items, 0)) * 10) / 10;
  const costSek = costOf(items);
  if (ctx.req.budgetSek != null && costSek > ctx.req.budgetSek) return null;
  const checks = validateLayout(ctx.model, items, ctx.req);
  if (checks.some((c) => c.result === 'fail')) return null;
  const own: ValidationResult[] = checks.length ? checks : ownChecks(ctx, items, route);
  return {
    id: uid('cand'), name, summary: '', parentVersion: ctx.model.version, furniture: items,
    metrics: { openAreaM2, costSek, minClearanceM: minClearance(ctx, items), routeLenM: route.lengthM == null ? null : Math.round(route.lengthM * 10) / 10, score: 0 },
    checks: own, assumptions: [...assumptions, 'Walls treated as straight, 2 cm placement tolerance', `Route width ${ctx.req.minRouteWidthM.toFixed(2)} m`],
    generator: `annealing v1 seed ${seed}`,
  };
}
function ownChecks(ctx: Ctx, items: FurnitureItem[], route: { ok: boolean; lengthM: number | null }): ValidationResult[] {
  const v = hardViolations(ctx, items);
  return [
    { id: uid('chk'), rule: 'Inside room, no overlaps', result: v.length ? 'fail' : 'pass', subjectIds: items.map((i) => i.id), details: v[0] ?? 'All items fit' },
    { id: uid('chk'), rule: 'Clear route', result: route.ok ? 'pass' : 'fail', threshold: ctx.req.minRouteWidthM, measured: route.lengthM ?? undefined, subjectIds: [], details: route.ok ? 'Doors reach targets' : 'Route blocked' },
  ];
}

function summarize(cands: LayoutCandidate[]) {
  for (const c of cands) {
    const others = cands.filter((o) => o !== c);
    c.metrics.score = Math.round((c.metrics.openAreaM2 * 10 - c.metrics.costSek / 1000) * 10) / 10;
    if (!others.length) { c.summary = `${c.metrics.openAreaM2.toFixed(1)} m² open floor, ${fmtSek(c.metrics.costSek)}`; continue; }
    const avgOpen = others.reduce((s, o) => s + o.metrics.openAreaM2, 0) / others.length;
    const minCost = Math.min(...others.map((o) => o.metrics.costSek));
    const dOpen = c.metrics.openAreaM2 - avgOpen;
    if (c.metrics.costSek < minCost) c.summary = `${fmtSek(minCost - c.metrics.costSek)} cheaper than the others`;
    else if (Math.abs(dOpen) >= 0.1) c.summary = `${Math.abs(dOpen).toFixed(1)} m² ${dOpen > 0 ? 'more' : 'less'} open floor than the others`;
    else c.summary = `${c.metrics.openAreaM2.toFixed(1)} m² open floor, ${fmtSek(c.metrics.costSek)}`;
  }
}

export async function generateLayouts(model: SpaceModel, req: Requirements, opts: SolveOptions = {}): Promise<{ candidates: LayoutCandidate[]; infeasibility: Infeasibility | null }> {
  if (!model.spaces.length) return { candidates: [], infeasibility: { reasons: ['No room outline yet'], relaxations: [] } };
  const ctx = makeCtx(model, req);
  const n = Math.min(opts.variants ?? 4, VARIANTS.length), seed0 = opts.seed ?? 1;
  const per = (opts.timeBudgetMs ?? 2400) / n;
  const out: LayoutCandidate[] = [];
  for (let v = 0; v < n; v++) {
    const vr = VARIANTS[v], cheap = vr.w.cost > 0;
    const built = buildItems(model, req, cheap);
    let items = built.items;
    if (cheap && req.budgetSek != null && costOf(items) > req.budgetSek) {
      items = items.filter((f) => !built.optional.has(f.id));
      built.assumptions.push('Dropped optional items to meet budget');
    }
    let cand: LayoutCandidate | null = null;
    for (let attempt = 0; attempt < 3 && !cand; attempt++) {
      const seed = seed0 * 1009 + v * 97 + attempt * 13;
      const res = await anneal(ctx, items, built.fixed, vr.w, seed, per / 2);
      if (res) {
        const c = finalize(ctx, res, vr.name, seed, built.assumptions);
        if (c && !out.some((o) => meanDisplacement(o.furniture, c.furniture) < 0.4)) cand = c;
      }
    }
    if (cand) out.push(cand);
    opts.onProgress?.((v + 1) / n);
  }
  summarize(out);
  return { candidates: out, infeasibility: out.length ? null : explainInfeasible(model, req) };
}

// ---------- infeasibility ----------
export function explainInfeasible(model: SpaceModel, req: Requirements): Infeasibility {
  const reasons: string[] = []; const relaxations: Infeasibility['relaxations'] = [];
  const sp = model.spaces[0]; const b = bounds(sp.polygon);
  const W = b.maxX - b.minX, H = b.maxY - b.minY, short = Math.min(W, H), long = Math.max(W, H);
  const built = buildItems(model, req, false).items.filter((f) => !isRug(f));
  const route = req.minRouteWidthM;
  const sorted = [...built].sort((a, b2) => b2.w * b2.d - a.w * a.d);
  for (const f of sorted.slice(0, 3)) {
    const minDim = Math.min(f.w, f.d), maxDim = Math.max(f.w, f.d);
    if (maxDim > long + 1e-6 || minDim > short + 1e-6) reasons.push(`${f.name} ${maxDim.toFixed(2)} x ${minDim.toFixed(2)} m does not fit a ${long.toFixed(2)} x ${short.toFixed(2)} m room`);
    else if (minDim + route > short) reasons.push(`${f.name} ${minDim.toFixed(2)} m + ${route.toFixed(2)} m route needs ${(minDim + route).toFixed(2)} m, room is ${short.toFixed(2)} m wide`);
  }
  const roomA = area(sp.polygon);
  const doorA = makeCtx(model, req).doorZones.reduce((s, z) => s + area(z), 0) / 2;
  const need = built.reduce((s, f) => s + area(itemCorners(f, true)), 0);
  if (need > roomA - doorA) reasons.push(`Items with use space need ${need.toFixed(1)} m², free floor is ${(roomA - doorA).toFixed(1)} m²`);
  const cheapest = req.items.reduce((s, ri) => {
    const e = catalogEntry(ri.catalogId); if (!e || ri.keepExistingId) return s;
    const min = Math.min(...CATALOG.filter((c) => c.category === e.category).map((c) => c.priceSek));
    return s + min * Math.max(1, ri.qty);
  }, 0);
  if (req.budgetSek != null && cheapest > req.budgetSek) {
    reasons.push(`Cheapest matching items cost ${fmtSek(cheapest)}, budget is ${fmtSek(req.budgetSek)}`);
    relaxations.push({ label: `Raise budget by ${fmtSek(cheapest - req.budgetSek)}`, patch: { budgetSek: Math.ceil(cheapest) } });
  }
  if (!reasons.length) reasons.push(`No layout found in time for ${built.length} items in ${roomA.toFixed(1)} m²`);
  const big = sorted[0];
  if (big) {
    const e = catalogEntry(big.catalogId);
    const smaller = e && CATALOG.filter((c) => c.category === e.category && c.w * c.d < e.w * e.d - 1e-6).sort((a, c) => c.w * c.d - a.w * a.d)[0];
    if (smaller) relaxations.push({ label: `Use ${smaller.name} instead of ${e!.name}`, patch: { items: req.items.map((ri) => (ri.catalogId === e!.id ? { ...ri, catalogId: smaller.id } : ri)) } });
  }
  if (req.items.length > 1) {
    const prio = (id: string) => { const c = catalogEntry(id)?.category ?? ''; return OPTIONAL.has(c) ? 0 : SLEEP.has(c) ? 3 : 1; };
    const drop = [...req.items].sort((a, c) => prio(a.catalogId) - prio(c.catalogId) || (catalogEntry(a.catalogId)?.w ?? 0) - (catalogEntry(c.catalogId)?.w ?? 0))[0];
    relaxations.push({ label: `Drop ${catalogEntry(drop.catalogId)?.name ?? drop.catalogId}`, patch: { items: req.items.filter((ri) => ri !== drop) } });
  }
  if (route > 0.8) relaxations.push({ label: 'Narrow route to 0.80 m', patch: { minRouteWidthM: 0.8 } });
  return { reasons, relaxations };
}

// ---------- genome ----------
export interface Genome { zones: Record<string, Vec2>; walls: Record<string, number | null>; focal: string | null }
export function genomeOf(c: LayoutCandidate, model?: SpaceModel): Genome {
  const zones: Record<string, Vec2> = {}, walls: Record<string, number | null> = {};
  const groups: Record<string, FurnitureItem[]> = {};
  for (const f of c.furniture) { const z = SLEEP.has(f.category) ? 'sleep' : WORK.has(f.category) || f.category === 'chair' ? 'work' : 'living'; (groups[z] ??= []).push(f); }
  for (const [z, fs] of Object.entries(groups)) zones[z] = { x: fs.reduce((s, f) => s + f.x, 0) / fs.length, y: fs.reduce((s, f) => s + f.y, 0) / fs.length };
  const sp = model?.spaces[0];
  for (const f of c.furniture) {
    if (!WALL_BACKED.has(f.category)) continue;
    if (!sp) { walls[f.id] = null; continue; }
    const back = itemCorners(f).slice(0, 2), mid = { x: (back[0].x + back[1].x) / 2, y: (back[0].y + back[1].y) / 2 };
    let bi: number | null = null, bd = 0.15;
    for (let i = 0; i < sp.polygon.length; i++) { const [a, b] = wallSegment(sp, i); const d = distPointSegment(mid, a, b); if (d < bd) { bd = d; bi = i; } }
    walls[f.id] = bi;
  }
  const solid = c.furniture.filter((f) => !isRug(f));
  const focal = solid.length ? solid.reduce((m, f) => (f.w * f.d > m.w * m.d ? f : m)).id : null;
  return { zones, walls, focal };
}

/** Take the larger half of items (by area) from A and the rest from B, pin them where valid, re-solve the others. */
export async function crossover(a: LayoutCandidate, b: LayoutCandidate, model: SpaceModel, req: Requirements, seed = 7): Promise<LayoutCandidate | null> {
  const ctx = makeCtx(model, req);
  const byCat = (list: FurnitureItem[]) => { const m = new Map<string, FurnitureItem[]>(); for (const f of list) { const k = f.catalogId; m.set(k, [...(m.get(k) ?? []), f]); } return m; };
  const mb = byCat(b.furniture);
  const sorted = [...a.furniture].sort((x, y) => y.w * y.d - x.w * x.d);
  const items: FurnitureItem[] = []; const fixed = new Set<string>();
  sorted.forEach((f, i) => {
    const fromB = i % 2 === 1 ? mb.get(f.catalogId)?.shift() : undefined;
    const src = fromB ?? f;
    const g = { ...f, x: src.x, y: src.y, rotation: src.rotation };
    items.push(g);
    if (!hardViolations(ctx, [...items.filter((x) => fixed.has(x.id)), g]).length) fixed.add(g.id);
  });
  for (const f of items) if (f.locked || req.lockedIds.includes(f.id)) fixed.add(f.id);
  const res = await anneal(ctx, items, fixed, VARIANTS[0].w, seed, 600)
    ?? await anneal(ctx, items, new Set([...fixed].filter((id) => items.find((i) => i.id === id)?.locked)), VARIANTS[0].w, seed + 1, 600);
  if (!res) return null;
  const c = finalize(ctx, res, `${a.name} + ${b.name}`, seed, ['Combined from two pinned layouts']);
  if (c) c.summary = `${c.metrics.openAreaM2.toFixed(1)} m² open floor, ${fmtSek(c.metrics.costSek)}`;
  return c;
}
