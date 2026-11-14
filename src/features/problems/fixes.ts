import { centroid, itemCorners, openingSegment, polygonInside, wallLength } from '../../core/geometry';
import { applyOp } from '../../core/ops';
import type { FurnitureItem, Op, Requirements, SpaceModel, Vec2 } from '../../core/types';
import { validateLayout } from '../referee/validate';
import { evaluateRules, RULES } from '../design/rules';
import { quickFindings } from '../safety/assess';
import { clampInside, findFreeSpot, resolveOverlap, rotationFacing, snapToWall } from '../objects/placement';
import { CATALOG } from '../furniture/catalog';
import type { ProblemRaw } from './collect';
import type { Fix, GhostPose, Problem } from './types';

export interface FixContext {
  model: SpaceModel;
  furniture: FurnitureItem[];
  req: Requirements | null;
  raw: Map<string, ProblemRaw>;
  /** Referee failures before any fix, so a fix can be judged by what it adds. */
  baseFails: Set<string>;
}

export function fixContext(model: SpaceModel, furniture: FurnitureItem[], req: Requirements | null, raw: Map<string, ProblemRaw>): FixContext {
  const baseFails = new Set(validateLayout(model, furniture, req).filter((r) => r.result === 'fail').map((r) => r.id));
  return { model: { ...model, furniture }, furniture, req, raw, baseFails };
}

// ---- Optional fixes from the layout solver ---------------------------------------------------
// The solver may export `fixesFor(model, furniture, check)`. It is loaded lazily when present; every
// fix it returns is still checked here before it is offered.
type SolverFix = { label?: unknown; ops?: unknown };
type FixesFor = (model: SpaceModel, furniture: FurnitureItem[], check: unknown) => SolverFix[] | undefined;
let solverFixesFor: FixesFor | null = null;
let solverLoad: Promise<void> | null = null;
export function loadSolverFixes(): Promise<void> {
  if (solverLoad) return solverLoad;
  const mods = import.meta.glob(['../design/fixes.ts', '../design/repair.ts', '../design/solve.ts']);
  solverLoad = (async () => {
    for (const load of Object.values(mods)) {
      try {
        const m = (await load()) as { fixesFor?: unknown };
        if (typeof m.fixesFor === 'function') { solverFixesFor = m.fixesFor as FixesFor; return; }
      } catch { /* optional */ }
    }
  })();
  return solverLoad;
}

// ---- Helpers ---------------------------------------------------------------------------------
const TAU = Math.PI * 2;
const normAng = (a: number) => ((a % TAU) + TAU) % TAU;
const angDiff = (a: number, b: number) => { const d = Math.abs(normAng(a) - normAng(b)); return Math.min(d, TAU - d); };
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const isFurnitureOp = (op: Op) => op.type === 'UPDATE_OBJECT' || op.type === 'REMOVE_OBJECT' || op.type === 'PLACE_OBJECT' || op.type === 'SET_FURNITURE';

export function applyOps(model: SpaceModel, ops: Op[]): SpaceModel {
  return ops.reduce((m, op) => applyOp(m, op), model);
}

/** Where each changed item ends up (or that it goes). */
export function previewOf(model: SpaceModel, ops: Op[]): GhostPose[] {
  const after = applyOps(model, ops).furniture;
  const byId = new Map(after.map((f) => [f.id, f]));
  const out: GhostPose[] = [];
  for (const f of model.furniture) {
    const g = byId.get(f.id);
    if (!g) { out.push({ id: f.id, x: f.x, y: f.y, rotation: f.rotation, w: f.w, d: f.d, removed: true }); continue; }
    if (Math.abs(g.x - f.x) > 1e-4 || Math.abs(g.y - f.y) > 1e-4 || angDiff(g.rotation, f.rotation) > 1e-4 || g.w !== f.w || g.d !== f.d) {
      out.push({ id: g.id, x: g.x, y: g.y, rotation: g.rotation, w: g.w, d: g.d });
    }
  }
  return out;
}

