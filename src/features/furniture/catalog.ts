import { uid } from '../../core/geometry';
import type { Clearance, FurnitureItem } from '../../core/types';

export interface CatalogEntry {
  id: string; name: string; category: string; w: number; d: number; h: number;
  clearance: Clearance; unfoldedD?: number; priceSek: number; color: string; material?: string; tags: string[];
}

export const CATALOG: CatalogEntry[] = [
  { id: 'desk-140', name: 'Desk 140', category: 'desk', w: 1.4, d: 0.7, h: 0.74, clearance: { front: 0.9, back: 0, left: 0, right: 0 }, priceSek: 2490, color: '#b08a5a', tags: ['work'] },
];

export function catalogEntry(id: string) { return CATALOG.find((c) => c.id === id); }

export function makeItem(catalogId: string, at: { x: number; y: number; rotation?: number } = { x: 1, y: 1 }): FurnitureItem {
  const c = catalogEntry(catalogId) ?? CATALOG[0];
  return {
    id: uid('f'), catalogId: c.id, name: c.name, category: c.category, x: at.x, y: at.y, rotation: at.rotation ?? 0,
    w: c.w, d: c.d, h: c.h, clearance: { ...c.clearance }, unfoldedD: c.unfoldedD, locked: false, owned: false,
    priceSek: c.priceSek, priceStatus: 'estimated', color: c.color, material: c.material, sourceKind: 'catalog',
  };
}
