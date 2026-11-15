// Wheelchair journey check across the whole plan: from the entrance to every room and to the key
// items (bed side, desk, sofa, WC, basin). Every figure comes from the active rule pack or the
// planning defaults; each result names the assumption it used. A planning aid, not a compliance check.
import type { FurnitureItem, Highlight, Op, SpaceModel, Vec2 } from '../../core/types';
import { applyPack, type RulePack } from '../jurisdiction/rulepacks';
import { GENERIC_PACK } from '../jurisdiction/rulepacks';
import { DIR_WORD, doorZone, poseValid, resolveConfig, swingZone, type SafetyConfig, type SafetyKey } from './assess';
import { buildSafetyGrid, centre, chain, exitCells, shortest, widthAt, type SafetyGrid } from './field';
import { clearWidth } from './evac';
import { isRug } from '../sim/grid';
import { itemCorners, pointInPolygon, distPointPolygonEdges } from '../../core/geometry';

export interface AssumptionRef { id: string; key: SafetyKey; value: number; unit: string; source: 'rule pack' | 'planning default' }

/** The rule (pack) or default that sets a setting, with its id, so any figure can be traced. */
export function assumptionFor(pack: RulePack, key: SafetyKey, cfg: SafetyConfig): AssumptionRef {
  const r = pack.rules.find((x) => x.key === key);
  if (r) return { id: r.id, key, value: r.value, unit: r.unit, source: pack.id === 'generic' ? 'planning default' : 'rule pack' };
  const g = GENERIC_PACK.rules.find((x) => x.key === key)!;
  return { id: g.id, key, value: cfg[key], unit: g.unit, source: 'planning default' };
}

export type DestKind = 'room' | 'bed' | 'desk' | 'sofa' | 'wc' | 'basin';
export type BlockKind = 'door' | 'item' | 'wall';
export type BlockReason = 'door' | 'width' | 'turn' | 'transfer';

export interface AccessFix {
  kind: 'move' | 'widen-door';
  /** 1-3 words. */
  label: string;
  itemId?: string;
  doorId?: string;
  dir?: 'up' | 'down' | 'left' | 'right';
  cm?: number;
  toM?: number;
  ops: Op[];
  /** True when the plan was re-checked with the change and the destination became reachable. */
  verified: boolean;
}

export interface AccessDestination {
  id: string;
  kind: DestKind;
  label: string;
  spaceId: string;
  at: Vec2;
  reachable: boolean;
  /** Narrowest passage on the route, metres, when a route exists. */
  narrowestM: number | null;
  route: Vec2[];
  blocking?: { kind: BlockKind; id: string | null; at: Vec2; reason: BlockReason; widthM: number | null };
  fix?: AccessFix;
  assumptionIds: string[];
}

export interface AccessReport {
  entranceId: string | null;
  destinations: AccessDestination[];
  reachableCount: number;
  total: number;
  /** Reachable destinations over all destinations, 0..1. */
  score: number;
  highlights: Highlight[];
  routes: Array<{ id: string; points: Vec2[]; ok: boolean; label: string }>;
  points: Array<{ id: string; at: Vec2; ok: boolean; label: string }>;
  assumptions: AssumptionRef[];
}

export interface AccessOptions { pack?: RulePack; config?: Partial<SafetyConfig>; exitOverrides?: Record<string, boolean>; skipFixes?: boolean }

const BED = /\bbed\b|bed$|^bed/i, DESK = /desk|workstation/i, SOFA = /sofa|couch/i, WC = /toilet|\bwc\b/i, BASIN = /basin|sink|washbasin/i;
const SKIP = /night|side|crib|bunk|sofa ?bed/i;

function kindOf(f: FurnitureItem): { kind: Exclude<DestKind, 'room'>; label: string } | null {
  const t = `${f.category} ${f.name}`;
  if (SKIP.test(t) && !/sofa/i.test(f.category)) return null;
  if (WC.test(t)) return { kind: 'wc', label: 'WC' };
  if (BASIN.test(t)) return { kind: 'basin', label: 'Basin' };
  if (BED.test(f.category) || /\bbed\b/i.test(f.name)) return { kind: 'bed', label: 'Bed side' };
  if (DESK.test(t)) return { kind: 'desk', label: 'Desk' };
  if (SOFA.test(t)) return { kind: 'sofa', label: 'Sofa' };
  return null;
}

