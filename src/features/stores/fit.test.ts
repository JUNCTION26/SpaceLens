import { describe, expect, it } from 'vitest';
import type { FurnitureItem, SpaceModel } from '../../core/types';
import { fitsWindow, fitWindow } from './fit';

const item = (o: Partial<FurnitureItem>): FurnitureItem => ({
  id: 'a', catalogId: 'desk', name: 'Desk', category: 'desk', x: 1, y: 0.4, rotation: 0, w: 1.2, d: 0.6, h: 0.75,
  clearance: { front: 0.6, back: 0, left: 0, right: 0 }, locked: false, owned: false, priceSek: 0, priceStatus: 'estimated', color: '#fff', sourceKind: 'catalog', ...o,
});
const room = (furniture: FurnitureItem[]): Pick<SpaceModel, 'spaces' | 'furniture' | 'ceilingM'> => ({
  ceilingM: 2.5, furniture,
  spaces: [{ id: 's', name: 'r', polygon: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }, { x: 0, y: 4 }], walls: [] }],
});

describe('fitWindow', () => {
  it('grows to the walls but keeps the front clearance', () => {
    const a = item({});
    const w = fitWindow(a, room([a]));
    expect(w.gap.back).toBeCloseTo(0.1); expect(w.gap.left).toBeCloseTo(0.4); expect(w.gap.right).toBeCloseTo(1.4);
    expect(w.w).toBeCloseTo(3); expect(w.d).toBeCloseTo(3.4); expect(w.h).toBe(2.5);
  });
  it('stops at a neighbour across the item span only', () => {
    const a = item({});
    const b = item({ id: 'b', x: 2.5, y: 0.4, w: 0.5, d: 0.5 }); // right of a, gap 0.65... a right edge 1.6, b left 2.25
    const c = item({ id: 'c', x: 2.5, y: 3, w: 0.5, d: 0.5 });   // outside the band
    const w = fitWindow(a, room([a, b, c]));
    expect(w.gap.right).toBeCloseTo(0.65);
  });
  it('follows rotation', () => {
    const a = item({ rotation: Math.PI / 2, x: 0.4, y: 2 }); // local width runs along y
    const w = fitWindow(a, room([a]));
    expect(w.w).toBeCloseTo(4);
  });
  it('filters sizes against the window', () => {
    const win = { w: 1.5, d: 0.7, h: 2 };
    expect(fitsWindow({ w: 1.4, d: 0.7, h: 0.75 }, win)).toBe(true);
    expect(fitsWindow({ w: 1.6, d: 0.6, h: 0.75 }, win)).toBe(false);
    expect(fitsWindow({ w: 1.4, d: 0.6 }, win)).toBe(false);
  });
});
