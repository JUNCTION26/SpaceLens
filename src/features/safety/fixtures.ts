// Small hand-built models used by the safety tests.
import type { FurnitureItem, Opening, Space, SpaceModel, Vec2 } from '../../core/types';

const wall = { thicknessM: 0.1, sourceKind: 'manual' as const, status: 'verified' as const };
export const rect = (x: number, y: number, w: number, h: number): Vec2[] => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

export function space(id: string, name: string, polygon: Vec2[]): Space { return { id, name, polygon, walls: polygon.map(() => wall) }; }

export function door(id: string, spaceId: string, wallIndex: number, offsetM: number, widthM = 0.9, swing: Opening['swing'] = 'out', kind: Opening['kind'] = 'door'): Opening {
  return { id, kind, spaceId, wallIndex, offsetM, widthM, heightM: 2.1, sillM: 0, swing, hinge: 'start', sourceKind: 'manual', status: 'verified' };
}

export function model(spaces: Space[], openings: Opening[], furniture: FurnitureItem[] = []): SpaceModel {
  return { id: 'fx', name: 'Fixture', version: 1, units: 'm', ceilingM: 2.5, sourceLabel: 'Fixture', spaces, openings, furniture, measurements: [], evidence: [] };
}

export function item(id: string, category: string, x: number, y: number, w: number, d: number, patch: Partial<FurnitureItem> = {}): FurnitureItem {
  return {
    id, catalogId: id, name: patch.name ?? id, category, x, y, rotation: 0, w, d, h: 0.8,
    clearance: { front: 0, back: 0, left: 0, right: 0 }, locked: false, owned: false, priceSek: 0, priceStatus: 'catalog',
    color: '#888', sourceKind: 'manual', ...patch,
  };
}

/** 5 x 4 m room, exit on the left; a wardrobe and a shelf form a divider leaving a 70 cm gap at the bottom. */
export function shelfRoom(): SpaceModel {
  const f = [
    item('wardrobe', 'wardrobe', 2.5, 1.0, 0.6, 1.98, { name: 'Wardrobe', locked: true, h: 2 }),
    item('shelf', 'bookshelf', 2.5, 2.8, 0.4, 1.0, { name: 'Shelf', h: 2 }),
  ];
  return model([space('r', 'Studio', rect(0, 0, 5, 4))], [door('exit', 'r', 3, 2, 0.9, 'out')], f);
}

/** 12 x 6 m office, one door; two desk banks run to the far wall leaving a 1 m aisle closed at the end. */
export function deadEndOffice(): SpaceModel {
  const f: FurnitureItem[] = [];
  for (let k = 0; k < 6; k++) {
    const x = 3.75 + k * 1.5;
    f.push(item(`a${k}`, 'desk', x, 1.6, 1.5, 0.8, { name: `Desk A${k + 1}`, rotation: Math.PI }), item(`b${k}`, 'desk', x, 2.4, 1.5, 0.8, { name: `Desk B${k + 1}` }));
    f.push(item(`c${k}`, 'desk', x, 4.2, 1.5, 0.8, { name: `Desk C${k + 1}`, rotation: Math.PI }), item(`d${k}`, 'desk', x, 5.0, 1.5, 0.8, { name: `Desk D${k + 1}` }));
  }
  // wall index 3 runs from (0,6) up to (0,0); offset 5 puts the door at y = 1
  return model([space('o', 'Office', rect(0, 0, 12, 6))], [door('exit', 'o', 3, 5, 0.9, 'out')], f);
}

/** Living room 5 x 4 with the front door, bedroom 3 x 4 reached only through the living room. */
export function twoRoomFlat(): SpaceModel {
  return model(
    [space('liv', 'Living room', rect(0, 0, 5, 4)), space('bed', 'Bedroom', rect(5, 0, 3, 4))],
    [door('front', 'liv', 3, 2, 0.9, 'out'), door('inner', 'liv', 1, 3, 0.8, 'in')],
    [item('bed1', 'bed', 6.8, 1.0, 1.4, 2.0, { name: 'Double bed' }), item('sofa', 'sofa', 2.5, 0.5, 2.1, 0.9, { name: 'Sofa' })],
  );
}

/** 10 x 6 m cafe: 15 two-top tables with 30 chairs and a single door. */
export function cafe(): SpaceModel {
  const f: FurnitureItem[] = [];
  let n = 0;
  for (const x of [2.5, 4.2, 5.9, 7.6, 9.3]) for (const y of [1.0, 3.0, 5.0]) {
    n++;
    f.push(item(`t${n}`, 'cafe-table', x, y, 0.6, 0.6, { name: `Table ${n}` }));
    f.push(item(`c${n}a`, 'chair', x, y - 0.6, 0.45, 0.5, { name: `Chair ${n}a` }), item(`c${n}b`, 'chair', x, y + 0.6, 0.45, 0.5, { name: `Chair ${n}b`, rotation: Math.PI }));
  }
  return model([space('c', 'Cafe', rect(0, 0, 10, 6))], [door('exit', 'c', 3, 3, 0.9, 'out')], f);
}
