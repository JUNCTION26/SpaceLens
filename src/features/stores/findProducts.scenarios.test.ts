import { describe, expect, it, vi } from 'vitest';

// No network in these tests: the key is reported absent.
vi.mock('../../core/ai', async (orig) => ({ ...(await orig<typeof import('../../core/ai')>()), aiReady: () => false }));

import type { FurnitureItem } from '../../core/types';
import { findProducts, findProductsReport, fitLadder, productKey, rankMatches, shopTheRoom, sameKind, type FindDeps, type Match } from './findProducts';
import { familyOf, normalizeKind, widthHintCm } from './kinds';
import type { ReadListing } from './read';

const u = (slug: string, n: number, store: 'se' | 'fi' = 'se') => `https://www.ikea.com/${store}/en/p/${slug}-${n}/`;
const page = (url: string, title: string, o: Partial<ReadListing> = {}): ReadListing => ({ store: 'IKEA', title, url, price: 995, currency: url.includes('/fi/') ? 'EUR' : 'SEK', images: ['i.jpg'], fetchedAt: 1, via: 'page', ...o });
const cm = (w: number, d: number, h?: number) => ({ w: w / 100, d: d / 100, ...(h === undefined ? {} : { h: h / 100 }) });

/** A shop: product table by url; the model answers with every url in it. */
const shop = (rows: Record<string, ReadListing>, ask?: (p: string) => string): FindDeps => ({
  ask: async (p) => ask?.(p) ?? '```json\n' + JSON.stringify({ products: Object.keys(rows).map((url) => ({ name: rows[url].title, url })) }) + '\n```',
  read: async (url) => { if (!rows[url]) throw new Error('404'); return rows[url]; },
});

const it0 = (name: string, category: string) => ({ name, category });

describe('kinds', () => {
  it('treats synonyms as one family', () => {
    expect(familyOf('couch')).toBe('sofa');
    expect(familyOf('settee')).toBe('sofa');
    expect(familyOf('closet')).toBe('wardrobe');
    expect(sameKind('sofa', 'couch')).toBe(true);
    expect(sameKind('wardrobe', 'closet')).toBe(true);
    expect(sameKind('sofa', 'wardrobe')).toBe(false);
  });
  it('reads unusual names, the name before the category', () => {
    expect(normalizeKind('cat tree', 'other')).toBe('cat-tree');
    expect(normalizeKind('Standing desk 140', 'other')).toBe('desk');
    expect(normalizeKind('bench seat', 'chair')).toBe('bench');
    expect(normalizeKind('Cafe table', 'table')).toBe('table');
    expect(normalizeKind('thing', 'gizmo')).toBeNull();
    expect(widthHintCm('standing desk 140')).toBe(140);
    expect(widthHintCm('desk 140x70')).toBe(140);
    expect(widthHintCm('cat tree')).toBeNull();
  });
});

describe('tolerance ladder', () => {
  const win = { w: 1, d: 0.5, h: 2 };
  it('exact, then within 5%, then over, then unknown', () => {
    expect(fitLadder(cm(100, 50, 200), win).state).toBe('fits');
    expect(fitLadder(cm(104, 50, 200), win)).toMatchObject({ state: 'tight', overPct: 4, overCm: { w: 4 } });
    expect(fitLadder(cm(106, 50, 200), win).state).toBe('over');
    expect(fitLadder(cm(100, 50), win).state).toBe('height-unconfirmed');
    expect(fitLadder({ w: 1 }, win).state).toBe('no-size');
  });
});

describe('scenario: cat room', () => {
  const win = { w: 1.0, d: 0.6, h: 2.4 };
  it('finds a cat tree for an item whose category is "other" and keeps a sofa out of it', async () => {
    const CAT = u('lurvig-klostrad-katt', 40510345);
    const SOFA = u('kivik-soffa', 29204511);
    const deps = shop({ [CAT]: page(CAT, 'LURVIG klösträd', { stated: cm(50, 40, 120) }), [SOFA]: page(SOFA, 'KIVIK soffa', { stated: cm(90, 60, 80) }) });
    const { matches, report } = await findProductsReport(it0('cat tree', 'other'), win, { deps });
    expect(report.kind).toBe('cat-tree');
    expect(matches.map((m) => m.listing.url)).toEqual([CAT]);
    expect(report.dropped.map((d) => d.reason)).toEqual(['different kind of product']);
  });
  it('asks the model for the kind, not only the vague category', async () => {
    let prompt = '';
    await findProducts(it0('cat tree', 'other'), win, { deps: shop({}, (p) => { prompt = prompt || p; return ''; }) });
    expect(prompt).toContain('kind: cat-tree');
  });
});

