import { describe, expect, it } from 'vitest';
import type { FurnitureItem } from '../../core/types';
import { findProducts, parseCandidates, shopTheRoom, type FindDeps } from './findProducts';
import type { ReadListing } from './read';

const U1 = 'https://www.ikea.com/se/en/p/bekant-desk-white-s19022855/';
const U2 = 'https://www.ikea.com/fi/en/p/malm-desk-white-s1/';
const U3 = 'https://www.ikea.com/se/en/cat/desks-20649/';
const reply = '```json\n' + JSON.stringify({ products: [
  { name: 'BEKANT', url: U1, price: 1, currency: 'sek', widthCm: 160, depthCm: 80, heightCm: 65 },
  { name: 'MALM', url: U2, price: null, currency: 'EUR', widthCm: null, depthCm: null, heightCm: null },
  { name: 'cat', url: U3 }, { name: 'dupe', url: U1 }, { name: 'other', url: 'https://example.com/p/x' },
] }) + '\n```';

const page = (url: string, o: Partial<ReadListing> = {}): ReadListing => ({ store: 'IKEA', title: 'x', url, price: 1495, currency: 'SEK', images: ['i.jpg'], fetchedAt: 1, via: 'page', stated: { w: 1.2, d: 0.6, h: 0.75 }, ...o });
const win = { w: 1.3, d: 0.7, h: 2 };
const item = { name: 'Desk', category: 'desk' };

describe('parseCandidates', () => {
  it('keeps IKEA SE/FI product urls only, once each', () => {
    const c = parseCandidates(reply);
    expect(c.map((x) => x.url)).toEqual([U1, U2]);
    expect(c[0].currency).toBe('SEK');
  });
  it('survives garbage', () => { expect(parseCandidates('no json here')).toEqual([]); });
});

describe('findProducts', () => {
  it('uses the page price and size, not the model claims, and drops what fails', async () => {
    const deps: FindDeps = {
      ask: async () => reply,
      read: async (u) => {
        if (u === U1) return page(u, { price: 1495 });
        throw new Error('404');
      },
    };
    const m = await findProducts(item, win, { deps });
    expect(m).toHaveLength(1);
    expect(m[0].listing.price).toBe(1495);
    expect(m[0].listing.stated).toEqual({ w: 1.2, d: 0.6, h: 0.75 });
  });
  it('drops redirects, missing price, missing size, and too-large products', async () => {
    const mk = (o: Partial<ReadListing>): FindDeps => ({ ask: async () => reply, read: async (u) => page(u, o) });
    expect(await findProducts(item, win, { deps: mk({ note: 'The store sent this link to a general page, so ...' }) })).toEqual([]);
    expect(await findProducts(item, win, { deps: mk({ price: null }) })).toEqual([]);
    expect(await findProducts(item, win, { deps: mk({ stated: { w: 1.2 } }) })).toEqual([]);
    expect(await findProducts(item, win, { deps: mk({ stated: { w: 1.6, d: 0.6, h: 0.75 } }) })).toEqual([]);
  });
  it('returns nothing when the model fails', async () => {
    expect(await findProducts(item, win, { deps: { ask: async () => { throw new Error('x'); }, read: async (u) => page(u) } })).toEqual([]);
  });
});

describe('shopTheRoom', () => {
  const f = (id: string, o: Partial<FurnitureItem> = {}): FurnitureItem => ({
    id, catalogId: 'desk', name: id, category: 'desk', x: 1.5, y: 1, rotation: 0, w: 1.2, d: 0.6, h: 0.75,
    clearance: { front: 0, back: 0, left: 0, right: 0 }, locked: false, owned: false, priceSek: 0, priceStatus: 'estimated', color: '#fff', sourceKind: 'catalog', ...o,
  });
  it('runs at most 3 at once, skips owned, reports unmatched', async () => {
    let live = 0, peak = 0;
    const deps: FindDeps = {
      ask: async (p) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 10)); live--; return p.includes('"nomatch"') ? 'none' : reply; },
      read: async (u) => page(u),
    };
    const furniture = [f('a'), f('b'), f('c'), f('d'), f('e'), f('nomatch'), f('mine', { owned: true })];
    const model = { ceilingM: 2.5, furniture, spaces: [{ id: 's', name: 'r', polygon: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }], walls: [] }] };
    const r = await shopTheRoom(model, { deps });
    expect(peak).toBe(3);
    expect(Object.keys(r.matches).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(r.unmatched).toEqual(['nomatch']);
  });
});
