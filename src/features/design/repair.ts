// Repair: the smallest set of moves (slide, turn, move to another wall, swap) that turns a layout
// with failed checks into a valid one without lowering its design score, and one-click fix options
// for a single failed check or rule.
import type { FurnitureItem, Op, Requirements, RuleVerdict, SpaceModel, ValidationResult } from '../../core/types';
import { validateLayout } from '../referee/validate';
import { buildRoom, evaluateRules, pairSeatsOf, type RoomCtx } from './rules';
import { critiqueKnowledge, evaluateKnowledge, type CriticItem, type KnowledgeResult, type Repair, type RoomUse } from './knowledge';
import { flankOptions, rotationFacing, seatArrangements } from './relations';
import { designScore } from './score';
import { isRug, normaliseItem, semanticsOf } from './semantics';

export interface RepairMove { itemId: string; from: { x: number; y: number; rotation: number }; to: { x: number; y: number; rotation: number }; reason: string }
export interface RepairResult {
  furniture: FurnitureItem[]; moves: RepairMove[]; valid: boolean; scoreBefore: number; scoreAfter: number;
  /** The relation pass after the referee pass: hard relations broken before and after, and what is left. */
  knowledge?: { hardBefore: string[]; hardAfter: string[]; scoreBefore: number; scoreAfter: number; left: CriticItem[] };
}
export interface RepairOptions { spaceId?: string; maxMoves?: number; use?: RoomUse; /** false skips the relation pass. */ knowledge?: boolean }
export interface Fix { label: string; ops: Op[]; preview: FurnitureItem[] }

type Pose = { x: number; y: number; rotation: number };
interface Cand { label: string; reason: string; poses: Map<string, Pose> }

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const TAU = Math.PI * 2;
const angDiff = (a: number, b: number) => { const d = Math.abs((((a - b) % TAU) + TAU) % TAU); return Math.min(d, TAU - d); };
const lcName = (f: FurnitureItem) => f.name.charAt(0).toLowerCase() + f.name.slice(1);

/** An item and the seats drawn up to it move together. */
function groupOf(items: FurnitureItem[], id: string): FurnitureItem[] {
  const hostOf = pairSeatsOf(items.map(normaliseItem));
  const host = hostOf.get(id) ?? id;
  return items.filter((f) => f.id === host || hostOf.get(f.id) === host);
}

/** Move a group rigidly so its lead item lands on `to`. */
function moveGroup(group: FurnitureItem[], lead: FurnitureItem, to: Pose): Map<string, Pose> {
  const dr = to.rotation - lead.rotation, c = Math.cos(dr), s = Math.sin(dr);
  const out = new Map<string, Pose>();
  for (const f of group) {
    const dx = f.x - lead.x, dy = f.y - lead.y;
    out.set(f.id, { x: r3(to.x + dx * c - dy * s), y: r3(to.y + dx * s + dy * c), rotation: f.rotation + dr });
  }
  return out;
}

function moveText(f: FurnitureItem, to: Pose): string {
  const dx = to.x - f.x, dy = to.y - f.y, ax = Math.round(Math.abs(dx) * 100), ay = Math.round(Math.abs(dy) * 100);
  const turn = angDiff(to.rotation, f.rotation) > 0.1;
  const parts: string[] = [];
  if (ax >= 2) parts.push(`${ax} cm ${dx < 0 ? 'left' : 'right'}`);
  if (ay >= 2) parts.push(`${ay} cm ${dy < 0 ? 'up' : 'down'}`);
  const name = lcName(f);
  if (turn && !parts.length) return `Turn the ${name}`;
  return `${turn ? 'Turn and move' : 'Move'} the ${name} ${parts.join(' and ')}`.trim();
}