describe('scenario: home office', () => {
  const win = { w: 1.6, d: 0.8, h: 2.4 };
  it('a standing desk 140 gets desks only, by synonym, best first', async () => {
    const A = u('bekant-skrivbord', 29022855), B = u('idasen-skrivbord', 39279565), C = u('alex-lador', 30473543), D = u('tall-skrivbord', 39000111);
    const deps = shop({
      [A]: page(A, 'BEKANT skrivbord', { price: 2995, stated: cm(160, 80, 65) }),
      [B]: page(B, 'IDASEN skrivbord sit-stand', { price: 4995, stated: cm(160, 80, 65) }),
      [C]: page(C, 'ALEX lådor', { stated: cm(36, 58, 70) }),
      [D]: page(D, 'TALL skrivbord', { price: 1995, stated: cm(140, 60, 75) }),
    }, (p) => (p.includes('prefer about 140 cm wide') ? '```json\n' + JSON.stringify({ products: [A, B, C, D].map((url) => ({ url })) }) + '\n```' : ''));
    const { matches } = await findProductsReport(it0('standing desk 140', 'other'), win, { deps });
    expect(matches.map((m) => m.listing.url)).toEqual([D, A, B]); // cheaper first, drawers dropped
  });
});

describe('scenario: small bedroom', () => {
  const win = { w: 1.0, d: 0.6, h: 2.3 };
  const W1 = u('pax-garderob', 49000001), W2 = u('brimnes-garderob', 49000002), W3 = u('hauga-garderob', 49000003);
  const rows = {
    [W1]: page(W1, 'PAX garderob', { price: 1500, stated: cm(100, 58, 201) }),
    [W2]: page(W2, 'BRIMNES garderob', { price: 1200, stated: cm(104, 50, 190) }), // 4% over
    [W3]: page(W3, 'HAUGA garderob', { price: 900, stated: cm(150, 55, 200) }), // far over
  };
  it('accepts a wardrobe 4% too wide as a tight fit, ranked after the clean fit', async () => {
    const { matches } = await findProductsReport(it0('closet', 'wardrobe'), win, { deps: shop(rows) });
    expect(matches.map((m) => m.listing.url)).toEqual([W1, W2]);
    expect(matches[0].compromise).toBeUndefined();
    expect(matches[1].compromise).toMatchObject({ kind: 'tight', overPct: 4, overCm: { w: 4 } });
  });
  it('an item just over the space: nothing fits, closest are reported with how much', async () => {
    const only = { [W2]: page(W2, 'BRIMNES garderob', { stated: cm(108, 50, 190) }), [W3]: rows[W3] };
    const strict = await findProductsReport(it0('wardrobe', 'wardrobe'), win, { deps: shop(only) });
    expect(strict.matches).toEqual([]);
    expect(strict.closest.map((m) => m.listing.url)).toEqual([W2, W3]);
    expect(strict.closest[0].compromise).toMatchObject({ kind: 'oversize', overPct: 8, overCm: { w: 8 } });
    const fb = await findProductsReport(it0('wardrobe', 'wardrobe'), win, { deps: shop(only), fallback: true });
    expect(fb.matches.map((m) => m.listing.url)).toEqual([W2, W3]);
    expect(fb.matches.every((m) => m.compromise?.kind === 'oversize')).toBe(true);
    expect(fb.report.verified).toBe(2);
  });
  it('a page with no size is offered last as size-unknown, never as a fit', async () => {
    const N = u('nosize-garderob', 49000009);
    const r = await findProductsReport(it0('wardrobe', 'wardrobe'), win, { deps: shop({ [N]: page(N, 'X garderob', { stated: { w: 1 } }) }), fallback: true });
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].compromise?.kind).toBe('size-unknown');
  });
});

