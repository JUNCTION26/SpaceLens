import { describe, expect, it } from 'vitest';
import { convexOverlap, itemCorners, polygonInside } from '../../core/geometry';
import type { FurnitureItem, SpaceModel } from '../../core/types';
import { alignmentGuides, clampInside, describeItemPlacement, findFreeSpot, groupBounds, moveGroup, nearestWallDistance, resolveOverlap, rotateGroup, snapToWall } from './placement';

const wall = { thicknessM: 0.1, sourceKind: 'manual' as const, status: 'verified' as const };
const model: SpaceModel = {
  id: 'm', name: 'r', version: 1, units: 'm', ceilingM: 2.5, sourceLabel: '',
  spaces: [{ id: 's', name: 'Room', polygon: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }], walls: [wall, wall, wall, wall] }],
  openings: [{ id: 'w', kind: 'window', spaceId: 's', wallIndex: 0, offsetM: 3, widthM: 1, heightM: 1, sillM: 0.9, swing: 'none', hinge: 'start', sourceKind: 'manual', status: 'verified' }],
  furniture: [], measurements: [], evidence: [],
};
const mk = (p: Partial<FurnitureItem>): FurnitureItem => ({
  id: 'i', catalogId: 'c', name: 'Item', category: 'chair', x: 2, y: 1.5, rotation: 0, w: 1, d: 0.5, h: 1,
  clearance: { front: 0, back: 0, left: 0, right: 0 }, locked: false, owned: false, priceSek: 0, priceStatus: 'catalog',
  color: '#888', sourceKind: 'catalog', ...p,
});

describe('placement', () => {
  it('findFreeSpot backs a sofa against a wall facing inward', () => {
    const sofa = mk({ category: 'sofa', w: 2, d: 0.9 });
    const p = findFreeSpot(model, sofa, []);
    const nw = nearestWallDistance(model, { ...sofa, ...p })!;
    expect(nw.distanceM).toBeLessThan(0.02);
    // front direction equals inward normal
    expect(-Math.sin(p.rotation)).toBeCloseTo(nw.inward.x, 5);
    expect(Math.cos(p.rotation)).toBeCloseTo(nw.inward.y, 5);
  });
  it('findFreeSpot avoids others and stays inside', () => {
    const big = mk({ id: 'b', x: 2, y: 1.5, w: 3, d: 2 });
    const p = findFreeSpot(model, mk({ w: 0.5, d: 0.4 }), [big]);
    const c = itemCorners({ ...mk({ w: 0.5, d: 0.4 }), ...p });
    expect(polygonInside(c, model.spaces[0].polygon)).toBe(true);
    expect(convexOverlap(c, itemCorners(big))).toBe(0);
  });
  it('snapToWall pulls a near item flush to the top wall', () => {
    const p = snapToWall(model, mk({ y: 0.35 }))!;
    expect(p.y).toBeCloseTo(0.25);
    expect(Math.cos(p.rotation)).toBeCloseTo(1);
    expect(snapToWall(model, mk({ y: 1.5 }))).toBeNull();
  });
  it('resolveOverlap returns the minimum translation', () => {
    const r = resolveOverlap(model, mk({ x: 1.9 }), [mk({ id: 'o', x: 1, y: 1.5 })])!;
    expect(r.x).toBeGreaterThan(1.99);
    expect(r.y).toBeCloseTo(1.5);
    expect(resolveOverlap(model, mk({}), [])).toBeNull();
  });
  it('clampInside pushes a poking item back in', () => {
    const p = clampInside(model, mk({ x: 3.8 }));
    expect(polygonInside(itemCorners({ ...mk({}), ...p }), model.spaces[0].polygon)).toBe(true);
  });
  it('alignmentGuides finds shared edges and centres', () => {
    const g = alignmentGuides(mk({ x: 2, y: 1 }), [mk({ id: 'o', x: 2.01, y: 2.5 })]);
    expect(g.some((x) => x.axis === 'x' && x.kind === 'centre')).toBe(true);
  });
  it('group helpers', () => {
    const items = [mk({ id: 'a', x: 1, y: 1 }), mk({ id: 'b', x: 3, y: 1 })];
    expect(groupBounds(items).w).toBeCloseTo(3);
    expect(moveGroup(items, 1, 0)[0].x).toBe(2);
    const r = rotateGroup(items, Math.PI, { x: 2, y: 1 });
    expect(r[0].x).toBeCloseTo(3);
  });
  it('describeItemPlacement', () => {
    expect(describeItemPlacement(model, mk({ x: 1.5, y: 0.25 }))).toBe('Against the north wall, 50 cm from the window');
  });
});
