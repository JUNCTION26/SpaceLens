import { describe, expect, it } from 'vitest';
import type { FurnitureItem } from '../../core/types';
import { findProducts, findProductsReport, kindFromTitle, matchByName, parseCandidates, shopTheRoom, type FindDeps } from './findProducts';
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
      ask: async (p) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 10)); live--; return p.includes('"nomatch"') || p.startsWith('IKEA ') ? 'none' : reply; },
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

describe('fitState and sameKind', () => {
  const w = { w: 1.5, d: 0.8, h: 1.2 };
  it('accepts a missing height when width and depth fit', async () => {
    const { fitState } = await import('./findProducts');
    expect(fitState({ w: 1.2, d: 0.6 }, w)).toBe('height-unconfirmed');
    expect(fitState({ w: 1.6, d: 0.6 }, w)).toBe('over');
    expect(fitState({ w: 1.2 }, w)).toBe('no-size');
    expect(fitState({ w: 1.5, d: 0.8, h: 1.2 }, w)).toBe('fits');
  });
  it('keeps a drawer unit out of the desk results', async () => {
    const { sameKind } = await import('./findProducts');
    expect(sameKind('desk', 'table')).toBe(true);
    expect(sameKind('desk', 'dresser')).toBe(false);
    expect(sameKind('desk', 'weird')).toBe(false);
  });
});

describe('yield', () => {
  const REAL = 'https://www.ikea.com/se/sv/p/micke-skrivbord-vit-80213074/';
  const FAKE = 'https://www.ikea.com/se/sv/p/trotten-skrivbord-vit-1012710/';
  const fakeReply = '```json\n' + JSON.stringify({ products: [{ name: 'TROTTEN skrivbord', url: FAKE }] }) + '\n```';
  const realOnly = (u: string) => {
    if (u === REAL) return page(u, { title: 'MICKE skrivbord, vit', category: 'desk' });
    throw new Error('x');
  };
  it('prefers the source links the search tool returned', async () => {
    const deps: FindDeps = {
      ask: async () => ({ text: fakeReply, sources: ['https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/def'] }),
      resolve: async (u) => (u.endsWith('abc') ? REAL : null),
      read: async (u) => realOnly(u),
    };
    const { matches, report } = await findProductsReport(item, win, { deps });
    expect(matches.map((m) => m.listing.url)).toEqual([REAL]);
    expect(report.asked).toBe(2);
  });
  it('looks a dropped candidate up by name on the store search page', async () => {
    const deps: FindDeps = {
      ask: async () => fakeReply,
      read: async (u) => realOnly(u),
      search: async () => [{ title: 'TROTTEN skrivbord', url: FAKE }, { title: 'MICKE skrivbord', url: REAL }],
    };
    const redirected = { ...deps, ask: async () => '```json\n' + JSON.stringify({ products: [{ name: 'MICKE skrivbord', url: 'https://www.ikea.com/se/sv/p/micke-skrivbord-vit-1234567/' }] }) + '\n```' };
    const { matches, report } = await findProductsReport(item, win, { deps: redirected });
    expect(matches.map((m) => m.listing.url)).toEqual([REAL]);
    expect(report.dropped).toHaveLength(1);
  });
  it('never accepts a name match whose page does not verify', async () => {
    const deps: FindDeps = { ask: async () => fakeReply, read: async () => { throw new Error('x'); }, search: async () => [{ title: 'TROTTEN skrivbord', url: REAL }] };
    expect((await findProductsReport(item, win, { deps })).matches).toEqual([]);
  });
  it('asks again with a plain query when the first answer is empty', async () => {
    const asked: string[] = [];
    const deps: FindDeps = { ask: async (p) => { asked.push(p); return asked.length === 1 ? '' : `See ${REAL} and more`; }, read: async (u) => realOnly(u) };
    const { matches } = await findProductsReport(item, win, { deps });
    expect(asked[1]).toBe('IKEA desk under 130 cm wide site:ikea.com/se');
    expect(matches).toHaveLength(1);
  });
  it('retries a slow page read once', async () => {
    let n = 0;
    const deps: FindDeps = { ask: async () => reply, read: async (u) => { if (u === U1 && n++ === 0) throw new Error('The page took too long to read.'); return page(u); } };
    expect((await findProductsReport(item, win, { deps })).matches.length).toBeGreaterThan(0);
  });
  it('reads kind from Swedish, Finnish and English words', () => {
    expect(kindFromTitle('desk', 'MICKE skrivbord, vit')).toBe('match');
    expect(kindFromTitle('desk', 'ALEX lådor')).toBe('other');
    expect(kindFromTitle('desk', 'ALEX')).toBe('unknown');
    expect(kindFromTitle('desk', 'MALM byrå')).toBe('other');
    expect(kindFromTitle('desk', 'MICKE työpöytä')).toBe('match');
    expect(kindFromTitle('bed', 'x', 'https://www.ikea.com/fi/fi/p/malm-sanky-s1234567/')).toBe('match');
    expect(kindFromTitle('bed', 'SLATTUM klädd sängstomme')).toBe('match');
    expect(kindFromTitle('bed', 'EKET sängbord')).toBe('other');
    expect(kindFromTitle('wardrobe', 'PAX garderob')).toBe('match');
    expect(kindFromTitle('armchair', 'POANG fåtölj')).toBe('match');
    expect(kindFromTitle('bed', 'KIVIK soffa')).toBe('other');
  });
  it('matches search links by name', () => {
    expect(matchByName([{ title: '', url: 'https://www.ikea.com/se/sv/p/lillasen-skrivbord-1/' }, { title: '', url: 'https://www.ikea.com/se/sv/p/micke-skrivbord-vit-80213074/' }], 'MICKE')).toEqual(['https://www.ikea.com/se/sv/p/micke-skrivbord-vit-80213074/']);
  });
});
