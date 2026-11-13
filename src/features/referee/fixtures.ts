import type { FurnitureItem, Opening, Requirements, SpaceModel, Vec2 } from '../../core/types';

export function room(polygon: Vec2[], openings: Opening[] = [], ceilingM = 2.5): SpaceModel {
  return {
    id: 'fx', name: 'Fixture', version: 1, units: 'm', ceilingM, sourceLabel: 'Fixture',
    spaces: [{ id: 's1', name: 'Room', polygon, walls: polygon.map(() => ({ thicknessM: 0.1, sourceKind: 'manual', status: 'verified' })) }],
    openings, furniture: [], measurements: [], evidence: [],
  };
}

export const rect = (w: number, h: number): Vec2[] => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
/** 4 x 4 L with the 2 x 2 notch cut from the top-right. */
export const lShape: Vec2[] = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
export const trapezoid: Vec2[] = [{ x: 1, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }];
export const bowtie: Vec2[] = [{ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 2, y: 0 }, { x: 0, y: 2 }];

export function opening(id: string, kind: Opening['kind'], wallIndex: number, offsetM: number, widthM: number, swing: Opening['swing'] = 'none'): Opening {
  return { id, kind, spaceId: 's1', wallIndex, offsetM, widthM, heightM: kind === 'window' ? 1.2 : 2.05, sillM: kind === 'window' ? 0.9 : 0, swing, hinge: 'start', sourceKind: 'manual', status: 'verified' };
}

export function item(id: string, x: number, y: number, w: number, d: number, patch: Partial<FurnitureItem> = {}): FurnitureItem {
  return {
    id, catalogId: id, name: id, category: 'misc', x, y, rotation: 0, w, d, h: 0.8,
    clearance: { front: 0, back: 0, left: 0, right: 0 }, locked: false, owned: false, priceSek: 0, priceStatus: 'catalog',
    color: '#888', sourceKind: 'manual', ...patch,
  };
}

export function reqs(patch: Partial<Requirements> = {}): Requirements {
  return { purpose: 'test', people: 1, budgetSek: null, items: [], routeTargets: [], minRouteWidthM: 0.8, style: '', lockedIds: [], notes: [], questions: [], compiledBy: 'rules', ...patch };
}

/** Deterministic PRNG for seeded tests. */
export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
