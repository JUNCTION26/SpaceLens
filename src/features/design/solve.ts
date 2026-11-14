// Hierarchical constructive solver. Anchors (bed, TV wall, desk, counter, tables) are tried in exact
// wall slots, corners and free regions; dependents follow from their relations (seats, nightstands,
// coffee table, rug, armchair); a beam keeps the best and most different partial layouts; a local
// pass then slides each group to raise the rule score. Every returned layout passes the referee.
import type { Clearance, DesignProgram, DesignReport, FurnitureItem, Infeasibility, LayoutCandidate, Relation, Requirements, RuleVerdict, SpaceModel, ValidationResult } from '../../core/types';
import { distPointRect, overlapDepth, pointInPolygon, rectOutside, type ORect, type P } from '../referee/geom';
import { validateLayout } from '../referee/validate';
import { uid } from '../../core/geometry';
import { catalogEntry, CATALOG } from '../furniture/catalog';
import {
  analyse, buildRoom, evaluateCtx, floorGrid, largestOpenRect, localRect, polyDist, rectOf, toPlanOf,
  type AItem, type LayoutCtx, type RoomCtx,
} from './rules';
import {
  besideOptions, facingOptions, flankOptions, inFrontOptions, isStructural, programScore, relationScore, rotationFacing, rugOptions,
  seatArrangements, structuralRank, type Pose,
} from './relations';
import { designScore, explainDetailed } from './score';
import { isHostCategory, isSeatCategory, semanticsOf } from './semantics';

export interface SolveProgramOptions {
  variants?: number;
  seed?: number;
  timeBudgetMs?: number;
  onProgress?: (p: number) => void;
  /** Route targets, route width and budget for the hard checks. */
  req?: Requirements | null;
  /** Items that keep their current pose (in addition to `locked` ones). */
  fixedIds?: string[];
  signal?: AbortSignal;
}
export interface SolveResult { candidates: LayoutCandidate[]; reports: DesignReport[]; infeasibility: Infeasibility | null }

const OPTIONAL = new Set(['rug', 'lamp', 'plant', 'side-table']);
const FLOAT_HOST = /^(table|cafe-table|kitchen-island)$/;
const M = 0.004; // safety margin inside the referee's 1 cm tolerance

const dot = (a: P, b: P) => a.x * b.x + a.y * b.y;
const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
const distp = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
function rng(seed: number) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

export function anchorPriority(f: FurnitureItem): number {
  switch (f.category) {
    case 'bed': case 'bunk-bed': return 100;
    case 'tv-unit': return 90;
    case 'counter': return 88;
    case 'reception-desk': return 87;
    case 'sofa': case 'sofa-bed': return 85;
    case 'desk': return 80;
    case 'table': case 'cafe-table': case 'kitchen-island': return 75;
    case 'crib': case 'treatment-bed': return 70;
    case 'wardrobe': return 60;
    case 'office-pod': return 55;
    case 'dresser': return 50;
    case 'bookshelf': return 45;
    case 'storage-cabinet': case 'filing-cabinet': case 'toy-storage': case 'sideboard': return 40;
    case 'armchair': return 30;
    case 'room-divider': return 25;
    case 'rug': return 15;
    case 'lamp': case 'plant': return 10;
    default: return 35;
  }
}

// ---------------------------------------------------------------- context
interface Ctx {
  room: RoomCtx; model: SpaceModel; program: DesignProgram; req: Requirements | null;
  byId: Map<string, FurnitureItem>;
  /** Clearance used by the hard checks (beds keep their side access even when nightstands flank them). */
  clr: Map<string, Clearance>;
  flank: Map<string, string>;
  parent: Map<string, { id: string; rel: Relation }>;
  children: Map<string, string[]>;
  cache: Map<FurnitureItem, AItem>;
  routes: RouteBase[];
  routeWidth: number;
  noise: () => number;
  rejects: Map<string, number>;
}

// ---------------------------------------------------------------- hard checks (mirror the referee)
interface Geo { r: ORect; sides: Array<{ side: 'front' | 'back' | 'left' | 'right'; need: number; r: ORect }>; unfold?: ORect }
const geoCache = new WeakMap<FurnitureItem, Geo>();
function geo(ctx: Ctx, f: FurnitureItem): Geo {
  const hit = geoCache.get(f);
  if (hit) return hit;
  const c = ctx.clr.get(f.id) ?? f.clearance, hw = f.w / 2, hd = f.d / 2;
  const g: Geo = {
    r: rectOf(f),
    sides: ([['front', c.front, localRect(f, -hw, hw, hd, hd + c.front)], ['back', c.back, localRect(f, -hw, hw, -hd - c.back, -hd)],
      ['left', c.left, localRect(f, -hw - c.left, -hw, -hd, hd)], ['right', c.right, localRect(f, hw, hw + c.right, -hd, hd)]] as const)
      .filter(([, need]) => need > 0.01).map(([side, need, r]) => ({ side, need, r })),
    unfold: f.unfoldedD && f.unfoldedD > f.d ? localRect(f, -hw, hw, -hd, hd + (f.unfoldedD - f.d)) : undefined,
  };
  geoCache.set(f, g);
  return g;
}
const isRug = (f: FurnitureItem) => f.category === 'rug';

