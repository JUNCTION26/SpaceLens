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
  analyse, buildRoom, evaluateCtx, spaceOf, floorGrid, largestOpenRect, localRect, polyDist, rectOf, toPlanOf,
  type AItem, type LayoutCtx, type RoomCtx,
} from './rules';
import {
  besideOptions, facingOptions, flankOptions, inFrontOptions, isStructural, programScore, relationScore, rotationFacing, rugOptions,
  seatArrangements, structuralRank, type Pose,
} from './relations';
import { deductions, designScore, explainDetailed, pointsOf } from './score';
import { isHostCategory, isSeatCategory, normaliseItem, semanticsOf } from './semantics';
import { assignSeatHosts } from './program';
import { isMounted, placeWallItems } from '../layout/wallItems';
import type { Weights } from '../layout/solver';
import { layoutFeatures } from '../taste/features';
import { tasteWeights } from '../taste/apply';
import type { TasteProfile } from '../taste/profile';
import { activeProfile } from '../taste/state';

export interface SolveProgramOptions {
  variants?: number;
  seed?: number;
  /**
   * Effort, not a deadline: scales the fixed amount of search work (1500 = normal). The solver never
   * reads the clock to decide when to stop, so the same seed gives the same layouts on any machine.
   */
  timeBudgetMs?: number;
  /** Hard wall-clock ceiling (default 20 s): past it the search stops expanding and returns the best layout found. */
  maxWallMs?: number;
  onProgress?: (p: number) => void;
  /** Route targets, route width and budget for the hard checks. */
  req?: Requirements | null;
  /** Items that keep their current pose (in addition to `locked` ones). */
  fixedIds?: string[];
  signal?: AbortSignal;
  /** Room of the model to furnish (default: the first). Other rooms and their furniture are left alone. */
  spaceId?: string;
  /** Taste to apply: a profile, null for none. Default: the person's active profile, if any. */
  taste?: TasteProfile | null;
}
/** Set on a layout produced with pieces left out or with reduced clear space. */
export interface Degraded { dropped: string[]; clearanceFactor: number }
export type SolvedCandidate = LayoutCandidate & { degraded?: Degraded; idea?: LayoutIdea };
export interface SolveResult {
  candidates: SolvedCandidate[]; reports: DesignReport[]; infeasibility: Infeasibility | null;
  /** Ids the best partial layout could not seat (set when nothing was returned). */
  unplaced?: string[];
}

const OPTIONAL = new Set(['rug', 'lamp', 'plant', 'side-table']);
const FLOAT_HOST = /^(table|cafe-table|kitchen-island)$/;
const M = 0.004;
const DBG = !!(globalThis as { process?: { env?: Record<string, string> } }).process?.env?.SOLVE_DEBUG; // safety margin inside the referee's 1 cm tolerance

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
    case 'wardrobe': return 82; // tall, window-shy and hard to fit: before desks
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
  /** Items placed with their left and right use zones swapped (a single bed's open side away from the wall). */
  swapped: WeakSet<FurnitureItem>;
  /** Room-only fit results per size and pose, shared by identical pieces within one solve. */
  staticFit: Map<string, string | null>;
  /** Taste multipliers on the solver weights; null when no profile is active. */
  taste: Weights | null;
}
const swapSides = (c: Clearance): Clearance => ({ ...c, left: c.right, right: c.left });
const asymmetric = (f: FurnitureItem) => Math.abs(f.clearance.left - f.clearance.right) > 0.05;

