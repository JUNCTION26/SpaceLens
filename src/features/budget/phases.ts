import type { FurnitureItem } from '../../core/types';
import { costOf } from './money';

export type PhaseKey = 'now' | 'next' | 'later';

export interface Phase {
  key: PhaseKey;
  label: string;
  why: string;
  items: FurnitureItem[];
  total: number;
  /** With a monthly amount: the month by which this phase is paid for, counting from the first. */
  paidByMonth: number | null;
}

const NOW = new Set(['bed', 'sofa-bed', 'crib', 'treatment-bed', 'desk', 'chair', 'desk-chair', 'office-chair', 'counter', 'stool']);
const NEXT = new Set(['wardrobe', 'dresser', 'bookshelf', 'storage-cabinet', 'filing-cabinet', 'shoe-cabinet', 'toy-storage', 'nightstand', 'tv-unit', 'table', 'cafe-table', 'sofa', 'armchair']);

/** Sleep and work first, storage and seating next, decor last. */
export function phaseOf(f: FurnitureItem): PhaseKey {
  if (NOW.has(f.category)) return 'now';
  if (NEXT.has(f.category)) return 'next';
  return 'later';
}

const META: Record<PhaseKey, { label: string; why: string }> = {
  now: { label: 'Now', why: 'Somewhere to sleep and to work.' },
  next: { label: 'Next', why: 'Storage, seating and tables.' },
  later: { label: 'Later', why: 'Rugs, plants, lamps and the rest.' },
};

/** Things still to buy, split by need, with the month each phase is covered by a steady monthly amount. */
export function planPhases(items: FurnitureItem[], monthlySek = 0): Phase[] {
  const buy = items.filter((f) => costOf(f) > 0);
  let running = 0;
  return (['now', 'next', 'later'] as const).map((key) => {
    const its = buy.filter((f) => phaseOf(f) === key).sort((a, b) => costOf(b) - costOf(a));
    const total = its.reduce((t, f) => t + costOf(f), 0);
    running += total;
    return { key, ...META[key], items: its, total, paidByMonth: monthlySek > 0 && total > 0 ? Math.ceil(running / monthlySek) : null };
  });
}