/** "Move 20 cm left", "Move 15 cm left and 10 cm down". Plan x grows to the right, y grows down. */
export function moveLabel(dx: number, dy: number): string {
  const parts: string[] = [];
  const ax = Math.round(Math.abs(dx) * 100), ay = Math.round(Math.abs(dy) * 100);
  const h = ax >= 1 ? `${ax} cm ${dx < 0 ? 'left' : 'right'}` : '';
  const v = ay >= 1 ? `${ay} cm ${dy < 0 ? 'up' : 'down'}` : '';
  if (ax >= ay) { if (h) parts.push(h); if (v && ay >= 3) parts.push(v); } else { if (v) parts.push(v); if (h && ax >= 3) parts.push(h); }
  return parts.length ? `Move ${parts.join(' and ')}` : 'Nudge into place';
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

interface Verdict { cleared: boolean | 'unknown'; added: number }
/**
 * Runs the checks on the layout after `ops`: is the problem gone, and how many new failures appear?
 * Escape route findings take seconds to recompute, so for those `cleared` is 'unknown' unless `deep` is set.
 */
export function verifyFix(ctx: FixContext, problem: Problem, ops: Op[], deep = false): Verdict {
  const m = applyOps(ctx.model, ops);
  const fails = new Set(validateLayout(m, m.furniture, ctx.req).filter((r) => r.result === 'fail').map((r) => r.id));
  let added = 0;
  for (const id of fails) if (!ctx.baseFails.has(id)) added++;
  const raw = ctx.raw.get(problem.id);
  let cleared: Verdict['cleared'] = true;
  if (!raw) cleared = true;
  else if (raw.source === 'check') cleared = !fails.has(raw.result.id);
  else if (raw.source === 'design') {
    const v = raw.verdict;
    const fast = !RULES.find((r) => r.id === v.ruleId)?.costly;
    try { cleared = !evaluateRules(m, m.furniture, ctx.req, { fast }).some((x) => x.ruleId === v.ruleId && !x.pass && sameSet(x.itemIds, v.itemIds)); } catch { cleared = false; }
  } else if (deep) {
    const f = raw.finding;
    try { cleared = !quickFindings(m, m.furniture).some((x) => x.kind === f.kind && (f.itemIds.length ? x.itemIds.some((id) => f.itemIds.includes(id)) : true)); } catch { cleared = false; }
  } else cleared = 'unknown';
  return { cleared, added };
}

interface Candidate { label: string; ops: Op[]; kind: Fix['kind']; cost: number }

function moveOp(f: FurnitureItem, to: { x: number; y: number; rotation?: number }): Op {
  return { type: 'UPDATE_OBJECT', id: f.id, patch: { x: r3(to.x), y: r3(to.y), ...(to.rotation != null ? { rotation: normAng(to.rotation) } : {}) } };
}

/** Item a fix should change: the first unlocked one, preferring the smaller of a pair. */
function targetsOf(ctx: FixContext, p: Problem): FurnitureItem[] {
  const items = p.itemIds.map((id) => ctx.furniture.find((f) => f.id === id)).filter((f): f is FurnitureItem => !!f && !f.locked);
  if (p.rule === 'No overlap' || p.rule === 'Clearance') return items.slice(0, 2).sort((a, b) => a.w * a.d - b.w * b.d).concat(items.slice(2));
  return items;
}

function directionsFor(ctx: FixContext, p: Problem, t: FurnitureItem): Vec2[] {
  const dirs: Vec2[] = [];
  const push = (v: Vec2) => {
    const ax = Math.abs(v.x) >= Math.abs(v.y) ? { x: Math.sign(v.x) || 1, y: 0 } : { x: 0, y: Math.sign(v.y) || 1 };
    if (!dirs.some((d) => d.x === ax.x && d.y === ax.y)) dirs.push(ax);
  };
  // Away from the narrow spot an escape route finding points at.
  if (p.source === 'safety' && p.at) push({ x: t.x - p.at.x, y: t.y - p.at.y });
  for (const id of p.itemIds) {
    if (id === t.id) continue;
    const o = ctx.furniture.find((f) => f.id === id); if (o) push({ x: t.x - o.x, y: t.y - o.y });
  }
  for (const id of p.openingIds) {
    const o = ctx.model.openings.find((x) => x.id === id); const s = o && ctx.model.spaces.find((x) => x.id === o.spaceId);
    if (!o || !s || o.wallIndex >= s.polygon.length) continue;
    const seg = openingSegment(s, o);
    const along = (t.x - seg.c.x) * seg.dir.x + (t.y - seg.c.y) * seg.dir.y;
    push(along >= 0 ? seg.dir : { x: -seg.dir.x, y: -seg.dir.y });
  }
  // Facing something too close: step back from it.
  if (p.rule === 'Clearance' || p.rule === 'Desk chair pull-out' || p.rule === 'Room to pull chairs out') push({ x: Math.sin(t.rotation), y: -Math.cos(t.rotation) });
  // Towards the room centre is usually the roomiest way to go.
  const sp = ctx.model.spaces[0];
  if (sp) { const c = centroid(sp.polygon); push({ x: c.x - t.x, y: c.y - t.y }); }
  for (const v of [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 }]) push(v);
  return dirs;
}

