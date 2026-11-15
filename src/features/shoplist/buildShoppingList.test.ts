import { describe, expect, it } from 'vitest';
import type { FurnitureItem } from '../../core/types';
import { buildShoppingList, toCsv } from './buildShoppingList';

const item = (o: Partial<FurnitureItem>): FurnitureItem => ({
  id: 'i', catalogId: 'c', name: 'Chair', category: 'seat', x: 0, y: 0, rotation: 0, w: 0.5, d: 0.5, h: 0.9,
  clearance: { front: 0, back: 0, left: 0, right: 0 }, locked: false, owned: false, priceSek: 0, priceStatus: 'estimated',
  color: '#fff', sourceKind: 'catalog', ...o,
} as FurnitureItem);
const listing = (price: number | null, url = 'https://shop.test/a') => ({ store: 'S', title: 't', url, price, currency: 'SEK', fetchedAt: 0 });

describe('buildShoppingList', () => {
  it('merges identical items and skips owned', () => {
    const l = buildShoppingList({ furniture: [item({ id: '1' }), item({ id: '2' }), item({ id: '3', owned: true }), item({ id: '4', w: 1 })] });
    expect(l.lines).toHaveLength(2);
    expect(l.lines[0].qty).toBe(2);
    expect(l.lines[0]).toMatchObject({ wCm: 50, dCm: 50, hCm: 90 });
  });
  it('totals priced lines and counts unpriced', () => {
    const l = buildShoppingList({ furniture: [item({ id: '1', listing: listing(100) }), item({ id: '2', listing: listing(100) }), item({ id: '3', name: 'Desk' })] });
    expect(l.totals).toEqual({ SEK: 200 });
    expect(l.unpriced).toBe(1);
  });
  it('uses listing url, else an IKEA name search', () => {
    const l = buildShoppingList({ furniture: [item({ listing: listing(5) }), item({ name: 'Oak desk' })] });
    expect(l.lines[0]).toMatchObject({ link: 'https://shop.test/a', listed: true });
    expect(l.lines[1].link).toBe('https://www.ikea.com/se/en/search/?q=Oak%20desk');
    expect(l.lines[1].listed).toBe(false);
  });
  it('listing without price is unpriced', () => {
    expect(buildShoppingList({ furniture: [item({ listing: listing(null) })] }).unpriced).toBe(1);
  });
  it('escapes csv', () => {
    const l = buildShoppingList({ furniture: [item({ name: 'Chair, "big"' })] });
    const csv = toCsv(l);
    expect(csv.split('\r\n')[1].startsWith('"Chair, ""big""",50,50,90,1,,,,')).toBe(true);
  });
});

import { totalOf } from '../budget/money';
describe('list total equals budget total', () => {
  it('same furniture gives the same sum, estimates included, owned excluded', () => {
    const furniture = [
      item({ id: '1', priceSek: 1200 }),
      item({ id: '2', priceSek: 1200 }),
      item({ id: '3', name: 'Desk', priceSek: 3000, priceStatus: 'catalog', listing: listing(3000) }),
      item({ id: '4', name: 'Rug', priceSek: 500, priceStatus: 'owned' }),
      item({ id: '5', name: 'Sofa', priceSek: 9000, owned: true }),
      item({ id: '6', name: 'Lamp', priceSek: 0 }),
    ];
    expect(buildShoppingList({ furniture }).totals.SEK).toBe(totalOf(furniture));
  });
});
