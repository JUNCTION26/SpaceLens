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
  ['armchair', 'Armchair', 'armchair', 0.8, 0.82, 0.85, c(0.4), 2990, '#8f7a66', 'fabric', ['living', 'cafe']],
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
  ['kitchen-island', 'Kitchen island', 'counter', 1.8, 0.9, 0.91, c(1.0, 1.0, 0.9, 0.9), 12990, '#e8e4dc', 'oak top', ['dining', 'kitchen']],
  ['dining-bench', 'Dining bench 160', 'bench', 1.6, 0.35, 0.45, c(0.6), 1990, '#a07a52', 'oak', ['dining']],
  ['bunk-bed', 'Bunk bed 90x200', 'bunk-bed', 0.97, 2.06, 1.6, c(0.7, 0, 0.6, 0), 3990, '#d8c7a8', 'pine', ['sleep', 'kids']],
  ['office-pod', 'Office pod', 'office-pod', 1.0, 1.0, 2.2, c(0.9), 89900, '#55606b', 'felt', ['work']],
  ['reception-desk', 'Reception desk', 'reception-desk', 1.8, 0.8, 1.1, c(1.0, 0.9, 0, 0), 14990, '#ece9e3', 'oak top', ['clinic', 'work', 'cafe']],
  ['display-shelf', 'Display shelf', 'bookshelf', 1.2, 0.4, 1.8, c(0.8), 3490, '#3a3a3a', 'steel and wood', ['cafe', 'storage']],
  ['desk-accessible', 'Wheelchair-friendly desk', 'desk', 1.6, 0.8, 0.76, c(1.5, 0, 0.3, 0.3), 4990, '#d8c7a8', 'birch', ['work', 'accessible']],
  ['shoe-bench', 'Shoe cabinet with seat', 'storage-cabinet', 0.9, 0.35, 0.5, c(0.6), 1490, '#c4a27c', 'oak veneer', ['storage']],
  ['room-divider', 'Room divider', 'room-divider', 1.6, 0.05, 1.7, c(0.3, 0.3), 2490, '#d9cdb8', 'linen', ['living', 'work', 'clinic']],
  // Bathroom and utility fixtures, true sizes. They share the storage-cabinet category so the layout rules
  // treat them as wall-backed pieces that need room in front.
  ['toilet', 'Toilet', 'storage-cabinet', 0.4, 0.7, 0.8, c(0.6, 0, 0.2, 0.2), 2490, '#f4f4f2', 'porcelain', ['bath', 'wet']],
  ['washbasin', 'Washbasin with cabinet', 'storage-cabinet', 0.6, 0.48, 0.85, c(0.7), 2990, '#f4f4f2', 'porcelain and laminate', ['bath', 'wet']],
  ['shower', 'Shower 90x90', 'storage-cabinet', 0.9, 0.9, 2.0, c(0.7), 5990, '#dfe7ea', 'glass and acrylic', ['bath', 'wet']],
  ['bathtub', 'Bathtub 170x75', 'storage-cabinet', 1.7, 0.75, 0.57, c(0.7), 5490, '#f4f4f2', 'acrylic', ['bath', 'wet']],
  ['washing-machine', 'Washing machine', 'storage-cabinet', 0.6, 0.6, 0.85, c(0.8), 5990, '#e8eaec', 'white steel', ['utility', 'wet']],
  ['bar-stool-wood', 'Bar stool, wood', 'stool', 0.42, 0.42, 0.76, c(0.45), 990, '#a07a52', 'oak', ['cafe', 'kitchen']],
  // ---- Beds and cots: the width ladder 80 to 180, plus kids and baby pieces.
  ['bed-80', 'Guest bed 80x200', 'bed', 0.8, 2.0, 0.85, c(0.6, 0, 0.6, 0), 1790, '#d8c7a8', 'pine', ['sleep', 'kids']],
  ['bed-120', 'Small double bed 120x200', 'bed', 1.2, 2.0, 0.92, c(0.6, 0, 0.6, 0.6), 3490, '#c9b8a0', 'oak veneer', ['sleep']],
  ['bed-180', 'King bed 180x200', 'bed', 1.8, 2.0, 1.05, c(0.6, 0, 0.6, 0.6), 8990, '#7d6b5d', 'upholstered', ['sleep']],
  ['bed-storage-160', 'Storage bed 160x200', 'bed', 1.6, 2.05, 1.0, c(0.7, 0, 0.6, 0.6), 9490, '#6d7f8f', 'upholstered', ['sleep', 'storage']],
  ['bed-kids-70', 'Junior bed 70x160', 'bed', 0.7, 1.6, 0.7, c(0.6, 0, 0.6, 0), 1490, '#f1e3c4', 'birch', ['kids', 'sleep']],
  ['loft-bed-90', 'Loft bed 90x200', 'bunk-bed', 0.97, 2.06, 1.7, c(0.7, 0, 0.6, 0), 4490, '#d8c7a8', 'pine', ['kids', 'sleep']],
  ['bunk-bed-120', 'Family bunk bed 120/90', 'bunk-bed', 1.27, 2.06, 1.65, c(0.7, 0, 0.6, 0), 5990, '#c9b8a0', 'pine', ['kids', 'sleep']],
  ['crib-70', 'Cot 70x140', 'crib', 0.76, 1.46, 0.95, c(0.6), 2490, '#f4f1ea', 'white beech', ['kids', 'sleep']],
  ['cradle', 'Cradle', 'crib', 0.55, 0.9, 0.75, c(0.4), 1290, '#f4f1ea', 'white beech', ['kids', 'sleep']],
  // ---- Sofas and soft seating.
  ['sofa-2-compact', 'Sofa 2-seat compact', 'sofa', 1.4, 0.82, 0.78, c(0.45), 3990, '#8a8f7a', 'fabric', ['living']],
  ['sofa-loveseat', 'Loveseat', 'sofa', 1.3, 0.8, 0.78, c(0.45), 3490, '#8f7a66', 'velvet', ['living']],
  ['sofa-3-deep', 'Sofa 3-seat deep', 'sofa', 2.3, 1.0, 0.82, c(0.45), 9490, '#5d6e7c', 'fabric', ['living']],
  ['sofa-4', 'Sofa 4-seat', 'sofa', 2.6, 0.95, 0.82, c(0.45), 11990, '#3b3f46', 'fabric', ['living']],
  ['sofa-corner', 'Corner sofa 250x160', 'sofa', 2.5, 1.6, 0.85, c(0.45, 0, 0, 0.3), 14990, '#6d7f8f', 'fabric', ['living']],
  ['sofa-corner-large', 'Corner sofa 300x180', 'sofa', 3.0, 1.8, 0.85, c(0.45, 0, 0, 0.3), 19990, '#7d6b5d', 'fabric', ['living']],
  ['sofa-chaise', 'Sofa with chaise 220x150', 'sofa', 2.2, 1.5, 0.85, c(0.45, 0, 0, 0.3), 12990, '#b7a58f', 'linen', ['living']],
  ['sofa-bed-2', 'Sofa bed 2-seat', 'sofa-bed', 1.6, 0.9, 0.82, c(0.45), 4990, '#6d7f8f', 'fabric', ['living', 'sleep'], { unfoldedD: 1.95 }],
  ['sofa-bed-corner', 'Corner sofa bed', 'sofa-bed', 2.4, 1.5, 0.85, c(0.45, 0, 0, 0.3), 10990, '#5d6e7c', 'fabric', ['living', 'sleep'], { unfoldedD: 2.1 }],
  ['armchair-lounge', 'Lounge armchair', 'armchair', 0.78, 0.85, 0.9, c(0.4), 3990, '#5f4a3c', 'leather', ['living']],
  ['armchair-compact', 'Compact armchair', 'armchair', 0.68, 0.74, 0.8, c(0.4), 1990, '#b7a58f', 'linen', ['living', 'cafe']],
  ['armchair-wing', 'Wing armchair', 'armchair', 0.82, 0.85, 1.05, c(0.4), 4490, '#4f6b55', 'velvet', ['living']],
  ['bean-bag', 'Bean bag', 'armchair', 0.9, 0.9, 0.7, c(0.3), 790, '#3b3f46', 'fabric', ['living', 'kids']],
  ['pouf', 'Pouf', 'stool', 0.5, 0.5, 0.4, c(0.3), 690, '#b7a58f', 'linen', ['living']],
  ['pouf-large', 'Pouf large', 'stool', 0.7, 0.7, 0.4, c(0.3), 1290, '#6d7f8f', 'fabric', ['living']],
  // ---- Desks and workstations.
  ['desk-80', 'Compact desk 80', 'desk', 0.8, 0.5, 0.74, c(0.75), 990, '#f2efe9', 'white laminate', ['work', 'kids']],
  ['desk-100', 'Desk 100', 'desk', 1.0, 0.55, 0.74, c(0.75), 1190, '#d8c7a8', 'birch', ['work']],
  ['desk-drawers-140', 'Desk 140 with drawers', 'desk', 1.4, 0.7, 0.74, c(0.75), 2990, '#9b7b55', 'oak veneer', ['work', 'storage']],
  ['desk-180', 'Desk 180', 'desk', 1.8, 0.8, 0.74, c(0.75), 3990, '#6e4f36', 'walnut veneer', ['work']],
  ['desk-l-shape', 'Corner desk 160x140', 'desk', 1.6, 1.4, 0.74, c(0.75, 0, 0.3, 0), 3490, '#b08a5a', 'oak veneer', ['work']],
  ['desk-standing-120', 'Standing desk 120', 'desk', 1.2, 0.7, 1.0, c(0.75), 4990, '#e2e2e2', 'steel and laminate', ['work', 'accessible']],
  ['desk-kids', 'Kids desk 100', 'desk', 1.0, 0.55, 0.65, c(0.6), 1190, '#f1e3c4', 'birch', ['work', 'kids']],
  ['desk-pod-2', 'Desk pod for 2', 'desk', 1.6, 1.4, 0.74, c(0.75, 0.75), 5990, '#d8c7a8', 'birch', ['work']],
  ['desk-pod-4', 'Desk pod for 4', 'desk', 2.8, 1.4, 0.74, c(0.75, 0.75), 11990, '#d8c7a8', 'birch', ['work']],
  ['desk-pod-6', 'Desk pod for 6', 'desk', 4.2, 1.4, 0.74, c(0.75, 0.75), 17990, '#d8c7a8', 'birch', ['work']],
  ['vanity-dressing', 'Dressing table with mirror', 'vanity', 1.0, 0.45, 1.4, c(0.7), 2990, '#f2efe9', 'white laminate', ['sleep', 'storage']],
  ['vanity-compact', 'Compact dressing table', 'vanity', 0.8, 0.4, 1.35, c(0.7), 1890, '#c4a27c', 'oak veneer', ['sleep']],
  // ---- Dining, meeting and bar tables.
  ['dining-2', 'Dining table for 2', 'table', 0.7, 0.7, 0.75, c(0.75, 0.75, 0.75, 0.75), 1490, '#d8c7a8', 'birch', ['dining']],
  ['dining-8', 'Dining table for 8', 'table', 2.2, 1.0, 0.75, c(0.75, 0.75, 0.75, 0.75), 6990, '#8a6744', 'oak', ['dining']],
  ['dining-10', 'Dining table for 10', 'table', 2.8, 1.05, 0.75, c(0.75, 0.75, 0.75, 0.75), 9990, '#6e4f36', 'walnut', ['dining']],
  ['dining-round-90', 'Round dining table 90', 'table', 0.9, 0.9, 0.75, c(0.75, 0.75, 0.75, 0.75), 2490, '#d8c7a8', 'birch', ['dining']],
  ['dining-round-110', 'Round dining table 110', 'table', 1.1, 1.1, 0.75, c(0.75, 0.75, 0.75, 0.75), 3990, '#a07a52', 'oak', ['dining']],
  ['dining-round-130', 'Round dining table 130', 'table', 1.3, 1.3, 0.75, c(0.75, 0.75, 0.75, 0.75), 4990, '#8a6744', 'oak', ['dining']],
  ['dining-ext-6', 'Extendable table for 6', 'table', 1.6, 0.9, 0.75, c(0.75, 0.75, 0.75, 0.75), 5490, '#9c7650', 'oak veneer', ['dining'], { unfoldedD: 2.2 }],
  ['bar-table-120', 'Bar table 120', 'table', 1.2, 0.6, 1.05, c(0.6, 0.6, 0.3, 0.3), 2490, '#3a3a3a', 'steel and wood', ['cafe', 'dining']],
  ['cafe-high', 'High cafe table', 'cafe-table', 0.6, 0.6, 1.05, c(0.5, 0.5, 0.5, 0.5), 1290, '#2f2f2f', 'steel and wood', ['cafe']],
  ['meeting-table-6', 'Meeting table for 6', 'table', 2.4, 1.1, 0.74, c(0.75, 0.75, 0.75, 0.75), 7990, '#ece9e3', 'white laminate', ['work']],
  ['meeting-table-10', 'Meeting table for 10', 'table', 3.2, 1.2, 0.74, c(0.75, 0.75, 0.75, 0.75), 12990, '#ece9e3', 'white laminate', ['work']],
  ['meeting-table-14', 'Meeting table for 14', 'table', 4.2, 1.3, 0.74, c(0.75, 0.75, 0.75, 0.75), 16990, '#b08a5a', 'oak veneer', ['work']],
  ['meeting-round-120', 'Round meeting table 120', 'table', 1.2, 1.2, 0.74, c(0.75, 0.75, 0.75, 0.75), 4990, '#ece9e3', 'white laminate', ['work', 'clinic']],
  ['play-table-round', 'Round kids table', 'table', 0.7, 0.7, 0.5, c(0.5, 0.5, 0.5, 0.5), 790, '#f1e3c4', 'birch', ['kids']],
  // ---- Wardrobes 50 to 200 wide.
  ['wardrobe-50', 'Narrow wardrobe 50', 'wardrobe', 0.5, 0.58, 2.0, c(0.6), 1490, '#f2efe9', 'white laminate', ['storage', 'sleep']],
  ['wardrobe-80', 'Wardrobe 80', 'wardrobe', 0.8, 0.58, 2.0, c(0.6), 2490, '#f2efe9', 'white laminate', ['storage', 'sleep']],
  ['wardrobe-120', 'Wardrobe 120', 'wardrobe', 1.2, 0.6, 2.1, c(0.6), 3490, '#c9b8a0', 'oak veneer', ['storage', 'sleep']],
  ['wardrobe-200', 'Wardrobe 200', 'wardrobe', 2.0, 0.6, 2.3, c(0.6), 6990, '#f2efe9', 'white laminate', ['storage', 'sleep']],
  ['wardrobe-sliding-200', 'Sliding door wardrobe 200', 'wardrobe', 2.0, 0.65, 2.4, c(0.5), 7990, '#e9e7e2', 'laminate and mirror', ['storage', 'sleep']],
  ['wardrobe-open-100', 'Open clothes rail 100', 'wardrobe', 1.0, 0.5, 1.8, c(0.6), 990, '#2f2f2f', 'steel', ['storage', 'sleep']],
  ['wardrobe-kids', 'Kids wardrobe 80', 'wardrobe', 0.8, 0.5, 1.5, c(0.5), 1990, '#f1e3c4', 'birch', ['storage', 'kids']],
  // ---- Bookshelves, narrow to wide, low and tall.
  ['bookshelf-narrow', 'Narrow bookshelf 40', 'bookshelf', 0.4, 0.28, 2.0, c(0.6), 890, '#efe8dc', 'white laminate', ['storage', 'living']],
  ['bookshelf-60', 'Bookshelf 60', 'bookshelf', 0.6, 0.28, 1.8, c(0.6), 990, '#c4a27c', 'oak veneer', ['storage', 'living', 'work']],
  ['bookshelf-tall', 'Tall bookshelf 80', 'bookshelf', 0.8, 0.3, 2.3, c(0.6), 1790, '#efe8dc', 'white laminate', ['storage', 'living']],
  ['bookshelf-wide', 'Wide bookshelf 120', 'bookshelf', 1.2, 0.3, 2.0, c(0.6), 1990, '#c4a27c', 'oak veneer', ['storage', 'living', 'work']],
  ['bookshelf-wide-low', 'Wide low shelf 120', 'bookshelf', 1.2, 0.3, 0.9, c(0.6), 1290, '#efe8dc', 'white laminate', ['storage', 'kids', 'work']],
  ['shelf-low-160', 'Low shelf 160', 'bookshelf', 1.6, 0.35, 0.8, c(0.6), 1790, '#c4a27c', 'oak veneer', ['storage', 'living']],
  ['cube-shelf', 'Cube shelf 4x4', 'bookshelf', 1.5, 0.38, 1.5, c(0.6), 1990, '#efe8dc', 'white laminate', ['storage', 'living', 'kids']],
  ['ladder-shelf', 'Ladder shelf', 'bookshelf', 0.6, 0.35, 1.8, c(0.6), 1290, '#b08a5a', 'oak', ['storage', 'living']],
  // ---- Chairs and stools.
  ['chair-upholstered', 'Upholstered dining chair', 'chair', 0.5, 0.55, 0.88, c(0.6), 1190, '#6d7f8f', 'fabric and beech', ['dining']],
  ['chair-stackable', 'Stackable chair', 'chair', 0.45, 0.5, 0.8, c(0.6), 490, '#3a3a3a', 'plastic and steel', ['cafe', 'dining', 'clinic']],
  ['chair-folding', 'Folding chair', 'chair', 0.44, 0.46, 0.8, c(0.55), 390, '#7b5b3e', 'beech', ['dining']],
  ['chair-meeting', 'Meeting chair', 'chair', 0.55, 0.55, 0.9, c(0.65), 1990, '#2c2f33', 'mesh', ['work']],
  ['chair-kids', 'Kids chair', 'chair', 0.32, 0.34, 0.55, c(0.4), 290, '#f1e3c4', 'birch', ['kids']],
  ['desk-chair-kids', 'Kids desk chair', 'chair', 0.4, 0.4, 0.8, c(0.6), 690, '#58738a', 'plastic', ['kids', 'work']],
  ['office-chair-task', 'Task chair', 'office-chair', 0.6, 0.6, 1.0, c(0.75), 1990, '#2c2f33', 'mesh', ['work']],
  ['office-chair-exec', 'Executive chair', 'office-chair', 0.7, 0.7, 1.2, c(0.8), 4990, '#2c2f33', 'leather', ['work']],
  ['counter-stool', 'Counter stool', 'stool', 0.38, 0.38, 0.65, c(0.4), 690, '#a07a52', 'oak', ['cafe', 'kitchen']],
  ['step-stool', 'Step stool', 'stool', 0.35, 0.3, 0.4, c(0.3), 290, '#f1e3c4', 'birch', ['kids', 'kitchen']],
  // ---- Benches.
  ['storage-bench-100', 'Storage bench 100', 'bench', 1.0, 0.4, 0.45, c(0.45), 1490, '#c4a27c', 'oak veneer', ['storage', 'living']],
  ['storage-bench-140', 'Storage bench 140', 'bench', 1.4, 0.4, 0.45, c(0.45), 1990, '#efe8dc', 'white laminate', ['storage', 'sleep']],
  ['bench-hallway', 'Hallway bench', 'bench', 1.0, 0.35, 0.45, c(0.45), 990, '#d8c7a8', 'birch', ['dining', 'living']],
  // ---- Sideboards, dressers, console and baby changing.
  ['sideboard-120', 'Sideboard 120', 'dresser', 1.2, 0.4, 0.75, c(0.5), 2990, '#c4a27c', 'oak veneer', ['storage', 'dining', 'living']],
  ['sideboard-200', 'Sideboard 200', 'dresser', 2.0, 0.45, 0.8, c(0.5), 5490, '#6e4f36', 'walnut veneer', ['storage', 'dining', 'living']],
  ['dresser-6', 'Chest of 6 drawers', 'dresser', 1.2, 0.5, 1.0, c(0.6), 3490, '#efe8dc', 'white laminate', ['storage', 'sleep']],
  ['chest-5', 'Tall chest of 5 drawers', 'dresser', 0.6, 0.45, 1.1, c(0.6), 1990, '#c4a27c', 'oak veneer', ['storage', 'sleep']],
  ['highboard', 'Highboard', 'dresser', 0.9, 0.4, 1.4, c(0.5), 3490, '#8a6744', 'walnut veneer', ['storage', 'dining', 'living']],
  ['console-table', 'Console table', 'dresser', 1.1, 0.3, 0.8, c(0.5), 1490, '#b08a5a', 'oak', ['storage', 'living']],
  ['changing-table', 'Changing table with drawers', 'dresser', 0.9, 0.55, 0.95, c(0.7), 2490, '#f4f1ea', 'white beech', ['kids', 'sleep']],
  ['nightstand-35', 'Slim nightstand', 'nightstand', 0.35, 0.35, 0.5, c(0.3), 390, '#efe8dc', 'white laminate', ['sleep']],
  ['nightstand-3', 'Nightstand with 3 drawers', 'nightstand', 0.5, 0.4, 0.6, c(0.3), 890, '#9c7650', 'oak veneer', ['sleep', 'storage']],
  // ---- TV units.
  ['tv-unit-120', 'TV unit 120', 'tv-unit', 1.2, 0.4, 0.45, c(0.5), 1490, '#efe8dc', 'white laminate', ['living', 'storage']],
  ['tv-unit-180', 'TV unit 180', 'tv-unit', 1.8, 0.42, 0.5, c(0.5), 2990, '#8a6744', 'walnut veneer', ['living', 'storage']],
  ['tv-unit-240', 'TV unit 240', 'tv-unit', 2.4, 0.45, 0.5, c(0.5), 4990, '#3b3b3b', 'black laminate', ['living', 'storage']],
  // ---- Coffee and side tables.
  ['coffee-table-round-80', 'Round coffee table 80', 'coffee-table', 0.8, 0.8, 0.4, c(0.3, 0.3, 0.3, 0.3), 1490, '#8a6744', 'walnut veneer', ['living']],
  ['coffee-table-small', 'Coffee table 90', 'coffee-table', 0.9, 0.5, 0.4, c(0.3, 0.3, 0, 0), 990, '#d8c7a8', 'birch', ['living']],
  ['coffee-table-large', 'Coffee table 130', 'coffee-table', 1.3, 0.7, 0.42, c(0.3, 0.3, 0, 0), 1890, '#a07a52', 'oak', ['living']],
  ['coffee-nest', 'Nest of two tables', 'coffee-table', 0.6, 0.45, 0.45, c(0.3, 0.3, 0, 0), 1290, '#2f2f2f', 'steel and oak', ['living']],
  ['side-table-40', 'Round side table 40', 'side-table', 0.4, 0.4, 0.5, c(0.2), 390, '#d8c7a8', 'birch', ['living']],
  ['side-table-50', 'Round side table 50', 'side-table', 0.5, 0.5, 0.55, c(0.2), 590, '#2f2f2f', 'steel', ['living', 'cafe']],
  ['side-table-sofa', 'Sofa side table', 'side-table', 0.35, 0.5, 0.6, c(0.2), 490, '#a07a52', 'oak', ['living']],
  // ---- Rugs in standard sizes, round and runner.
  ['rug-80', 'Rug 80x150', 'rug', 0.8, 1.5, 0.01, c(0), 590, '#b7a58f', 'wool', ['living', 'sleep'], { overlaps: true }],
  ['rug-120', 'Rug 120x170', 'rug', 1.2, 1.7, 0.01, c(0), 990, '#8f9a8a', 'wool', ['living', 'sleep'], { overlaps: true }],
  ['rug-140', 'Rug 140x200', 'rug', 1.4, 2.0, 0.01, c(0), 1290, '#b7a58f', 'wool', ['living', 'sleep'], { overlaps: true }],
  ['rug-250', 'Rug 250x350', 'rug', 2.5, 3.5, 0.01, c(0), 4990, '#8f9a8a', 'wool', ['living', 'dining'], { overlaps: true }],
  ['rug-round-120', 'Round rug 120', 'rug', 1.2, 1.2, 0.01, c(0), 890, '#7a6a5c', 'cotton', ['living', 'kids'], { overlaps: true }],
  ['rug-round-160', 'Round rug 160', 'rug', 1.6, 1.6, 0.01, c(0), 1390, '#b7a58f', 'wool', ['living', 'dining'], { overlaps: true }],
  ['rug-runner', 'Runner rug 70x240', 'rug', 0.7, 2.4, 0.01, c(0), 690, '#6d7f8f', 'cotton', ['living'], { overlaps: true }],
  ['doormat', 'Doormat 60x40', 'rug', 0.6, 0.4, 0.015, c(0), 190, '#3a3a3a', 'coir', ['living'], { overlaps: true }],
  // ---- Lamps.
  ['table-lamp', 'Table lamp', 'lamp', 0.25, 0.25, 0.45, c(0), 390, '#d9c9a3', 'ceramic and linen', ['living', 'sleep']],
  ['desk-lamp', 'Desk lamp', 'lamp', 0.18, 0.18, 0.45, c(0), 490, '#2f3a44', 'steel', ['work']],
  ['floor-lamp-reading', 'Reading lamp', 'lamp', 0.3, 0.3, 1.4, c(0), 890, '#2f3a44', 'steel', ['living', 'work']],
  ['floor-lamp-uplight', 'Uplighter', 'lamp', 0.3, 0.3, 1.8, c(0), 1190, '#e2e2e2', 'steel', ['living']],
  ['floor-lamp-arc', 'Arc floor lamp', 'lamp', 0.5, 0.5, 2.0, c(0), 1490, '#d9c9a3', 'steel and linen', ['living']],
  // ---- Plants, small to large.
  ['plant-small', 'Small plant', 'plant', 0.25, 0.25, 0.45, c(0), 149, '#4f7d4a', 'ceramic pot', ['living', 'work', 'clinic']],
  ['plant-medium', 'Medium plant', 'plant', 0.4, 0.4, 0.9, c(0), 290, '#4f7d4a', 'ceramic pot', ['living', 'cafe', 'clinic']],
  ['plant-tall', 'Tall plant', 'plant', 0.55, 0.55, 1.6, c(0), 590, '#4f7d4a', 'ceramic pot', ['living', 'cafe', 'clinic']],
  ['plant-large', 'Large plant', 'plant', 0.8, 0.8, 2.0, c(0), 990, '#4f7d4a', 'ceramic pot', ['living', 'cafe']],
  ['plant-palm', 'Palm', 'plant', 0.7, 0.7, 1.9, c(0), 890, '#4f7d4a', 'ceramic pot', ['living', 'cafe']],
  ['plant-tree', 'Indoor tree', 'plant', 1.0, 1.0, 2.4, c(0), 1790, '#4f7d4a', 'ceramic pot', ['living', 'work', 'cafe']],
  // ---- Mirrors.
  ['mirror-floor', 'Floor mirror', 'statue', 0.5, 0.06, 1.7, c(0.6), 1490, '#c4a27c', 'oak frame', ['sleep', 'living']],
  ['mirror-floor-wide', 'Wide floor mirror', 'statue', 0.8, 0.06, 1.8, c(0.6), 2490, '#2f2f2f', 'steel frame', ['sleep', 'living']],
  // ---- Bathroom fixtures.
  ['toilet-wall', 'Wall-hung toilet', 'storage-cabinet', 0.36, 0.55, 0.8, c(0.6, 0, 0.2, 0.2), 3490, '#f4f4f2', 'porcelain', ['bath', 'wet']],
  ['washbasin-small', 'Small washbasin 40', 'storage-cabinet', 0.4, 0.3, 0.85, c(0.6), 1490, '#f4f4f2', 'porcelain', ['bath', 'wet']],
  ['washbasin-80', 'Washbasin with cabinet 80', 'storage-cabinet', 0.8, 0.48, 0.85, c(0.7), 3990, '#f4f4f2', 'porcelain and laminate', ['bath', 'wet']],
  ['washbasin-double', 'Double washbasin 120', 'storage-cabinet', 1.2, 0.48, 0.85, c(0.7), 6990, '#f4f4f2', 'porcelain and laminate', ['bath', 'wet']],
  ['shower-80', 'Shower 80x80', 'storage-cabinet', 0.8, 0.8, 2.0, c(0.7), 4990, '#dfe7ea', 'glass and acrylic', ['bath', 'wet']],
  ['shower-120', 'Shower 120x80', 'storage-cabinet', 1.2, 0.8, 2.0, c(0.7), 7990, '#dfe7ea', 'glass and acrylic', ['bath', 'wet', 'accessible']],
  ['bathtub-150', 'Bathtub 150x70', 'storage-cabinet', 1.5, 0.7, 0.57, c(0.7), 4490, '#f4f4f2', 'acrylic', ['bath', 'wet']],
  ['bathtub-freestanding', 'Freestanding bathtub 170x80', 'storage-cabinet', 1.7, 0.8, 0.6, c(0.8, 0.5, 0.5, 0.5), 12990, '#f4f4f2', 'acrylic', ['bath', 'wet']],
  ['bath-cabinet-tall', 'Tall bathroom cabinet', 'storage-cabinet', 0.35, 0.3, 1.6, c(0.5), 1290, '#e9e7e2', 'laminate', ['bath', 'storage']],
  ['laundry-dryer', 'Tumble dryer', 'storage-cabinet', 0.6, 0.6, 0.85, c(0.8), 5990, '#e8eaec', 'white steel', ['utility', 'wet']],
  // ---- Kitchen fixtures and units.
  ['fridge', 'Fridge freezer 60', 'storage-cabinet', 0.6, 0.65, 1.85, c(0.9), 7990, '#e8eaec', 'white steel', ['kitchen', 'utility']],
  ['fridge-under', 'Under-counter fridge', 'storage-cabinet', 0.6, 0.6, 0.85, c(0.8), 3990, '#e8eaec', 'white steel', ['kitchen', 'utility']],
  ['dishwasher', 'Dishwasher 60', 'storage-cabinet', 0.6, 0.6, 0.85, c(0.9), 5490, '#b8bec4', 'steel', ['kitchen', 'utility']],
  ['pantry-tall', 'Tall pantry unit 60', 'storage-cabinet', 0.6, 0.6, 2.1, c(0.8), 3490, '#e9e7e2', 'laminate', ['kitchen', 'storage']],
  ['stove-60', 'Cooker with hob 60', 'counter', 0.6, 0.6, 0.9, c(1.0), 5990, '#b8bec4', 'steel', ['kitchen', 'utility']],
  ['kitchen-sink-120', 'Sink unit 120', 'counter', 1.2, 0.6, 0.9, c(1.0), 6990, '#e8e4dc', 'steel and laminate', ['kitchen', 'wet']],
  ['kitchen-base-60', 'Base unit 60', 'counter', 0.6, 0.6, 0.9, c(1.0), 1990, '#e8e4dc', 'laminate top', ['kitchen']],
  ['kitchen-base-120', 'Base unit 120', 'counter', 1.2, 0.6, 0.9, c(1.0), 3490, '#e8e4dc', 'laminate top', ['kitchen']],
  ['counter-240', 'Counter 240', 'counter', 2.4, 0.6, 0.9, c(1.0), 8990, '#dcdcdc', 'laminate top', ['cafe', 'dining', 'kitchen']],
  ['bar-counter-150', 'Bar counter 150', 'counter', 1.5, 0.5, 1.1, c(0.9), 5990, '#3a3a3a', 'oak top', ['cafe', 'dining']],
  ['kitchen-island-120', 'Kitchen island 120', 'kitchen-island', 1.2, 0.7, 0.91, c(1.0, 1.0, 0.9, 0.9), 8990, '#e8e4dc', 'oak top', ['dining', 'kitchen']],
  ['kitchen-island-240', 'Kitchen island 240', 'kitchen-island', 2.4, 1.0, 0.91, c(1.0, 1.0, 0.9, 0.9), 16990, '#e8e4dc', 'oak top', ['dining', 'kitchen']],
  // ---- Office pieces.
  ['phone-booth', 'Phone booth', 'office-pod', 1.0, 1.0, 2.2, c(0.9), 79900, '#6d7f8f', 'felt', ['work']],
  ['meeting-pod-4', 'Meeting pod for 4', 'office-pod', 2.0, 2.0, 2.2, c(1.0), 119900, '#55606b', 'felt', ['work']],
  ['reception-desk-120', 'Reception desk 120', 'reception-desk', 1.2, 0.7, 1.1, c(1.0, 0.9), 9990, '#ece9e3', 'oak top', ['clinic', 'work', 'cafe']],
  ['reception-desk-240', 'Reception desk 240', 'reception-desk', 2.4, 0.9, 1.1, c(1.0, 0.9), 22990, '#ece9e3', 'oak top', ['clinic', 'work']],
  ['locker-3', 'Locker unit, 3 doors', 'storage-cabinet', 0.9, 0.5, 1.8, c(0.9), 4490, '#b8bec4', 'steel', ['work', 'storage']],
  ['locker-6', 'Locker unit, 6 doors', 'storage-cabinet', 1.2, 0.5, 1.8, c(0.9), 6490, '#58738a', 'steel', ['work', 'storage']],
  ['locker-low-3', 'Low locker bench, 3 doors', 'storage-cabinet', 0.9, 0.5, 0.9, c(0.8), 2490, '#b8bec4', 'steel', ['work', 'storage']],
  ['whiteboard-mobile', 'Mobile whiteboard 120', 'room-divider', 1.2, 0.5, 1.8, c(0.6, 0.3), 2990, '#f4f4f2', 'steel and laminate', ['work']],
  ['whiteboard-mobile-180', 'Mobile whiteboard 180', 'room-divider', 1.8, 0.6, 1.9, c(0.6, 0.3), 4990, '#f4f4f2', 'steel and laminate', ['work']],
  ['room-divider-120', 'Room divider 120', 'room-divider', 1.2, 0.05, 1.7, c(0.3, 0.3), 1790, '#d9cdb8', 'linen', ['living', 'work', 'clinic']],
  ['room-divider-240', 'Room divider 240', 'room-divider', 2.4, 0.05, 1.7, c(0.3, 0.3), 3990, '#d9cdb8', 'linen', ['living', 'work', 'clinic']],
  ['filing-lateral', 'Lateral filing cabinet 90', 'filing-cabinet', 0.9, 0.45, 0.75, c(0.7), 3490, '#b8bec4', 'steel', ['work', 'storage']],
  ['filing-cabinet-4', 'Filing cabinet 4 drawers', 'filing-cabinet', 0.42, 0.6, 1.35, c(0.7), 3490, '#b8bec4', 'steel', ['work', 'storage']],
  ['printer-stand', 'Printer stand', 'storage-cabinet', 0.6, 0.5, 0.75, c(0.6), 1490, '#e9e7e2', 'laminate', ['work', 'storage']],
  ['storage-cabinet-120', 'Low storage cabinet 120', 'storage-cabinet', 1.2, 0.45, 1.0, c(0.6), 2490, '#e9e7e2', 'laminate', ['work', 'storage', 'clinic']],
  ['storage-cabinet-tall-120', 'Tall storage cabinet 120', 'storage-cabinet', 1.2, 0.45, 2.0, c(0.6), 4490, '#e9e7e2', 'laminate', ['work', 'storage', 'clinic']],
  // ---- Kids storage and play.
  ['toy-chest', 'Toy chest', 'toy-storage', 0.7, 0.4, 0.45, c(0.5), 690, '#f1e3c4', 'pine', ['kids', 'storage']],
  ['toy-shelf-cubes', 'Toy shelf with boxes', 'toy-storage', 0.9, 0.3, 0.9, c(0.5), 1190, '#efe8dc', 'white laminate', ['kids', 'storage']],
  ['toy-storage-low', 'Low toy bench 120', 'toy-storage', 1.2, 0.35, 0.5, c(0.5), 1290, '#e6d7b9', 'pine', ['kids', 'storage']],
  // ---- Pet pieces.
  ['cat-tree', 'Cat tree 150', 'cat-tree', 0.5, 0.5, 1.5, c(0.3, 0, 0.1, 0.1), 1290, '#b7a58f', 'sisal and plush', ['pet']],
  ['cat-tree-large', 'Cat tree 180', 'cat-tree', 0.7, 0.5, 1.8, c(0.3, 0, 0.1, 0.1), 2490, '#8f9a8a', 'sisal and plush', ['pet']],
  ['pet-bed-m', 'Pet bed medium', 'pet-bed', 0.6, 0.45, 0.2, c(0.15), 490, '#8f9a8a', 'fleece', ['pet']],
  ['pet-bed-l', 'Pet bed large', 'pet-bed', 0.9, 0.6, 0.25, c(0.15), 790, '#6d7f8f', 'fleece', ['pet']],
  ['dog-crate', 'Dog crate medium', 'pet-bed', 0.75, 0.5, 0.6, c(0.4), 1290, '#3a3a3a', 'steel wire', ['pet']],
  ['pet-bowls', 'Pet bowls on mat', 'pet-bowls', 0.5, 0.3, 0.12, c(0.15), 290, '#b8bec4', 'steel and rubber', ['pet']],
  ['litter-box', 'Litter box', 'litter-box', 0.5, 0.4, 0.3, c(0.3), 390, '#e9e7e2', 'plastic', ['pet']],
  ['litter-cabinet', 'Litter box cabinet', 'litter-box', 0.55, 0.5, 0.55, c(0.4), 1290, '#efe8dc', 'laminate', ['pet', 'storage']],
  ['toy-basket', 'Toy basket', 'toy-basket', 0.4, 0.3, 0.3, c(0.1), 190, '#b7a58f', 'felt', ['pet', 'kids']],
  ['window-perch', 'Window perch', 'window-perch', 0.6, 0.3, 0.35, c(0.15), 490, '#c4a27c', 'wood and plush', ['pet']],
  ['scratching-post', 'Scratching post', 'scratching-post', 0.3, 0.3, 0.8, c(0.15), 390, '#b7a58f', 'sisal', ['pet']],
];

