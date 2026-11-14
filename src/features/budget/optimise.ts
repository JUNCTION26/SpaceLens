import type { FurnitureItem, Requirements, SpaceModel, ValidationResult } from '../../core/types';
import { CATALOG, type CatalogEntry } from '../furniture/catalog';
import { evaluateRules } from '../design/rules';
import { designScore } from '../design/score';
import { validateLayout } from '../referee/validate';
import { costOf, countWord, kr, nounOf, plural, totalOf } from './money';

export type SwapKind = 'replace' | 'downsize' | 'drop';

export interface Snap { name: string; catalogId: string; w: number; d: number; h: number; priceSek: number }

/** One proposed change to one item. `after` is null for a drop. */
export interface Swap {
  id: string;
  itemId: string;
  kind: SwapKind;
  before: Snap;
  after: Snap | null;
  /** Fields to write onto the item for replace and downsize. */
  patch: Partial<FurnitureItem> | null;
  saving: number;
  /** Design score points lost by this swap on its own, never negative. */
  scoreLoss: number;
  /** One plain sentence on what changes. */
  change: string;
}

export interface OptimiseOptions {
  req?: Requirements | null;
  spaceId?: string;
  /** Categories that may be dropped. */
  optional?: string[];
  /** Skip these items entirely. */
  frozen?: string[];
  maxSteps?: number;
}

export interface BudgetPlan {
  plan: Swap[];
  /** Cost of what is left to buy after the plan. */
  total: number;
  before: number;
  saved: number;
  feasible: boolean;
  /** Plain sentences: what was reached, and what blocks the target when it cannot be met. */
  notes: string[];
  /** Names of owned items that were left alone. */
  kept: string[];
  scoreBefore: number;
  scoreAfter: number;
  /** True when the starting layout already fails a check, so the plan only promises not to add more. */
  alreadyFailing: boolean;
}

export const OPTIONAL = ['rug', 'plant', 'lamp', 'side-table', 'coffee-table', 'decor', 'mirror'];

const FAMILY: Record<string, string> = { chair: 'chair', 'desk-chair': 'chair', 'office-chair': 'chair' };
const family = (c: string) => FAMILY[c] ?? c;
const EPS = 0.005;

const snapOf = (f: FurnitureItem): Snap => ({ name: f.name, catalogId: f.catalogId, w: f.w, d: f.d, h: f.h, priceSek: costOf(f) });
const keyOf = (x: ValidationResult) => `${x.id}|${[...x.subjectIds].sort().join(',')}`;
const failKeys = (r: ValidationResult[]) => new Set(r.filter((x) => x.result === 'fail').map(keyOf));

const cmStr = (m: number) => `${Math.round(Math.abs(m) * 100)} cm`;

/** What the person gives up in size, in words. */
export function sizeChange(b: Snap, a: Snap): string {
  const parts: string[] = [];
  if (b.w - a.w > EPS) parts.push(`${cmStr(b.w - a.w)} narrower`);
  if (b.d - a.d > EPS) parts.push(`${cmStr(b.d - a.d)} shallower`);
  if (b.h - a.h > 0.04) parts.push(`${cmStr(b.h - a.h)} lower`);
  return parts.join(' and ');
}

/** Cheaper catalogue models of the same kind that fit the item's footprint, dearest first. */
export function cheaperOptions(f: FurnitureItem): CatalogEntry[] {
  if (f.custom || f.catalogId === 'custom' || f.catalogId === 'generated') return [];
  const fam = family(f.category), cost = costOf(f);
  return CATALOG.filter((e) => family(e.category) === fam && e.id !== f.catalogId && e.priceSek < cost
    && e.w <= f.w + EPS && e.d <= f.d + EPS && (e.unfoldedD ?? e.d) <= (f.unfoldedD ?? f.d) + EPS)
    .sort((a, b) => b.priceSek - a.priceSek);
}

/** The item as it would look after a swap. Its back edge stays put so a wall-backed item stays against the wall. */
function swapped(f: FurnitureItem, e: CatalogEntry): FurnitureItem {
  const shift = (f.d - e.d) / 2;
  return {
    ...f, catalogId: e.id, name: e.name, w: e.w, d: e.d, h: e.h, clearance: { ...e.clearance }, unfoldedD: e.unfoldedD,
    x: f.x + Math.sin(f.rotation) * shift, y: f.y - Math.cos(f.rotation) * shift,
    priceSek: e.priceSek, priceStatus: 'estimated', color: e.color, material: e.material, listing: undefined, sourceKind: 'catalog',
  };
}
const patchOf = (n: FurnitureItem): Partial<FurnitureItem> => ({
  catalogId: n.catalogId, name: n.name, w: n.w, d: n.d, h: n.h, clearance: n.clearance, unfoldedD: n.unfoldedD, x: n.x, y: n.y,
  priceSek: n.priceSek, priceStatus: n.priceStatus, color: n.color, material: n.material, listing: undefined, sourceKind: 'catalog',
});