/** Candidate single moves for one item: slides, turns, wall slots, swaps. */
function candidates(room: RoomCtx, items: FurnitureItem[], id: string): Cand[] {
  const f = items.find((x) => x.id === id);
  if (!f || f.locked) return [];
  const group = groupOf(items, id);
  const lead = group.find((g) => !pairSeatsOf(items.map(normaliseItem)).has(g.id)) ?? f;
  const out: Cand[] = [];
  const push = (to: Pose, why: string) => out.push({ label: moveText(lead, to), reason: why, poses: moveGroup(group, lead, to) });
  for (const d of [0.05, 0.1, 0.2, 0.3, 0.45, 0.6, 0.9]) for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) push({ x: lead.x + dx, y: lead.y + dy, rotation: lead.rotation }, 'slide clear');
  for (const q of [1, 2, 3]) push({ x: lead.x, y: lead.y, rotation: lead.rotation + (q * Math.PI) / 2 }, 'turn');
  // Wall slots: back on each wall, a few positions along it.
  if (semanticsOf(lead).wallBacked) {
    const off = lead.d / 2 + (lead.clearance.back ?? 0) + 0.006;
    for (const w of room.walls) {
      if (w.len < lead.w + 0.02) continue;
      const n = Math.max(2, Math.min(8, Math.floor(w.len / 0.4)));
      for (let k = 0; k <= n; k++) {
        const t = lead.w / 2 + 0.006 + ((w.len - lead.w - 0.012) * k) / n;
        push({ x: w.a.x + w.dir.x * t + w.n.x * off, y: w.a.y + w.dir.y * t + w.n.y * off, rotation: rotationFacing(w.n) }, 'move to a wall');
      }
    }
  }
  // Swap with another piece of similar footprint.
  for (const o of items) {
    if (o.id === lead.id || o.locked || isRug(o) || group.some((g) => g.id === o.id)) continue;
    if (Math.abs(o.w * o.d - lead.w * lead.d) > 0.6 * Math.max(o.w * o.d, lead.w * lead.d)) continue;
    const og = groupOf(items, o.id);
    if (og.length > 1) continue;
    const poses = moveGroup(group, lead, { x: o.x, y: o.y, rotation: o.rotation });
    poses.set(o.id, { x: lead.x, y: lead.y, rotation: lead.rotation });
    out.push({ label: `Swap the ${lcName(lead)} and the ${lcName(o)}`, reason: 'swap', poses });
  }
  return out;
}

const apply = (items: FurnitureItem[], poses: Map<string, Pose>) => items.map((f) => { const p = poses.get(f.id); return p ? { ...f, ...p } : f; });

interface Judge { fails: Set<string>; failCount: number; score: number }
function judge(model: SpaceModel, items: FurnitureItem[], req: Requirements | null, spaceId?: string): Judge {
  const checks = validateLayout(model, items, req, { spaceId });
  const fails = new Set(checks.filter((c) => c.result === 'fail').map((c) => c.id));
  return { fails, failCount: fails.size, score: designScore(evaluateRules(model, items, req, { spaceId })) };
}
const displacement = (a: FurnitureItem[], b: FurnitureItem[]) => {
  const m = new Map(b.map((f) => [f.id, f]));
  return a.reduce((t, f) => { const g = m.get(f.id); return t + (g ? Math.hypot(f.x - g.x, f.y - g.y) + angDiff(f.rotation, g.rotation) * 0.3 : 0); }, 0);
};
function subjects(model: SpaceModel, items: FurnitureItem[], failed: ValidationResult[]): string[] {
  const ids = new Set(items.map((f) => f.id));
  const out: string[] = [];
  for (const c of failed) for (const id of c.subjectIds) if (ids.has(id) && !out.includes(id)) out.push(id);
  void model;
  return out;
}

/**
 * Smallest set of moves that makes the layout pass every check: greedy, one move at a time, each move
 * the one that clears the most failed checks (ties: higher score, then smaller move). Stops when valid
 * or after `maxMoves`. Locked items never move.
 */
export function repairLayout(model: SpaceModel, furniture: FurnitureItem[], req: Requirements | null = null, opts: RepairOptions = {}): RepairResult {
  const room = buildRoom(model, opts.spaceId);
  const maxMoves = opts.maxMoves ?? 4;
  let cur = furniture;
  let j = judge(model, cur, req, opts.spaceId);
  const scoreBefore = j.score;
  const moves: RepairMove[] = [];
  for (let step = 0; step < maxMoves && j.failCount > 0; step++) {
    const failed = validateLayout(model, cur, req, { spaceId: opts.spaceId }).filter((c) => c.result === 'fail');
    let best: { items: FurnitureItem[]; j: Judge; cand: Cand; disp: number } | null = null;
    for (const id of subjects(model, cur, failed)) {
      for (const cand of candidates(room, cur, id)) {
        const next = apply(cur, cand.poses);
        const nj = judge(model, next, req, opts.spaceId);
        if (nj.failCount >= j.failCount) continue;
        const disp = displacement(next, cur);
        const better = !best || nj.failCount < best.j.failCount || (nj.failCount === best.j.failCount && (nj.score > best.j.score + 0.5 || (Math.abs(nj.score - best.j.score) <= 0.5 && disp < best.disp)));
        if (better) best = { items: next, j: nj, cand, disp };
      }
    }
    if (!best) break;
    const fixedNow = [...j.fails].filter((id) => !best!.j.fails.has(id));
    const why = failed.filter((c) => fixedNow.includes(c.id)).map((c) => c.details).join(' ') || best.cand.reason;
    for (const [id, to] of best.cand.poses) {
      const f = cur.find((x) => x.id === id)!;
      moves.push({ itemId: id, from: { x: f.x, y: f.y, rotation: f.rotation }, to, reason: why });
    }
    cur = best.items; j = best.j;
  }
  if (opts.knowledge === false) return { furniture: cur, moves, valid: j.failCount === 0, scoreBefore, scoreAfter: j.score };
  // Then the professional relations: each broken one comes with its own repair; apply, re-check.
  const k = repairKnowledge(model, cur, req, { spaceId: opts.spaceId, use: opts.use, maxMoves: Math.max(1, maxMoves - moves.length) });
  const jk = judge(model, k.furniture, req, opts.spaceId);
  return { furniture: k.furniture, moves: [...moves, ...k.moves], valid: jk.failCount === 0, scoreBefore, scoreAfter: jk.score, knowledge: { hardBefore: k.hardBefore, hardAfter: k.hardAfter, scoreBefore: k.scoreBefore, scoreAfter: k.scoreAfter, left: k.left } };
}

