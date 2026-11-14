import type { FurnitureItem, Infeasibility, LayoutCandidate, Requirements, Space, SpaceModel, ValidationResult, Vec2 } from '../../core/types';
import {
  add, area, bounds, convexOverlap, dist, distPointSegment, doorSwingPolygon, itemCorners, mul, openingSegment,
  pointInPolygon, polygonInside, uid, wallInwardNormal, wallSegment, fmtSek,
} from '../../core/geometry';
import { CATALOG, catalogEntry, makeItem } from '../furniture/catalog';
import { validateLayout } from '../referee/validate';

export interface SolveOptions { variants?: number; seed?: number; timeBudgetMs?: number; onProgress?: (p: number, bestOpenM2?: number) => void }

const WALL_TOL = 0.01;
const WALL_BACKED = new Set(['bed', 'sofa', 'sofa-bed', 'storage', 'wardrobe', 'shelf', 'desk', 'dresser', 'bookcase', 'bookshelf', 'tv']);
const SEATS = new Set(['chair', 'desk-chair', 'office-chair', 'stool', 'bench']);
const isSeat = (f: FurnitureItem) => SEATS.has(f.category);
const isHost = (f: FurnitureItem) => /desk|table|counter/.test(f.category) && !/coffee|side/.test(f.category);
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
  routeCache: Map<number, RouteBase[]>;
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
  return { model, space, req, doorZones, windowZones, windowCentres, routeCache: new Map() };
}

const isRug = (f: FurnitureItem) => f.category === 'rug';

type Side = keyof FurnitureItem['clearance'];
const SIDES: Side[] = ['front', 'back', 'left', 'right'];

/** Rectangle given in the item's local frame (front faces +y), in plan coordinates. */
function localPoly(f: Pick<FurnitureItem, 'x' | 'y' | 'rotation'>, x0: number, x1: number, y0: number, y1: number): Vec2[] {
  const c = Math.cos(f.rotation), s = Math.sin(f.rotation);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([lx, ly]) => ({ x: f.x + lx * c - ly * s, y: f.y + lx * s + ly * c }));
}
/** Clearance strip on one side of an item. */
function sideRect(f: FurnitureItem, side: Side): Vec2[] {
  const hw = f.w / 2, hd = f.d / 2, n = f.clearance[side];
  if (side === 'front') return localPoly(f, -hw, hw, hd, hd + n);
  if (side === 'back') return localPoly(f, -hw, hw, -hd - n, -hd);
  if (side === 'left') return localPoly(f, -hw - n, -hw, -hd, hd);
  return localPoly(f, hw, hw + n, -hd, hd);
}

/** Each seat belongs to the nearest desk or table (centre to centre), the same pairing the referee uses. */
function seatHosts(items: FurnitureItem[]): Int32Array {
  const host = new Int32Array(items.length).fill(-1);
  const hosts = items.map((f, i) => (isHost(f) ? i : -1)).filter((i) => i >= 0);
  if (!hosts.length) return host;
  items.forEach((f, i) => {
    if (!isSeat(f)) return;
    let bd = Infinity;
    for (const h of hosts) { const d = dist(f, items[h]); if (d < bd) { bd = d; host[i] = h; } }
  });
  return host;
}

interface Rel {
  fp: Vec2[];
  /** Full use envelope, tested against other footprints. Null for rugs. */
  env: Vec2[] | null;
  /** Envelope tested against the walls: a seat's side that faces into its desk is knee space under the desk. */
  wallEnv: Vec2[] | null;
  host: number;
}
function relations(items: FurnitureItem[]): Rel[] {
  const host = seatHosts(items);
  return items.map((f, i) => {
    const fp = itemCorners(f);
    if (isRug(f)) return { fp, env: null, wallEnv: null, host: -1 };
    const env = itemCorners(f, true);
    let wallEnv = env;
    if (host[i] >= 0) {
      const hfp = itemCorners(items[host[i]]);
      const cl = { ...f.clearance };
      let cut = false;
      for (const sd of SIDES) if (cl[sd] > 0 && convexOverlap(sideRect(f, sd), hfp) > 0.01) { cl[sd] = 0; cut = true; }
      if (cut) wallEnv = itemCorners({ ...f, clearance: cl }, true);
    }
    return { fp, env, wallEnv, host: host[i] };
  });
}
/** A seat may sit in its host's use zone, and the seat's own use zone may reach over the host. */
const paired = (rel: Rel[], i: number, j: number) => rel[i].host === j || rel[j].host === i;