export const CATALOG: CatalogEntry[] = ROWS.map(([id, name, category, w, d, h, clearance, priceSek, color, material, tags, extra]) => ({
  id, name, category, w, d, h, clearance, priceSek, color, material, tags, priceStatus: 'estimated' as PriceStatus, ...(extra ?? {}),
}));

export const CATEGORIES: string[] = Array.from(new Set(CATALOG.map((e) => e.category)));

export function catalogEntry(id: string) { return CATALOG.find((e) => e.id === id); }

// Longer phrases first so "sofa bed" wins over "sofa" and "bed".
const KEYWORDS: Array<[string, string]> = [
  ['corner sofa', 'sofa-corner'], ['loft bed', 'loft-bed-90'], ['king bed', 'bed-180'], ['meeting table', 'meeting-table-10'], ['round table', 'dining-round-110'],
  ['table lamp', 'table-lamp'], ['desk lamp', 'desk-lamp'], ['side table', 'side-table-50'], ['changing table', 'changing-table'], ['dressing table', 'vanity-dressing'],
  ['cat tree', 'cat-tree'], ['litter', 'litter-box'], ['scratching post', 'scratching-post'], ['dog crate', 'dog-crate'], ['cradle', 'cradle'],
  ['fridge', 'fridge'], ['refrigerator', 'fridge'], ['dishwasher', 'dishwasher'], ['stove', 'stove-60'], ['cooker', 'stove-60'], ['oven', 'stove-60'],
  ['mirror', 'mirror-floor'], ['locker', 'locker-3'], ['whiteboard', 'whiteboard-mobile'], ['pouf', 'pouf'], ['bean bag', 'bean-bag'], ['dryer', 'laundry-dryer'], ['console', 'console-table'],
  ['sofa bed', 'sofa-bed'], ['sofabed', 'sofa-bed'], ['bäddsoffa', 'sofa-bed'], ['standing desk', 'desk-standing'],
  ['monitor desk', 'desk-monitor'], ['office chair', 'office-chair'], ['desk chair', 'desk-chair'], ['dining table', 'dining-4'],
  ['coffee table', 'coffee-table'], ['cafe table', 'cafe-4'], ['tv', 'tv-unit'], ['treatment', 'treatment-bed'],
  ['kitchen island', 'kitchen-island'], ['island', 'kitchen-island'], ['dining bench', 'dining-bench'], ['bunk', 'bunk-bed'], ['pod', 'office-pod'], ['phone booth', 'office-pod'], ['reception', 'reception-desk'], ['display', 'display-shelf'], ['wheelchair', 'desk-accessible'], ['shoe', 'shoe-cabinet'], ['divider', 'room-divider'], ['screen', 'room-divider'],
  ['double bed', 'bed-double'], ['single bed', 'bed-single'], ['filing', 'filing-cabinet'], ['crib', 'crib'], ['cot', 'crib'],
  ['toy', 'toy-storage'], ['bookshelf', 'bookshelf'], ['bookcase', 'bookshelf'], ['shelf', 'bookshelf'], ['shelves', 'bookshelf'],
  ['wardrobe', 'wardrobe-100'], ['closet', 'wardrobe-100'], ['dresser', 'dresser'], ['drawers', 'dresser'], ['nightstand', 'nightstand'],
  ['bedside', 'nightstand'], ['storage', 'storage-cabinet'], ['cabinet', 'storage-cabinet'], ['sideboard', 'sideboard'],
  ['armchair', 'armchair'], ['sofa', 'sofa-3'], ['couch', 'sofa-3'], ['desk', 'desk-140'], ['bed', 'bed-double'],
  ['table', 'dining-4'], ['stool', 'bar-stool'], ['chair', 'chair'], ['bench', 'bench'], ['counter', 'counter'],
  ['toilet', 'toilet'], ['wc', 'toilet'], ['washbasin', 'washbasin'], ['sink', 'washbasin'], ['basin', 'washbasin'], ['shower', 'shower'], ['bathtub', 'bathtub'], ['bath tub', 'bathtub'], ['washing machine', 'washing-machine'], ['rug', 'rug-160'], ['carpet', 'rug-160'], ['plant', 'plant'], ['lamp', 'floor-lamp'],
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

/** Colour and material options shown as swatches. */
export interface Variant { color: string; material: string }
const WOODS: Variant[] = [{ color: '#d8c7a8', material: 'birch' }, { color: '#b08a5a', material: 'oak' }, { color: '#6e4f36', material: 'walnut' }, { color: '#f2efe9', material: 'white laminate' }, { color: '#2f2f2f', material: 'black laminate' }];
const FABRICS: Variant[] = [{ color: '#6d7f8f', material: 'fabric' }, { color: '#b7a58f', material: 'linen' }, { color: '#4f6b55', material: 'velvet' }, { color: '#5f4a3c', material: 'leather' }, { color: '#3b3f46', material: 'fabric' }];
const METALS: Variant[] = [{ color: '#2f3a44', material: 'vinyl' }, { color: '#b8bec4', material: 'steel' }, { color: '#3a3a3a', material: 'steel' }, { color: '#e2e2e2', material: 'steel' }];
const SOFT = new Set(['sofa', 'sofa-bed', 'armchair', 'rug', 'office-pod', 'room-divider', 'office-chair']);
const METAL = new Set(['filing-cabinet', 'treatment-bed', 'stool']);
export function variantsFor(e: { color: string; material?: string; category: string }): Variant[] {
  const base = SOFT.has(e.category) ? FABRICS : METAL.has(e.category) ? METALS : WOODS;
  const own = { color: e.color, material: e.material ?? '' };
  return [own, ...base.filter((v) => v.color.toLowerCase() !== own.color.toLowerCase())].slice(0, 5);
}