function nearestHosts(items: FurnitureItem[]): Map<string, string> {
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

/** First hard problem when adding `cand` to `others`, or null. */
function fits(ctx: Ctx, others: FurnitureItem[], cand: FurnitureItem[]): string | null {
  const all = [...others, ...cand];
  const hostOf = nearestHosts(all);
  const byId = new Map(all.map((f) => [f.id, f]));
  const paired = (a: FurnitureItem, b: FurnitureItem) => hostOf.get(a.id) === b.id || hostOf.get(b.id) === a.id || ctx.flank.get(a.id) === b.id || ctx.flank.get(b.id) === a.id;
  const poly = ctx.room.poly;
  for (let k = 0; k < cand.length; k++) {
    const f = cand[k], g = geo(ctx, f);
    if (rectOutside(g.r, poly) > M) return 'wall';
    if (f.h > ctx.model.ceilingM) return 'ceiling';
    if (isRug(f)) continue;
    for (const { z } of ctx.room.swingZones) if (overlapDepth(z, g.r) > M) return 'door';
    for (const { z } of ctx.room.approachZones) if (overlapDepth(z, g.r) > M) return 'door';
    if (f.h > 1.0) for (const { z } of ctx.room.windowZones) if (overlapDepth(z, g.r) > M) return 'window';
    if (g.unfold && rectOutside(g.unfold, poly) > M) return 'unfold';
    const host = hostOf.has(f.id) ? byId.get(hostOf.get(f.id)!) : undefined;
    const hostR = host ? geo(ctx, host).r : null;
    for (const s of g.sides) {
      if (hostR && overlapDepth(s.r, hostR) > 0.01) continue;
      if (rectOutside(s.r, poly) > M) return 'use-wall';
    }
    // Pairs with everything already placed and the earlier candidates.
    const pool = k ? [...others, ...cand.slice(0, k)] : others;
    for (const o of pool) {
      if (isRug(o)) continue;
      const go = geo(ctx, o);
      if (Math.abs(go.r.cx - g.r.cx) + Math.abs(go.r.cy - g.r.cy) > 8) continue;
      if (overlapDepth(g.r, go.r) > M) return `overlap:${o.id}`;
      if (g.unfold && overlapDepth(g.unfold, go.r) > M) return `unfold:${o.id}`;
      if (go.unfold && overlapDepth(go.unfold, g.r) > M) return `unfold:${o.id}`;
      if (paired(f, o)) continue;
      for (const s of g.sides) if (overlapDepth(s.r, go.r) > M) return `use:${o.id}`;
      for (const s of go.sides) if (overlapDepth(s.r, g.r) > M) return `use:${o.id}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------- routes (same grid and endpoints as the referee)
interface RouteBase { cols: number; rows: number; ox: number; oy: number; s: number; g: number; blocked: Uint8Array; rad: number }
const CELL = 0.05;
function routeBases(room: RoomCtx, targets: Requirements['routeTargets'], width: number): RouteBase[] {
  const poly = room.poly, rad = width / 2 - 1e-9;
  const doors = room.openings.filter((o) => o.kind === 'door');
  const goals = targets.flatMap((t) => room.openings.filter((o) => o.kind === t.kind && (!t.id || o.id === t.id)));
  const b = room.box;
  const cols = Math.max(1, Math.ceil((b.maxX - b.minX) / CELL)), rows = Math.max(1, Math.ceil((b.maxY - b.minY) / CELL));
  const cellAt = (p: P) => Math.min(rows - 1, Math.max(0, Math.floor((p.y - b.minY) / CELL))) * cols + Math.min(cols - 1, Math.max(0, Math.floor((p.x - b.minX) / CELL)));
  const distOut = (p: P) => { let m = Infinity; for (let i = 0; i < poly.length; i++) { const a = poly[i], q = poly[(i + 1) % poly.length], ab = sub(q, a), l2 = dot(ab, ab), u = l2 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0; m = Math.min(m, Math.hypot(p.x - a.x - ab.x * u, p.y - a.y - ab.y * u)); } return m; };
  const out: RouteBase[] = [];
  for (const d of doors) {
    const start = { x: d.c.x + d.inward.x * 0.4, y: d.c.y + d.inward.y * 0.4 };
    for (const t of goals) {
      if (t.id === d.id) continue;
      const goal = { x: t.c.x + t.inward.x * 0.5, y: t.c.y + t.inward.y * 0.5 };
      const blocked = new Uint8Array(cols * rows);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const p = { x: b.minX + (c + 0.5) * CELL, y: b.minY + (r + 0.5) * CELL }, k = r * cols + c;
        if (!pointInPolygon(p, poly)) { blocked[k] = 2; continue; }
        const nearEnd = distp(p, start) < 0.5 || distp(p, goal) < 0.5;
        if (!nearEnd && distOut(p) < rad) blocked[k] = 1;
      }
      const s = cellAt(start), g = cellAt(goal);
      if (blocked[s] === 2 || blocked[g] === 2) continue;
      out.push({ cols, rows, ox: b.minX, oy: b.minY, s, g, blocked, rad });
    }
  }
  return out;
}
function routeCheck(bases: RouteBase[], items: FurnitureItem[]): { ok: boolean; lengthM: number | null } {
  if (!bases.length) return { ok: true, lengthM: null };
  const rects = items.filter((f) => !isRug(f)).map(rectOf);
  let total = 0;
  for (const rb of bases) {
    const { cols, rows, ox, oy, rad } = rb, blocked = rb.blocked.slice();
    for (const q of rects) {
      const ext = Math.abs(q.hw * Math.cos(q.rot)) + Math.abs(q.hd * Math.sin(q.rot)), eyt = Math.abs(q.hw * Math.sin(q.rot)) + Math.abs(q.hd * Math.cos(q.rot));
      const c0 = Math.max(0, Math.floor((q.cx - ext - rad - ox) / CELL)), c1 = Math.min(cols - 1, Math.ceil((q.cx + ext + rad - ox) / CELL));
      const r0 = Math.max(0, Math.floor((q.cy - eyt - rad - oy) / CELL)), r1 = Math.min(rows - 1, Math.ceil((q.cy + eyt + rad - oy) / CELL));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const k = r * cols + c;
        if (blocked[k]) continue;
        if (distPointRect({ x: ox + (c + 0.5) * CELL, y: oy + (r + 0.5) * CELL }, q) < rad) blocked[k] = 1;
      }
    }
    if (blocked[rb.s] || blocked[rb.g]) return { ok: false, lengthM: null };
    const steps = new Int32Array(cols * rows).fill(-1), queue = [rb.s];
    steps[rb.s] = 0;
    for (let h = 0; h < queue.length && steps[rb.g] < 0; h++) {
      const k = queue[h], r = Math.floor(k / cols), c = k % cols;
      const nb = [r > 0 ? k - cols : -1, r < rows - 1 ? k + cols : -1, c > 0 ? k - 1 : -1, c < cols - 1 ? k + 1 : -1];
      for (const n of nb) { if (n < 0 || blocked[n] || steps[n] >= 0) continue; steps[n] = steps[k] + 1; queue.push(n); }
    }
    if (steps[rb.g] < 0) return { ok: false, lengthM: null };
    total += steps[rb.g] * CELL;
  }
  return { ok: true, lengthM: total };
}

// ---------------------------------------------------------------- groups
type Spec =
  | { kind: 'fixed' }
  | { kind: 'wall'; wall: number; t: number }
  | { kind: 'free'; x: number; y: number; rot: number }
  | { kind: 'array'; x0: number; y0: number; x1: number; y1: number; rows: number; cols: number; rot: number; strategy: number };
interface Group { id: string; roots: string[]; members: string[]; priority: number; fixed: boolean; kind: 'wall' | 'array' | 'free' | 'fixed'; optional: boolean }
interface Placed { group: Group; spec: Spec; mirror: boolean; items: FurnitureItem[] }
interface State { placed: Placed[]; items: FurnitureItem[]; deferred: string[]; dropped: string[]; score: number }

function buildTree(ctx: Ctx, items: FurnitureItem[], fixed: Set<string>) {
  const cand = new Map<string, { id: string; rel: Relation; rank: number }>();
  for (const rel of ctx.program.relations) {
    if (!isStructural(rel, ctx.byId) || fixed.has(rel.subject)) continue;
    const rank = structuralRank(rel.kind);
    const prev = cand.get(rel.subject);
    if (!prev || rank < prev.rank) cand.set(rel.subject, { id: rel.target!, rel, rank });
  }
  // Break cycles: the higher-priority piece becomes the root.
  for (const id of [...cand.keys()]) {
    const seen = new Set<string>([id]);
    let cur = cand.get(id)?.id;
    while (cur && cand.has(cur)) {
      if (seen.has(cur)) {
        const loop = [...seen].filter((x) => cand.has(x));
        const top = loop.reduce((a, b) => (anchorPriority(ctx.byId.get(b)!) > anchorPriority(ctx.byId.get(a)!) ? b : a));
        cand.delete(top);
        break;
      }
      seen.add(cur); cur = cand.get(cur)?.id;
    }
  }
  for (const [id, p] of cand) {
    ctx.parent.set(id, { id: p.id, rel: p.rel });
    (ctx.children.get(p.id) ?? ctx.children.set(p.id, []).get(p.id)!).push(id);
    if (p.rel.kind === 'flanks') ctx.flank.set(id, p.id);
  }
  void items;
}

function membersOf(ctx: Ctx, root: string): string[] {
  const out: string[] = [root];
  for (let i = 0; i < out.length; i++) for (const c of ctx.children.get(out[i]) ?? []) out.push(c);
  return out;
}

function buildGroups(ctx: Ctx, items: FurnitureItem[], fixed: Set<string>): Group[] {
  const roots = items.filter((f) => !ctx.parent.has(f.id));
  const groups: Group[] = [];
  const arrays = new Map<string, FurnitureItem[]>();
  for (const f of roots) {
    if (fixed.has(f.id)) { groups.push({ id: f.id, roots: [f.id], members: membersOf(ctx, f.id), priority: 1000, fixed: true, kind: 'fixed', optional: false }); continue; }
    if (FLOAT_HOST.test(f.category)) { const k = `${f.catalogId}:${f.w}x${f.d}`; (arrays.get(k) ?? arrays.set(k, []).get(k)!).push(f); continue; }
    const sem = semanticsOf(f);
    groups.push({ id: f.id, roots: [f.id], members: membersOf(ctx, f.id), priority: anchorPriority(f), fixed: false, kind: sem.wallBacked ? 'wall' : 'free', optional: OPTIONAL.has(f.category) });
  }
  for (const list of arrays.values()) {
    const members = list.flatMap((f) => membersOf(ctx, f.id));
    groups.push({ id: list.map((f) => f.id).join('+'), roots: list.map((f) => f.id), members, priority: anchorPriority(list[0]) + (list.length > 1 ? 1 : 0), fixed: false, kind: 'array', optional: false });
  }
  // Counters before the tables they serve; otherwise by priority, then size.
  const size = (g: Group) => g.members.reduce((t, id) => { const f = ctx.byId.get(id)!; return t + f.w * f.d; }, 0);
  return groups.sort((a, b) => b.priority - a.priority || size(b) - size(a));
}

const withPose = (f: FurnitureItem, p: Pose): FurnitureItem => ({ ...f, x: p.x, y: p.y, rotation: p.rotation });

function wallPose(ctx: Ctx, f: FurnitureItem, wall: number, t: number): Pose {
  const w = ctx.room.walls[wall];
  const off = f.d / 2 + (f.clearance.back ?? 0) + 0.006;
  return { x: w.a.x + w.dir.x * t + w.n.x * off, y: w.a.y + w.dir.y * t + w.n.y * off, rotation: rotationFacing(w.n) };
}

/** Root poses for a spec (several for a table array). */
function rootPoses(ctx: Ctx, g: Group, spec: Spec): Pose[] | null {
  if (spec.kind === 'fixed') return g.roots.map((id) => { const f = ctx.byId.get(id)!; return { x: f.x, y: f.y, rotation: f.rotation }; });
  if (spec.kind === 'wall') return [wallPose(ctx, ctx.byId.get(g.roots[0])!, spec.wall, spec.t)];
  if (spec.kind === 'free') return [{ x: spec.x, y: spec.y, rotation: spec.rot }];
  const n = g.roots.length, out: Pose[] = [];
  const W = spec.x1 - spec.x0, H = spec.y1 - spec.y0;
  for (let i = 0; i < spec.rows; i++) {
    const inRow = Math.min(spec.cols, n - i * spec.cols);
    if (inRow <= 0) break;
    for (let j = 0; j < inRow; j++) {
      // A short last row is centred under the others.
      const x = spec.x0 + (inRow === spec.cols ? (j + 0.5) * W / spec.cols : W / 2 + (j - (inRow - 1) / 2) * W / spec.cols);
      out.push({ x, y: spec.y0 + (i + 0.5) * H / spec.rows, rotation: spec.rot });
    }
  }
  return out.length === n ? out : null;
}

/** Place a whole group for one root spec. Optional pieces that do not fit are deferred. */
function placeGroup(ctx: Ctx, others: FurnitureItem[], g: Group, spec: Spec, mirror: boolean, check = true): { items: FurnitureItem[]; deferred: string[] } | { fail: string } {
  const poses = rootPoses(ctx, g, spec);
  if (!poses) return { fail: 'shape' };
  const out: FurnitureItem[] = [];
  const placed = new Map<string, FurnitureItem>();
  const deferred: string[] = [];
  const ok = (cand: FurnitureItem[]) => !check || !fits(ctx, [...others, ...out], cand);
  const fail = (cand: FurnitureItem[]) => (check ? fits(ctx, [...others, ...out], cand) : null);
  for (let k = 0; k < g.roots.length; k++) {
    const f = withPose(ctx.byId.get(g.roots[k])!, poses[k]);
    const why = fail([f]);
    if (why) return { fail: why };
    out.push(f); placed.set(f.id, f);
  }
  const usedSides = new Map<string, Set<number>>();
  const seatsDone = new Set<string>();
  const hasTv = [...ctx.byId.values()].some((f) => f.category === 'tv-unit');
  const strategyOrder = (host: FurnitureItem, arr: Pose[][]): Pose[][] => {
    if (spec.kind !== 'array' || spec.strategy === 0) return arr;
    const cx = (spec.x0 + spec.x1) / 2, cy = (spec.y0 + spec.y1) / 2;
    const spread = (a: Pose[]) => a.reduce((t, p) => t + Math.hypot(p.x - cx, p.y - cy), 0) / Math.max(1, a.length);
    return [...arr].sort((a, b) => (spec.strategy === 1 ? spread(b) - spread(a) : spread(a) - spread(b)));
  };
  for (const id of g.members) {
    if (placed.has(id) || seatsDone.has(id)) continue;
    const link = ctx.parent.get(id);
    const parent = link ? placed.get(link.id) : undefined;
    const child = ctx.byId.get(id)!;
    const optional = OPTIONAL.has(child.category);
    if (!link || !parent) { if (optional || !check) { deferred.push(id); continue; } return { fail: 'orphan' }; }
    const rel = link.rel;
    let options: Pose[] = [];
    if (rel.kind === 'paired-seat') {
      const seats = (ctx.children.get(parent.id) ?? []).filter((c) => ctx.parent.get(c)?.rel.kind === 'paired-seat').map((c) => ctx.byId.get(c)!);
      const arr = strategyOrder(parent, seatArrangements(parent, seats, mirror));
      let done = false;
      let why: string | null = 'seats';
      for (const a of arr) {
        const cand = seats.map((s, i) => withPose(s, a[i]));
        why = fail(cand);
        if (!why) { for (const c of cand) { out.push(c); placed.set(c.id, c); seatsDone.add(c.id); } done = true; break; }
      }
      if (!done) return { fail: why ?? 'seats' };
      continue;
    }
    if (rel.kind === 'flanks') {
      const used = usedSides.get(parent.id) ?? new Set<number>();
      const order = ((mirror ? [1, -1] : [-1, 1]) as Array<-1 | 1>).filter((s) => !used.has(s));
      const opts = flankOptions(parent, child, order);
      let done = false;
      for (let i = 0; i < opts.length; i++) {
        const c = withPose(child, opts[i]);
        if (ok([c])) { out.push(c); placed.set(c.id, c); used.add(order[i]); usedSides.set(parent.id, used); done = true; break; }
      }
      if (!done) return { fail: fail([withPose(child, opts[0] ?? opts[0])]) ?? 'flank' };
      continue;
    }
    if (rel.kind === 'in-front-of') options = inFrontOptions(parent, child, rel.distanceM ?? [0.45, 0.5]);
    else if (rel.kind === 'faces') options = facingOptions(ctx.room, parent, child, rel.distanceM ?? [2.1, 3.5]);
    else if (rel.kind === 'beside') options = besideOptions(parent, child, rel.distanceM, mirror, !hasTv && parent.category === 'coffee-table');
    else if (rel.kind === 'centered-on') {
      const gp = ctx.parent.get(parent.id);
      const seat = parent.category === 'coffee-table' && gp ? placed.get(gp.id) : undefined;
      options = rugOptions(child, parent, seat && /^sofa/.test(seat.category) ? seat : undefined);
    }
    let done = false, why: string | null = 'no option';
    for (const p of options) {
      const c = withPose(child, p);
      why = fail([c]);
      if (!why) { out.push(c); placed.set(c.id, c); done = true; break; }
    }
    if (!done) {
      if (optional || child.category === 'armchair') {
        deferred.push(id);
        for (const d of membersOf(ctx, id).slice(1)) if (!deferred.includes(d)) deferred.push(d);
        continue;
      }
      return { fail: why ?? 'no option' };
    }
  }
  // Nightstands at the head: the bed's side box becomes the rules' job past the nightstand.
  for (const f of out) {
    const bedId = ctx.flank.get(f.id);
    const bed = bedId ? placed.get(bedId) : undefined;
    if (!bed) continue;
    const lx = (f.x - bed.x) * Math.cos(bed.rotation) + (f.y - bed.y) * Math.sin(bed.rotation);
    const side = lx < 0 ? 'left' : 'right';
    const i = out.indexOf(bed);
    const nb = { ...bed, clearance: { ...bed.clearance, [side]: 0 } };
    out[i] = nb; placed.set(nb.id, nb);
  }
  return { items: out, deferred };
}

// ---------------------------------------------------------------- slots
function extentsAlong(ctx: Ctx, items: FurnitureItem[], root: FurnitureItem, dir: P): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const f of items) {
    if (isRug(f)) continue;
    const c = Math.cos(f.rotation), s = Math.sin(f.rotation);
    for (const [lx, ly] of [[-f.w / 2, -f.d / 2], [f.w / 2, -f.d / 2], [f.w / 2, f.d / 2], [-f.w / 2, f.d / 2]]) {
      const p = { x: f.x + lx * c - ly * s, y: f.y + lx * s + ly * c };
      const u = dot(sub(p, root), dir);
      lo = Math.min(lo, u); hi = Math.max(hi, u);
    }
  }
  return [lo, hi];
}

function wallSlots(ctx: Ctx, g: Group): Spec[] {
  const out: Spec[] = [];
  const root = ctx.byId.get(g.roots[0])!;
  for (const w of ctx.room.walls) {
    if (w.len < root.w + 0.02) continue;
    const t0 = w.len / 2;
    const trial = placeGroup(ctx, [], g, { kind: 'wall', wall: w.i, t: t0 }, false, false);
    if ('fail' in trial) continue;
    const r = trial.items[0];
    const [lo, hi] = extentsAlong(ctx, trial.items.filter((f) => !OPTIONAL.has(f.category)), r, w.dir);
    const tLo = -lo + 0.006, tHi = w.len - hi - 0.006;
    if (tLo > tHi + 1e-9) continue;
    const ts = new Set<number>([tLo, tHi, (tLo + tHi) / 2]);
    const centreOff = (lo + hi) / 2;
    for (const [s, e] of w.windows) ts.add(Math.min(tHi, Math.max(tLo, (s + e) / 2 - centreOff)));
    const span = tHi - tLo, n = Math.min(10, Math.floor(span / 0.2));
    for (let k = 1; k < n; k++) ts.add(tLo + (span * k) / n);
    for (const t of [...ts].sort((a, b) => a - b)) out.push({ kind: 'wall', wall: w.i, t: Math.round(t * 1000) / 1000 });
  }
  return out;
}

/** Largest axis-aligned rectangle of floor not taken by placed pieces, their use zones or door landings. */
function freeRegion(ctx: Ctx, items: FurnitureItem[]): { x0: number; y0: number; x1: number; y1: number } | null {
  const b = ctx.room.box, cell = 0.1;
  const cols = Math.ceil((b.maxX - b.minX) / cell), rows = Math.ceil((b.maxY - b.minY) / cell);
  const blocked = new Uint8Array(cols * rows);
  const rects: ORect[] = [];
  for (const f of items) {
    if (isRug(f)) continue;
    const g = geo(ctx, f);
    rects.push(g.r, ...g.sides.map((s) => s.r));
  }
  for (const { z } of [...ctx.room.swingZones, ...ctx.room.approachZones]) rects.push(z);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const p = { x: b.minX + (c + 0.5) * cell, y: b.minY + (r + 0.5) * cell };
    if (!pointInPolygon(p, ctx.room.poly)) { blocked[r * cols + c] = 1; continue; }
    for (const q of rects) if (distPointRect(p, q) < 0.02) { blocked[r * cols + c] = 1; break; }
  }
  const h = new Array(cols).fill(0); let best = 0, bestR: { x0: number; y0: number; x1: number; y1: number } | null = null;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) h[c] = blocked[r * cols + c] ? 0 : h[c] + 1;
    const st: number[] = [];
    for (let c = 0; c <= cols; c++) {
      const hc = c === cols ? 0 : h[c];
      while (st.length && h[st[st.length - 1]] >= hc) {
        const top = st.pop()!, left = st.length ? st[st.length - 1] + 1 : 0, a = h[top] * (c - left);
        if (a > best) { best = a; bestR = { x0: b.minX + left * cell, x1: b.minX + c * cell, y0: b.minY + (r - h[top] + 1) * cell, y1: b.minY + (r + 1) * cell }; }
      }
      st.push(c);
    }
  }
  return bestR;
}

function arraySlots(ctx: Ctx, g: Group, items: FurnitureItem[]): Spec[] {
  const n = g.roots.length, f0 = ctx.byId.get(g.roots[0])!;
  const base = ctx.room.walls[0]?.rot ?? 0;
  const regions: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  const fr = freeRegion(ctx, items);
  if (fr) {
    regions.push(fr);
    // The free region grown back by the table's own use zone, which may overlap other use zones.
    const grow = Math.max(f0.clearance.front, f0.clearance.left, 0.3) * 0.8, b = ctx.room.box;
    regions.push({ x0: Math.max(b.minX, fr.x0 - grow), y0: Math.max(b.minY, fr.y0 - grow), x1: Math.min(b.maxX, fr.x1 + grow), y1: Math.min(b.maxY, fr.y1 + grow) });
  }
  const b = ctx.room.box;
  regions.push({ x0: b.minX, y0: b.minY, x1: b.maxX, y1: b.maxY });
  const shapes: Array<[number, number]> = [];
  for (let r = 1; r <= n; r++) { const c = Math.ceil(n / r); if (r * c - n < c) shapes.push([r, c]); }
  const rots = Math.abs(f0.w - f0.d) < 0.01 ? [base] : [base, base + Math.PI / 2];
  const out: Spec[] = [];
  for (const reg of regions) for (const [rows, cols] of shapes) for (const rot of rots) for (const strategy of n > 1 ? [1, 0, 2] : [0]) {
    out.push({ kind: 'array', ...reg, rows, cols, rot, strategy });
    if (n === 1) {
      // A lone table also tries the middle of the room and nudges off the region centre.
      const cx = (reg.x0 + reg.x1) / 2, cy = (reg.y0 + reg.y1) / 2;
      for (const [dx, dy] of [[0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]]) out.push({ kind: 'array', x0: cx + dx - 0.5, x1: cx + dx + 0.5, y0: cy + dy - 0.5, y1: cy + dy + 0.5, rows: 1, cols: 1, rot, strategy: 0 });
    }
  }
  return out;
}

function freeSlots(ctx: Ctx, g: Group): Spec[] {
  const f = ctx.byId.get(g.roots[0])!;
  const out: Spec[] = [];
  const base = ctx.room.walls[0]?.rot ?? 0;
  if (f.category === 'plant' || f.category === 'lamp') {
    const poly = ctx.room.poly, n = poly.length;
    for (let i = 0; i < n; i++) {
      const wPrev = ctx.room.walls[(i - 1 + n) % n], wNext = ctx.room.walls[i];
      if (dot(wPrev.n, wNext.dir) <= 0.1) continue; // convex corners only
      const off = Math.max(f.w, f.d) / 2 + 0.03;
      const p = { x: poly[i].x + wPrev.n.x * off + wNext.n.x * off, y: poly[i].y + wPrev.n.y * off + wNext.n.y * off };
      out.push({ kind: 'free', x: p.x, y: p.y, rot: rotationFacing(wNext.n) });
    }
    return out;
  }
  if (isRug(f)) {
    const c = ctx.room.centre;
    for (const rot of [base, base + Math.PI / 2]) out.push({ kind: 'free', x: c.x, y: c.y, rot });
    return out;
  }
  const b = ctx.room.box;
  for (let x = b.minX + 0.3; x < b.maxX; x += 0.3) for (let y = b.minY + 0.3; y < b.maxY; y += 0.3) for (const rot of [base, base + Math.PI / 2]) out.push({ kind: 'free', x, y, rot });
  return out;
}

function slotsFor(ctx: Ctx, g: Group, items: FurnitureItem[]): Spec[] {
  if (g.kind === 'fixed') return [{ kind: 'fixed' }];
  if (g.kind === 'array') return arraySlots(ctx, g, items);
  if (g.kind === 'wall') { const w = wallSlots(ctx, g); return w.length ? w : freeSlots(ctx, g); }
  return freeSlots(ctx, g);
}
const hasChoice = (ctx: Ctx, g: Group) => g.members.some((id) => { const r = ctx.parent.get(id)?.rel.kind; return r === 'flanks' || r === 'beside' || r === 'paired-seat'; });

// ---------------------------------------------------------------- scoring
function layoutCtx(ctx: Ctx, items: FurnitureItem[]): LayoutCtx { return analyse(ctx.room, items, ctx.req, ctx.cache); }
function scoreItems(ctx: Ctx, items: FurnitureItem[]): number {
  const L = layoutCtx(ctx, items);
  const v = evaluateCtx(L, { fast: true });
  return 0.8 * (designScore(v) / 100) + 0.2 * programScore(ctx.program, L) + ctx.noise();
}
/** Cheap pre-score: only the relations that mention the group's pieces. */
function quickScore(ctx: Ctx, items: FurnitureItem[], groupIds: Set<string>): number {
  const L = layoutCtx(ctx, items);
  let w = 0, s = 0;
  for (const r of ctx.program.relations) {
    if (!groupIds.has(r.subject) && !(r.target && groupIds.has(r.target))) continue;
    const v = relationScore(r, L);
    if (v == null) continue;
    w += r.weight; s += r.weight * v;
  }
  // Wall-backed pieces resting on a wall, nothing tall on window walls.
  for (const id of groupIds) {
    const a = L.byId.get(id);
    if (!a) continue;
    if (a.f.h > 1.2 && a.sem.role === 'storage' && a.back && ctx.room.walls[a.back.wall].windows.length) { w += 0.5; }
    else if (a.f.h > 1.2 && a.sem.role === 'storage') { w += 0.5; s += 0.5; }
  }
  return w ? s / w : 0.5;
}

// ---------------------------------------------------------------- signatures and names
function cls(ctx: Ctx, p: Placed): string {
  const s = p.spec;
  if (s.kind === 'wall') {
    const w = ctx.room.walls[s.wall];
    const root = p.items[0];
    const lo = root.w / 2 + 0.05;
    const pos = s.t <= lo + 0.15 ? 'a' : s.t >= w.len - lo - 0.15 ? 'b' : 'mid';
    return `w${s.wall}${pos}`;
  }
  if (s.kind === 'array') return `arr${s.rows}x${s.cols}r${Math.round(s.rot * 10)}s${s.strategy}`;
  if (s.kind === 'free') return `f${Math.round(s.x)}:${Math.round(s.y)}`;
  return 'fixed';
}
function signature(ctx: Ctx, st: State, depth = 3): string {
  return st.placed.filter((p) => !p.group.fixed && p.group.priority >= 40).slice(0, depth).map((p) => `${p.group.id}@${cls(ctx, p)}`).join('|');
}

const wallWord = (ctx: Ctx, wi: number): string => {
  const w = ctx.room.walls[wi];
  if (w.windows.length) return 'window wall';
  if (w.doors.length) return 'door wall';
  const longest = Math.max(...ctx.room.walls.map((x) => x.len));
  return w.len >= longest - 0.05 ? 'long wall' : 'short wall';
};
const nearWindow = (ctx: Ctx, f: FurnitureItem) => ctx.room.windows.some((w) => polyDist([w.a, w.b, w.b, w.a], [toPlanOf(f, -f.w / 2, -f.d / 2), toPlanOf(f, f.w / 2, -f.d / 2), toPlanOf(f, f.w / 2, f.d / 2), toPlanOf(f, -f.w / 2, f.d / 2)]) < 1.0);

function phrase(ctx: Ctx, st: State, p: Placed): string {
  const root = p.items[0], c = root.category, spec = p.spec;
  const wall = spec.kind === 'wall' ? spec.wall : null;
  if (c === 'bed' || c === 'bunk-bed') {
    if (wall == null) return 'Bed in the room';
    const w = ctx.room.walls[wall];
    const facesWin = ctx.room.windows.some((o) => dot(o.inward, w.n) < -0.9);
    if (root.w < 1.2 && cls(ctx, p) !== `w${wall}mid`) return 'Bed tucked in the corner';
    if (facesWin) return 'Bed facing the window';
    return `Bed on the ${wallWord(ctx, wall)}`;
  }
  if (c === 'desk') {
    const desks = st.placed.filter((q) => q.items[0].category === 'desk');
    if (desks.length >= 2) {
      const [a, b] = desks.map((q) => q.items[0]);
      const fa = { x: -Math.sin(a.rotation), y: Math.cos(a.rotation) }, fb = { x: -Math.sin(b.rotation), y: Math.cos(b.rotation) };
      const d = dot(fa, fb);
      const where = desks.some((q) => nearWindow(ctx, q.items[0])) ? ' by the window' : '';
      if (d > 0.9) return `Desks side by side${where}`;
      if (d < -0.9) return `Desks on facing walls${where}`;
      return `Desks in an L${where}`;
    }
    if (nearWindow(ctx, root)) return 'Desk by the window';
    if (wall != null && ctx.room.windows.some((o) => dot(o.inward, ctx.room.walls[wall].n) < -0.9)) return 'Desk facing the window';
    return wall != null ? `Desk on the ${wallWord(ctx, wall)}` : 'Desk in the room';
  }
  if (c === 'tv-unit') {
    const sofa = p.items.find((f) => /^sofa/.test(f.category));
    const floating = sofa && !layoutCtx(ctx, st.items).byId.get(sofa.id)?.back;
    const where = wall != null ? ` on the ${wallWord(ctx, wall)}` : '';
    return floating ? `Floating sofa, TV${where}` : `Lounge around the TV${where}`;
  }
  if (c === 'sofa' || c === 'sofa-bed') return wall != null ? `Sofa on the ${wallWord(ctx, wall)}` : 'Sofa in the room';
  if (c === 'counter' || c === 'reception-desk') {
    const door = ctx.room.doors[0];
    if (door && polyDist([door.a, door.b, door.b, door.a], [toPlanOf(root, -root.w / 2, -root.d / 2), toPlanOf(root, root.w / 2, -root.d / 2), toPlanOf(root, root.w / 2, root.d / 2), toPlanOf(root, -root.w / 2, root.d / 2)]) < 1.6) return 'Counter by the door';
    if (wall != null && door && dot(ctx.room.walls[wall].n, door.inward) < -0.9) return 'Counter facing the door';
    return wall != null ? `Counter on the ${wallWord(ctx, wall)}` : 'Counter in the room';
  }
  if (spec.kind === 'array') {
    const n = p.group.roots.length, name = ctx.byId.get(p.group.roots[0])!.category === 'cafe-table' ? 'Tables' : 'Tables';
    if (n === 1) return `${root.name} centred`;
    return spec.rows === 1 || spec.cols === 1 ? `${name} in a row of ${n}` : `${name} in a ${spec.rows} x ${spec.cols} grid`;
  }
  if (wall != null) return `${root.name} on the ${wallWord(ctx, wall)}`;
  return root.name;
}

function conceptName(ctx: Ctx, st: State, depth: number): string {
  const major = st.placed.filter((p) => !p.group.fixed && p.group.priority >= 40);
  const ps: string[] = [];
  for (const p of major) {
    const s = phrase(ctx, st, p);
    if (!ps.some((x) => x.split(' ')[0] === s.split(' ')[0])) ps.push(s);
    if (ps.length >= depth) break;
  }
  if (!ps.length) return 'Layout';
  return ps.map((s, i) => (i ? lc(s) : s)).join(', ');
}

// ---------------------------------------------------------------- infeasibility
function reasonText(ctx: Ctx, code: string): string {
  const [kind, id] = code.split(':');
  const other = id ? ctx.byId.get(id)?.name.toLowerCase() : undefined;
  switch (kind) {
    case 'wall': return 'it does not fit between the walls';
    case 'door': return 'it would block the door swing or the landing inside the door';
    case 'window': return 'tall pieces must stay 40 cm off the window';
    case 'use-wall': return 'its use space (pull-out, access) would run into a wall';
    case 'overlap': return `it would overlap the ${other ?? 'other furniture'}`;
    case 'use': return `the use space of it or the ${other ?? 'other furniture'} would be blocked`;
    case 'unfold': return 'it cannot unfold';
    case 'ceiling': return 'it is taller than the ceiling';
    case 'route': return 'every spot closes the walkway from the door';
    default: return 'there is no free spot left';
  }
}
function infeasible(ctx: Ctx, failed: Group | null, placedNames: string[], items: FurnitureItem[], req: Requirements | null): Infeasibility {
  const reasons: string[] = [];
  const area = ctx.room.area;
  const doorA = ctx.room.swingZones.reduce((t, z) => t + z.z.hw * z.z.hd * 4, 0) * 0.5 + ctx.room.approachZones.reduce((t, z) => t + z.z.hw * z.z.hd * 4, 0) * 0.5;
  const hosted = new Set([...ctx.parent.entries()].filter(([, p]) => p.rel.kind === 'paired-seat').map(([id]) => id));
  const need = items.filter((f) => !isRug(f)).reduce((t, f) => {
    const c = hosted.has(f.id) ? { front: 0, back: 0, left: 0, right: 0 } : f.clearance;
    return t + (f.w + c.left + c.right) * (f.d + c.front + c.back);
  }, 0);
  if (failed) {
    const top = [...ctx.rejects.entries()].sort((a, b) => b[1] - a[1])[0];
    const f = ctx.byId.get(failed.roots[0])!;
    const deps = failed.members.length - failed.roots.length;
    reasons.push(`No spot for the ${f.name.toLowerCase()}${deps ? ` and its ${deps} companion piece${deps > 1 ? 's' : ''}` : ''}${placedNames.length ? ` once the ${placedNames.slice(0, 3).map((n) => n.toLowerCase()).join(', ')} ${placedNames.length > 1 ? 'are' : 'is'} placed` : ''}: ${reasonText(ctx, top?.[0] ?? '')}.`);
  }
  if (need > area - doorA) reasons.push(`The pieces with their use space need about ${need.toFixed(1)} m²; the room has ${(area - doorA).toFixed(1)} m² once the door is kept clear.`);
  const bb = ctx.room.box, W = bb.maxX - bb.minX, H = bb.maxY - bb.minY;
  for (const f of items) {
    if (Math.max(f.w, f.d) > Math.max(W, H) + 1e-6 || Math.min(f.w, f.d) > Math.min(W, H) + 1e-6) reasons.push(`The ${f.name.toLowerCase()} (${f.w.toFixed(2)} x ${f.d.toFixed(2)} m) is larger than the room (${W.toFixed(2)} x ${H.toFixed(2)} m).`);
  }
  if (!reasons.length) reasons.push(`No arrangement of ${items.length} pieces in ${area.toFixed(1)} m² keeps every use zone and the walkway clear.`);
  const relaxations: Infeasibility['relaxations'] = [];
  if (req && req.items.length) {
    const prio = (cid: string) => { const e = catalogEntry(cid); return e ? anchorPriority({ category: e.category } as FurnitureItem) : 35; };
    const sorted = [...req.items].sort((a, b) => prio(a.catalogId) - prio(b.catalogId));
    const failCat = failed ? ctx.byId.get(failed.roots[0])?.catalogId : undefined;
    const drops = [...new Set([failCat, sorted[0]?.catalogId].filter(Boolean) as string[])];
    for (const cid of drops) {
      const e = catalogEntry(cid);
      const ri = req.items.find((x) => x.catalogId === cid);
      if (!e || !ri) continue;
      relaxations.push({ label: `Leave out the ${e.name.toLowerCase()}`, patch: { items: req.items.filter((x) => x !== ri) } });
      const smaller = CATALOG.filter((c) => c.category === e.category && c.w * c.d < e.w * e.d - 1e-6).sort((a, b) => b.w * b.d - a.w * a.d)[0];
      if (smaller) relaxations.push({ label: `Use the ${smaller.name.toLowerCase()} instead`, patch: { items: req.items.map((x) => (x === ri ? { ...x, catalogId: smaller.id } : x)) } });
    }
    if (req.minRouteWidthM > 0.8) relaxations.push({ label: 'Narrow the walkway to 80 cm', patch: { minRouteWidthM: 0.8 } });
  }
  return { reasons, relaxations };
}

// ---------------------------------------------------------------- metrics and summaries
function minClearance(items: FurnitureItem[]): number | null {
  const s = items.filter((f) => !isRug(f));
  if (s.length < 2) return null;
  const polys = s.map((f) => [toPlanOf(f, -f.w / 2, -f.d / 2), toPlanOf(f, f.w / 2, -f.d / 2), toPlanOf(f, f.w / 2, f.d / 2), toPlanOf(f, -f.w / 2, f.d / 2)]);
  let m = Infinity;
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) m = Math.min(m, polyDist(polys[i], polys[j]));
  return Math.round(m * 100) / 100;
}
function meanDisplacement(a: FurnitureItem[], b: FurnitureItem[]): number {
  const mb = new Map(b.map((f) => [f.id, f]));
  let s = 0, n = 0;
  for (const f of a) { const g = mb.get(f.id); if (g) { s += Math.hypot(f.x - g.x, f.y - g.y); n++; } }
  return n ? s / n : Infinity;
}

function summaries(cands: Array<{ verdicts: RuleVerdict[]; cand: LayoutCandidate }>) {
  const mean = (v: RuleVerdict[], id: string) => { const xs = v.filter((x) => x.ruleId === id); return xs.length ? xs.reduce((t, x) => t + x.score, 0) / xs.length : null; };
  for (const c of cands) {
    const others = cands.filter((o) => o !== c);
    const ids = [...new Set(c.verdicts.filter((v) => v.severity !== 'hard').map((v) => v.ruleId))];
    let best: { id: string; d: number } | null = null;
    for (const id of ids) {
      const mine = mean(c.verdicts, id);
      const theirs = others.map((o) => mean(o.verdicts, id)).filter((x): x is number => x != null);
      if (mine == null || !theirs.length) continue;
      const d = mine - theirs.reduce((t, x) => t + x, 0) / theirs.length;
      if (!best || d > best.d) best = { id, d };
    }
    const top = explainDetailed(c.verdicts, 12);
    const strength = best && best.d > 0.05 ? c.verdicts.filter((v) => v.ruleId === best!.id).sort((a, b) => b.score - a.score)[0] : top.find((e) => e.pass && e.severity === 'strong');
    const weak = top.find((e) => !e.pass || e.score < 0.75);
    const parts = [strength?.message, weak && weak.message !== strength?.message ? `Trade-off: ${lc(weak.message)}` : undefined].filter(Boolean);
    c.cand.summary = parts.join(' ') || `${c.cand.metrics.openAreaM2.toFixed(1)} m² of open floor.`;
  }
}

// ---------------------------------------------------------------- main
export async function solveProgram(model: SpaceModel, items: FurnitureItem[], program: DesignProgram, opts: SolveProgramOptions = {}): Promise<SolveResult> {
  const t0 = now();
  const budget = opts.timeBudgetMs ?? 1500;
  const variants = Math.max(1, Math.min(6, opts.variants ?? 3));
  const seed = opts.seed ?? 1;
  if (!model.spaces.length || model.spaces[0].polygon.length < 3) return { candidates: [], reports: [], infeasibility: { reasons: ['No room outline yet'], relaxations: [] } };
  if (!items.length) return { candidates: [], reports: [], infeasibility: { reasons: ['Nothing to place yet'], relaxations: [] } };
  const room = buildRoom(model);
  const req = opts.req ?? null;
  const r = rng(seed * 2654435761);
  const fixed = new Set([...items.filter((f) => f.locked).map((f) => f.id), ...(opts.fixedIds ?? [])]);
  const work = items.map((f) => ({ ...f, clearance: { ...f.clearance } }));
  const ctx: Ctx = {
    room, model, program, req, byId: new Map(work.map((f) => [f.id, f])), clr: new Map(work.map((f) => [f.id, { ...f.clearance }])),
    flank: new Map(), parent: new Map(), children: new Map(), cache: new Map(), routes: [], routeWidth: 0.8,
    noise: () => (r() - 0.5) * 0.002, rejects: new Map(),
  };
  buildTree(ctx, work, fixed);
  let groups = buildGroups(ctx, work, fixed);
  const targets = req ? req.routeTargets : room.windows.length ? [{ kind: 'window' as const }] : [];
  ctx.routeWidth = req ? req.minRouteWidthM : 0.8;
  ctx.routes = routeBases(room, targets, ctx.routeWidth);
  const softRoute = !req; // without a brief the walkway to the window is a wish, not a rule
  const routeOk = (list: FurnitureItem[]) => routeCheck(ctx.routes, list).ok;

  const B = groups.length > 7 ? 5 : 7, K = 5;
  let states: State[] = [{ placed: [], items: [], deferred: [], dropped: [], score: 0 }];
  let failedGroup: Group | null = null;
  let lastPlaced: string[] = [];
  let lastYield = now();
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (now() - lastYield > 40) { await tick(); lastYield = now(); }
    const next: State[] = [];
    ctx.rejects.clear();
    const gIds = new Set(g.members);
    for (const st of states) {
      const specs = slotsFor(ctx, g, st.items);
      const mirrors = hasChoice(ctx, g) ? [false, true] : [false];
      const cands: Array<{ spec: Spec; mirror: boolean; items: FurnitureItem[]; deferred: string[]; q: number; wallKey: string }> = [];
      for (const spec of specs) for (const mirror of mirrors) {
        const res = placeGroup(ctx, st.items, g, spec, mirror);
        if ('fail' in res) { const k = res.fail.split(':')[0] === 'overlap' || res.fail.split(':')[0] === 'use' ? res.fail : res.fail.split(':')[0]; ctx.rejects.set(k, (ctx.rejects.get(k) ?? 0) + 1); continue; }
        const all = [...st.items, ...res.items];
        cands.push({ spec, mirror, items: res.items, deferred: res.deferred, q: quickScore(ctx, all, gIds), wallKey: spec.kind === 'wall' ? `w${spec.wall}` : spec.kind });
      }
      if (!cands.length) continue;
      // Keep the best few per wall so every wall stays in play, then score those in full.
      cands.sort((a, b) => b.q - a.q);
      const perWall = new Map<string, number>(), short: typeof cands = [];
      for (const c of cands) { const n = perWall.get(c.wallKey) ?? 0; if (n < 4) { short.push(c); perWall.set(c.wallKey, n + 1); } }
      for (const c of cands) if (short.length < 14 && !short.includes(c)) short.push(c);
      const scored = short.map((c) => ({ c, s: scoreItems(ctx, [...st.items, ...c.items]) })).sort((a, b) => b.s - a.s);
      let kept = 0;
      for (const { c, s } of scored) {
        if (kept >= K) break;
        const all = [...st.items, ...c.items];
        if (!softRoute && !routeOk(all)) { ctx.rejects.set('route', (ctx.rejects.get('route') ?? 0) + 1); continue; }
        next.push({ placed: [...st.placed, { group: g, spec: c.spec, mirror: c.mirror, items: c.items }], items: all, deferred: [...st.deferred, ...c.deferred], dropped: st.dropped, score: s });
        kept++;
      }
    }
    if (!next.length) {
      // Split a composite group into its pieces and try again; drop optional pieces; otherwise give up.
      if (g.members.length > g.roots.length && g.kind !== 'array') {
        for (const id of g.members.slice(1)) { const p = ctx.parent.get(id); if (p) { ctx.parent.delete(id); ctx.flank.delete(id); const sib = ctx.children.get(p.id); if (sib) ctx.children.set(p.id, sib.filter((x) => x !== id)); } }
        const rest = groups.slice(gi + 1);
        const split = buildGroups(ctx, g.members.map((id) => ctx.byId.get(id)!), fixed);
        groups = [...groups.slice(0, gi), ...split, ...rest];
        gi--;
        continue;
      }
      if (g.optional) { for (const st of states) st.dropped = [...st.dropped, ...g.members]; continue; }
      failedGroup = g;
      lastPlaced = states[0]?.items.map((f) => f.name) ?? [];
      break;
    }
    // Diverse beam: best per signature first, then by score.
    next.sort((a, b) => b.score - a.score);
    const seen = new Set<string>(), beam: State[] = [];
    for (const st of next) { const sg = signature(ctx, st); if (!seen.has(sg)) { seen.add(sg); beam.push(st); } if (beam.length >= B) break; }
    states = beam;
    opts.onProgress?.(((gi + 1) / groups.length) * 0.6);
  }

  if (failedGroup || !states.length) {
    if (softRoute && ctx.routes.length) {
      // Last resort without a brief: allow the window walkway to narrow and say so.
      return solveProgram(model, items, program, { ...opts, req: { purpose: '', people: 1, budgetSek: null, items: [], routeTargets: [], minRouteWidthM: 0.8, style: '', lockedIds: [], notes: [], questions: [], compiledBy: 'rules' } });
    }
    return { candidates: [], reports: [], infeasibility: infeasible(ctx, failedGroup, lastPlaced, work, req) };
  }

  // Deferred optional pieces: best free spot each.
  for (const st of states) {
    for (const id of st.deferred) {
      if (st.items.some((f) => f.id === id)) continue;
      const f = ctx.byId.get(id)!;
      const g: Group = { id, roots: [id], members: [id], priority: anchorPriority(f), fixed: false, kind: semanticsOf(f).wallBacked ? 'wall' : 'free', optional: OPTIONAL.has(f.category) };
      const saved = ctx.parent.get(id);
      ctx.parent.delete(id);
      let best: { items: FurnitureItem[]; s: number; spec: Spec } | null = null;
      for (const spec of slotsFor(ctx, g, st.items)) {
        const res = placeGroup(ctx, st.items, g, spec, false);
        if ('fail' in res) continue;
        const all = [...st.items, ...res.items];
        if (!softRoute && !routeOk(all)) continue;
        const s = quickScore(ctx, all, new Set([id]));
        if (!best || s > best.s) best = { items: res.items, s, spec };
      }
      if (saved) ctx.parent.set(id, saved);
      if (best) { st.items = [...st.items, ...best.items]; st.placed.push({ group: g, spec: best.spec, mirror: false, items: best.items }); }
      else st.dropped.push(id);
    }
    st.score = scoreItems(ctx, st.items);
  }
  states = states.filter((st) => st.dropped.every((id) => OPTIONAL.has(ctx.byId.get(id)!.category)));

  // Local pass: slide, flip and nudge each group while the score rises.
  const deadline = t0 + budget * 0.85;
  const improve = async (st: State): Promise<State> => {
    let cur = st;
    for (let pass = 0; pass < 4; pass++) {
      let better = false;
      for (let k = 0; k < cur.placed.length; k++) {
        const p = cur.placed[k];
        if (p.group.fixed || p.spec.kind === 'array') continue;
        if (now() > deadline) return cur;
        if (now() - lastYield > 40) { await tick(); lastYield = now(); }
        const others = cur.placed.filter((_, i) => i !== k).flatMap((q) => q.items);
        const moves: Array<{ spec: Spec; mirror: boolean }> = [];
        const s = p.spec;
        if (s.kind === 'wall') {
          const len = ctx.room.walls[s.wall].len;
          for (const d of [-0.4, -0.2, -0.1, -0.05, 0.05, 0.1, 0.2, 0.4]) { const t = s.t + d; if (t > 0 && t < len) moves.push({ spec: { ...s, t: Math.round(t * 1000) / 1000 }, mirror: p.mirror }); }
        } else if (s.kind === 'free') {
          for (const [dx, dy] of [[0.1, 0], [-0.1, 0], [0, 0.1], [0, -0.1], [0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25]]) moves.push({ spec: { ...s, x: s.x + dx, y: s.y + dy }, mirror: p.mirror });
        }
        if (hasChoice(ctx, p.group)) moves.push({ spec: s, mirror: !p.mirror });
        let bestMove: { placed: Placed; items: FurnitureItem[]; s: number } | null = null;
        for (const mv of moves) {
          const res = placeGroup(ctx, others, p.group, mv.spec, mv.mirror);
          if ('fail' in res) continue;
          if (res.items.length < p.items.length) continue;
          const all = [...others, ...res.items];
          const sc = scoreItems(ctx, all);
          if (sc > (bestMove?.s ?? cur.score) + 1e-4 && (softRoute || routeOk(all))) bestMove = { placed: { ...p, spec: mv.spec, mirror: mv.mirror, items: res.items }, items: all, s: sc };
        }
        if (bestMove) {
          const placed = [...cur.placed]; placed[k] = bestMove.placed;
          cur = { ...cur, placed, items: placed.flatMap((q) => q.items), score: bestMove.s };
          better = true;
        }
      }
      if (!better) break;
    }
    return cur;
  };
  const pool: State[] = [];
  const order = [...states].sort((a, b) => b.score - a.score);
  for (const st of order.slice(0, Math.max(variants * 2, 4))) pool.push(await improve(st));
  opts.onProgress?.(0.85);

  // Full evaluation, referee, variety.
  const finals: Array<{ st: State; verdicts: RuleVerdict[]; checks: ValidationResult[]; ds: number; sig: string }> = [];
  for (const st of pool) {
    const checks = validateLayout(model, st.items, req);
    if (checks.some((c) => c.result === 'fail')) continue;
    const L = layoutCtx(ctx, st.items);
    const verdicts = evaluateCtx(L);
    finals.push({ st, verdicts, checks, ds: designScore(verdicts) + programScore(program, L) * 2, sig: signature(ctx, st, 1) });
  }
  finals.sort((a, b) => b.ds - a.ds);
  const chosen: typeof finals = [];
  for (const f of finals) {
    if (chosen.length >= variants) break;
    if (chosen.some((c) => c.sig === f.sig || meanDisplacement(c.st.items, f.st.items) < 0.25)) continue;
    chosen.push(f);
  }
  for (const f of finals) { if (chosen.length >= variants) break; if (!chosen.includes(f) && !chosen.some((c) => meanDisplacement(c.st.items, f.st.items) < 0.25)) chosen.push(f); }
  if (!chosen.length) return { candidates: [], reports: [], infeasibility: infeasible(ctx, null, [], work, req) };

  const out: Array<{ verdicts: RuleVerdict[]; cand: LayoutCandidate }> = [];
  const names = new Set<string>();
  for (const [i, f] of chosen.entries()) {
    let name = conceptName(ctx, f.st, 1);
    if (names.has(name)) name = conceptName(ctx, f.st, 2);
    if (names.has(name)) name = `${name} (${i + 1})`;
    names.add(name);
    const L = layoutCtx(ctx, f.st.items);
    const g = floorGrid(L, 0.1);
    const route = routeCheck(ctx.routes, f.st.items);
    const cost = f.st.items.reduce((t, x) => t + (x.owned ? 0 : x.priceSek || 0), 0);
    const flanked = f.st.items.filter((x) => ctx.flank.has(x.id)).length;
    const assumptions = [
      'Walls treated as straight; 1 cm placement tolerance',
      'Seats belong to the nearest desk or table',
      ...(req ? [`Walkway ${Math.round(req.minRouteWidthM * 100)} cm from the door to ${req.routeTargets.map((t) => t.kind).join(' and ') || 'the room'}`] : []),
      ...(flanked ? ['Bed side access is measured past the nightstands'] : []),
      ...f.st.dropped.map((id) => `Left out the ${ctx.byId.get(id)!.name.toLowerCase()}: no spot without blocking something`),
    ];
    const ds = designScore(f.verdicts);
    out.push({
      verdicts: f.verdicts,
      cand: {
        id: uid('cand'), name, summary: '', parentVersion: model.version, furniture: f.st.items,
        metrics: { openAreaM2: Math.round(largestOpenRect(g) * 10) / 10, costSek: cost, minClearanceM: minClearance(f.st.items), routeLenM: route.lengthM == null ? null : Math.round(route.lengthM * 10) / 10, score: ds },
        checks: f.checks, assumptions, generator: `design rules + relation solver, seed ${seed}`,
      },
    });
  }
  summaries(out);
  opts.onProgress?.(1);
  return {
    candidates: out.map((o) => o.cand),
    reports: out.map((o) => ({ candidateId: o.cand.id, program, verdicts: o.verdicts })),
    infeasibility: null,
  };
}