/** Items after applying swaps (the whole plan, or the part the person kept switched on). */
export function applySwaps(furniture: FurnitureItem[], swaps: Swap[]): FurnitureItem[] {
  const by = new Map(swaps.map((s) => [s.itemId, s]));
  const out: FurnitureItem[] = [];
  for (const f of furniture) {
    const s = by.get(f.id);
    if (!s) out.push(f);
    else if (s.kind !== 'drop' && s.patch) out.push({ ...f, ...s.patch });
  }
  return out;
}

export function scoreOf(model: SpaceModel, furniture: FurnitureItem[], req?: Requirements | null, spaceId?: string, fast = false): number {
  return designScore(evaluateRules(model, furniture, req, { fast, spaceId }));
}

/** Failing checks the next layout would add compared with the start. */
export function newFailures(model: SpaceModel, start: FurnitureItem[], next: FurnitureItem[], req?: Requirements | null, spaceId?: string): ValidationResult[] {
  const base = failKeys(validateLayout(model, start, req, { spaceId }));
  return validateLayout(model, next, req, { spaceId }).filter((r) => r.result === 'fail' && !base.has(keyOf(r)));
}

interface Move { itemId: string; kind: SwapKind; entry?: CatalogEntry }

export function optimiseBudget(model: SpaceModel, furniture: FurnitureItem[], targetSek: number, opts: OptimiseOptions = {}): BudgetPlan {
  const { req, spaceId } = opts;
  const optional = new Set(opts.optional ?? OPTIONAL), frozen = new Set(opts.frozen ?? []);
  const maxSteps = opts.maxSteps ?? 40;
  const before = totalOf(furniture);
  const baseFails = failKeys(validateLayout(model, furniture, req, { spaceId }));
  const alreadyFailing = baseFails.size > 0;
  const okLayout = (items: FurnitureItem[]) => validateLayout(model, items, req, { spaceId })
    .every((r) => r.result !== 'fail' || baseFails.has(keyOf(r)));
  const fastScore = (items: FurnitureItem[]) => scoreOf(model, items, req, spaceId, true);

  const kept = furniture.filter((f) => f.owned || f.priceStatus === 'owned').map((f) => f.name);
  const scoreBefore = scoreOf(model, furniture, req, spaceId);

  let cur = furniture.slice();
  let curScore = fastScore(cur);
  const movable = (f: FurnitureItem) => !frozen.has(f.id) && !f.locked && costOf(f) > 0;

  const movesFor = (items: FurnitureItem[]): Move[] => {
    const out: Move[] = [];
    for (const f of items.filter(movable)) {
      for (const e of cheaperOptions(f)) out.push({ itemId: f.id, kind: 'replace', entry: e });
      if (optional.has(f.category)) out.push({ itemId: f.id, kind: 'drop' });
    }
    return out;
  };
  const run = (items: FurnitureItem[], m: Move): FurnitureItem[] => (m.kind === 'drop'
    ? items.filter((f) => f.id !== m.itemId)
    : items.map((f) => (f.id === m.itemId ? swapped(f, m.entry!) : f)));

  // Greedy: biggest saving per score point lost, among moves that keep every check passing.
  for (let step = 0; step < maxSteps && totalOf(cur) > targetSek; step++) {
    let best: { next: FurnitureItem[]; score: number; ratio: number } | null = null;
    for (const m of movesFor(cur)) {
      const item = cur.find((f) => f.id === m.itemId)!;
      const saving = costOf(item) - (m.entry ? m.entry.priceSek : 0);
      if (saving <= 0) continue;
      const next = run(cur, m);
      const score = fastScore(next);
      const loss = Math.max(0, curScore - score) + (m.kind === 'drop' ? 1.5 : 0.25);
      const ratio = saving / loss;
      if (best && ratio <= best.ratio) continue;
      if (!okLayout(next)) continue;
      best = { next, score, ratio };
    }
    if (!best) break;
    cur = best.next; curScore = best.score;
  }

  // One swap per changed item, comparing the end state with the start.
  const endBy = new Map(cur.map((f) => [f.id, f]));
  let plan: Swap[] = [];
  for (const f of furniture) {
    const e = endBy.get(f.id);
    if (e && e.catalogId === f.catalogId && costOf(e) === costOf(f)) continue;
    const bSnap = snapOf(f);
    if (!e) {
      plan.push({ id: `drop:${f.id}`, itemId: f.id, kind: 'drop', before: bSnap, after: null, patch: null, saving: costOf(f), scoreLoss: 0,
        change: `Leave out the ${f.name.toLowerCase()}.` });
      continue;
    }
    const aSnap = snapOf(e);
    const smaller = bSnap.w - aSnap.w > EPS || bSnap.d - aSnap.d > EPS;
    const diff = sizeChange(bSnap, aSnap);
    plan.push({
      id: `swap:${f.id}`, itemId: f.id, kind: smaller ? 'downsize' : 'replace', before: bSnap, after: aSnap, patch: patchOf(e),
      saving: costOf(f) - costOf(e), scoreLoss: 0,
      change: diff ? `${e.name} instead of ${f.name.toLowerCase()}: ${diff}.` : `${e.name} instead of ${f.name.toLowerCase()}, same footprint.`,
    });
  }

  // Improvement pass: put a change back when the target still holds without it.
  const totalWith = (p: Swap[]) => totalOf(applySwaps(furniture, p));
  if (totalWith(plan) <= targetSek) {
    for (;;) {
      let pick: { s: Swap; score: number } | null = null;
      const baseScore = fastScore(applySwaps(furniture, plan));
      for (const s of plan) {
        const rest = plan.filter((x) => x !== s);
        if (totalWith(rest) > targetSek) continue;
        const rem = applySwaps(furniture, rest);
        const score = fastScore(rem);
        if (score >= baseScore - 0.01 && !(pick && score <= pick.score) && okLayout(rem)) pick = { s, score };
      }
      if (!pick) break;
      plan = plan.filter((x) => x !== pick!.s);
    }
  }
  // Each swap's own cost in design points, measured alone against the start.
  const startScore = fastScore(furniture);
  plan = plan.map((s) => ({ ...s, scoreLoss: Math.max(0, Math.round((startScore - fastScore(applySwaps(furniture, [s]))) * 10) / 10) }));
  plan.sort((a, b) => b.saving - a.saving);

  // Last guard: the whole plan must leave the layout at least as valid as it started.
  if (plan.length && !okLayout(applySwaps(furniture, plan))) plan = [];
  const result = applySwaps(furniture, plan);
  const total = totalOf(result);
  const feasible = total <= targetSek;
  const scoreAfter = scoreOf(model, result, req, spaceId);

  const notes: string[] = [];
  if (before <= targetSek) notes.push(`Already within budget: ${kr(before)} to buy against ${kr(targetSek)}.`);
  else if (feasible) notes.push(`${kr(before - total)} saved, bringing the purchases to ${kr(total)}.`);
  else {
    notes.push(`The lowest I can reach without breaking a check is ${kr(total)}, which is ${kr(total - targetSek)} over ${kr(targetSek)}.`);
    notes.push(...blockers(result, furniture));
  }
  if (plan.length && scoreAfter < scoreBefore) notes.push(`Design score ${scoreBefore} to ${scoreAfter}.`);
  if (alreadyFailing) notes.push('The room already fails a check. These changes do not add any new ones.');
  if (kept.length) notes.push(`Owned items are kept: ${kept.join(', ')}.`);

  return { plan, total, before, saved: before - total, feasible, notes, kept, scoreBefore, scoreAfter, alreadyFailing };
}

/** What is left that cannot be made cheaper: the heaviest groups of items, in plain words. */
export function blockers(left: FurnitureItem[], all: FurnitureItem[] = left): string[] {
  const groups = new Map<string, { n: number; cost: number }>();
  for (const f of left) {
    const c = costOf(f); if (c <= 0) continue;
    const k = family(f.category), g = groups.get(k) ?? { n: 0, cost: 0 };
    g.n++; g.cost += c; groups.set(k, g);
  }
  const top = [...groups.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 2);
  const out = top.map(([cat, g]) => {
    const noun = nounOf(cat);
    return g.n === 1 ? `The ${noun} alone costs ${kr(g.cost)} and nothing cheaper fits its space.` : `The ${countWord(g.n)} ${plural(noun, g.n)} alone cost ${kr(g.cost)}.`;
  });
  const owned = all.filter((f) => f.owned || f.priceStatus === 'owned').length;
  if (owned) out.push(`${owned} owned ${owned === 1 ? 'item is' : 'items are'} left as they are.`);
  return out;
}