describe('scenario: cafe', () => {
  it('bench seat and cafe table are searched as their own kinds and a tv bench is not a bench seat', async () => {
    const B = u('ekero-bank', 59000001), T = u('norraryd-bord', 59000002), TV = u('besta-tv-bank', 59000003);
    const deps = shop({
      [B]: page(B, 'EKERÖ bänk', { stated: cm(120, 45, 45) }),
      [T]: page(T, 'NORRARYD bord', { stated: cm(70, 70, 74) }),
      [TV]: page(TV, 'BESTA tv-bänk', { stated: cm(120, 40, 40) }),
    });
    const bench = await findProducts(it0('bench seat', 'chair'), { w: 1.3, d: 0.5, h: 1 }, { deps });
    expect(bench.map((m) => m.listing.url)).toEqual([B]);
    const table = await findProducts(it0('Cafe table', 'table'), { w: 0.8, d: 0.8, h: 1 }, { deps });
    expect(table.map((m) => m.listing.url)).toEqual([T]);
  });
  it('a whole room: same product found for two chairs is returned per item; owned items and wall items are skipped', async () => {
    const S = u('terje-pall', 59100001);
    const deps = shop({ [S]: page(S, 'TERJE pall', { stated: cm(40, 40, 45) }) });
    const f = (id: string, o: Partial<FurnitureItem> = {}): FurnitureItem => ({
      id, catalogId: 'x', name: 'bar stool', category: 'other', x: 1, y: 1, rotation: 0, w: 0.4, d: 0.4, h: 0.8,
      clearance: { front: 0, back: 0, left: 0, right: 0 }, locked: false, owned: false, priceSek: 0, priceStatus: 'estimated', color: '#fff', sourceKind: 'catalog', ...o,
    });
    const model = { ceilingM: 2.5, furniture: [f('a'), f('b', { x: 2 }), f('own', { owned: true }), f('wall', { mount: 'wall' })], spaces: [{ id: 's', name: 'r', polygon: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }], walls: [] }] };
    const r = await shopTheRoom(model, { deps });
    expect(Object.keys(r.matches).sort()).toEqual(['a', 'b']);
    expect(r.unmatched).toEqual([]);
  });
});

describe('dedupe and stable order', () => {
  it('one product reached through the sources, the text, and a differently written link is listed once', async () => {
    const A = u('micke-skrivbord', 80213074);
    const deps: FindDeps = {
      ask: async () => ({ text: '```json\n' + JSON.stringify({ products: [{ url: A }, { url: A.replace(/\/$/, '?x=1') }, { url: A.replace(/\/$/, '') }] }) + '\n```', sources: [A + '#top'] }),
      read: async (url) => page(url, 'MICKE skrivbord', { stated: cm(100, 50, 75) }),
      resolve: async (s) => s,
    };
    const { matches, report } = await findProductsReport(it0('desk', 'desk'), { w: 1.2, d: 0.6, h: 2 }, { deps });
    expect(matches).toHaveLength(1);
    expect(report.asked).toBe(1);
    expect(productKey(A)).toBe(productKey(A + '?a=b'));
    expect(productKey(u('x-desk', 11111111, 'fi'))).not.toBe(productKey(u('x-desk', 11111111, 'se')));
  });
  it('order is the same whichever page answers first', async () => {
    const urls = ['a', 'b', 'c', 'd'].map((x, i) => u(`${x}-skrivbord`, 70000001 + i));
    const run = async (delays: number[]) => {
      const deps: FindDeps = {
        ask: async () => '```json\n' + JSON.stringify({ products: urls.map((url) => ({ url })) }) + '\n```',
        read: async (url) => { const i = urls.indexOf(url); await new Promise((r) => setTimeout(r, delays[i])); return page(url, 'skrivbord', { price: 500, stated: cm(100, 50, 75) }); },
      };
      return (await findProductsReport(it0('desk', 'desk'), { w: 1.2, d: 0.6, h: 2 }, { deps })).matches.map((m) => m.listing.url);
    };
    const a = await run([1, 8, 1, 8]);
    const b = await run([8, 1, 8, 1]);
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort()); // equal price and title: by link
  });
  it('rankMatches: clean, height unconfirmed, tight, oversize, size unknown', () => {
    const m = (url: string, o: Partial<Match> = {}): Match => ({ listing: { store: 'IKEA', title: 't', url, price: 1, currency: 'SEK', fetchedAt: 1 }, ...o });
    const r = rankMatches([
      m('5', { compromise: { kind: 'size-unknown', overPct: 0, overCm: {} } }), m('4', { compromise: { kind: 'oversize', overPct: 9, overCm: {} } }),
      m('3', { compromise: { kind: 'tight', overPct: 3, overCm: {} } }), m('2', { heightUnconfirmed: true }), m('1'),
    ]);
    expect(r.map((x) => x.listing.url)).toEqual(['1', '2', '3', '4', '5']);
  });
});

describe('offline', () => {
  it('without a key or injected deps it says so and returns nothing, without throwing', async () => {
    const r = await findProductsReport(it0('sofa', 'sofa'), { w: 2, d: 1, h: 1 }, {});
    expect(r.matches).toEqual([]);
    expect(r.closest).toEqual([]);
    expect(r.report.offline).toBe(true);
  });
});