/** Hard-constraint violations as a list of human readable strings (empty = feasible). */
export function hardViolations(ctx: Ctx, items: FurnitureItem[]): string[] {
  const out: string[] = [];
  const poly = ctx.space.polygon;
  const rel = relations(items);
  for (let i = 0; i < items.length; i++) {
    const f = items[i], { fp, env, wallEnv } = rel[i];
    if (!polygonInside(shrink(fp, WALL_TOL), poly)) out.push(`${f.name} is outside the room`);
    if (!env || !wallEnv) continue;
    if (!polygonInside(shrink(wallEnv, WALL_TOL), poly)) out.push(`${f.name} has no room for its use space`);
    if (f.unfoldedD && !polygonInside(shrink(itemCorners(f, false, f.unfoldedD), WALL_TOL), poly)) out.push(`${f.name} cannot unfold`);
    for (const z of ctx.doorZones) if (convexOverlap(fp, z) > 0.01) out.push(`${f.name} blocks a door`);
    if (f.h > 1.0) for (const z of ctx.windowZones) if (convexOverlap(fp, z) > 0.01) out.push(`${f.name} blocks a window`);
    for (let j = 0; j < items.length; j++) {
      if (i === j || isRug(items[j])) continue;
      const g = rel[j].fp;
      if (j > i && convexOverlap(fp, g) > 0.005) out.push(`${f.name} overlaps ${items[j].name}`);
      if (!paired(rel, i, j) && convexOverlap(env, g) > 0.01) out.push(`${items[j].name} is in the use space of ${f.name}`);
    }
  }
  return out;
}

