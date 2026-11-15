import type { FurnitureItem, Op, SpaceModel } from '../../core/types';
import { catalogEntry, type CatalogEntry } from '../furniture/catalog';
import { costOf } from './money';
import { OPTIONAL, cheaperOptions } from './optimise';

export type MoveKind = 'swap' | 'drop' | 'keep';
export type ReasonTag = 'Cheaper twin' | 'Decor' | 'Essential' | 'Already owned';

export interface Move {
  id: string;
  itemId: string;
  name: string;
  kind: MoveKind;
  tag: ReasonTag;
  /** Kronor saved when the move is applied. Zero for a keep. */
  savingSek: number;
  /** Catalogue entry a swap switches to. */
  toCatalogId?: string;
  toName?: string;
  /** Whether the plan proposes this move to reach the budget. */
  suggested: boolean;
}

export interface BudgetSummary {
  budgetSek: number;
  totalSek: number;
  /** Positive when over budget, negative when under. */
  overSek: number;
  moves: Move[];
  /** Total after the suggested moves. */
  afterSek: number;
}

/** Pieces a room is used through; they can be made cheaper but never removed. */
export const ESSENTIAL = ['bed', 'bunk-bed', 'crib', 'desk', 'sofa', 'sofa-bed', 'table', 'cafe-table', 'treatment-bed'];

const isOwned = (f: FurnitureItem) => f.owned || f.priceStatus === 'owned';
const isDecor = (f: FurnitureItem) => OPTIONAL.includes(f.category);
const isEssential = (f: FurnitureItem) => f.locked || ESSENTIAL.includes(f.category);

/** The same-spot patch for a swap: the back edge stays put, so the new item sits inside the old footprint. */
export function swapPatch(f: FurnitureItem, e: CatalogEntry): Partial<FurnitureItem> {
  const shift = (f.d - e.d) / 2;
  return {
    catalogId: e.id, name: e.name, w: e.w, d: e.d, h: e.h, clearance: { ...e.clearance }, unfoldedD: e.unfoldedD,
    x: f.x + Math.sin(f.rotation) * shift, y: f.y - Math.cos(f.rotation) * shift,
    priceSek: e.priceSek, priceStatus: 'estimated', color: e.color, material: e.material, listing: undefined, sourceKind: 'catalog',
  };
}

function candidates(f: FurnitureItem): Move[] {
  const base = { itemId: f.id, name: f.name, suggested: false };
  if (isOwned(f)) return [{ ...base, id: `keep:${f.id}`, kind: 'keep', tag: 'Already owned', savingSek: 0 }];
  const out: Move[] = [];
  if (!f.locked) {
    // Deepest saving first: the cheapest model that still fits.
    const opts = cheaperOptions(f);
    const best = opts[opts.length - 1];
    if (best) out.push({ ...base, id: `swap:${f.id}`, kind: 'swap', tag: 'Cheaper twin', savingSek: costOf(f) - best.priceSek, toCatalogId: best.id, toName: best.name });
    if (isDecor(f) && !isEssential(f) && costOf(f) > 0) out.push({ ...base, id: `drop:${f.id}`, kind: 'drop', tag: 'Decor', savingSek: costOf(f) });
  }
  if (!out.length && isEssential(f)) out.push({ ...base, id: `keep:${f.id}`, kind: 'keep', tag: 'Essential', savingSek: 0 });
  return out;
}

export function totalFor(items: FurnitureItem[]) { return items.reduce((t, f) => t + costOf(f), 0); }

/**
 * Propose what to swap, drop or keep to reach a budget. Moves come ranked: suggested ones first (largest saving first),
 * then the remaining options, then keeps. The suggestion uses as few moves as it can.
 */
export function planBudget(model: SpaceModel, budgetSek: number): BudgetSummary {
  const items = model.furniture;
  const totalSek = totalFor(items);
  const all = items.flatMap(candidates);
  const money = all.filter((m) => m.kind !== 'keep').sort((a, b) => b.savingSek - a.savingSek);
  const need = totalSek - budgetSek;
  let picked: Move[] = [];
  if (need > 0) {
    // One move per item at most.
    const used = new Set<string>();
    let got = 0;
    for (const m of money) {
      if (got >= need) break;
      if (used.has(m.itemId)) continue;
      used.add(m.itemId); picked.push(m); got += m.savingSek;
    }
    // Release moves that turned out unnecessary, smallest first, while the target is still met.
    for (const m of [...picked].sort((a, b) => a.savingSek - b.savingSek)) {
      if (got - m.savingSek >= need) { picked = picked.filter((p) => p !== m); got -= m.savingSek; }
    }
  }
  const sel = new Set(picked.map((m) => m.id));
  const moves = [
    ...money.filter((m) => sel.has(m.id)).map((m) => ({ ...m, suggested: true })),
    ...money.filter((m) => !sel.has(m.id)),
    ...all.filter((m) => m.kind === 'keep'),
  ];
  const afterSek = totalSek - picked.reduce((t, m) => t + m.savingSek, 0);
  return { budgetSek, totalSek, overSek: totalSek - budgetSek, moves, afterSek };
}

/** Store operations for the chosen moves. Keeps produce nothing. */
export function applyMoves(model: SpaceModel, moves: Move[]): Op[] {
  const ops: Op[] = [];
  const done = new Set<string>();
  for (const m of moves) {
    if (m.kind === 'keep' || done.has(m.itemId)) continue;
    const f = model.furniture.find((x) => x.id === m.itemId);
    if (!f) continue;
    done.add(m.itemId);
    if (m.kind === 'drop') {
      if (isEssential(f)) continue;
      ops.push({ type: 'REMOVE_OBJECT', id: f.id });
    } else {
      const e = m.toCatalogId ? catalogEntry(m.toCatalogId) : undefined;
      if (e) ops.push({ type: 'UPDATE_OBJECT', id: f.id, patch: swapPatch(f, e) });
    }
  }
  return ops;
}

/** Total once the given moves are applied (one move per item). */
export function totalAfter(model: SpaceModel, moves: Move[]): number {
  const by = new Map(moves.filter((m) => m.kind !== 'keep').map((m) => [m.itemId, m]));
  return model.furniture.reduce((t, f) => {
    const m = by.get(f.id);
    return t + (m ? costOf(f) - m.savingSek : costOf(f));
  }, 0);
}