interface Dest { id: string; kind: DestKind; label: string; spaceId: string; at: Vec2; roomIdx: number; item?: FurnitureItem }

function destinations(model: SpaceModel, furniture: FurnitureItem[]): Dest[] {
  const out: Dest[] = [];
  model.spaces.forEach((s, k) => {
    let cx = 0, cy = 0; for (const p of s.polygon) { cx += p.x; cy += p.y; }
    out.push({ id: `room:${s.id}`, kind: 'room', label: s.name, spaceId: s.id, at: { x: cx / s.polygon.length, y: cy / s.polygon.length }, roomIdx: k });
  });
  for (const f of furniture) {
    if (isRug(f)) continue;
    const k = kindOf(f); if (!k) continue;
    const r = model.spaces.findIndex((s) => s.polygon.length >= 3 && pointInPolygon(f, s.polygon));
    if (r < 0) continue;
    out.push({ id: `item:${f.id}`, kind: k.kind, label: k.label, spaceId: model.spaces[r].id, at: { x: f.x, y: f.y }, roomIdx: r, item: f });
  }
  return out;
}

interface Ctx {
  g: SafetyGrid; cfg: SafetyConfig; tol: number; entrance: number; sources: number[];
  doorOk: boolean[]; ok: (i: number) => boolean; free: (i: number) => boolean;
  FW: ReturnType<typeof shortest>; FU: ReturnType<typeof shortest>;
}

function buildCtx(model: SpaceModel, furniture: FurnitureItem[], cfg: SafetyConfig, overrides: Record<string, boolean>): Ctx | null {
  const g = buildSafetyGrid(model, furniture, overrides);
  const tol = g.cell / 2;
  const exits = g.doors.filter((d) => d.exit);
  if (!exits.length) return null;
  const entranceDoor = [...exits].sort((a, b) => clearWidth(b, cfg.doorLeafM) - clearWidth(a, cfg.doorLeafM))[0];
  const doorOk = g.doors.map((d) => clearWidth(d, cfg.doorLeafM) >= cfg.wheelchairDoorM - 0.005);
  const ok = (i: number) => g.free[i] === 1 && (g.door[i] >= 0 ? doorOk[g.door[i]] && g.dist[i] + tol >= cfg.wheelchairDoorM / 2 : g.dist[i] + tol >= cfg.wheelchairRouteM / 2);
  const free = (i: number) => g.free[i] === 1 && g.dist[i] + tol >= cfg.squeezeM / 2;
  const sources = exitCells(g, entranceDoor);
  const okSources = sources.filter(ok);
  return { g, cfg, tol, entrance: entranceDoor.idx, sources, doorOk, ok, free, FW: shortest(g, okSources, ok), FU: shortest(g, okSources.length ? okSources : sources.filter(free), free) };
}

interface Check { reachable: boolean; reason?: BlockReason; target: number; route: number[] }

const distToPoly = (p: Vec2, poly: Vec2[]) => (pointInPolygon(p, poly) ? 0 : distPointPolygonEdges(p, poly));