const STEPS = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8];
const CATEGORY_WORD: Record<string, string> = { 'sofa-bed': 'sofa bed', 'tv-unit': 'TV unit', 'coffee-table': 'coffee table', 'cafe-table': 'cafe table', 'office-chair': 'office chair', 'storage-cabinet': 'cabinet', 'filing-cabinet': 'filing cabinet' };

/**
 * Up to three fixes for a problem, best first. Moves and turns are tried on a copy of the layout
 * and only offered when they clear the problem without breaking anything else.
 */
export function findFixes(ctx: FixContext, p: Problem, budget = 40): Fix[] {
  const out: Fix[] = [];
  let tries = 0;
  const rawP = ctx.raw.get(p.id);
  // Floor-grid rules cost far more to re-check, so try fewer moves for them.
  if (rawP?.source === 'design' && RULES.find((r) => r.id === rawP.verdict.ruleId)?.costly) budget = Math.min(budget, 12);
  const seen = new Set<string>();
  const accept = (c: Candidate, mustVerify = true): boolean => {
    const key = JSON.stringify(c.ops);
    if (seen.has(key) || tries >= budget) return false;
    seen.add(key); tries++;
    const v = verifyFix(ctx, p, c.ops);
    const ok = v.cleared === true && v.added === 0;
    // Not confirmed either way (escape routes), but breaks nothing: offer it, never run it in Fix all.
    const maybe = v.cleared === 'unknown' && v.added === 0;
    if (!ok && !maybe && mustVerify) return false;
    out.push({ id: `${p.id}|${c.kind}|${out.length}`, label: c.label, ops: c.ops, preview: previewOf(ctx.model, c.ops), safe: ok && (c.kind === 'move' || c.kind === 'rotate' || c.kind === 'opening'), kind: c.kind });
    return ok || maybe;
  };

  // Room outline problems are fixed where the outline is drawn.
  if (p.rule === 'Room shape') return [{ id: `${p.id}|go`, label: 'Redraw the room', ops: [], preview: [], safe: false, kind: 'go', go: 'capture' }];

  // A door or window that runs past its wall: slide it back on, or narrow it.
  if (p.rule === 'Opening on wall') {
    for (const id of p.openingIds) {
      const o = ctx.model.openings.find((x) => x.id === id); const s = o && ctx.model.spaces.find((x) => x.id === o.spaceId);
      if (!o || !s || o.wallIndex >= s.polygon.length) continue;
      const L = wallLength(s, o.wallIndex);
      const width = Math.min(o.widthM, Math.max(0.3, L - 0.1));
      const offset = Math.min(Math.max(o.offsetM, width / 2 + 0.05), L - width / 2 - 0.05);
      const ops: Op[] = [{ type: 'UPDATE_OPENING', id, patch: { offsetM: r3(offset), widthM: r3(width) } }];
      accept({ label: width < o.widthM ? `Narrow the ${o.kind} to ${Math.round(width * 100)} cm` : `Slide the ${o.kind} ${Math.round(Math.abs(offset - o.offsetM) * 100)} cm along the wall`, ops, kind: 'opening', cost: 0 }, false);
    }
    return out;
  }

  // Solver-provided fixes come first when they check out.
  if (solverFixesFor) {
    const raw = ctx.raw.get(p.id);
    const thing = raw ? (raw.source === 'check' ? raw.result : raw.source === 'design' ? raw.verdict : raw.finding) : null;
    try {
      for (const sf of solverFixesFor(ctx.model, ctx.furniture, thing) ?? []) {
        if (typeof sf.label !== 'string' || !Array.isArray(sf.ops) || !sf.ops.length) continue;
        const ops = sf.ops as Op[];
        if (!ops.every(isFurnitureOp)) continue;
        if (accept({ label: sf.label, ops, kind: ops.some((o) => o.type === 'REMOVE_OBJECT') ? 'remove' : 'move', cost: 0 }) && out.length >= 2) break;
      }
    } catch { /* fall back to our own */ }
  }

  const targets = targetsOf(ctx, p);
  const room = ctx.model.spaces[0];
  for (const t of targets.slice(0, 2)) {
    if (out.filter((f) => f.kind !== 'remove').length >= 2) break;
    const others = ctx.furniture.filter((f) => f.id !== t.id);
    const found: Candidate[] = [];

    // 1. Smallest push out of an overlap, or back inside the room.
    const push = resolveOverlap(ctx.model, t, others.filter((f) => f.category !== 'rug'));
    if (push) found.push({ label: moveLabel(push.x - t.x, push.y - t.y), ops: [moveOp(t, push)], kind: 'move', cost: Math.hypot(push.x - t.x, push.y - t.y) });
    if (room && !polygonInside(itemCorners(t), room.polygon)) {
      const c = clampInside(ctx.model, t);
      found.push({ label: moveLabel(c.x - t.x, c.y - t.y), ops: [moveOp(t, c)], kind: 'move', cost: Math.hypot(c.x - t.x, c.y - t.y) });
    }
    for (const c of found.sort((a, b) => a.cost - b.cost)) if (accept(c) && out.length >= 2) break;
    if (out.filter((f) => f.kind !== 'remove').length >= 2) break;

    // 2. Short straight nudges, away from whatever is in the way first.
    let moves = 0;
    for (const d of directionsFor(ctx, p, t)) {
      if (moves >= 2 || tries >= budget - 8) break;
      for (const s of p.source === 'safety' ? [0.3, 0.5] : STEPS) {
        const to = { x: t.x + d.x * s, y: t.y + d.y * s };
        if (room && !polygonInside(itemCorners({ ...t, ...to }), room.polygon)) break;
        if (tries >= budget - 8) break;
        if (accept({ label: moveLabel(d.x * s, d.y * s), ops: [moveOp(t, to)], kind: 'move', cost: s })) { moves++; break; }
      }
    }
    if (out.filter((f) => f.kind !== 'remove').length >= 2) break;

    // 3. Turn it: back to the nearest wall, to face the room, or a quarter turn.
    const wall = snapToWall(ctx.model, t, 0.35);
    if (wall && (angDiff(wall.rotation, t.rotation) > 0.05 || Math.hypot(wall.x - t.x, wall.y - t.y) > 0.02)) {
      accept({ label: angDiff(wall.rotation, t.rotation) > 0.05 ? 'Turn to face the room' : 'Push back to the wall', ops: [moveOp(t, wall)], kind: 'rotate', cost: 1 });
    } else if (room) {
      const c = centroid(room.polygon);
      const face = Math.round(rotationFacing({ x: c.x - t.x, y: c.y - t.y }) / (Math.PI / 2)) * (Math.PI / 2);
      if (angDiff(face, t.rotation) > 0.05) accept({ label: 'Turn to face the room', ops: [moveOp(t, { x: t.x, y: t.y, rotation: face })], kind: 'rotate', cost: 1 });
    }
    if (out.filter((f) => f.kind !== 'remove').length < 2) accept({ label: 'Turn 90°', ops: [moveOp(t, { x: t.x, y: t.y, rotation: t.rotation + Math.PI / 2 })], kind: 'rotate', cost: 1.2 });

    // 4. Somewhere else entirely.
    if (out.filter((f) => f.kind !== 'remove').length < 2) {
      const spot = findFreeSpot(ctx.model, t, others);
      if (Math.hypot(spot.x - t.x, spot.y - t.y) > 0.05) accept({ label: 'Move to a free spot', ops: [moveOp(t, spot)], kind: 'move', cost: 2 });
    }

    // 5. A smaller piece of the same kind, same back edge.
    if (out.filter((f) => f.kind !== 'remove').length < 2 && !t.owned && !t.custom && !t.listing) {
      const smaller = CATALOG.filter((e) => e.category === t.category && e.id !== t.catalogId && (p.rule === 'Budget' ? e.priceSek < t.priceSek : e.w * e.d < t.w * t.d - 1e-6))
        .sort((a, b) => (p.rule === 'Budget' ? b.priceSek - a.priceSek : b.w * b.d - a.w * a.d))[0];
      if (smaller) {
        const shift = (smaller.d - t.d) / 2; // keep the back edge where it is
        const x = t.x - Math.sin(t.rotation) * shift, y = t.y + Math.cos(t.rotation) * shift;
        const word = CATEGORY_WORD[t.category] ?? t.category.replace(/-/g, ' ');
        const ops: Op[] = [{ type: 'UPDATE_OBJECT', id: t.id, patch: { catalogId: smaller.id, name: smaller.name, w: smaller.w, d: smaller.d, h: smaller.h, clearance: { ...smaller.clearance }, unfoldedD: smaller.unfoldedD, priceSek: smaller.priceSek, x: r3(x), y: r3(y) } }];
        accept({ label: `Swap for a ${Math.round(smaller.w * 100)} cm ${word}`, ops, kind: 'swap', cost: 3 }, p.rule !== 'Budget');
      }
    }
  }

  const best = out.filter((f) => f.kind !== 'remove').sort((a, b) => rank(a) - rank(b)).slice(0, 2);
  const first = targets[0] ?? p.itemIds.map((id) => ctx.furniture.find((f) => f.id === id)).find(Boolean);
  if (first && !first.locked) {
    const ops: Op[] = [{ type: 'REMOVE_OBJECT', id: first.id }];
    best.push({ id: `${p.id}|remove`, label: `Remove ${first.name}`, ops, preview: previewOf(ctx.model, ops), safe: false, kind: 'remove' });
  } else if (first?.locked) {
    const ops: Op[] = [{ type: 'UPDATE_OBJECT', id: first.id, patch: { locked: false } }];
    best.push({ id: `${p.id}|unlock`, label: `Unlock ${first.name}`, ops, preview: [], safe: false, kind: 'move' });
  }
  return best;
}

const KIND_RANK: Record<Fix['kind'], number> = { opening: 0, move: 1, rotate: 2, swap: 3, remove: 4, go: 5 };
const rank = (f: Fix) => (f.safe ? 0 : 10) + KIND_RANK[f.kind] + (f.label === 'Move to a free spot' ? 1.5 : 0);
