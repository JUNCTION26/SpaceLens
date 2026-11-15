import type { FurnitureItem } from '../../core/types';

type Piece = Pick<FurnitureItem, 'category' | 'w' | 'd'>;

const ANCHORS = /^(bed|sofa|desk|table|dining-?table|wardrobe|bookcase|shelf|tv-?unit|tv|cabinet|sideboard|dresser|counter|cat-?tree|crib)/i;
const DEPENDENTS = /^(chair|stool|bench|nightstand|armchair|coffee-?table|side-?table|ottoman|pouf|footstool|storage)/i;

/** 0 = anchor (bed, sofa, desk, table), 1 = dependent (chairs, nightstands), 2 = decor (rugs, lamps, art). */
export function revealRank(it: Pick<FurnitureItem, 'category'>): 0 | 1 | 2 {
  if (ANCHORS.test(it.category)) return 0;
  if (DEPENDENTS.test(it.category)) return 1;
  return 2;
}

/** The order a designer would place pieces in: anchors first, then what depends on them, then decor.
 *  Within a group the larger piece goes first; ties keep the input order. Never mutates the input. */
export function revealOrder<T extends Piece>(items: readonly T[]): T[] {
  return items
    .map((it, i) => ({ it, i, r: revealRank(it), a: it.w * it.d }))
    .sort((p, q) => p.r - q.r || (p.r === 0 ? q.a - p.a : 0) || p.i - q.i)
    .map((p) => p.it);
}