function penalty(ctx: Ctx, items: FurnitureItem[]): number {
  let p = 0;
  const poly = ctx.space.polygon;
  const rel = relations(items);
  const outside = (pts: Vec2[]) => pts.reduce((s, q) => s + (pointInPolygon(q, poly) ? 0 : 0.2 + distOut(q, poly)), 0) + (polygonInside(shrink(pts, WALL_TOL), poly) ? 0 : 0.1);
  for (let i = 0; i < items.length; i++) {
    const f = items[i], { fp, env, wallEnv } = rel[i];
    p += outside(fp) * 4;
    if (!env || !wallEnv) continue;
    p += outside(wallEnv) * 2;
    if (f.unfoldedD) p += outside(itemCorners(f, false, f.unfoldedD)) * 2;
    for (const z of ctx.doorZones) p += convexOverlap(fp, z) * 3;
    if (f.h > 1.0) for (const z of ctx.windowZones) p += convexOverlap(fp, z) * 2;
    for (let j = 0; j < items.length; j++) {
      if (i === j || isRug(items[j])) continue;
      const g = rel[j].fp;
      if (j > i) { const o = convexOverlap(fp, g); p += o * 5 + (o > 0 ? 0.1 : 0); }
      if (!paired(rel, i, j)) { const e = convexOverlap(env, g); p += e * 2 + (e > 0 ? 0.05 : 0); }
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

interface RouteBase { cols: number; rows: number; ox: number; oy: number; s: number; g: number; blocked: Uint8Array }
/**
 * Static part of each door-to-target route grid: cells outside the room or closer than half the
 * route width to a wall. Near both ends the wall is the destination, so only furniture narrows it.
 * Endpoints and cells match the referee's route check, so both agree on what counts as clear.
 */
function routeBases(ctx: Ctx, width: number): RouteBase[] {
  const hit = ctx.routeCache.get(width);
  if (hit) return hit;
  const sp = ctx.space, poly = sp.polygon, rad = width / 2 - 1e-9;
  const doors = ctx.model.openings.filter((o) => o.spaceId === sp.id && o.kind === 'door');
  const targets = ctx.req.routeTargets.flatMap((t) => ctx.model.openings.filter((o) => o.spaceId === sp.id && o.kind === t.kind && (!t.id || o.id === t.id)));
  const b = bounds(poly);
  const cols = Math.max(1, Math.ceil((b.maxX - b.minX) / CELL)), rows = Math.max(1, Math.ceil((b.maxY - b.minY) / CELL));
  const cellAt = (p: Vec2) => Math.min(rows - 1, Math.max(0, Math.floor((p.y - b.minY) / CELL))) * cols + Math.min(cols - 1, Math.max(0, Math.floor((p.x - b.minX) / CELL)));
  const out: RouteBase[] = [];
  for (const d of doors) {
    const ds = openingSegment(sp, d), start = add(ds.c, mul(ds.inward, 0.4));
    for (const t of targets) {
      if (t.id === d.id) continue;
      const ts = openingSegment(sp, t), goal = add(ts.c, mul(ts.inward, 0.5));
      const blocked = new Uint8Array(cols * rows);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const p = { x: b.minX + (c + 0.5) * CELL, y: b.minY + (r + 0.5) * CELL };
        const k = r * cols + c;
        if (!pointInPolygon(p, poly)) { blocked[k] = 2; continue; }
        const nearEnd = dist(p, start) < 0.5 || dist(p, goal) < 0.5;
        if (!nearEnd && distOut(p, poly) < rad) blocked[k] = 1;
      }
      const s = cellAt(start), g = cellAt(goal);
      if (blocked[s] === 2 || blocked[g] === 2) continue; // the referee reports this as unknown, not blocked
      out.push({ cols, rows, ox: b.minX, oy: b.minY, s, g, blocked });
    }
  }
  ctx.routeCache.set(width, out);
  return out;
}

/** Route from each door to every target through a corridor at least `width` wide. Returns total length or not ok. */
export function routeCheck(ctx: Ctx, items: FurnitureItem[], width: number): { ok: boolean; lengthM: number | null } {
  const bases = routeBases(ctx, width);
  if (!bases.length) return { ok: true, lengthM: null };
  const rad = width / 2 - 1e-9;
  const polys = items.filter((f) => !isRug(f)).map((f) => itemCorners(f));
  let total = 0;
  for (const rb of bases) {
    const { cols, rows, ox, oy } = rb, blocked = rb.blocked.slice();
    for (const q of polys) {
      const bb = bounds(q);
      const c0 = Math.max(0, Math.floor((bb.minX - rad - ox) / CELL)), c1 = Math.min(cols - 1, Math.ceil((bb.maxX + rad - ox) / CELL));
      const r0 = Math.max(0, Math.floor((bb.minY - rad - oy) / CELL)), r1 = Math.min(rows - 1, Math.ceil((bb.maxY + rad - oy) / CELL));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const k = r * cols + c;
        if (blocked[k]) continue;
        const p = { x: ox + (c + 0.5) * CELL, y: oy + (r + 0.5) * CELL };
        if (pointInPolygon(p, q) || distToPoly(p, q) < rad) blocked[k] = 1;
      }
    }
    if (blocked[rb.s] || blocked[rb.g]) return { ok: false, lengthM: null };
    const steps = new Int32Array(cols * rows).fill(-1), queue = [rb.s];
    steps[rb.s] = 0;
    for (let h = 0; h < queue.length && steps[rb.g] < 0; h++) {
      const k = queue[h], r = Math.floor(k / cols), c = k % cols;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        const n = rr * cols + cc;
        if (blocked[n] || steps[n] >= 0) continue;
        steps[n] = steps[k] + 1; queue.push(n);
      }
    }
    if (steps[rb.g] < 0) return { ok: false, lengthM: null };
    total += steps[rb.g] * CELL;
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

// ---------- seats ----------
/** Spread movable seats over the desks and tables: seat k goes to host k mod H. Returns seat index -> host index. */
function assignSeats(items: FurnitureItem[], fixed: Set<string>): Map<number, number> {
  const hosts = items.map((f, i) => (isHost(f) ? i : -1)).filter((i) => i >= 0);
  const out = new Map<number, number>();
  if (!hosts.length) return out;
  let k = 0;
  items.forEach((f, i) => { if (isSeat(f) && !fixed.has(f.id)) out.set(i, hosts[k++ % hosts.length]); });
  return out;
}
const seatsOf = (attach: Map<number, number>, h: number) => [...attach].filter(([, hh]) => hh === h).map(([s]) => s);

/** Put a host's seats inside its use zone, facing it: front first, then back, left and right where there is room. */
function placeSeatsFor(items: FurnitureItem[], h: number, seats: number[]): void {
  if (!seats.length) return;
  const H = items[h];
  const sides = SIDES.filter((sd) => H.clearance[sd] >= 0.3);
  if (!sides.length) sides.push('front');
  const queue = [...seats], plan: Array<[Side, number[]]> = [];
  for (const sd of sides) {
    const span = sd === 'front' || sd === 'back' ? H.w : H.d, take: number[] = [];
    let used = 0;
    while (queue.length && used + items[queue[0]].w <= span + 1e-6) { used += items[queue[0]].w + 0.05; take.push(queue.shift()!); }
    if (take.length) plan.push([sd, take]);
  }
  if (queue.length) { if (plan.length) plan[0][1].push(...queue); else plan.push([sides[0], queue]); }
  const c = Math.cos(H.rotation), s = Math.sin(H.rotation);
  for (const [sd, list] of plan) {
    const span = sd === 'front' || sd === 'back' ? H.w : H.d;
    list.forEach((si, k) => {
      const seat = items[si];
      const u = ((k + 0.5) / list.length - 0.5) * span;
      const off = Math.max(0, Math.min(0.1, H.clearance[sd] - seat.d)) + seat.d / 2;
      let lx: number, ly: number, rot: number;
      if (sd === 'front') { lx = u; ly = H.d / 2 + off; rot = H.rotation + Math.PI; }
      else if (sd === 'back') { lx = u; ly = -H.d / 2 - off; rot = H.rotation; }
      else if (sd === 'left') { lx = -H.w / 2 - off; ly = u; rot = H.rotation - Math.PI / 2; }
      else { lx = H.w / 2 + off; ly = u; rot = H.rotation + Math.PI / 2; }
      seat.x = H.x + lx * c - ly * s; seat.y = H.y + lx * s + ly * c; seat.rotation = rot;
    });
  }
}
function placeSeats(items: FurnitureItem[], attach: Map<number, number>): void {
  for (const h of new Set(attach.values())) placeSeatsFor(items, h, seatsOf(attach, h));
}

// ---------- constructive seed ----------
type Pose = { x: number; y: number; rotation: number };
function candidatePoses(ctx: Ctx, f: FurnitureItem, onWall: boolean): Pose[] {
  const sp = ctx.space, out: Pose[] = [];
  if (onWall) {
    for (let i = 0; i < sp.polygon.length; i++) {
      const [a, b] = wallSegment(sp, i), L = dist(a, b);
      if (L < f.w + 0.01) continue;
      const n = wallInwardNormal(sp, i), dir = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
      const back = f.clearance.back + f.d / 2 + 0.005, lo = f.w / 2 + 0.005, hi = L - f.w / 2 - 0.005;
      for (let t = lo; t <= hi + 1e-9; t += 0.1) out.push(wallPose(a, dir, n, t, back));
      out.push(wallPose(a, dir, n, hi, back));
    }
  } else {
    const b = bounds(sp.polygon);
    for (let x = b.minX + 0.25; x < b.maxX; x += 0.2) for (let y = b.minY + 0.25; y < b.maxY; y += 0.2)
      for (let q = 0; q < 4; q++) out.push({ x, y, rotation: q * (Math.PI / 2) });
  }
  return out;
}
function wallPose(a: Vec2, dir: Vec2, n: Vec2, t: number, back: number): Pose {
  const p = add(add(a, mul(dir, t)), mul(n, back));
  return { x: p.x, y: p.y, rotation: Math.atan2(-n.x, n.y) };
}

/**
 * Greedy construction: wall-backed items first (largest first), each with its seats attached, then the
 * rest. Every step keeps the partial layout free of hard violations and the route open, so when the
 * room has space the annealer starts from a valid layout instead of searching for one.
 */
function greedySeed(ctx: Ctx, start: FurnitureItem[], fixed: Set<string>, attach: Map<number, number>, w: Weights, r: () => number): FurnitureItem[] | null {
  const cur = start.map((f) => ({ ...f }));
  const active = new Set<number>();
  cur.forEach((f, i) => { if (fixed.has(f.id)) active.add(i); });
  placeSeats(cur, attach);
  for (const [s, h] of attach) if (active.has(h)) active.add(s);
  const order = cur.map((_, i) => i).filter((i) => !active.has(i) && !attach.has(i))
    .sort((a, b) => Number(WALL_BACKED.has(cur[b].category)) - Number(WALL_BACKED.has(cur[a].category)) || cur[b].w * cur[b].d - cur[a].w * cur[a].d);
  for (const i of order) {
    const f = cur[i], group = [i, ...seatsOf(attach, i)];
    const listNow = () => [...active, ...group].map((k) => cur[k]);
    const scoreAll = (poses: Pose[]) => {
      const out: Array<{ pose: Pose; s: number }> = [];
      for (const pose of poses) {
        Object.assign(f, pose); placeSeatsFor(cur, i, group.slice(1));
        const list = listNow();
        if (penalty(ctx, list) > 0) continue;
        out.push({ pose, s: softScore(ctx, list, w) + r() * 0.6 });
      }
      return out;
    };
    const wb = WALL_BACKED.has(f.category);
    let scored = scoreAll(candidatePoses(ctx, f, wb));
    if (!scored.length && wb) scored = scoreAll(candidatePoses(ctx, f, false));
    scored.sort((a, b) => b.s - a.s);
    let ok = false;
    for (const c of scored.slice(0, 12)) {
      Object.assign(f, c.pose); placeSeatsFor(cur, i, group.slice(1));
      if (routeCheck(ctx, listNow(), ctx.req.minRouteWidthM).ok) { ok = true; break; }
    }
    if (!ok) return null;
    for (const k of group) active.add(k);
  }
  return cur;
}

// ---------- annealing ----------
/** Reward for differing from layouts already offered, saturating once a layout counts as distinct. */
const DIVERSITY = 6;
function novelty(s: FurnitureItem[], avoid: FurnitureItem[][]): number {
  if (!avoid.length) return 0;
  return Math.min(...avoid.map((o) => Math.min(meanDisplacement(s, o), 0.5)));
}

async function anneal(ctx: Ctx, start: FurnitureItem[], fixed: Set<string>, w: Weights, seed: number, ms: number, avoid: FurnitureItem[][] = []): Promise<FurnitureItem[] | null> {
  const r = rng(seed);
  let cur = start.map((f) => ({ ...f }));
  const attach = assignSeats(cur, fixed);
  placeSeats(cur, attach);
  const free = cur.map((f, i) => (fixed.has(f.id) || attach.has(i) ? -1 : i)).filter((i) => i >= 0);
  const evalState = (s: FurnitureItem[]) => {
    const p = penalty(ctx, s);
    const ok = p === 0 && routeCheck(ctx, s, ctx.req.minRouteWidthM).ok;
    return { e: p * 50 - softScore(ctx, s, w) - DIVERSITY * novelty(s, avoid) + (p === 0 && !ok ? 4 : 0), ok };
  };
  if (!free.length) return evalState(cur).ok && !hardViolations(ctx, cur).length ? cur : null;

  let seeded: FurnitureItem[] | null = null;
  for (let k = 0; k < 4 && !seeded; k++) seeded = greedySeed(ctx, cur, fixed, attach, w, r);
  if (seeded) cur = seeded;
  else {
    // No valid construction: start from the least-bad wall snaps and let annealing repair.
    const order = [...free].sort((a, b) => cur[b].w * cur[b].d - cur[a].w * cur[a].d);
    for (const i of order) {
      let best: Pose = { x: 0, y: 0, rotation: 0 }, bv = Infinity;
      for (let t = 0; t < 40; t++) {
        if (r() < 0.75) wallSnap(ctx, cur[i], r); else randomPlace(ctx, cur[i], r);
        placeSeats(cur, attach);
        const v = penalty(ctx, cur);
        if (v < bv) { bv = v; best = { x: cur[i].x, y: cur[i].y, rotation: cur[i].rotation }; }
      }
      Object.assign(cur[i], best);
    }
    placeSeats(cur, attach);
  }

  let { e, ok } = evalState(cur);
  let best = cur.map((f) => ({ ...f })), be = e;
  let bestValid = ok ? best : null, bve = ok ? e : Infinity;
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
    placeSeats(nxt, attach);
    const ns = evalState(nxt);
    if (ns.e < e || r() < Math.exp((e - ns.e) / T)) {
      cur = nxt; e = ns.e;
      if (e < be) { be = e; best = cur.map((x) => ({ ...x })); }
      if (ns.ok && e < bve) { bve = e; bestValid = cur.map((x) => ({ ...x })); }
    }
  }
  const pick = bestValid ?? best;
  return hardViolations(ctx, pick).length ? null : pick;
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
    checks: own, assumptions: [...assumptions, 'Walls treated as straight, 1 cm placement tolerance', 'Chairs sit at the desk or table they belong to', `Route width ${ctx.req.minRouteWidthM.toFixed(2)} m`],
    generator: `constructive + annealing v2 seed ${seed}`,
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
  const per = (opts.timeBudgetMs ?? 1800) / n;
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
      const res = await anneal(ctx, items, built.fixed, vr.w, seed, per / 3, out.map((o) => o.furniture));
      if (res) {
        const c = finalize(ctx, res, vr.name, seed, built.assumptions);
        if (c && !out.some((o) => meanDisplacement(o.furniture, c.furniture) < 0.4)) cand = c;
      }
    }
    if (cand) out.push(cand);
    opts.onProgress?.((v + 1) / n, out.length ? Math.max(...out.map((o) => o.metrics.openAreaM2)) : undefined);
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
  // A seat at a desk or table uses that host's use zone, so only its footprint adds to the need.
  const hosted = built.some(isHost);
  const need = built.reduce((s, f) => s + area(itemCorners(f, !(hosted && isSeat(f)))), 0);
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
