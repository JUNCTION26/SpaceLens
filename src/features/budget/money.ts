import type { FurnitureItem } from '../../core/types';

/** "5 480 kr", with non-breaking spaces so a figure never wraps. */
export const kr = (v: number) => `${Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} kr`;

/** What the person pays for an item: nothing when they own it. */
export const costOf = (f: FurnitureItem) => (f.owned || f.priceStatus === 'owned' ? 0 : Math.max(0, f.priceSek || 0));
export const totalOf = (items: FurnitureItem[]) => items.reduce((t, f) => t + costOf(f), 0);

/** Plain label for where a price came from. Estimates are never presented as quotes. */
export function priceLabel(f: FurnitureItem): string {
  if (f.owned || f.priceStatus === 'owned') return 'owned';
  if (f.listing && f.listing.price != null) return `from ${f.listing.store} listing`;
  if (f.priceStatus === 'user') return 'your price';
  if (f.priceStatus === 'catalog') return 'catalogue price';
  return 'estimate';
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
export const countWord = (n: number) => WORDS[n] ?? String(n);

const PLURAL: Record<string, string> = { shelf: 'shelves', wardrobe: 'wardrobes', 'chest of drawers': 'chests of drawers' };
export function plural(noun: string, n: number): string {
  if (n === 1) return noun;
  if (PLURAL[noun]) return PLURAL[noun];
  return /(s|x|ch)$/.test(noun) ? `${noun}es` : `${noun}s`;
}

/** Everyday noun for a category. */
const NOUN: Record<string, string> = {
  bed: 'bed', sofa: 'sofa', 'sofa-bed': 'sofa bed', armchair: 'armchair', desk: 'desk', chair: 'chair', 'office-chair': 'office chair',
  bookshelf: 'bookshelf', wardrobe: 'wardrobe', dresser: 'chest of drawers', nightstand: 'nightstand', table: 'table', 'cafe-table': 'cafe table',
  bench: 'bench', counter: 'counter', 'coffee-table': 'coffee table', 'tv-unit': 'TV unit', rug: 'rug', plant: 'plant', lamp: 'lamp',
  crib: 'crib', 'toy-storage': 'toy storage', 'storage-cabinet': 'cabinet', 'filing-cabinet': 'filing cabinet', stool: 'stool', 'treatment-bed': 'treatment bed',
};
export const nounOf = (category: string) => NOUN[category] ?? category.replace(/-/g, ' ');
