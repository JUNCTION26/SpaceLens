import { describe, expect, it } from 'vitest';
import { catalogEntry } from '../furniture/catalog';
import { buildPhotoRoom, clampSize, itemFromPhoto, mostVisibleWall, nearestWall, nudgeApart, parseEstimate, placeOpening, resolveCatalogId, type PhotoItem } from './room';

const item = (o: Partial<PhotoItem> = {}): PhotoItem => ({
  label: 'sofa', kind: 'sofa', widthM: 2.1, depthM: 0.9, heightM: 0.8, x: 0.5, y: 0.5, against: 'none', facing: 'camera', color: '', material: '', ...o,
});

describe('catalogue mapping and size clamping', () => {
  it('maps "other" to the closest piece by its label', () => {
    expect(resolveCatalogId('other', 'wooden bookcase')).toBe('bookshelf');
    expect(resolveCatalogId('other', 'grand piano')).toBeUndefined();
    expect(resolveCatalogId('sofa', 'x')).toBe('sofa-3');
  });
  it('keeps sizes near the catalogue piece', () => {
    const s = clampSize({ widthM: 9, depthM: 0.01, heightM: 5 }, 'sofa-3');
    expect(s.w).toBeCloseTo(catalogEntry('sofa-3')!.w * 2.2);
    expect(s.d).toBeCloseTo(catalogEntry('sofa-3')!.d * 0.4);
    expect(s.h).toBeLessThan(2);
    expect(clampSize({ widthM: 8, depthM: 8, heightM: 8 })).toEqual({ w: 3.5, d: 3.5, h: 2.5 });
    expect(clampSize({ widthM: 2, depthM: 3, heightM: 0.5, kind: 'rug' }, 'rug-160').h).toBeLessThanOrEqual(0.02);
  });
  it('builds items with clamped sizes', () => {
    const f = itemFromPhoto(item({ widthM: 12 }), 4, 5);
    expect(f.w).toBeLessThan(5);
    expect(f.x).toBeGreaterThan(0);
  });
});

describe('wall snapping', () => {
  it('finds the nearest wall', () => {
    expect(nearestWall(0.2, 2, 4, 5)).toEqual({ wall: 'left', distM: 0.2 });
    expect(nearestWall(2, 4.9, 4, 5).wall).toBe('front');
    expect(nearestWall(3.9, 2, 4, 5).wall).toBe('right');
    expect(nearestWall(2, 0.1, 4, 5).wall).toBe('back');
  });
  it('sits an item that is almost at a wall flush against it', () => {
    const f = itemFromPhoto(item({ widthM: 1, depthM: 0.5, heightM: 0.5, kind: 'bench', label: 'bench', x: 0.5, y: 0.06 }), 4, 5);
    expect(f.y).toBeCloseTo(0.25);
  });
  it('clamps opening widths and keeps them on the wall', () => {
    const w = placeOpening({ kind: 'door', wall: 'back', at: 0, widthM: 3, heightM: 2, sillM: 0 }, 4, 5);
    expect(w.widthM).toBe(1.3);
    expect(w.offsetM).toBeCloseTo(0.7);
    const tiny = placeOpening({ kind: 'window', wall: 'right', at: 1, widthM: 0.01, heightM: 1, sillM: 1 }, 4, 5);
    expect(tiny.widthM).toBe(0.4);
    expect(tiny.wallIndex).toBe(1);
    expect(placeOpening({ kind: 'window', wall: 'back', at: 0.5, widthM: 3.5, heightM: 1, sillM: 1 }, 1.5, 4).widthM).toBe(1.4);
  });
});

describe('overlap nudging', () => {
  const built = (xs: Array<[number, number]>) => buildPhotoRoom(parseEstimate({
    widthM: 4, depthM: 4, confidence: 0.8,
    furniture: xs.map(([x, y]) => ({ label: 'chair', kind: 'chair', widthM: 0.5, depthM: 0.5, heightM: 0.9, x, y, against: 'none', facing: 'camera', color: '#fff', material: 'wood' })),
  })).furniture;
  const overlap = (a: { x: number; y: number; w: number; d: number }, b: typeof a) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 0.01 && Math.abs(a.y - b.y) < (a.d + b.d) / 2 - 0.01;
  it('moves stacked items apart and keeps them inside', () => {
    const f = built([[0.5, 0.5], [0.5, 0.5], [0.52, 0.5]]);
    for (let i = 0; i < f.length; i++) {
      expect(f[i].x - f[i].w / 2).toBeGreaterThanOrEqual(-0.001);
      expect(f[i].x + f[i].w / 2).toBeLessThanOrEqual(4.001);
      for (let j = i + 1; j < f.length; j++) expect(overlap(f[i], f[j])).toBe(false);
    }
  });
  it('lets a rug sit under furniture', () => {
    const base = built([[0.5, 0.5]])[0];
    const rug = { ...base, id: 'r', h: 0.01, w: 2, d: 2 };
    const out = nudgeApart([base, rug], 4, 4);
    expect(out[1].x).toBeCloseTo(2);
    expect(out[0].x).toBeCloseTo(base.x);
  });
  it('pulls a piece from outside back in', () => {
    const out = nudgeApart([{ ...built([[0.5, 0.5]])[0], x: -3, y: 9 }], 4, 4);
    expect(out[0].x).toBeCloseTo(0.25);
    expect(out[0].y).toBeCloseTo(3.75);
  });
});

describe('confidence', () => {
  it('defaults the ceiling to 2.5 m when unsure', () => {
    expect(parseEstimate({ widthM: 4, depthM: 4, confidence: 0.2, ceilingM: 3.9 }).ceilingM).toBe(2.5);
    expect(parseEstimate({ widthM: 4, depthM: 4, confidence: 0.8 }).ceilingM).toBe(2.5);
    expect(parseEstimate({ widthM: 4, depthM: 4, confidence: 0.8, ceilingM: 3.3 }).ceilingM).toBe(3.3);
  });
  it('marks weakly seen walls unknown and picks the clearest wall', () => {
    const e = parseEstimate({ widthM: 4, depthM: 4, confidence: 0.8, wallConfidence: { back: 0.4, right: 0.9, front: 0.2, left: 0.7 } });
    const m = buildPhotoRoom(e);
    expect(m.spaces[0].walls.map((w) => w.status)).toEqual(['unknown', 'estimated', 'unknown', 'estimated']);
    expect(mostVisibleWall(e.wallConfidence)).toBe('right');
    expect(mostVisibleWall({ back: 0.8, right: 0.8, front: 0.8, left: 0.8 })).toBe('back');
  });
});