// ---------------------------------------------------------------- hard checks (mirror the referee)
interface Geo { r: ORect; rad: number; sides: Array<{ side: 'front' | 'back' | 'left' | 'right'; need: number; r: ORect }>; unfold?: ORect }
const geoCache = new WeakMap<FurnitureItem, Geo>();
function geo(ctx: Ctx, f: FurnitureItem): Geo {
  const hit = geoCache.get(f);
  if (hit) return hit;
  const base = ctx.clr.get(f.id) ?? f.clearance, c = ctx.swapped.has(f) ? swapSides(base) : base, hw = f.w / 2, hd = f.d / 2;
  const g: Geo = {
    r: rectOf(f),
    sides: ([['front', c.front, localRect(f, -hw, hw, hd, hd + c.front)], ['back', c.back, localRect(f, -hw, hw, -hd - c.back, -hd)],
      ['left', c.left, localRect(f, -hw - c.left, -hw, -hd, hd)], ['right', c.right, localRect(f, hw, hw + c.right, -hd, hd)]] as const)
      .filter(([, need]) => need > 0.01).map(([side, need, r]) => ({ side, need, r })),
    unfold: f.unfoldedD && f.unfoldedD > f.d ? localRect(f, -hw, hw, -hd, hd + (f.unfoldedD - f.d)) : undefined,
    // Bounding radius of footprint, use zones and unfolded depth, for a cheap broad phase.
    rad: Math.hypot(hw + Math.max(c.left, c.right), hd + Math.max(c.front, c.back, (f.unfoldedD ?? 0) - f.d)) + 0.02,
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

function staticFit(ctx: Ctx, f: FurnitureItem, g: Geo): string | null {
  const poly = ctx.room.poly;
  if (rectOutside(g.r, poly) > M) return 'wall';
  if (f.h > ctx.model.ceilingM) return 'ceiling';
  if (isRug(f)) return null;
  for (const { z } of ctx.room.swingZones) if (overlapDepth(z, g.r) > M) return 'door';
  for (const { z } of ctx.room.approachZones) if (overlapDepth(z, g.r) > M) return 'door';
  if (f.h > 1.0) for (const { z } of ctx.room.windowZones) if (overlapDepth(z, g.r) > M) return 'window';
  if (g.unfold && rectOutside(g.unfold, poly) > M) return 'unfold';
  return null;
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
    // Room-only checks depend on the piece's size and pose alone: same answer for identical pieces.
    const sk = `${f.w}|${f.d}|${f.h}|${f.unfoldedD ?? 0}|${f.category === 'rug' ? 1 : 0}|${f.x.toFixed(3)}|${f.y.toFixed(3)}|${f.rotation.toFixed(3)}`;
    let sv = ctx.staticFit.get(sk);
    if (sv === undefined) {
      sv = staticFit(ctx, f, g);
      ctx.staticFit.set(sk, sv);
    }
    if (sv) return sv;
    if (isRug(f)) continue;
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
      if (Math.hypot(go.r.cx - g.r.cx, go.r.cy - g.r.cy) > g.rad + go.rad) continue;
      if (overlapDepth(g.r, go.r) > M) return `overlap:${o.id}`;
      if (g.unfold && overlapDepth(g.unfold, go.r) > M) return `unfold:${o.id}`;
      if (go.unfold && overlapDepth(go.unfold, g.r) > M) return `unfold:${o.id}`;
      if (paired(f, o)) continue;
      const hostO = hostOf.has(o.id) ? byId.get(hostOf.get(o.id)!) : undefined;
      const hostOR = hostO ? geo(ctx, hostO).r : null;
      // A seat's zone that reaches under its own desk or table stops there.
      for (const s of g.sides) if (!(hostR && overlapDepth(s.r, hostR) > 0.01) && overlapDepth(s.r, go.r) > M) return `use:${o.id}`;
      for (const s of go.sides) if (!(hostOR && overlapDepth(s.r, hostOR) > 0.01) && overlapDepth(s.r, g.r) > M) return `use:${o.id}`;
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
  | { kind: 'wall'; wall: number; t: number; /** A single bed with its long side on the wall (daybed), open side +1 / -1. */ side?: 1 | -1 }
  | { kind: 'free'; x: number; y: number; rot: number }
  | { kind: 'array'; x0: number; y0: number; x1: number; y1: number; rows: number; cols: number; rot: number; strategy: number; hug?: number; bench?: { gap: number; per: number; align: number } };
interface Group { id: string; roots: string[]; members: string[]; priority: number; fixed: boolean; kind: 'wall' | 'array' | 'free' | 'fixed'; optional: boolean; bench?: boolean }
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
  // Three or more identical desks work as benches of facing pairs in the open floor, not one per wall.
  const deskCount = new Map<string, number>();
  for (const f of roots) if (f.category === 'desk' && !fixed.has(f.id)) deskCount.set(`${f.catalogId}:${f.w}x${f.d}`, (deskCount.get(`${f.catalogId}:${f.w}x${f.d}`) ?? 0) + 1);
  const benchKey = (f: FurnitureItem) => (f.category === 'desk' && (deskCount.get(`${f.catalogId}:${f.w}x${f.d}`) ?? 0) >= 3 ? `bench:${f.catalogId}:${f.w}x${f.d}` : null);
  for (const f of roots) {
    if (fixed.has(f.id)) { groups.push({ id: f.id, roots: [f.id], members: membersOf(ctx, f.id), priority: 1000, fixed: true, kind: 'fixed', optional: false }); continue; }
    const bk = benchKey(f);
    if (bk) { (arrays.get(bk) ?? arrays.set(bk, []).get(bk)!).push(f); continue; }
    if (FLOAT_HOST.test(f.category)) { const k = `${f.catalogId}:${f.w}x${f.d}`; (arrays.get(k) ?? arrays.set(k, []).get(k)!).push(f); continue; }
    const sem = semanticsOf(f);
    groups.push({ id: f.id, roots: [f.id], members: membersOf(ctx, f.id), priority: anchorPriority(f), fixed: false, kind: sem.wallBacked ? 'wall' : 'free', optional: OPTIONAL.has(f.category) });
  }
  for (const [k, list] of arrays) {
    const members = list.flatMap((f) => membersOf(ctx, f.id));
    groups.push({ id: list.map((f) => f.id).join('+'), roots: list.map((f) => f.id), members, priority: anchorPriority(list[0]) + (list.length > 1 ? 1 : 0), fixed: false, kind: 'array', optional: false, bench: k.startsWith('bench:') });
  }
  // Counters before the tables they serve; otherwise by priority, then size.
  const size = (g: Group) => g.members.reduce((t, id) => { const f = ctx.byId.get(id)!; return t + f.w * f.d; }, 0);
  return groups.sort((a, b) => b.priority - a.priority || size(b) - size(a));
}

const withPose = (f: FurnitureItem, p: Pose): FurnitureItem => ({ ...f, x: p.x, y: p.y, rotation: p.rotation });

function wallPose(ctx: Ctx, f: FurnitureItem, wall: number, t: number, side?: 1 | -1): Pose {
  const w = ctx.room.walls[wall];
  if (side) {
    // Long side on the wall: the item's right (side 1) or left (side -1) faces the wall.
    const off = f.w / 2 + 0.006, n = w.n;
    return { x: w.a.x + w.dir.x * t + n.x * off, y: w.a.y + w.dir.y * t + n.y * off, rotation: side === 1 ? Math.atan2(-n.y, -n.x) : Math.atan2(n.y, n.x) };
  }
  const off = f.d / 2 + (f.clearance.back ?? 0) + 0.006;
  return { x: w.a.x + w.dir.x * t + w.n.x * off, y: w.a.y + w.dir.y * t + w.n.y * off, rotation: rotationFacing(w.n) };
}

/** Root poses for a spec (several for a table array). */
function rootPoses(ctx: Ctx, g: Group, spec: Spec): Pose[] | null {
  if (spec.kind === 'fixed') return g.roots.map((id) => { const f = ctx.byId.get(id)!; return { x: f.x, y: f.y, rotation: f.rotation }; });
  if (spec.kind === 'wall') return [wallPose(ctx, ctx.byId.get(g.roots[0])!, spec.wall, spec.t, spec.side)];
  if (spec.kind === 'free') return [{ x: spec.x, y: spec.y, rotation: spec.rot }];
  if (spec.bench) return benchPoses(ctx, g, spec);
  const n = g.roots.length, out: Pose[] = [];
  // hug: outer tables sit as close to the region edge as their use zone allows, leaving central aisles.
  const h = spec.hug ?? 0;
  const axis = (lo: number, hi: number, k: number, m: number) => {
    if (!h || m <= 1) return lo + ((k + 0.5) * (hi - lo)) / m;
    const a = lo + h, b = hi - h;
    return a + (k * (b - a)) / (m - 1);
  };
  for (let i = 0; i < spec.rows; i++) {
    const inRow = Math.min(spec.cols, n - i * spec.cols);
    if (inRow <= 0) break;
    for (let j = 0; j < inRow; j++) {
      // A short last row is centred under the others.
      const x = inRow === spec.cols ? axis(spec.x0, spec.x1, j, spec.cols) : (spec.x0 + spec.x1) / 2 + (j - (inRow - 1) / 2) * (spec.x1 - spec.x0) / spec.cols;
      out.push({ x, y: axis(spec.y0, spec.y1, i, spec.rows), rotation: spec.rot });
    }
  }
  return out.length === n ? out : null;
}

/**
 * Desk clusters: pairs of desks back to back (users face each other across the pair), `per` pairs side
 * by side form a cluster, clusters in a row are split by an aisle of `gap`, rows spread across the
 * region with the chairs' pull-out space between them. `align` -1 starts the rows at the region's
 * low end along the row axis (next to the windows when the rows run away from them).
 */
function benchPoses(ctx: Ctx, g: Group, spec: Extract<Spec, { kind: 'array' }>): Pose[] | null {
  const n = g.roots.length, f0 = ctx.byId.get(g.roots[0])!, W = f0.w, D = f0.d, pairs = Math.ceil(n / 2);
  const { gap, per, align } = spec.bench!;
  if (per === 0) return classRows(ctx, g, spec);
  const u = { x: Math.cos(spec.rot), y: Math.sin(spec.rot) }, v = { x: -Math.sin(spec.rot), y: Math.cos(spec.rot) };
  const cx = (spec.x0 + spec.x1) / 2, cy = (spec.y0 + spec.y1) / 2;
  const ex = Math.abs(u.x) * (spec.x1 - spec.x0) / 2 + Math.abs(u.y) * (spec.y1 - spec.y0) / 2;
  const ey = Math.abs(v.x) * (spec.x1 - spec.x0) / 2 + Math.abs(v.y) * (spec.y1 - spec.y0) / 2;
  const rows = spec.rows, cols = spec.cols;
  if (rows * cols < pairs) return null;
  const half = D + Math.max(f0.clearance.front, 0.75); // a pair with its chairs' pull-out, from the centre line
  const rowLen = (k: number) => k * W + (Math.ceil(k / per) - 1) * gap;
  if (rowLen(cols) / 2 > ex + 1e-6) return null;
  const ys = rows === 1 ? [0] : Array.from({ length: rows }, (_, i) => -ey + half + (i * (2 * ey - 2 * half)) / (rows - 1));
  if (rows > 1 && ys[1] - ys[0] < 2 * half + 0.6) return null; // a walkway between the chairs of neighbouring rows
  const out: Pose[] = [];
  let k = 0;
  for (let i = 0; i < rows && k < n; i++) {
    const inRow = Math.min(cols, pairs - i * cols);
    const len = rowLen(inRow);
    const start = align < 0 ? -ex : align > 0 ? ex - len : -len / 2;
    for (let j = 0; j < inRow && k < n; j++) {
      const lx = start + W / 2 + j * W + Math.floor(j / per) * gap, ly = ys[i];
      const at = (dy: number) => ({ x: cx + u.x * lx + v.x * (ly + dy), y: cy + u.y * lx + v.y * (ly + dy) });
      out.push({ ...at(D / 2 + 0.002), rotation: spec.rot }); k++;
      if (k < n) { out.push({ ...at(-D / 2 - 0.002), rotation: spec.rot + Math.PI }); k++; }
    }
  }
  return out.length === n ? out : null;
}

/** Place a whole group for one root spec. Optional pieces that do not fit are deferred. */
function placeGroup(ctx: Ctx, others: FurnitureItem[], g: Group, spec: Spec, mirror: boolean, check = true): { items: FurnitureItem[]; deferred: string[] } | { fail: string; root?: boolean } {
  const poses = rootPoses(ctx, g, spec);
  if (!poses) return { fail: 'shape' };
  const out: FurnitureItem[] = [];
  const placed = new Map<string, FurnitureItem>();
  const deferred: string[] = [];
  const ok = (cand: FurnitureItem[]) => !check || !fits(ctx, [...others, ...out], cand);
  const fail = (cand: FurnitureItem[]) => (check ? fits(ctx, [...others, ...out], cand) : null);
  for (let k = 0; k < g.roots.length; k++) {
    let f = withPose(ctx.byId.get(g.roots[k])!, poses[k]);
    if (mirror && spec.kind !== 'array' && !(spec.kind === 'wall' && spec.side) && asymmetric(f)) { f = { ...f, clearance: swapSides(f.clearance) }; ctx.swapped.add(f); }
    const why = fail([f]);
    if (why) return { fail: why, root: true };
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
    if (ctx.swapped.has(bed)) ctx.swapped.add(nb);
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

function wallSlots(ctx: Ctx, g: Group, side?: 1 | -1): Spec[] {
  const out: Spec[] = [];
  const root = ctx.byId.get(g.roots[0])!;
  for (const w of ctx.room.walls) {
    if (w.len < (side ? root.d : root.w) + 0.02) continue;
    const t0 = w.len / 2;
    const trial = placeGroup(ctx, [], g, { kind: 'wall', wall: w.i, t: t0, side }, false, false);
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
    for (const t of [...ts].sort((a, b) => a - b)) out.push({ kind: 'wall', wall: w.i, t: Math.round(t * 1000) / 1000, side });
  }
  return out;
}
const isSingleBed = (f: FurnitureItem) => (f.category === 'bed' || f.category === 'bunk-bed') && f.w < 1.2;
/** Daybed slots: a single bed side-on to a wall, for rooms too narrow to walk past its foot. */
function daybedSlots(ctx: Ctx, g: Group): Spec[] {
  return [...wallSlots(ctx, g, 1), ...wallSlots(ctx, g, -1)];
}
function narrowFor(ctx: Ctx, f: FurnitureItem): boolean {
  const b = ctx.room.box;
  return f.d + f.clearance.front + 0.6 > Math.min(b.maxX - b.minX, b.maxY - b.minY);
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
  if (g.bench) return benchSlots(ctx, g, items);
  const n = g.roots.length, f0 = ctx.byId.get(g.roots[0])!;
  const base = ctx.room.walls[0]?.rot ?? 0;
  const regions: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  const fr = freeRegion(ctx, items);
  if (fr) {
    regions.push(fr);
    // The free region grown back by the table's own use zone, which may overlap other use zones.
    const grow = Math.max(f0.clearance.front, f0.clearance.left, 0.3) * 0.8, b = ctx.room.box;
    const big = { x0: Math.max(b.minX, fr.x0 - grow), y0: Math.max(b.minY, fr.y0 - grow), x1: Math.min(b.maxX, fr.x1 + grow), y1: Math.min(b.maxY, fr.y1 + grow) };
    regions.push(big);
    // Keep a band clear along one side (window landings, a walkway past the counter).
    for (const r0 of [fr, big]) for (const band of [0.6, 1.0]) {
      regions.push({ ...r0, y0: r0.y0 + band }, { ...r0, y1: r0.y1 - band }, { ...r0, x0: r0.x0 + band }, { ...r0, x1: r0.x1 - band });
    }
  }
  const b = ctx.room.box;
  regions.push({ x0: b.minX, y0: b.minY, x1: b.maxX, y1: b.maxY });
  // The room minus a band along one wall (where a counter or sofa usually goes).
  for (const band of [0.8, 1.4]) {
    regions.push({ x0: b.minX + band, y0: b.minY, x1: b.maxX, y1: b.maxY }, { x0: b.minX, y0: b.minY, x1: b.maxX - band, y1: b.maxY });
    regions.push({ x0: b.minX, y0: b.minY + band, x1: b.maxX, y1: b.maxY }, { x0: b.minX, y0: b.minY, x1: b.maxX, y1: b.maxY - band });
  }
  const uniq = regions.filter((a, i) => regions.findIndex((b) => Math.abs(a.x0 - b.x0) + Math.abs(a.y0 - b.y0) + Math.abs(a.x1 - b.x1) + Math.abs(a.y1 - b.y1) < 0.15) === i);
  regions.length = 0; regions.push(...uniq);
  const shapes: Array<[number, number]> = [];
  for (let r = 1; r <= n; r++) { const c = Math.ceil(n / r); if (r * c - n < c) shapes.push([r, c]); }
  const rots = Math.abs(f0.w - f0.d) < 0.01 ? [base] : [base, base + Math.PI / 2];
  const out: Spec[] = [];
  const reach = Math.max(f0.w, f0.d) / 2 + Math.max(f0.clearance.front, f0.clearance.back, f0.clearance.left, f0.clearance.right) + 0.17;
  // Many tables: the grid shape and region decide; fewer seat strategies keep the search small.
  const strategies = n > 4 ? [1, 0] : n > 1 ? [1, 0, 2] : [0];
  const hugs = n > 4 ? [reach + 0.45] : [reach + 0.45, reach + 0.3];
  for (const reg of regions) for (const [rows, cols] of shapes) for (const rot of rots) for (const strategy of strategies) {
    out.push({ kind: 'array', ...reg, rows, cols, rot, strategy });
    // Tables pushed out towards the walls, seats with pull-out room behind them, central aisles.
    if (n > 1) for (const hug of hugs) out.push({ kind: 'array', ...reg, rows, cols, rot, strategy, hug });
    if (n === 1) {
      // A lone table also tries the middle of the room and nudges off the region centre.
      const cx = (reg.x0 + reg.x1) / 2, cy = (reg.y0 + reg.y1) / 2;
      for (const [dx, dy] of [[0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]]) out.push({ kind: 'array', x0: cx + dx - 0.5, x1: cx + dx + 0.5, y0: cy + dy - 0.5, y1: cy + dy + 0.5, rows: 1, cols: 1, rot, strategy: 0 });
    }
  }
  return out;
}

/** Classroom rows: every desk faces the same way (towards the board), rows split by a walkway. */
function classRows(ctx: Ctx, g: Group, spec: Extract<Spec, { kind: 'array' }>): Pose[] | null {
  const n = g.roots.length, f0 = ctx.byId.get(g.roots[0])!, W = f0.w, D = f0.d;
  const u = { x: Math.cos(spec.rot), y: Math.sin(spec.rot) }, v = { x: -Math.sin(spec.rot), y: Math.cos(spec.rot) };
  const cx = (spec.x0 + spec.x1) / 2, cy = (spec.y0 + spec.y1) / 2;
  const ex = Math.abs(u.x) * (spec.x1 - spec.x0) / 2 + Math.abs(u.y) * (spec.y1 - spec.y0) / 2;
  const ey = Math.abs(v.x) * (spec.x1 - spec.x0) / 2 + Math.abs(v.y) * (spec.y1 - spec.y0) / 2;
  const rows = spec.rows, cols = spec.cols, gap = spec.bench!.gap;
  if (rows * cols < n) return null;
  const pitch = D + Math.max(f0.clearance.front, 0.75) + 0.25; // desk, chair pull-out, a narrow pass
  const len = cols * W + (cols > 3 ? gap : 0);
  if (len / 2 > ex + 1e-6 || rows * pitch > 2 * ey + 1e-6) return null;
  const out: Pose[] = [];
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols && out.length < n; j++) {
    const lx = -len / 2 + W / 2 + j * W + (cols > 3 && j >= Math.ceil(cols / 2) ? gap : 0);
    const ly = -ey + D / 2 + i * pitch + (2 * ey - rows * pitch) / 2;
    // Front (the chair side) faces +v, so everyone looks towards -v.
    out.push({ x: cx + u.x * lx + v.x * ly, y: cy + u.y * lx + v.y * ly, rotation: spec.rot });
  }
  return out.length === n ? out : null;
}

function benchSlots(ctx: Ctx, g: Group, items: FurnitureItem[]): Spec[] {
  const pairs = Math.ceil(g.roots.length / 2);
  const board = [...ctx.byId.values()].some((f) => f.category === 'tv-unit');
  if (board && g.roots.length >= 6) {
    // A room with a board: rows facing it, each way round; the rules pick the one that looks at the board.
    const b = ctx.room.box, base = ctx.room.walls[0]?.rot ?? 0, n = g.roots.length, out: Spec[] = [];
    const regions = [{ x0: b.minX + 0.8, y0: b.minY + 0.8, x1: b.maxX - 0.8, y1: b.maxY - 0.8 }, { x0: b.minX + 0.6, y0: b.minY + 1.4, x1: b.maxX - 0.6, y1: b.maxY - 0.6 }, { x0: b.minX + 0.6, y0: b.minY + 0.6, x1: b.maxX - 0.6, y1: b.maxY - 1.4 }, { x0: b.minX + 1.4, y0: b.minY + 0.6, x1: b.maxX - 0.6, y1: b.maxY - 0.6 }, { x0: b.minX + 0.6, y0: b.minY + 0.6, x1: b.maxX - 1.4, y1: b.maxY - 0.6 }];
    // Once the board is up, the rows turn to face it.
    const tv = items.find((f) => f.category === 'tv-unit');
    const look = tv ? { x: tv.x - ctx.room.centre.x, y: tv.y - ctx.room.centre.y } : null;
    const qs = look ? [[0, 1, 2, 3].sort((a, c) => { const va = base + (a * Math.PI) / 2, vc = base + (c * Math.PI) / 2; return (Math.sin(va) * look.x - Math.cos(va) * look.y) > (Math.sin(vc) * look.x - Math.cos(vc) * look.y) ? -1 : 1; })[0]] : [0, 1, 2, 3];
    for (let r = 2; r <= n; r++) { const c = Math.ceil(n / r); if (r * c - n >= c) continue; for (const reg of regions) for (const q of qs) out.push({ kind: 'array', ...reg, rows: r, cols: c, rot: base + (q * Math.PI) / 2, strategy: 0, bench: { gap: 0.9, per: 0, align: 0 } }); }
    return out;
  }
  const b = ctx.room.box, base = ctx.room.walls[0]?.rot ?? 0;
  // Rows run away from the main window wall, so every desk gets daylight from the side.
  const winLen = new Map<number, number>();
  for (const w of ctx.room.windows) winLen.set(w.wall, (winLen.get(w.wall) ?? 0) + w.o.widthM);
  const main = [...winLen.entries()].sort((a, c) => c[1] - a[1])[0];
  const options: Array<{ rot: number; align: number }> = [];
  if (main) {
    const n = ctx.room.walls[main[0]].n;
    // u (the row axis) points away from the window wall; align -1 starts each row at the window.
    options.push({ rot: Math.atan2(n.y, n.x), align: -1 }, { rot: Math.atan2(n.y, n.x), align: 0 });
  } else options.push({ rot: base, align: 0 }, { rot: base + Math.PI / 2, align: 0 });
  const regions: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  const fr = freeRegion(ctx, items);
  if (fr) regions.push(fr);
  // The room less a walkway band along the walls (1.0 m by the windows, 0.9 m elsewhere).
  for (const band of [0.9, 1.2]) regions.push({ x0: b.minX + band, y0: b.minY + band, x1: b.maxX - band, y1: b.maxY - band });
  regions.push({ x0: b.minX + 0.9, y0: b.minY + 0.9, x1: b.maxX - 1.8, y1: b.maxY - 0.9 }, { x0: b.minX + 1.8, y0: b.minY + 0.9, x1: b.maxX - 0.9, y1: b.maxY - 0.9 });
  const out: Spec[] = [];
  // Clusters of 2 to 6 desks (1-3 pairs), split by a 1.2 m aisle.
  for (const per of [3, 2, 1]) {
    if (per > pairs) continue;
    for (let r = 1; r <= pairs; r++) {
      const c = Math.ceil(pairs / r);
      if (r * c - pairs >= c) continue;
      for (const reg of regions) for (const o of options) out.push({ kind: 'array', ...reg, rows: r, cols: c, rot: o.rot, strategy: 0, bench: { gap: 1.2, per, align: o.align } });
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
  // Pieces with a front (a reception desk, an armchair) may face any of the four ways.
  const rots = semanticsOf(f).faces === 'none' ? [base, base + Math.PI / 2] : [base, base + Math.PI / 2, base + Math.PI, base - Math.PI / 2];
  for (let x = b.minX + 0.3; x < b.maxX; x += 0.3) for (let y = b.minY + 0.3; y < b.maxY; y += 0.3) for (const rot of rots) out.push({ kind: 'free', x, y, rot });
  return out;
}

function slotsFor(ctx: Ctx, g: Group, items: FurnitureItem[]): Spec[] {
  if (g.kind === 'fixed') return [{ kind: 'fixed' }];
  if (g.kind === 'array') return arraySlots(ctx, g, items);
  if (g.kind === 'wall') {
    const root = ctx.byId.get(g.roots[0])!;
    const w = [...wallSlots(ctx, g), ...(isSingleBed(root) && narrowFor(ctx, root) ? daybedSlots(ctx, g) : [])];
    return w.length ? w : freeSlots(ctx, g);
  }
  return freeSlots(ctx, g);
}
const hasChoice = (ctx: Ctx, g: Group) => ((g.kind !== 'array' && asymmetric(ctx.byId.get(g.roots[0])!)) || g.members.some((id) => { const r = ctx.parent.get(id)?.rel.kind; return r === 'flanks' || r === 'beside' || r === 'paired-seat'; }));

// ---------------------------------------------------------------- scoring
function layoutCtx(ctx: Ctx, items: FurnitureItem[]): LayoutCtx { return analyse(ctx.room, items, ctx.req, ctx.cache); }
/** Taste as a small signed term (about -0.15 .. +0.15): each weight above 1 rewards its trait, below 1 rewards the opposite. */
function tasteTerm(ctx: Ctx, items: FurnitureItem[]): number {
  const w = ctx.taste;
  if (!w) return 0;
  const f = layoutFeatures(ctx.model, items);
  const rels = Object.values(f.rel) as number[];
  const near = rels.length ? 0.5 - rels.reduce((t, x) => t + x, 0) / rels.length : 0; // + near the window
  return 0.3 * ((w.wall - 1) * (f.hug - 0.5) + (w.open - 1) * (f.open - 0.5) + (w.window - 1) * near);
}
function scoreItems(ctx: Ctx, items: FurnitureItem[]): number {
  const L = layoutCtx(ctx, items);
  const v = evaluateCtx(L, { fast: true });
  return 0.8 * (designScore(v) / 100) + 0.2 * programScore(ctx.program, L) + tasteTerm(ctx, items) + ctx.noise();
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
  if (s.kind === 'array') return `arr${s.rows}x${s.cols}r${Math.round(s.rot * 10)}s${s.strategy}${s.hug ? 'h' : ''}${s.bench ? `b${s.bench.per}${s.bench.align}` : ''}`;
  if (s.kind === 'free') return `f${Math.round(s.x)}:${Math.round(s.y)}`;
  return 'fixed';
}
/** The design decisions of a layout: each anchor's wall and orientation, or the table grid. */
function anchorSig(ctx: Ctx, st: State): string {
  return st.placed.filter((p) => !p.group.fixed && p.group.priority >= 40 && p.items[0].w * p.items[0].d >= 0.4).map((p) => {
    const s = p.spec;
    if (s.kind === 'wall') return `${p.group.id}@w${s.wall}${s.side ? 's' : ''}`;
    if (s.kind === 'array') return `${p.group.id}@a${s.rows}x${s.cols}r${Math.round(s.rot * 2 / Math.PI)}`;
    if (s.kind === 'free') { const b = ctx.room.box; return `${p.group.id}@f${s.x < (b.minX + b.maxX) / 2 ? 'w' : 'e'}${s.y < (b.minY + b.maxY) / 2 ? 'n' : 's'}${Math.round(s.rot * 2 / Math.PI) & 3}`; }
    return p.group.id;
  }).sort().join('|');
}
/** Where the most important movable anchor went: its wall (or table grid / free quarter). */
function mainKey(ctx: Ctx, st: State): string | null {
  const p = st.placed.filter((q) => !q.group.fixed && q.group.priority >= 40).sort((a, b) => b.group.priority - a.group.priority)[0];
  if (!p) return null;
  const s = p.spec;
  if (s.kind === 'wall') return `${p.group.id}@w${s.wall}${s.side ? 's' : ''}`;
  if (s.kind === 'array') return `${p.group.id}@a${s.rows}x${s.cols}r${Math.round(s.rot * 2 / Math.PI) & 1}`;
  if (s.kind === 'free') { const b = ctx.room.box; return `${p.group.id}@f${s.x < (b.minX + b.maxX) / 2 ? 'w' : 'e'}${s.y < (b.minY + b.maxY) / 2 ? 'n' : 's'}`; }
  return null;
}

/** The main idea of a layout in machine-readable form: where each anchor went and how open the middle is. */
export interface LayoutIdea {
  /** Stable text key: equal keys mean the same idea. */
  key: string;
  anchors: Array<{ id: string; category: string; wall: number | null; compass: string | null; atWindow: boolean }>;
  centre: 'open' | 'zoned';
  /** Largest open rectangle as a share of the floor (0..1). */
  openShare: number;
}
function ideaOf(ctx: Ctx, st: State, openAreaM2: number): LayoutIdea {
  const anchors = st.placed.filter((p) => !p.group.fixed && p.group.priority >= 45).sort((a, b) => b.group.priority - a.group.priority).map((p) => {
    const f = p.items[0], wall = p.spec.kind === 'wall' ? p.spec.wall : null;
    return { id: f.id, category: f.category, wall, compass: wall == null ? null : compass(ctx, wall), atWindow: nearWindow(ctx, f) };
  });
  const b = ctx.room.box;
  let area = 0;
  const poly = ctx.room.poly;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], q = poly[(i + 1) % poly.length]; area += a.x * q.y - q.x * a.y; }
  area = Math.abs(area) / 2 || (b.maxX - b.minX) * (b.maxY - b.minY);
  const openShare = Math.round(Math.min(1, openAreaM2 / area) * 100) / 100;
  const centre = openShare >= 0.2 ? 'open' : 'zoned';
  return { key: [...anchors.map((a) => `${a.category}:${a.compass ?? 'free'}${a.atWindow ? '+window' : ''}`), centre].join('|'), anchors, centre, openShare };
}

/** Compass name of a wall from its inward normal (the top of the plan is north). */
function compass(ctx: Ctx, wi: number): string {
  const n = ctx.room.walls[wi].n;
  return Math.abs(n.y) >= Math.abs(n.x) ? (n.y > 0 ? 'north' : 'south') : (n.x > 0 ? 'west' : 'east');
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
    if (spec.kind === 'wall' && spec.side) return 'Bed along the wall, daybed style';
    const w = ctx.room.walls[wall];
    const facesWin = ctx.room.windows.some((o) => dot(o.inward, w.n) < -0.9);
    if (root.w < 1.2 && cls(ctx, p) !== `w${wall}mid`) return 'Bed tucked in the corner';
    if (facesWin) return 'Bed facing the window';
    return `Bed on the ${wallWord(ctx, wall)}`;
  }
  if (spec.kind === 'array' && spec.bench && spec.bench.per === 0) return `Desks in ${spec.rows} rows facing the board`;
  if (spec.kind === 'array' && spec.bench) {
    const pairs = Math.ceil(p.group.roots.length / 2), clusters = Math.ceil(Math.min(spec.cols, pairs) / spec.bench.per) * spec.rows;
    const run = ctx.room.windows.length ? ' running from the windows' : '';
    return clusters > 1 ? `Desks in ${clusters} facing clusters of ${spec.bench.per * 2}${run}` : `Desks in one facing cluster${run}`;
  }
  if (c === 'desk' && st.placed.some((q) => q.spec.kind === 'array' && q.spec.bench)) return wall != null ? `${root.name.replace(/\s+\d.*$/, '')} on the ${wallWord(ctx, wall)}` : 'Desk in the room';
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
  if (c === 'tv-unit' && !p.items.some((f) => /^sofa/.test(f.category)) && ![...ctx.byId.values()].some((f) => /^sofa/.test(f.category))) return wall != null ? `Screen on the ${wallWord(ctx, wall)}` : 'Screen in the room';
  if (c === 'tv-unit') {
    const sofa = p.items.find((f) => /^sofa/.test(f.category));
    const floating = sofa && !layoutCtx(ctx, st.items).byId.get(sofa.id)?.back;
    const where = wall != null ? ` on the ${wallWord(ctx, wall)}` : '';
    return floating ? `Floating sofa, TV${where}` : `Lounge around the TV${where}`;
  }
  if (c === 'sofa' || c === 'sofa-bed') return wall != null ? `Sofa on the ${wallWord(ctx, wall)}` : 'Sofa in the room';
  if (c === 'reception-desk') {
    const seat = toPlanOf(root, 0, root.d / 2 + 0.45), door = ctx.room.doors[0];
    const facing = door && dot({ x: Math.sin(root.rotation), y: -Math.cos(root.rotation) }, sub(door.c, seat)) > 0;
    return facing ? 'Reception desk facing the entrance' : 'Reception desk in the room';
  }
  if (c === 'counter') {
    const door = ctx.room.doors[0];
    if (door && polyDist([door.a, door.b, door.b, door.a], [toPlanOf(root, -root.w / 2, -root.d / 2), toPlanOf(root, root.w / 2, -root.d / 2), toPlanOf(root, root.w / 2, root.d / 2), toPlanOf(root, -root.w / 2, root.d / 2)]) < 1.6) return 'Counter by the door';
    if (wall != null && door && dot(ctx.room.walls[wall].n, door.inward) < -0.9) return 'Counter facing the door';
    return wall != null ? `Counter on the ${wallWord(ctx, wall)}` : 'Counter in the room';
  }
  if (spec.kind === 'array') {
    const n = p.group.roots.length, name = 'Tables';
    if (n === 1) return `${root.name} centred`;
    const grid = spec.rows === 1 || spec.cols === 1 ? `${name} in a row of ${n}` : `${name} in a ${spec.rows} x ${spec.cols} grid`;
    return spec.hug ? `${grid} around a centre aisle` : `${grid}, evenly spaced`;
  }
  const noun = root.name.replace(/\s+\d.*$/, '');
  if (wall != null) {
    const c2 = cls(ctx, p);
    if (c2.endsWith('a') || c2.endsWith('b')) {
      const near = (os: typeof ctx.room.doors) => os.some((o) => polyDist([o.a, o.b, o.b, o.a], [toPlanOf(root, -root.w / 2, -root.d / 2), toPlanOf(root, root.w / 2, -root.d / 2), toPlanOf(root, root.w / 2, root.d / 2), toPlanOf(root, -root.w / 2, root.d / 2)]) < 1.2);
      return `${noun} in the ${near(ctx.room.doors) ? 'door ' : near(ctx.room.windows) ? 'window ' : ''}corner`;
    }
    return `${noun} on the ${wallWord(ctx, wall)}`;
  }
  return noun;
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
/**
 * Seats always belong to a desk, table or counter by the same rule (one chair per desk first), so a
 * planner that pairs two chairs with one desk cannot leave the other desk without a chair or turn a
 * chair towards the wrong desk. Planner reasons for those seats are kept where they still apply.
 */
export function withSeatHosts(program: DesignProgram, items: FurnitureItem[]): DesignProgram {
  const byId = new Map(items.map((f) => [f.id, f]));
  const hosts = assignSeatHosts(items);
  const isSeat = (id: string) => { const f = byId.get(id); return !!f && isSeatCategory(f.category); };
  const seatRel = (r: Relation) => isSeat(r.subject) && !!r.target && byId.has(r.target) && ['paired-seat', 'faces', 'beside', 'in-front-of', 'flanks'].includes(r.kind);
  const kept = program.relations.filter((r) => !seatRel(r));
  const added: Relation[] = [];
  for (const [seat, host] of hosts) {
    const old = program.relations.find((r) => r.subject === seat && r.target === host && seatRel(r));
    const h = byId.get(host)!;
    added.push({ kind: 'paired-seat', subject: seat, target: host, weight: 1, reason: old?.reason ?? `A seat drawn up to the ${h.name.toLowerCase()}, with room behind to pull it out.` });
  }
  return added.length || kept.length !== program.relations.length ? { ...program, relations: [...kept, ...added] } : program;
}

/** Only the relations a layout actually honours, so every reason shown matches what was placed. */
function honoured(program: DesignProgram, L: LayoutCtx): DesignProgram {
  return { ...program, relations: program.relations.filter((r) => { const v = relationScore(r, L); return v == null || v >= 0.75; }) };
}

async function solveOnce(model: SpaceModel, items: FurnitureItem[], programIn: DesignProgram, opts: SolveProgramOptions = {}): Promise<SolveResult> {
  const t0 = now();
  // Work budget: how many backtracks and local-pass evaluations the search may spend.
  const effort = Math.max(0.3, Math.min(3, (opts.timeBudgetMs ?? 1500) / 1500));
  const maxBacktracks = Math.round(12 * effort);
  const localEvals = Math.round(140 * effort);
  const wallMs = opts.maxWallMs ?? 20000;
  const late = () => now() - t0 > wallMs;
  const variants = Math.max(1, Math.min(6, opts.variants ?? 3));
  const seed = opts.seed ?? 1;
  const space = spaceOf(model, opts.spaceId);
  if (!space || space.polygon.length < 3) return { candidates: [], reports: [], infeasibility: { reasons: ['No room outline yet'], relaxations: [] } };
  if (!items.length) return { candidates: [], reports: [], infeasibility: { reasons: ['Nothing to place yet'], relaxations: [] } };
  // Wall-mounted pieces take no floor: solve the floor, then hang them on the walls of each layout.
  const mounted = items.filter(isMounted);
  if (mounted.length && mounted.length < items.length) {
    const ids = new Set(mounted.map((f) => f.id));
    const prog: DesignProgram = {
      ...programIn,
      relations: programIn.relations.filter((r) => !ids.has(r.subject) && !(r.target && ids.has(r.target))),
      zones: programIn.zones.map((z) => ({ ...z, itemIds: z.itemIds.filter((id) => !ids.has(id)) })),
      focalItemId: programIn.focalItemId && ids.has(programIn.focalItemId) ? undefined : programIn.focalItemId,
    };
    const res = await solveOnce(model, items.filter((f) => !isMounted(f)), prog, opts);
    return { ...res, candidates: res.candidates.map((c) => ({ ...c, furniture: [...c.furniture, ...placeWallItems(model, c.furniture, mounted, opts.spaceId).placed] })) };
  }
  const room = buildRoom(model, space.id);
  const req = opts.req ?? null;
  const r = rng(seed * 2654435761);
  const fixed = new Set([...items.filter((f) => f.locked).map((f) => f.id), ...(opts.fixedIds ?? [])]);
  // Generated objects join in under a known category, with their own clearances and open footprint.
  const work = items.map((f) => { const n = normaliseItem(f); return { ...n, clearance: { ...n.clearance } }; });
  const original = new Map(items.map((f) => [f.id, f]));
  const program = withSeatHosts(programIn, work);
  const restore = (list: FurnitureItem[]) => list.map((f) => { const o = original.get(f.id); return o ? { ...f, category: o.category, unfoldedD: o.unfoldedD } : f; });
  const ctx: Ctx = {
    room, model, program, req, byId: new Map(work.map((f) => [f.id, f])), clr: new Map(work.map((f) => [f.id, { ...f.clearance }])),
    flank: new Map(), parent: new Map(), children: new Map(), cache: new Map(), routes: [], routeWidth: 0.8,
    noise: () => (r() - 0.5) * 0.002, rejects: new Map(), swapped: new WeakSet(), staticFit: new Map(),
    taste: (() => { const p = opts.taste === undefined ? activeProfile() : opts.taste; return p ? tasteWeights(p).solver : null; })(),
  };
  buildTree(ctx, work, fixed);
  // Chairs at tables keep room behind them to pull out and to pass (the referee does not ask this,
  // the solver does, so a cafe never boxes floor in between chair backs).
  for (const [id, link] of ctx.parent) {
    const host = ctx.byId.get(link.id);
    if (link.rel.kind === 'paired-seat' && host && /^(table|cafe-table)$/.test(host.category)) ctx.clr.set(id, { ...ctx.clr.get(id)!, back: Math.max(ctx.clr.get(id)!.back, 0.45) });
  }
  let groups = buildGroups(ctx, work, fixed);
  const targets = req ? req.routeTargets : room.windows.length ? [{ kind: 'window' as const }] : [];
  ctx.routeWidth = req ? req.minRouteWidthM : 0.8;
  ctx.routes = routeBases(room, targets, ctx.routeWidth);
  const softRoute = !req; // without a brief the walkway to the window is a wish, not a rule
  const routeOk = (list: FurnitureItem[]) => routeCheck(ctx.routes, list).ok;

  // A narrower beam for big rooms: their anchors are arrays that already carry most of the decisions.
  const big = work.length > 20;
  const B = big ? 3 : groups.length > 7 ? 5 : 7, K = big ? 3 : 5;
  const relaxed = new Set<string>();
  let states: State[] = [{ placed: [], items: [], deferred: [], dropped: [], score: 0 }];
  let failedGroup: Group | null = null;
  let lastPlaced: string[] = [];
  let lastYield = now();
  const spare: State[][] = [];
  let backtracks = 0;
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (now() - lastYield > 40) { await tick(); lastYield = now(); }
    const next: State[] = [];
    ctx.rejects.clear();
    const gIds = new Set(g.members);
    for (const st of states) {
      if (next.length && late()) break;
      let specs = slotsFor(ctx, g, st.items);
      const mirrors = hasChoice(ctx, g) ? [false, true] : [false];
      const cands: Array<{ spec: Spec; mirror: boolean; items: FurnitureItem[]; deferred: string[]; q: number; wallKey: string; split: number }> = [];
      // Seat strategies and mirroring do not move the anchors: once the anchors fail, skip their variants.
      const rootFails = new Set<string>();
      for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) {
        // Head to the wall found no spot: try a single bed side-on to a wall.
        const root = ctx.byId.get(g.roots[0])!;
        if (cands.length || g.kind !== 'wall' || !isSingleBed(root) || narrowFor(ctx, root)) break;
        specs = daybedSlots(ctx, g);
      }
      for (const spec of specs) for (const mirror of mirrors) {
        const rootKey = spec.kind === 'array' ? `${spec.x0},${spec.y0},${spec.x1},${spec.y1},${spec.rows},${spec.cols},${spec.rot},${spec.hug ?? 0},${spec.bench ? `${spec.bench.per}${spec.bench.align}` : -1}` : null;
        if (rootKey && rootFails.has(rootKey)) continue;
        const res = placeGroup(ctx, st.items, g, spec, mirror);
        if ('fail' in res && res.root && rootKey) rootFails.add(rootKey);
        if ('fail' in res) { const k = res.fail.split(':')[0] === 'overlap' || res.fail.split(':')[0] === 'use' ? res.fail : res.fail.split(':')[0]; ctx.rejects.set(k, (ctx.rejects.get(k) ?? 0) + 1); continue; }
        const all = [...st.items, ...res.items];
        // A seating group placed whole beats one that leaves an armchair to find a spot on its own.
        const split = res.deferred.filter((id) => !OPTIONAL.has(ctx.byId.get(id)!.category)).length;
        cands.push({ spec, mirror, items: res.items, deferred: res.deferred, q: quickScore(ctx, all, gIds) - 0.3 * split, wallKey: spec.kind === 'wall' ? `w${spec.wall}` : spec.kind, split });
      }
      }
      if (DBG && g.kind === 'array') console.log('  state', st.placed.map((p) => cls(ctx, p)).join(','), 'specs', specs.length, 'cands', cands.length, [...ctx.rejects].map(([k, n]) => `${k}=${n}`).join(' '));
      if (!cands.length) continue;
      // Keep the best few per wall so every wall stays in play, then score those in full.
      cands.sort((a, b) => b.q - a.q);
      const perWall = new Map<string, number>(), short: typeof cands = [];
      for (const c of cands) { const n = perWall.get(c.wallKey) ?? 0; if (n < 4) { short.push(c); perWall.set(c.wallKey, n + 1); } }
      const cap = work.length > 20 ? 8 : 14;
      for (const c of cands) if (short.length < cap && !short.includes(c)) short.push(c);
      const scored = short.map((c) => ({ c, s: scoreItems(ctx, [...st.items, ...c.items]) - 0.06 * c.split })).sort((a, b) => b.s - a.s);
      // If every short-listed spot closes the walkway, keep looking down the list (best quick score first).
      if (!softRoute) {
        const rest = cands.filter((c) => !short.includes(c));
        let tries = 0, found = scored.some(({ c }) => routeOk([...st.items, ...c.items]));
        while (rest.length && tries < 40 && !found) {
          const c = rest.shift()!; tries++;
          if (routeOk([...st.items, ...c.items])) { scored.push({ c, s: scoreItems(ctx, [...st.items, ...c.items]) - 0.06 * c.split }); found = true; }
        }
      }
      let kept = 0;
      for (const { c, s } of scored) {
        if (kept >= Math.max(K, Math.ceil((B * 2) / states.length))) break;
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
      // Tables that only fit tightly: drop the extra room behind their chairs and try again (the rules then say so).
      if (g.kind === 'array' && !relaxed.has(g.id)) {
        relaxed.add(g.id);
        for (const id of g.members) { const o = ctx.byId.get(id)!; if (ctx.clr.get(id)!.back !== o.clearance.back) ctx.clr.set(id, { ...ctx.clr.get(id)!, back: o.clearance.back }); }
        gi--;
        continue;
      }
      // Backtrack: resume from the best untried states of the deepest earlier level that has some.
      let j = gi - 1;
      while (j >= 0 && !(spare[j]?.length)) j--;
      if (j >= 0 && backtracks < maxBacktracks && !late()) {
        backtracks++;
        states = spare[j].splice(0, B);
        gi = j;
        continue;
      }
      if (DBG) console.log('fail', g.id, [...ctx.rejects], 'spare', spare.map((x) => x?.length), 'bt', backtracks, states.map((st) => st.placed.map((p) => `${p.group.id}:${JSON.stringify(p.spec)}`).join(' ')));
      failedGroup = g;
      lastPlaced = states[0]?.items.map((f) => f.name) ?? [];
      break;
    }
    // Diverse beam: best per signature first, then by score.
    next.sort((a, b) => b.score - a.score);
    const seen = new Set<string>(), beam: State[] = [], rest: State[] = [], dup: State[] = [];
    // One state per concept first (so 'side by side' survives next to 'facing walls'), then per signature.
    const ideas = new Set<string>();
    // The main anchor on each wall it can take survives first: the variants are built on that choice.
    const mains = new Set<string>();
    for (const st of next) {
      if (beam.length >= Math.ceil(B / 2)) break;
      const mk = mainKey(ctx, st);
      if (mk && !mains.has(mk)) { mains.add(mk); ideas.add(conceptName(ctx, st, 2)); seen.add(signature(ctx, st)); beam.push(st); }
    }
    for (const st of next) {
      if (beam.length >= Math.ceil(B / 2) + 1) break;
      if (beam.includes(st)) continue;
      const idea = conceptName(ctx, st, 2);
      if (!ideas.has(idea)) { ideas.add(idea); seen.add(signature(ctx, st)); beam.push(st); }
    }
    for (const st of next) {
      if (beam.includes(st)) continue;
      const sg = signature(ctx, st);
      if (!seen.has(sg)) { seen.add(sg); (beam.length < B ? beam : rest).push(st); } else dup.push(st);
    }
    spare[gi] = [...rest, ...dup].slice(0, 40);
    states = beam;
    if (DBG) console.log('group', g.id, 'states', states.length, 'next', next.length, 'ms', Math.round(now() - t0));
    opts.onProgress?.(((gi + 1) / groups.length) * 0.6);
  }

  if (failedGroup || !states.length) {
    if (softRoute && ctx.routes.length) {
      // Last resort without a brief: allow the window walkway to narrow and say so.
      return solveOnce(model, items, program, { ...opts, req: { purpose: '', people: 1, budgetSek: null, items: [], routeTargets: [], minRouteWidthM: 0.8, style: '', lockedIds: [], notes: [], questions: [], compiledBy: 'rules' } });
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
  // Which pieces could not be seated in the best state: lets the caller give up exactly those.
  let unplaced: string[] | undefined;
  {
    const lost = (st: State) => st.dropped.filter((id) => !OPTIONAL.has(ctx.byId.get(id)!.category));
    const keep = states.filter((st) => !lost(st).length);
    if (!keep.length && states.length) unplaced = states.map(lost).sort((a, b) => a.length - b.length)[0];
    states = keep;
  }

  // Local pass: slide, flip and nudge each group while the score rises, for a fixed number of evaluations.
  const improve = async (st: State): Promise<State> => {
    let cur = st;
    let evals = 0;
    for (let pass = 0; pass < 3; pass++) {
      let better = false;
      for (let k = 0; k < cur.placed.length; k++) {
        const p = cur.placed[k];
        if (p.group.fixed || p.spec.kind === 'array') continue;
        if (evals >= localEvals || late()) return cur;
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
          evals++;
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
  // Improve one state per concept first, so the variants differ in idea, not just in centimetres.
  const pool: State[] = [];
  const order = [...states].sort((a, b) => b.score - a.score);
  const picks: State[] = [], concepts = new Set<string>();
  for (const st of order) { const c = conceptName(ctx, st, 1); if (!concepts.has(c)) { concepts.add(c); picks.push(st); } }
  const sigs = new Set(picks.map((st) => anchorSig(ctx, st)));
  for (const st of order) { const sg = anchorSig(ctx, st); if (!picks.includes(st) && !sigs.has(sg)) { sigs.add(sg); picks.push(st); } }
  for (const st of order) if (!picks.includes(st)) picks.push(st);
  for (const st of picks.slice(0, variants + (work.length > 20 ? 1 : 2))) pool.push(await improve(st));
  if (DBG) console.log('improved', pool.length, Math.round(now() - t0));
  opts.onProgress?.(0.85);

  // Full evaluation, referee, variety.
  const finals: Array<{ st: State; verdicts: RuleVerdict[]; checks: ValidationResult[]; ds: number; sig: string }> = [];
  // Checks the empty room already fails (an opening drawn past its wall end) say nothing about the
  // furniture: they stay in the report but do not reject every layout.
  const roomFails = new Set(validateLayout(model, [], req, { spaceId: space.id }).filter((c) => c.result === 'fail').map((c) => c.id));
  for (const st of pool) {
    const checks = validateLayout(model, restore(st.items), req, { spaceId: space.id });
    if (checks.some((c) => c.result === 'fail' && !roomFails.has(c.id))) { if (DBG) console.log('REFEREE', checks.filter((c) => c.result === 'fail').map((c) => c.id + ' ' + c.rule + ' ' + c.measured + '/' + c.threshold + ' ' + c.subjectIds)); continue; }
    const L = layoutCtx(ctx, st.items);
    const verdicts = evaluateCtx(L);
    finals.push({ st, verdicts, checks, ds: designScore(verdicts) + programScore(program, L) * 2 + tasteTerm(ctx, st.items) * 60, sig: signature(ctx, st, 1) });
  }
  finals.sort((a, b) => b.ds - a.ds);
  const chosen: typeof finals = [];
  // First, one layout per wall the main anchor (bed, sofa, desk...) takes: the biggest decision in a room.
  for (const f of finals) {
    if (chosen.length >= variants) break;
    const mk = mainKey(ctx, f.st);
    if (mk && f.ds >= (finals[0]?.ds ?? 0) - 15 && !chosen.some((c) => mainKey(ctx, c.st) === mk)) chosen.push(f);
  }
  // Variants must differ in a design decision: which wall or orientation an anchor takes, or how the
  // tables are arranged. A layout that only moves a small piece is a near-duplicate and is dropped,
  // even if that leaves fewer variants. A different concept first, then any other anchor decision.
  for (const f of finals) {
    if (chosen.length >= variants) break;
    const cn = conceptName(ctx, f.st, 1), sg = anchorSig(ctx, f.st);
    if (f.ds >= (finals[0]?.ds ?? 0) - 12 && !chosen.some((c) => conceptName(ctx, c.st, 1) === cn || anchorSig(ctx, c.st) === sg)) chosen.push(f);
  }
  for (const f of finals) {
    if (chosen.length >= variants || chosen.includes(f) || f.ds < (finals[0]?.ds ?? 0) - 25) continue;
    const sg = anchorSig(ctx, f.st);
    if (!chosen.some((c) => anchorSig(ctx, c.st) === sg)) chosen.push(f);
  }
  if (!chosen.length) return { candidates: [], reports: [], infeasibility: infeasible(ctx, null, [], work, req), unplaced };

  const out: Array<{ verdicts: RuleVerdict[]; cand: SolvedCandidate }> = [];
  // Name: the first phrase, plus the first later phrase that tells same-named variants apart.
  const names = new Set<string>();
  const phrases = chosen.map((f) => f.st.placed.filter((p) => !p.group.fixed && p.group.priority >= 15).map((p) => phrase(ctx, f.st, p)));
  for (const [i, f] of chosen.entries()) {
    const ps = phrases[i];
    const twins = phrases.filter((q, j) => j !== i && q[0] === ps[0]);
    const extra = twins.length ? ps.slice(1).find((x, k) => twins.some((q) => q[k + 1] !== x)) : undefined;
    let name = ps.length ? ps[0] + (extra ? `, ${lc(extra)}` : '') : conceptName(ctx, f.st, 1);
    // Same words, different decision: say which wall the first differing anchor took.
    const sameName = chosen.some((c, j) => j !== i && (phrases[j][0] ?? '') === ps[0] && !phrases[j].slice(1).some((x, k) => x !== ps[k + 1]));
    if (sameName || names.has(name)) {
      const other = chosen.find((c, j) => j !== i && phrases[j][0] === ps[0]);
      const diff = f.st.placed.find((p) => !p.group.fixed && p.group.priority >= 40 && p.spec.kind === 'wall' && (!other || !other.st.placed.some((q) => q.group.id === p.group.id && q.spec.kind === 'wall' && q.spec.wall === (p.spec as { wall: number }).wall)));
      if (diff && diff.spec.kind === 'wall') name = `${ps[0]}, ${diff.items[0].name.replace(/\s+\d.*$/, '').toLowerCase()} on the ${compass(ctx, diff.spec.wall)} wall`;
    }
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
      ...(roomFails.size ? [`The room drawing itself fails ${roomFails.size} check${roomFails.size === 1 ? '' : 's'} before any furniture; fix the plan to clear ${roomFails.size === 1 ? 'it' : 'them'}`] : []),
      ...f.st.dropped.map((id) => `Left out the ${ctx.byId.get(id)!.name.toLowerCase()}: no spot without blocking something`),
    ];
    const ds = designScore(f.verdicts);
    const openArea = Math.round(largestOpenRect(g) * 10) / 10;
    out.push({
      verdicts: f.verdicts,
      cand: {
        id: uid('cand'), name, summary: '', parentVersion: model.version, furniture: restore(f.st.items), idea: ideaOf(ctx, f.st, openArea),
        metrics: { openAreaM2: openArea, costSek: cost, minClearanceM: minClearance(f.st.items), routeLenM: route.lengthM == null ? null : Math.round(route.lengthM * 10) / 10, score: ds },
        checks: f.checks, assumptions, generator: `design rules + relation solver, seed ${seed}`,
      },
    });
  }
  if (DBG) console.log('final', finals.length, chosen.length, finals.map((f) => f.sig + ' ' + Math.round(f.ds)), Math.round(now() - t0));
  summaries(out);
  opts.onProgress?.(1);
  return {
    candidates: out.map((o) => o.cand),
    reports: out.map((o) => ({ candidateId: o.cand.id, program: honoured(program, layoutCtx(ctx, o.cand.furniture.map((f) => ctx.byId.get(f.id) ? { ...ctx.byId.get(f.id)!, x: f.x, y: f.y, rotation: f.rotation } : f))), verdicts: o.verdicts })),
    infeasibility: null,
  };
}

// ---------------------------------------------------------------- graceful degradation
const without = (program: DesignProgram, gone: Set<string>): DesignProgram => ({
  ...program,
  relations: program.relations.filter((r) => !gone.has(r.subject) && !(r.target && gone.has(r.target))),
  zones: program.zones.map((z) => ({ ...z, itemIds: z.itemIds.filter((id) => !gone.has(id)) })),
  focalItemId: program.focalItemId && gone.has(program.focalItemId) ? undefined : program.focalItemId,
});

/** Pieces to give up, least important first: optional decor, then repeats of a piece, then the lowest-priority rest. */
function dropOrder(items: FurnitureItem[], fixed: Set<string>): FurnitureItem[] {
  const free = items.filter((f) => !f.locked && !fixed.has(f.id));
  const decor = free.filter((f) => OPTIONAL.has(f.category)).reverse();
  const rest = free.filter((f) => !OPTIONAL.has(f.category));
  const groups = new Map<string, FurnitureItem[]>();
  for (const f of rest) groups.set(f.catalogId, [...(groups.get(f.catalogId) ?? []), f]);
  // Repeats: peel the last copy off the most repeated piece each time, always keeping the first.
  const left = new Map([...groups].map(([k, v]) => [k, [...v]]));
  const repeats: FurnitureItem[] = [];
  for (;;) {
    const top = [...left.values()].filter((v) => v.length > 1).sort((a, b) => b.length - a.length)[0];
    if (!top) break;
    repeats.push(top.pop()!);
  }
  const singles = rest.filter((f) => !repeats.includes(f)).sort((a, b) => anchorPriority(a) - anchorPriority(b));
  return [...decor, ...repeats, ...singles];
}

/**
 * Solve; when nothing fits, give up the least important pieces one at a time and return the best
 * layout found, with what was left out named in `assumptions` and `infeasibility`.
 */
export async function solveProgram(model: SpaceModel, items: FurnitureItem[], programIn: DesignProgram, opts: SolveProgramOptions = {}): Promise<SolveResult> {
  const t0 = now();
  const first = await solveOnce(model, items, programIn, opts);
  if (first.candidates.length || !items.length) return first;
  const wallMs = opts.maxWallMs ?? 20000;
  const fixedIds = new Set(opts.fixedIds ?? []);
  const originals = new Map(items.map((f) => [f.id, f]));
  // Each round tries the full set, then gives up pieces in order. Later rounds also shrink the
  // clear space around every movable piece, for halls too narrow for the usual pull-out room.
  // The space in front of a piece (door swing, drawers, getting out) never drops below half.
  for (const scale of [1, 0.5, 0.25]) {
    const front = Math.max(scale, 0.5);
    const scaled = scale === 1 ? items : items.map((f) => (f.locked || fixedIds.has(f.id) ? f : { ...f, clearance: { front: f.clearance.front * front, back: f.clearance.back * scale, left: f.clearance.left * scale, right: f.clearance.right * scale } }));
    const order = dropOrder(scaled, fixedIds);
    // Decor goes as one step (it is already optional, so dropping it one by one rarely changes the outcome).
    const steps: FurnitureItem[][] = scale === 1 ? [] : [[]];
    for (const f of order) { if (OPTIONAL.has(f.category) && steps.length === 1 && steps[0].every((x) => OPTIONAL.has(x.category))) steps[0].push(f); else steps.push([f]); }
    // The pieces the last attempt could not seat go first, all at once.
    let hint = scale === 1 ? first.unplaced ?? [] : [];
    const gone: FurnitureItem[] = [];
    const goneIds = new Set<string>();
    const take = (list: FurnitureItem[]) => { for (const g of list) if (!goneIds.has(g.id) && !g.locked && !fixedIds.has(g.id)) { goneIds.add(g.id); gone.push(g); } };
    const attempt = async (): Promise<SolveResult | null> => {
      if (!gone.length && scale === 1) return null;
      const res = await solveOnce(model, scaled.filter((g) => !goneIds.has(g.id)), without(programIn, goneIds), { ...opts, maxWallMs: Math.max(1000, wallMs - (now() - t0)) });
      if (res.candidates.length) return res;
      hint = res.unplaced ?? [];
      return null;
    };
    const finish = (res: SolveResult): SolveResult => {
      const left = gone.map((g) => `Left out the ${g.name.toLowerCase()}: no layout of the full set passes the checks`);
      const shrunk = scale < 1 ? [`Clear space around the pieces reduced to ${Math.round(scale * 100)}% so they fit this narrow room`] : [];
      const lead = gone.length ? `Left out ${gone.map((g) => g.name.toLowerCase()).join(', ')}: they do not fit this room with the rest` : shrunk[0];
      const degraded: Degraded = { dropped: gone.map((g) => g.id), clearanceFactor: scale };
      const candidates = res.candidates.map((c): SolvedCandidate => {
        // Judged at the real clearances, not the reduced ones the solver used to find the spot.
        const full = c.furniture.map((f) => { const o = originals.get(f.id); return o ? { ...f, clearance: o.clearance } : f; });
        const checks = validateLayout(model, full, opts.req ?? null, { spaceId: opts.spaceId });
        const fails = checks.filter((k) => k.result === 'fail').length;
        const note = fails ? [`Does not pass ${fails} check${fails === 1 ? '' : 's'} at full clearances`] : [];
        return { ...c, checks, degraded, assumptions: [...c.assumptions, ...shrunk, ...left, ...note] };
      });
      return { ...res, candidates, infeasibility: { reasons: [lead, ...(first.infeasibility?.reasons ?? [])], relaxations: first.infeasibility?.relaxations ?? [] } };
    };
    // Scale 1 starts with the pieces named by the first failure; later rounds start with decor.
    if (hint.length) {
      take(hint.map((id) => scaled.find((f) => f.id === id)).filter((f): f is FurnitureItem => !!f));
      if (gone.length < items.length && !(opts.signal?.aborted || now() - t0 > wallMs)) { const r = await attempt(); if (r) return finish(r); }
    }
    for (const step of steps) {
      if (opts.signal?.aborted || now() - t0 > wallMs) break;
      take(step);
      take(hint.map((id) => scaled.find((f) => f.id === id)).filter((f): f is FurnitureItem => !!f));
      if (gone.length >= items.length) break;
      const r = await attempt();
      if (r) return finish(r);
    }
  }
  return first;
}


// ---------------------------------------------------------------- honest descriptions
export interface LayoutDescription {
  /** Short name from the final poses, e.g. "Bed on the east wall, desk by the window". */
  name: string;
  /** The layout's strongest point and its main trade-off, from the rule verdicts. */
  summary: string;
  /** Per item: sentences that are true of this layout (rule verdicts that hold). */
  reasons: Array<{ itemId: string; text: string }>;
}

/**
 * Describe a solved layout from what was actually placed. Every sentence comes from the final poses or
 * a rule verdict, so a card can never claim a wall, a window or a centre the layout does not have.
 */
export function describeLayout(model: SpaceModel, furniture: FurnitureItem[], req: Requirements | null = null, opts: { spaceId?: string } = {}): LayoutDescription {
  const space = spaceOf(model, opts.spaceId);
  if (!space || space.polygon.length < 3 || !furniture.length) return { name: 'Layout', summary: '', reasons: [] };
  const room = buildRoom(model, space.id);
  const L = analyse(room, furniture, req);
  const verdicts = evaluateCtx(L);
  const side = (wi: number) => { const n = room.walls[wi].n; return Math.abs(n.y) >= Math.abs(n.x) ? (n.y > 0 ? 'north' : 'south') : (n.x > 0 ? 'west' : 'east'); };
  const nearWin = (a: AItem) => room.windows.some((w) => polyDist([w.a, w.b, w.b, w.a], a.poly) < 1.0);
  const ph: string[] = [];
  const first = (cats: string[]) => L.items.find((a) => cats.includes(a.f.category));
  const bed = first(['bed', 'bunk-bed']), tv = first(['tv-unit']), sofa = first(['sofa', 'sofa-bed']), counter = first(['counter']), rec = first(['reception-desk']);
  const desks = L.items.filter((a) => a.f.category === 'desk'), tables = L.items.filter((a) => /^(table|cafe-table)$/.test(a.f.category));
  const noun = (a: AItem) => a.f.name.replace(/\s+\d.*$/, '');
  if (bed) ph.push(bed.back && bed.back.gap < 0.1 ? `${noun(bed)} against the ${side(bed.back.wall)} wall` : `${noun(bed)} along the wall`);
  if (tv && sofa) ph.push(`${noun(sofa)} facing the TV${tv.back ? ` on the ${side(tv.back.wall)} wall` : ''}`);
  else if (sofa) ph.push(sofa.back && sofa.back.gap < 0.1 ? `${noun(sofa)} on the ${side(sofa.back.wall)} wall` : `${noun(sofa)} floating in the room`);
  if (rec) ph.push(verdicts.some((v) => v.ruleId === 'reception-door' && v.score >= 0.9) ? 'Reception desk facing the entrance' : 'Reception desk in the room');
  if (counter && counter.back) ph.push(`Counter on the ${side(counter.back.wall)} wall`);
  if (desks.length >= 3) ph.push(`${desks.length} desks in facing clusters`);
  else if (desks.length) ph.push(desks.length === 2 ? `Two desks${desks.some(nearWin) ? ' by the window' : ''}` : `Desk ${nearWin(desks[0]) ? 'by the window' : desks[0].back && desks[0].back.gap < 0.1 ? `on the ${side(desks[0].back.wall)} wall` : 'in the room'}`);
  if (tables.length > 1) ph.push(`${tables.length} tables`);
  else if (tables.length) ph.push(`${noun(tables[0])} ${wallGapOf(room, tables[0]) > 0.4 ? 'in the open floor' : 'by the wall'}`);
  const name = ph.slice(0, 2).map((s, i) => (i ? lc(s) : s)).join(', ') || 'Layout';
  const ded = deductions(verdicts);
  const strength = verdicts.filter((v) => v.severity === 'strong' && v.score >= 0.95 && v.itemIds.length).sort((a, b) => pointsOf(b.ruleId, b.severity) - pointsOf(a.ruleId, a.severity))[0];
  const weak = ded[0] ? verdicts.filter((v) => v.ruleId === ded[0].ruleId).sort((a, b) => a.score - b.score)[0] : undefined;
  const summary = [strength?.message, weak && weak.score < 0.75 ? `Trade-off: ${lc(weak.message)}` : undefined].filter(Boolean).join(' ');
  const reasons: LayoutDescription['reasons'] = [];
  for (const a of L.items) for (const v of verdicts) if (v.severity !== 'hard' && v.score >= 0.9 && v.itemIds[0] === a.f.id && pointsOf(v.ruleId, v.severity) > 0) reasons.push({ itemId: a.f.id, text: v.message });
  return { name, summary, reasons };
}
function wallGapOf(room: RoomCtx, a: AItem): number { return Math.min(...a.poly.map((p) => Math.min(...room.walls.map((w) => Math.abs(dot(sub(p, w.a), w.n)))))); }