export interface KnowledgeRepairResult {
  furniture: FurnitureItem[]; moves: RepairMove[];
  /** Ids of the broken hard relations before and after. */
  hardBefore: string[]; hardAfter: string[];
  /** evaluateKnowledge score before and after. */
  scoreBefore: number; scoreAfter: number;
  /** What is still broken after the repair, strongest first, as chips and data. */
  left: CriticItem[];
}

const TASK_SEAT = /^(chair|desk-chair|office-chair|stool)$/;

/** Moves that carry out one knowledge repair: a chair back to a free place at its host, a nightstand to the bed head, or the general slides, turns and wall slots. */
function repairCands(room: RoomCtx, items: FurnitureItem[], rep: Repair): Cand[] {
  const f = items.find((x) => x.id === rep.itemId);
  if (!f || f.locked) return [];
  const one = (p: Pose, label: string, reason: string): Cand => ({ label, reason, poses: new Map([[f.id, { x: r3(p.x), y: r3(p.y), rotation: p.rotation }]]) });
  if (rep.relation.kind === 'paired-seat') {
    const host = items.find((x) => x.id === rep.to);
    if (!host) return [];
    const hostOf = pairSeatsOf(items.map(normaliseItem));
    const mates = items.filter((x) => TASK_SEAT.test(x.category) && (x.id === f.id || hostOf.get(x.id) === host.id));
    const out: Cand[] = [];
    for (const arr of seatArrangements(normaliseItem(host), mates.map(normaliseItem))) for (const p of arr) out.push(one(p, `Draw the ${lcName(f)} up to the ${lcName(host)}`, rep.chip));
    return out;
  }
  if (rep.relation.kind === 'flanks') {
    const bed = items.find((x) => x.id === rep.to);
    return bed ? flankOptions(normaliseItem(bed), normaliseItem(f), [-1, 1]).map((p) => one(p, `Put the ${lcName(f)} beside the ${lcName(bed)}`, rep.chip)) : [];
  }
  // A seat never drags its desk or table along: it moves alone.
  if (TASK_SEAT.test(f.category)) return [0.1, 0.3, 0.6].flatMap((d) => [[d, 0], [-d, 0], [0, d], [0, -d]]).map(([dx, dy]) => one({ x: f.x + dx, y: f.y + dy, rotation: f.rotation }, moveText(f, { x: f.x + dx, y: f.y + dy, rotation: f.rotation }), rep.chip));
  return candidates(room, items, rep.itemId).map((c) => ({ ...c, reason: rep.chip }));
}

/**
 * Apply the knowledge critic's repairs one at a time, strongest first, re-checking after each: a move
 * is kept only when it clears a hard relation (or lifts the relation score by 3+ with none broken),
 * adds no failed referee check and costs the measured rules at most 2 points. Locked items never move.
 */
