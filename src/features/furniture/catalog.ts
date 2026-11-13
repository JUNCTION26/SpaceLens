import { uid } from '../../core/geometry';
import type { Clearance, FurnitureItem, PriceStatus } from '../../core/types';

export interface CatalogEntry {
  id: string; name: string; category: string; w: number; d: number; h: number;
  clearance: Clearance; unfoldedD?: number; priceSek: number; color: string; material?: string; tags: string[];
  /** Prices are rough estimates of typical Swedish retail, not quotes. */
  priceStatus?: PriceStatus;
  /** Can overlap other items (rugs). */
  overlaps?: boolean;
}

const c = (front: number, back = 0, left = 0, right = 0): Clearance => ({ front, back, left, right });

type Row = [string, string, string, number, number, number, Clearance, number, string, string, string[], Partial<CatalogEntry>?];
const ROWS: Row[] = [
  ['bed-single', 'Single bed 90x200', 'bed', 0.9, 2.0, 0.9, c(0.6, 0, 0.6, 0), 2490, '#c9b8a0', 'pine', ['sleep', 'kids']],
  ['bed-double', 'Double bed 140x200', 'bed', 1.4, 2.0, 0.95, c(0.6, 0, 0.6, 0.6), 4990, '#b9a68c', 'oak veneer', ['sleep']],
  ['bed-160', 'Double bed 160x200', 'bed', 1.6, 2.0, 1.0, c(0.6, 0, 0.6, 0.6), 6490, '#8a7563', 'upholstered', ['sleep']],
  ['sofa-2', 'Sofa 2-seat', 'sofa', 1.6, 0.88, 0.8, c(0.45), 4990, '#6d7f8f', 'fabric', ['living']],
  ['sofa-3', 'Sofa 3-seat', 'sofa', 2.1, 0.92, 0.82, c(0.45), 7990, '#5d6e7c', 'fabric', ['living']],
  ['sofa-bed', 'Sofa bed', 'sofa-bed', 2.0, 0.95, 0.85, c(0.45), 6990, '#7d6b5d', 'fabric', ['living', 'sleep'], { unfoldedD: 2.1 }],
  ['armchair', 'Armchair', 'armchair', 0.8, 0.82, 0.85, c(0.4), 2990, '#a7835c', 'fabric', ['living', 'cafe']],
  ['desk-120', 'Desk 120', 'desk', 1.2, 0.6, 0.74, c(0.75), 1490, '#d8c7a8', 'birch', ['work', 'kids']],
  ['desk-140', 'Desk 140', 'desk', 1.4, 0.7, 0.74, c(0.75), 2490, '#b08a5a', 'oak veneer', ['work']],
  ['desk-160', 'Desk 160', 'desk', 1.6, 0.8, 0.74, c(0.75), 3490, '#9b7b55', 'oak veneer', ['work']],
  ['desk-standing', 'Standing desk 160', 'desk', 1.6, 0.8, 1.0, c(0.75), 5990, '#e2e2e2', 'steel and laminate', ['work', 'accessible']],
  ['desk-monitor', 'Monitor desk 180', 'desk', 1.8, 0.8, 0.74, c(0.75), 4490, '#3a3a3a', 'black laminate', ['work']],
  ['desk-chair', 'Desk chair', 'chair', 0.5, 0.5, 0.85, c(0.75), 990, '#444b55', 'plastic', ['work', 'kids']],
  ['office-chair', 'Office chair', 'office-chair', 0.65, 0.65, 1.15, c(0.75), 2990, '#2c2f33', 'mesh', ['work']],
  ['bookshelf', 'Bookshelf', 'bookshelf', 0.8, 0.28, 2.0, c(0.6), 1290, '#efe8dc', 'white laminate', ['storage', 'living', 'work']],
  ['bookshelf-low', 'Low bookshelf', 'bookshelf', 0.8, 0.3, 0.9, c(0.6), 790, '#efe8dc', 'white laminate', ['storage', 'kids']],
  ['wardrobe-100', 'Wardrobe 100', 'wardrobe', 1.0, 0.6, 2.0, c(0.6), 2990, '#f2efe9', 'white laminate', ['storage', 'sleep']],
  ['wardrobe-150', 'Wardrobe 150', 'wardrobe', 1.5, 0.6, 2.2, c(0.6), 4490, '#f2efe9', 'white laminate', ['storage', 'sleep']],
  ['dresser', 'Chest of drawers', 'dresser', 0.8, 0.48, 0.8, c(0.5), 1990, '#c4a27c', 'oak veneer', ['storage', 'sleep']],
  ['nightstand', 'Nightstand', 'nightstand', 0.45, 0.4, 0.55, c(0.3), 590, '#c4a27c', 'oak veneer', ['sleep', 'storage']],
  ['dining-4', 'Dining table for 4', 'table', 1.2, 0.8, 0.75, c(0.75, 0.75, 0.75, 0.75), 2990, '#a07a52', 'oak', ['dining']],
  ['dining-6', 'Dining table for 6', 'table', 1.8, 0.9, 0.75, c(0.75, 0.75, 0.75, 0.75), 4990, '#8a6744', 'oak', ['dining']],
  ['dining-ext', 'Extendable table', 'table', 1.4, 0.85, 0.75, c(0.75, 0.75, 0.75, 0.75), 4490, '#9c7650', 'oak veneer', ['dining'], { unfoldedD: 1.9 }],
  ['cafe-2', 'Cafe table 2-top', 'cafe-table', 0.6, 0.6, 0.74, c(0.6, 0.6, 0, 0), 990, '#2f2f2f', 'steel and wood', ['cafe', 'dining']],
  ['cafe-4', 'Cafe table 4-top', 'cafe-table', 0.8, 0.8, 0.74, c(0.6, 0.6, 0.6, 0.6), 1490, '#2f2f2f', 'steel and wood', ['cafe', 'dining']],
  ['chair', 'Chair', 'chair', 0.45, 0.5, 0.82, c(0.6), 590, '#7b5b3e', 'beech', ['dining', 'cafe']],
  ['bench', 'Bench', 'bench', 1.2, 0.38, 0.45, c(0.45), 1290, '#9c7650', 'oak', ['dining', 'living']],
  ['counter', 'Counter 180', 'counter', 1.8, 0.6, 0.9, c(1.0), 6990, '#dcdcdc', 'laminate top', ['cafe', 'dining']],
  ['coffee-table', 'Coffee table', 'coffee-table', 1.1, 0.6, 0.45, c(0.3, 0.3, 0, 0), 1290, '#8a6744', 'walnut veneer', ['living']],
  ['tv-unit', 'TV unit', 'tv-unit', 1.6, 0.4, 0.5, c(0.5), 1990, '#3b3b3b', 'black laminate', ['living', 'storage']],
  ['rug-160', 'Rug 160x230', 'rug', 1.6, 2.3, 0.01, c(0), 1490, '#b7a58f', 'wool', ['living'], { overlaps: true }],
  ['rug-200', 'Rug 200x300', 'rug', 2.0, 3.0, 0.01, c(0), 2490, '#8f9a8a', 'wool', ['living', 'dining'], { overlaps: true }],
  ['plant', 'Floor plant', 'plant', 0.45, 0.45, 1.3, c(0), 390, '#4f7d4a', 'ceramic pot', ['living', 'cafe', 'clinic']],
  ['floor-lamp', 'Floor lamp', 'lamp', 0.35, 0.35, 1.6, c(0), 690, '#d9c9a3', 'steel and linen', ['living', 'work']],
  ['crib', 'Crib 60x120', 'crib', 0.66, 1.26, 0.9, c(0.6), 1990, '#f4f1ea', 'white beech', ['kids', 'sleep']],
  ['toy-storage', 'Toy storage', 'toy-storage', 0.9, 0.35, 0.6, c(0.5), 890, '#e6d7b9', 'pine', ['kids', 'storage']],
  ['play-table', 'Kids table', 'table', 0.8, 0.55, 0.5, c(0.5, 0.5, 0, 0), 690, '#f1e3c4', 'birch', ['kids']],
  ['treatment-bed', 'Treatment bed', 'treatment-bed', 0.7, 1.95, 0.75, c(0.9, 0, 0.9, 0.9), 14990, '#d9e4ea', 'vinyl and steel', ['clinic', 'accessible']],
  ['clinic-stool', 'Rolling stool', 'stool', 0.5, 0.5, 0.6, c(0.5), 1490, '#2f3a44', 'vinyl', ['clinic']],
  ['filing-cabinet', 'Filing cabinet', 'filing-cabinet', 0.42, 0.6, 1.0, c(0.7), 2490, '#b8bec4', 'steel', ['work', 'clinic', 'storage']],
  ['storage-cabinet', 'Storage cabinet', 'storage-cabinet', 0.8, 0.45, 1.8, c(0.6), 2990, '#e9e7e2', 'laminate', ['storage', 'clinic', 'work']],
  ['shoe-cabinet', 'Shoe cabinet', 'storage-cabinet', 0.8, 0.3, 1.0, c(0.5), 1290, '#e9e7e2', 'laminate', ['storage']],
  ['sideboard', 'Sideboard', 'dresser', 1.6, 0.45, 0.8, c(0.5), 3990, '#8a6744', 'walnut veneer', ['storage', 'dining', 'living']],
  ['waiting-chair', 'Waiting chair', 'armchair', 0.6, 0.62, 0.8, c(0.45), 1690, '#58738a', 'vinyl', ['clinic', 'accessible']],
  ['bar-stool', 'Bar stool', 'stool', 0.4, 0.4, 0.75, c(0.4), 790, '#3a3a3a', 'steel', ['cafe']],
];

