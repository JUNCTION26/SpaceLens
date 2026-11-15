import { describe, expect, it } from 'vitest';
import type { FurnitureItem, Opening, SpaceModel } from '../../core/types';
import { planMoveIn } from './plan';

const wall = { thicknessM: 0.1, sourceKind: 'manual' as const, status: 'verified' as const };
const door = (widthM: number): Opening => ({
  id: 'd', kind: 'door', spaceId: 's', wallIndex: 3, offsetM: 2, widthM, heightM: 2.1, sillM: 0,
  swing: 'none', hinge: 'start', sourceKind: 'manual', status: 'verified',
});
const room = (doorW: number): SpaceModel => ({
  id: 'm', name: 't', version: 1, units: 'm', ceilingM: 2.5, sourceLabel: '',
  spaces: [{ id: 's', name: 'Room', polygon: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }], walls: [wall, wall, wall, wall] }],
  openings: [door(doorW)], furniture: [], measurements: [], evidence: [],
});
const item = (id: string, x: number, y: number, w: number, d: number, h: number): FurnitureItem => ({
  id, catalogId: id, name: id, category: 'storage', x, y, rotation: 0, w, d, h, clearance: { front: 0, back: 0, left: 0, right: 0 },
  locked: false, owned: false, priceSek: 0, priceStatus: 'estimated', color: '#888', sourceKind: 'manual',
});

describe('move-in', () => {
  it('a 2.2 m sofa fails a 0.8 m door and the entrance is named', () => {
    const p = planMoveIn(room(0.8), [item('sofa', 2, 2, 2.2, 0.95, 1.2)]);
    expect(p.items[0].verdict).toBe('assemble');
    expect(p.items[0].steps[0].ok).toBe(false);
    expect(p.items[0].tight).toBe('Entrance');
    expect(planMoveIn(room(0.4), [item('sofa', 2, 2, 2.2, 0.95, 1.2)]).items[0].verdict).toBe('wont');
  });
  it('a low sofa tilts through a 0.9 m door', () => {
    expect(planMoveIn(room(0.9), [item('sofa', 2, 2, 2.2, 0.95, 0.85)]).items[0].verdict).toBe('tilt');
  });
  it('a bookshelf passes', () => {
    expect(planMoveIn(room(0.9), [item('shelf', 2, 1, 1.8, 0.6, 2)]).items[0].verdict).toBe('fits');
  });
  it('flat-pack halves the carried size', () => {
    const f = item('sofa', 2, 2, 2.2, 0.95, 1.2);
    expect(planMoveIn(room(0.8), [f], { flat: new Set(['sofa']) }).items[0].verdict).toBe('fits');
    expect(planMoveIn(room(0.8), [f]).items[0].verdict).not.toBe('fits');
  });
  it('wardrobe goes in before the bed that would block it', () => {
    // the door is in the left wall at y = 2; the bed sits right behind it
    const bed = item('bed', 0.4, 2, 0.8, 1.8, 0.9);
    const wardrobe = item('wardrobe', 3, 1, 0.9, 0.4, 1.8);
    const p = planMoveIn(room(0.9), [bed, wardrobe]);
    expect(p.items.map((i) => i.id)).toEqual(['wardrobe', 'bed']);
  });
});
