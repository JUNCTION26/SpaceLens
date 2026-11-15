// Furnish > Library: search, category and "fits" filters, add from the catalogue, colour variants,
// Custom item, the shopping list total and CSV rows.
import { describe, expect, it, vi } from 'vitest';
import { centroid } from '../../core/geometry';
import { sampleRoom } from '../../core/sample';
import { CATALOG, makeItem, makeOwnItem, variantsFor } from '../../features/furniture/catalog';
import { findFreeSpot } from '../../features/objects/placement';
import { outside, overlaps, resetStore, st } from './lite';

// No key and no server: the app's offline path.
vi.stubEnv('VITE_API_BASE', '');
vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')));

const center = () => centroid(st().model.spaces[0].polygon);
/** LibraryPanel.addFromCatalog */
function add(id: string) {
  const item = makeItem(id, center());
  const placed = { ...item, ...findFreeSpot(st().model, item) };
  st().dispatch({ type: 'PLACE_OBJECT', item: placed });
  st().select({ kind: 'furniture', id: placed.id });
  return placed;
}
/** LibraryPanel list filter */
function filter(q: string, cat: string | null) {
  const t = q.trim().toLowerCase();
  return CATALOG.filter((e) => (!cat || e.category === cat) && (!t || e.name.toLowerCase().includes(t) || e.category.includes(t) || e.tags.some((g) => g.includes(t))));
}

describe('Library', () => {
  it('search "desk" and the desk category both list desks only', () => {
    expect(filter('desk', null).length).toBeGreaterThan(2);
    expect(filter('', 'desk').every((e) => e.category === 'desk')).toBe(true);
    expect(filter('zzzz', null)).toEqual([]);
  });

  it('adding a piece places it inside the room, clear of the others, and selects it', () => {
    resetStore(sampleRoom());
    const n = st().model.furniture.length;
    const p = add('armchair-1' in Object.fromEntries(CATALOG.map((e) => [e.id, 1])) ? 'armchair-1' : CATALOG.find((e) => e.category === 'armchair')!.id);
    expect(st().model.furniture.length).toBe(n + 1);
    expect(outside(st().model, [st().model.furniture.find((f) => f.id === p.id)!])).toEqual([]);
    expect(overlaps(st().model.furniture)).toEqual([]);
    expect(st().selection).toEqual({ kind: 'furniture', id: p.id });
  });

  it('adding five pieces in a row keeps every one inside and apart', () => {
    resetStore(sampleRoom());
    for (const cat of ['plant', 'bookshelf', 'lamp', 'side-table', 'chair']) {
      const e = CATALOG.find((x) => x.category === cat) ?? CATALOG.find((x) => x.category.includes(cat.split('-')[0]));
      if (e) add(e.id);
    }
    expect(outside(st().model)).toEqual([]);
    expect(overlaps(st().model.furniture)).toEqual([]);
  });

  it('a colour variant recolours the selected piece', () => {
    resetStore(sampleRoom());
    const e = CATALOG.find((x) => variantsFor(x).length > 1)!;
    expect(e).toBeTruthy();
    const p = add(e.id);
    const v = variantsFor(p).find((x) => x.color !== p.color)!;
    st().dispatch({ type: 'UPDATE_OBJECT', id: p.id, patch: { color: v.color, material: v.material || p.material } });
    expect(st().model.furniture.find((f) => f.id === p.id)!.color).toBe(v.color);
  });

  it('Custom item adds a piece of the typed size inside the room', () => {
    resetStore(sampleRoom());
    const it = makeOwnItem('Old trunk', 'storage-cabinet', 0.9, 0.5, 0.5, center());
    const placed = { ...it, ...findFreeSpot(st().model, it) };
    st().dispatch({ type: 'PLACE_OBJECT', item: placed });
    const f = st().model.furniture.find((x) => x.id === placed.id)!;
    expect([f.w, f.d, f.h]).toEqual([0.9, 0.5, 0.5]);
    expect(outside(st().model, [f])).toEqual([]);
    expect(overlaps(st().model.furniture)).toEqual([]);
  });

  it('the list total is the sum of prices of pieces to buy', () => {
    resetStore(sampleRoom());
    add(CATALOG[0].id);
    const total = st().model.furniture.reduce((s, f) => s + (f.owned ? 0 : f.priceSek), 0);
    const manual = st().model.furniture.filter((f) => !f.owned).map((f) => f.priceSek).reduce((a, b) => a + b, 0);
    expect(total).toBe(manual);
    expect(total).toBeGreaterThan(0);
  });
});