export const CATALOG: CatalogEntry[] = ROWS.map(([id, name, category, w, d, h, clearance, priceSek, color, material, tags, extra]) => ({
  id, name, category, w, d, h, clearance, priceSek, color, material, tags, priceStatus: 'estimated' as PriceStatus, ...(extra ?? {}),
}));

export const CATEGORIES: string[] = Array.from(new Set(CATALOG.map((e) => e.category)));

export function catalogEntry(id: string) { return CATALOG.find((e) => e.id === id); }

// Longer phrases first so "sofa bed" wins over "sofa" and "bed".
const KEYWORDS: Array<[string, string]> = [
  ['sofa bed', 'sofa-bed'], ['sofabed', 'sofa-bed'], ['bäddsoffa', 'sofa-bed'], ['standing desk', 'desk-standing'],
  ['monitor desk', 'desk-monitor'], ['office chair', 'office-chair'], ['desk chair', 'desk-chair'], ['dining table', 'dining-4'],
  ['coffee table', 'coffee-table'], ['cafe table', 'cafe-4'], ['tv', 'tv-unit'], ['treatment', 'treatment-bed'],
  ['double bed', 'bed-double'], ['single bed', 'bed-single'], ['filing', 'filing-cabinet'], ['crib', 'crib'], ['cot', 'crib'],
  ['toy', 'toy-storage'], ['bookshelf', 'bookshelf'], ['bookcase', 'bookshelf'], ['shelf', 'bookshelf'], ['shelves', 'bookshelf'],
  ['wardrobe', 'wardrobe-100'], ['closet', 'wardrobe-100'], ['dresser', 'dresser'], ['drawers', 'dresser'], ['nightstand', 'nightstand'],
  ['bedside', 'nightstand'], ['storage', 'storage-cabinet'], ['cabinet', 'storage-cabinet'], ['sideboard', 'sideboard'],
  ['armchair', 'armchair'], ['sofa', 'sofa-3'], ['couch', 'sofa-3'], ['desk', 'desk-140'], ['bed', 'bed-double'],
  ['table', 'dining-4'], ['stool', 'bar-stool'], ['chair', 'chair'], ['bench', 'bench'], ['counter', 'counter'],
  ['rug', 'rug-160'], ['carpet', 'rug-160'], ['plant', 'plant'], ['lamp', 'floor-lamp'],
];