export function repairKnowledge(model: SpaceModel, furniture: FurnitureItem[], req: Requirements | null = null, opts: { spaceId?: string; use?: RoomUse; maxMoves?: number } = {}): KnowledgeRepairResult {
  const room = buildRoom(model, opts.spaceId);
  const kOf = (items: FurnitureItem[]) => evaluateKnowledge(model, items, opts.use, opts.spaceId);
  let cur = furniture, k = kOf(cur), j = judge(model, cur, req, opts.spaceId);
  const first = k;
  const moves: RepairMove[] = [];
  const tried = new Set<string>();
  for (let step = 0; step < (opts.maxMoves ?? 4); step++) {
    const todo = critiqueKnowledge(model, cur, opts.use, opts.spaceId).filter((c) => c.repair && (c.hard || c.importance >= 4) && !tried.has(`${c.relation}:${c.repair.itemId}`));
    let done = false;
    for (const c of todo) {
      tried.add(`${c.relation}:${c.repair!.itemId}`);
      let best: { items: FurnitureItem[]; k: KnowledgeResult; j: Judge; cand: Cand; disp: number } | null = null;
      for (const cand of repairCands(room, cur, c.repair!)) {
        const next = apply(cur, cand.poses);
        const nk = kOf(next);
        const gain = nk.hardBroken.length < k.hardBroken.length || (nk.hardBroken.length === k.hardBroken.length && !nk.hardBroken.length && nk.score >= k.score + 3);
        if (!gain) continue;
        const nj = judge(model, next, req, opts.spaceId);
        if (nj.failCount > j.failCount || nj.score < j.score - 2) continue;
        const disp = displacement(next, cur);
        if (!best || nk.hardBroken.length < best.k.hardBroken.length || (nk.hardBroken.length === best.k.hardBroken.length && (nk.score > best.k.score + 1 || (Math.abs(nk.score - best.k.score) <= 1 && disp < best.disp)))) best = { items: next, k: nk, j: nj, cand, disp };
      }
      if (!best) continue;
      for (const [id, to] of best.cand.poses) {
        const f = cur.find((x) => x.id === id)!;
        moves.push({ itemId: id, from: { x: f.x, y: f.y, rotation: f.rotation }, to, reason: best.cand.reason });
      }
      cur = best.items; k = best.k; j = best.j; done = true;
      break;
    }
    if (!done) break;
  }
  return {
    furniture: cur, moves,
    hardBefore: first.hardBroken.map((v) => v.id), hardAfter: k.hardBroken.map((v) => v.id),
    scoreBefore: first.score, scoreAfter: k.score,
    left: critiqueKnowledge(model, cur, opts.use, opts.spaceId),
  };
}

const isCheck = (x: ValidationResult | RuleVerdict): x is ValidationResult => 'result' in x;

/**
 * One to three concrete ways to fix a single failed check (from the referee) or a weak rule verdict.
 * Each option moves as little as possible, clears that problem and adds no new failed check.
 */
export function fixesFor(model: SpaceModel, furniture: FurnitureItem[], problem: ValidationResult | RuleVerdict, req: Requirements | null = null, opts: { spaceId?: string } = {}): Fix[] {
  if (!problem) return [];
  const room = buildRoom(model, opts.spaceId);
  const base = judge(model, furniture, req, opts.spaceId);
  const ids = new Set(furniture.map((f) => f.id));
  const subj = (isCheck(problem) ? problem.subjectIds : problem.itemIds).filter((id) => ids.has(id));
  const solved = (items: FurnitureItem[], nj: Judge): boolean => {
    if (isCheck(problem)) return !nj.fails.has(problem.id) && ![...validateLayout(model, items, req, { spaceId: opts.spaceId })].some((c) => c.result === 'fail' && c.rule === problem.rule && c.subjectIds.some((s) => subj.includes(s)));
    const v = evaluateRules(model, items, req, { spaceId: opts.spaceId }).filter((x) => x.ruleId === problem.ruleId && x.itemIds.some((s) => subj.includes(s)));
    return v.every((x) => x.score >= Math.max(problem.score + 0.15, 0.6));
  };
  const found: Array<{ cand: Cand; items: FurnitureItem[]; score: number; disp: number }> = [];
  for (const id of subj) for (const cand of candidates(room, furniture, id)) {
    const items = apply(furniture, cand.poses);
    const nj = judge(model, items, req, opts.spaceId);
    if ([...nj.fails].some((f) => !base.fails.has(f))) continue; // never trade one problem for another
    if (!solved(items, nj)) continue;
    found.push({ cand, items, score: nj.score, disp: displacement(items, furniture) });
  }
  // Prefer small moves that keep or raise the score; offer different kinds of fix.
  found.sort((a, b) => a.disp * 8 - a.score - (b.disp * 8 - b.score));
  const out: Fix[] = [];
  const kinds = new Set<string>();
  for (const f of found) {
    if (out.length >= 3) break;
    if (kinds.has(f.cand.reason) && found.some((g) => !kinds.has(g.cand.reason))) continue;
    if (out.some((o) => o.label === f.cand.label)) continue;
    kinds.add(f.cand.reason);
    out.push({
      label: f.cand.label,
      ops: [...f.cand.poses].map(([id, p]) => ({ type: 'UPDATE_OBJECT', id, patch: { x: p.x, y: p.y, rotation: p.rotation } }) as Op),
      preview: f.items,
    });
  }
  return out;
}
