import type { FurnitureItem } from '../../core/types';
import { ai, aiReady } from '../../core/ai';
import { costOf, kr, nounOf, priceLabel, totalOf } from './money';
import { sizeChange, type Swap } from './optimise';

export interface Argument { itemId: string; name: string; text: string }

/** What an item makes possible, by category. */
const ENABLES: Record<string, string> = {
  bed: 'sleeping', 'sofa-bed': 'sleeping and sitting', crib: 'a safe place for the baby to sleep', 'treatment-bed': 'treatment',
  desk: 'working', chair: 'sitting', 'office-chair': 'sitting through a working day', 'desk-chair': 'sitting at the desk',
  wardrobe: 'storing clothes', dresser: 'storing clothes', bookshelf: 'storing books and things', 'storage-cabinet': 'storage',
  'filing-cabinet': 'keeping papers', nightstand: 'a place for a lamp and a phone by the bed', table: 'eating and working at a table',
  'cafe-table': 'serving', sofa: 'sitting and relaxing', armchair: 'a second seat', 'tv-unit': 'a place for the screen',
  'coffee-table': 'a surface within reach of the sofa', rug: 'warmth and a defined sitting area', plant: 'a bit of life in the room', lamp: 'softer light',
};

/**
 * One plain sentence per item to buy, built from the data: its share of the spend, what it enables,
 * and the cheaper option with what would be lost. Every figure comes from the items and the plan.
 */
export function argueItems(items: FurnitureItem[], plan: Swap[] = []): Argument[] {
  const total = totalOf(items);
  const by = new Map(plan.map((s) => [s.itemId, s]));
  return items.filter((f) => costOf(f) > 0).sort((a, b) => costOf(b) - costOf(a)).map((f) => {
    const share = total > 0 ? Math.round((costOf(f) / total) * 100) : 0;
    const enables = ENABLES[f.category] ?? `its place in the room`;
    const head = `${f.name}, ${kr(costOf(f))} (${share}% of the spend, ${priceLabel(f)}): it gives you ${enables}.`;
    const s = by.get(f.id);
    let tail: string;
    if (!s) tail = 'No cheaper option fits this spot without breaking a check or losing design quality.';
    else if (s.kind === 'drop') tail = `Leaving it out saves ${kr(s.saving)} and costs ${s.scoreLoss} design ${s.scoreLoss === 1 ? 'point' : 'points'}.`;
    else {
      const diff = s.after ? sizeChange(s.before, s.after) : '';
      tail = `${s.after?.name} saves ${kr(s.saving)}${diff ? ` but the ${nounOf(f.category)} is ${diff}` : ', same footprint'}.`;
    }
    return { itemId: f.id, name: f.name, text: `${head} ${tail}` };
  });
}

const numbersIn = (s: string) => (s.replace(/ /g, ' ').match(/\d[\d ]*\d|\d/g) ?? []).map((n) => n.replace(/ /g, '')).sort().join(',');

/**
 * Optionally smooth the wording with one fast call. A rewrite is accepted only when it contains exactly the
 * same numbers as the original, so the figures can never change.
 */
export async function polishArguments(args: Argument[], signal?: AbortSignal): Promise<Argument[]> {
  if (!args.length || !aiReady()) return args;
  try {
    const r = await ai<string[]>({
      task: 'fast', signal, json: true,
      system: 'Rewrite each line to read naturally in plain English, one sentence or two. Keep every number, unit and name exactly as given. Do not add facts. Return a JSON array of strings, same length and order.',
      parts: [{ text: JSON.stringify(args.map((a) => a.text)) }],
    });
    const out = Array.isArray(r.data) ? r.data : [];
    if (out.length !== args.length) return args;
    return args.map((a, i) => (typeof out[i] === 'string' && numbersIn(out[i]) === numbersIn(a.text) ? { ...a, text: out[i].trim() } : a));
  } catch {
    return args;
  }
}