/** Cells that count as arriving at a destination, and the best cell to measure a failed attempt from. */
function evaluate(ctx: Ctx, d: Dest): Check {
  const { g, cfg, tol, FW, FU } = ctx;
  const N = g.cols * g.rows;
  const reach = (i: number) => Number.isFinite(FW.len[i]);
  let target = -1, best = -Infinity, near: number[] = [];
  if (d.kind === 'room') {
    for (let i = 0; i < N; i++) {
      if (g.room[i] !== d.roomIdx || !g.free[i]) continue;
      if (reach(i) && g.dist[i] + tol >= cfg.turningM / 2) return { reachable: true, target: i, route: chain(FW, i) };
      if (Number.isFinite(FU.len[i]) && g.dist[i] > best) { best = g.dist[i]; target = i; }
      if (reach(i)) near.push(i);
    }
    if (near.length) {
      const b = near.reduce((a, i) => (g.dist[i] > g.dist[a] ? i : a), near[0]);
      return { reachable: false, reason: 'turn', target: b, route: chain(FW, b) };
    }
    return { reachable: false, reason: 'width', target, route: target >= 0 ? chain(FU, target) : [] };
  }
  const poly = itemCorners(d.item!);
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y), pad = 1.8;
  const c0 = Math.max(0, Math.floor((Math.min(...xs) - pad - g.ox) / g.cell)), c1 = Math.min(g.cols - 1, Math.ceil((Math.max(...xs) + pad - g.ox) / g.cell));
  const r0 = Math.max(0, Math.floor((Math.min(...ys) - pad - g.oy) / g.cell)), r1 = Math.min(g.rows - 1, Math.ceil((Math.max(...ys) + pad - g.oy) / g.cell));
  const side = cfg.besideM / 2 + g.cell * 1.5;
  let transfer = false, turn = d.kind !== 'bed', nearReach = -1, nearBest = Infinity;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const i = r * g.cols + c;
    if (!g.free[i]) continue;
    const dp = distToPoly(centre(g, i), poly);
    if (Number.isFinite(FU.len[i]) && dp < nearBest && dp <= side) { nearBest = dp; target = i; }
    if (!reach(i)) continue;
    if (dp <= side && g.dist[i] + tol >= cfg.besideM / 2) { transfer = true; if (nearReach < 0) nearReach = i; }
    if (d.kind === 'bed' && dp <= cfg.turningM && g.dist[i] + tol >= cfg.turningM / 2) turn = true;
    if (reach(i) && dp <= side && (nearReach < 0 || g.dist[i] > g.dist[nearReach])) nearReach = nearReach < 0 ? i : nearReach;
  }
  if (transfer && turn) return { reachable: true, target: nearReach, route: chain(FW, nearReach) };
  if (transfer) return { reachable: false, reason: 'turn', target: nearReach, route: chain(FW, nearReach) };
  if (target < 0) {
    // Nothing next to the item can be stood on at all: use the free cell closest to it.
    let bd = Infinity;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const i = r * g.cols + c; if (!Number.isFinite(FU.len[i])) continue; const dp = distToPoly(centre(g, i), poly); if (dp < bd) { bd = dp; target = i; } }
  }
  const anyReach = target >= 0 && reach(target);
  return { reachable: false, reason: anyReach ? 'transfer' : 'width', target, route: target >= 0 ? chain(anyReach ? FW : FU, target) : [] };
}

interface Blocker { kind: BlockKind; id: string | null; at: Vec2; reason: BlockReason; widthM: number | null; item?: FurnitureItem }

function findBlocker(ctx: Ctx, chk: Check, furniture: FurnitureItem[], dest: Dest): Blocker | null {
  const { g, cfg } = ctx;
  const byId = new Map(furniture.map((f) => [f.id, f]));
  const itemAt = (p: Vec2): { f?: FurnitureItem; w: number } => {
    const wa = widthAt(g, p);
    const cands = [wa.near, wa.far].map((s) => (s?.itemId ? byId.get(s.itemId) : undefined)).filter((f): f is FurnitureItem => !!f);
    return { f: cands.find((f) => !f.locked) ?? cands[0], w: wa.width };
  };
  if (chk.reason === 'turn' || chk.reason === 'transfer') {
    const p = centre(g, chk.target);
    const { f, w } = itemAt(p);
    const target = dest.item && f?.id !== dest.item.id && f ? f : f ?? dest.item;
    return { kind: target ? 'item' : 'wall', id: target?.id ?? null, at: p, reason: chk.reason, widthM: w, item: target };
  }
  const route = [...chk.route].reverse(); // entrance first
  for (const i of route) {
    const p = centre(g, i);
    if (ctx.ok(i)) continue;
    const k = g.door[i];
    if (k >= 0 && !ctx.doorOk[k]) return { kind: 'door', id: g.doors[k].id, at: g.doors[k].c, reason: 'door', widthM: clearWidth(g.doors[k], cfg.doorLeafM) };
    const bad = g.doors.find((d, j) => !ctx.doorOk[j] && Math.hypot(d.c.x - p.x, d.c.y - p.y) <= d.widthM / 2 + 0.6);
    if (bad) return { kind: 'door', id: bad.id, at: bad.c, reason: 'door', widthM: clearWidth(bad, cfg.doorLeafM) };
    const { f, w } = itemAt(p);
    if (k >= 0 && !f) return { kind: 'door', id: g.doors[k].id, at: g.doors[k].c, reason: 'width', widthM: w };
    return { kind: f ? 'item' : 'wall', id: f?.id ?? null, at: p, reason: 'width', widthM: w, item: f };
  }
  return null;
}

