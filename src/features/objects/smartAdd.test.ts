import { describe, expect, it } from 'vitest';
import { centroid, convexOverlap, itemCorners, polygonInside } from '../../core/geometry';
import type { FurnitureItem, SpaceModel } from '../../core/types';
import { nearestWallDistance, smartAddPose } from './placement';

const wall = { thicknessM: 0.1, sourceKind: 'manual' as const, status: 'verified' as const };
const room = (furniture: FurnitureItem[] = []): SpaceModel => ({
  id: 'm', name: 'r', version: 1, units: 'm', ceilingM: 2.5, sourceLabel: '',
  spaces: [{ id: 's', name: 'Room', polygon: [{ x: 0, y: 0 }, { x: 4.5, y: 0 }, { x: 4.5, y: 4 }, { x: 0, y: 4 }], walls: [wall, wall, wall, wall] }],
  openings: [], furniture, measurements: [], evidence: [],
});
let n = 0;
const mk = (p: Partial<FurnitureItem>): FurnitureItem => ({
  id: `i${n++}`, catalogId: 'c', name: 'Item', category: 'chair', x: 2.25, y: 2, rotation: 0, w: 0.5, d: 0.5, h: 0.9,
  clearance: { front: 0, back: 0, left: 0, right: 0 }, locked: false, owned: false, priceSek: 0, priceStatus: 'catalog',
  color: '#888', sourceKind: 'catalog', ...p,
});
const front = (r: number) => ({ x: -Math.sin(r), y: Math.cos(r) });

describe('smartAddPose', () => {
  it('puts a new chair at the desk, facing it', () => {
    // Desk against the east wall, facing west.
    const desk = mk({ category: 'desk', x: 4.15, y: 2, w: 1.4, d: 0.7, rotation: Math.PI / 2, h: 0.75 });
    const m = room([desk]);
    const p = smartAddPose(m, mk({ category: 'chair' }));
    expect(Math.hypot(p.x - desk.x, p.y - desk.y)).toBeLessThan(1.0);
    const f = front(p.rotation), to = { x: desk.x - p.x, y: desk.y - p.y };
    expect((f.x * to.x + f.y * to.y) / Math.hypot(to.x, to.y)).toBeGreaterThan(0.95);
  });

  it('puts a TV unit against a wall facing the sofa', () => {
    const sofa = mk({ category: 'sofa', x: 0.45, y: 2, w: 2, d: 0.9, rotation: -Math.PI / 2 });
    const m = room([sofa]);
    const tv = mk({ category: 'tv-unit', w: 1.6, d: 0.45, h: 0.5 });
    const p = smartAddPose(m, tv);
    expect(nearestWallDistance(m, { ...tv, ...p })!.distanceM).toBeLessThan(0.05);
    const f = front(p.rotation), to = { x: sofa.x - p.x, y: sofa.y - p.y };
    expect((f.x * to.x + f.y * to.y) / Math.hypot(to.x, to.y)).toBeGreaterThan(0.9);
  });

  it('ten random adds never overlap, and wall pieces never sit in the centre', () => {
    const cats: Array<[string, number, number]> = [
      ['sofa', 2, 0.9], ['chair', 0.5, 0.5], ['tv-unit', 1.6, 0.45], ['bookshelf', 0.8, 0.35], ['plant', 0.4, 0.4],
      ['desk', 1.2, 0.6], ['dresser', 1, 0.5], ['armchair', 0.8, 0.8], ['wardrobe', 1, 0.6], ['sideboard', 1.4, 0.45],
    ];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const order = [...cats].sort(() => rnd() - 0.5);
    let m = room();
    const c = centroid(m.spaces[0].polygon);
    for (const [category, w, d] of order) {
      const it = mk({ category, w, d });
      const placed = { ...it, ...smartAddPose(m, it) };
      const body = itemCorners(placed);
      expect(polygonInside(body, m.spaces[0].polygon)).toBe(true);
      for (const o of m.furniture) expect(convexOverlap(body, itemCorners(o))).toBe(0);
      if (!['chair', 'plant', 'armchair'].includes(category)) {
        expect(nearestWallDistance(m, placed)!.distanceM).toBeLessThan(0.05);
        expect(Math.hypot(placed.x - c.x, placed.y - c.y)).toBeGreaterThan(1);
      }
      m = { ...m, furniture: [...m.furniture, placed] };
    }
  });
});