export function findByKeyword(text: string): CatalogEntry | undefined {
  const t = text.toLowerCase().trim();
  const exact = CATALOG.find((e) => e.id === t || e.name.toLowerCase() === t);
  if (exact) return exact;
  for (const [k, id] of KEYWORDS) {
    if (new RegExp(`(^|[^a-zåäö])${k}(s|es)?([^a-zåäö]|$)`).test(t)) return catalogEntry(id);
  }
  return undefined;
}

export function makeItem(catalogId: string, at: { x: number; y: number; rotation?: number } = { x: 1, y: 1 }): FurnitureItem {
  const e = catalogEntry(catalogId) ?? CATALOG[0];
  return {
    id: uid('f'), catalogId: e.id, name: e.name, category: e.category, x: at.x, y: at.y, rotation: at.rotation ?? 0,
    w: e.w, d: e.d, h: e.h, clearance: { ...e.clearance }, unfoldedD: e.unfoldedD, locked: false, owned: false,
    priceSek: e.priceSek, priceStatus: 'estimated', color: e.color, material: e.material, sourceKind: 'catalog',
  };
}

/** An item the user already owns. Dimensions in metres. */
export function makeOwnItem(name: string, category: string, w: number, d: number, h: number, at: { x: number; y: number }): FurnitureItem {
  const base = CATALOG.find((e) => e.category === category);
  return {
    id: uid('f'), catalogId: 'custom', name, category, x: at.x, y: at.y, rotation: 0, w, d, h,
    clearance: base ? { ...base.clearance } : c(0.5), locked: false, owned: true, priceSek: 0, priceStatus: 'owned',
    color: base?.color ?? '#9aa3ad', material: base?.material, sourceKind: 'user-measured',
  };
}