const DIRS: Array<{ v: Vec2 }> = [{ v: { x: 0, y: -1 } }, { v: { x: 0, y: 1 } }, { v: { x: -1, y: 0 } }, { v: { x: 1, y: 0 } }];
const wordOf = (v: Vec2) => DIR_WORD(v) as 'up' | 'down' | 'left' | 'right';

function searchMove(model: SpaceModel, furniture: FurnitureItem[], cfg: SafetyConfig, overrides: Record<string, boolean>, dest: Dest, item: FurnitureItem, budget: { n: number }): AccessFix | undefined {
  if (item.locked) return undefined;
  const doors = buildSafetyGrid(model, [], overrides, 0.25).doors;
  const zones: Vec2[][] = [];
  for (const d of doors) { zones.push(doorZone(d, 0.3, 0.05)); const sw = swingZone(model, d); if (sw) zones.push(sw); }
  for (let delta = 0.05; delta <= cfg.maxMoveM + 1e-9; delta += 0.05) {
    for (const { v } of DIRS) {
      const x = Math.round((item.x + v.x * delta) * 1000) / 1000, y = Math.round((item.y + v.y * delta) * 1000) / 1000;
      if (!poseValid(model, item, x, y, furniture, zones)) continue;
      if (budget.n-- <= 0) return undefined;
      const moved = furniture.map((f) => (f.id === item.id ? { ...f, x, y } : f));
      const ctx = buildCtx(model, moved, cfg, overrides); if (!ctx) return undefined;
      const d2: Dest = dest.item?.id === item.id ? { ...dest, item: { ...item, x, y }, at: { x, y } } : dest;
      if (evaluate(ctx, d2).reachable) {
        const cm = Math.round(delta * 100), name = item.name || item.category;
        return { kind: 'move', label: `${name} ${wordOf(v)} ${cm}cm`, itemId: item.id, dir: wordOf(v), cm, ops: [{ type: 'UPDATE_OBJECT', id: item.id, patch: { x, y } }], verified: true };
      }
    }
  }
  return undefined;
}

function widenFix(model: SpaceModel, furniture: FurnitureItem[], cfg: SafetyConfig, overrides: Record<string, boolean>, doorId: string, dest: Dest): AccessFix | undefined {
  const o = model.openings.find((x) => x.id === doorId); if (!o) return undefined;
  const leaf = o.kind === 'door' && o.swing !== 'none' ? cfg.doorLeafM : 0;
  const toM = Math.round((cfg.wheelchairDoorM + leaf) * 1000) / 1000;
  const patched: SpaceModel = { ...model, openings: model.openings.map((x) => (x.id === doorId ? { ...x, widthM: toM } : x)) };
  const ctx = buildCtx(patched, furniture, cfg, overrides);
  const verified = !!ctx && evaluate(ctx, dest).reachable;
  return { kind: 'widen-door', label: `Widen to ${Math.round(toM * 100)}cm`, doorId, toM, ops: [{ type: 'UPDATE_OPENING', id: doorId, patch: { widthM: toM } }], verified };
}

export function assessAccess(model: SpaceModel, furniture: FurnitureItem[], opts: AccessOptions = {}): AccessReport {
  const pack = opts.pack ?? GENERIC_PACK;
  const cfg = resolveConfig({ ...applyPack(pack), ...opts.config });
  const overrides = opts.exitOverrides ?? {};
  const dests = destinations(model, furniture);
  const keys: SafetyKey[] = ['wheelchairRouteM', 'wheelchairDoorM', 'turningM', 'besideM', 'doorLeafM'];
  const assumptions = keys.map((k) => assumptionFor(pack, k, cfg));
  const aid = (...ks: SafetyKey[]) => ks.map((k) => assumptions.find((a) => a.key === k)!.id);
  const ctx = buildCtx(model, furniture, cfg, overrides);
  const empty: AccessReport = { entranceId: null, destinations: [], reachableCount: 0, total: dests.length, score: 0, highlights: [], routes: [], points: [], assumptions };
  if (!ctx) {
    empty.destinations = dests.map((d) => ({ id: d.id, kind: d.kind, label: d.label, spaceId: d.spaceId, at: d.at, reachable: false, narrowestM: null, route: [], assumptionIds: [] }));
    return empty;
  }
  const g = ctx.g;
  const budget = { n: 160 };
  const out: AccessDestination[] = dests.map((d) => {
    const chk = evaluate(ctx, d);
    const route = chk.route.length ? [...chk.route].reverse().map((i) => centre(g, i)) : [];
    const ids = d.kind === 'room' ? aid('wheelchairRouteM', 'wheelchairDoorM', 'turningM') : aid('wheelchairRouteM', 'wheelchairDoorM', 'besideM', ...(d.kind === 'bed' ? (['turningM'] as SafetyKey[]) : []));
    let narrow: number | null = null;
    if (chk.route.length) {
      narrow = Infinity;
      for (let n = 0; n < chk.route.length; n += 3) { const i = chk.route[n]; narrow = Math.min(narrow, g.door[i] >= 0 ? clearWidth(g.doors[g.door[i]], cfg.doorLeafM) : (g.dist[i] + ctx.tol) * 2); }
      if (!Number.isFinite(narrow)) narrow = null;
    }
    const res: AccessDestination = { id: d.id, kind: d.kind, label: d.label, spaceId: d.spaceId, at: d.at, reachable: chk.reachable, narrowestM: narrow, route, assumptionIds: ids };
    if (!chk.reachable) {
      const b = findBlocker(ctx, chk, furniture, d);
      if (b) {
        res.blocking = { kind: b.kind, id: b.id, at: b.at, reason: b.reason, widthM: b.widthM };
        if (!opts.skipFixes) {
          if (b.kind === 'door' && b.id) res.fix = widenFix(model, furniture, cfg, overrides, b.id, d);
          else if (b.item) res.fix = searchMove(model, furniture, cfg, overrides, d, b.item, budget);
        }
      }
    }
    return res;
  });
  const reachableCount = out.filter((d) => d.reachable).length;
  const entrance = g.doors[ctx.entrance];
  const hl = (label: string, color: string, ids: string[]): Highlight[] => (ids.length ? [{ ids, color, label }] : []);
  return {
    entranceId: entrance?.id ?? null,
    destinations: out, reachableCount, total: out.length, score: out.length ? reachableCount / out.length : 0,
    highlights: [...hl('Reachable', '#22a06b', out.filter((d) => d.reachable).map((d) => d.id)), ...hl('Blocked', '#d64545', out.filter((d) => !d.reachable).map((d) => d.id)),
      ...hl('Fix', '#e0a800', out.flatMap((d) => (d.fix?.itemId ? [d.fix.itemId] : d.fix?.doorId ? [d.fix.doorId] : [])))],
    routes: out.filter((d) => d.route.length > 1).map((d) => ({ id: d.id, points: d.route, ok: d.reachable, label: d.label })),
    points: out.map((d) => ({ id: d.id, at: d.blocking && !d.reachable ? d.blocking.at : d.at, ok: d.reachable, label: d.label })),
    assumptions,
  };
}
