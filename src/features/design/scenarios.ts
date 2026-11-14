// Reference rooms for the layout solver: a home office, a bedroom, a kid's room, a studio, offices,
// a reception, cafes, a narrow room, a bay window and an L-shaped room. Used by the scenario tests
// and the plan renders that show what the solver produces.
import type { FurnitureItem, ObjectSpec, Requirements, SpaceModel, Vec2 } from '../../core/types';
import { makeItem } from '../furniture/catalog';
import { opening, rect, reqs, room } from '../referee/fixtures';

export interface Scenario {
  key: string;
  title: string;
  model: SpaceModel;
  ids: Array<[string, number]>;
  req: Requirements;
  /** Extra items that are not in the catalogue (generated objects). */
  extra?: () => FurnitureItem[];
  /** Lowest acceptable design score for the best variant. */
  minScore: number;
}

const brief = (ids: Array<[string, number]>, patch: Partial<Requirements> = {}): Requirements =>
  reqs({ items: ids.map(([catalogId, qty]) => ({ catalogId, qty })), routeTargets: [{ kind: 'window' }], minRouteWidthM: 0.8, ...patch });

/** A canopy bed described by a child, as the object generator would return it. */
export function princessBed(): FurnitureItem {
  const spec: ObjectSpec = {
    id: 'spec-princess', name: 'Princess canopy bed', prompt: 'a princess bed with a pink canopy',
    size: { w: 1.05, d: 2.1, h: 1.9 }, parts: [], model: 'rules', latencyMs: 0, createdAt: 0,
    semantics: {
      category: 'princess bed', role: 'sleeping', wallBacked: true, frontClearanceM: 0.6, sideClearanceM: 0.6,
      pairsWith: ['nightstand', 'rug', 'toy-storage'], faces: 'room', tall: true, description: 'A single bed with a canopy frame.',
    },
  };
  return {
    id: 'princess-bed', catalogId: 'generated', name: 'Princess canopy bed', category: 'princess bed', x: 1, y: 1, rotation: 0,
    w: 1.05, d: 2.1, h: 1.9, clearance: { front: 0.6, back: 0, left: 0.6, right: 0 }, locked: false, owned: false,
    priceSek: 0, priceStatus: 'estimated', color: '#e8b4c8', sourceKind: 'generated', custom: spec,
  };
}

/** A wall bed that folds down 2.1 m into the room: closed it is a 45 cm deep cabinet. */
export function foldBed(): FurnitureItem {
  const spec: ObjectSpec = {
    id: 'spec-fold', name: 'Fold-down wall bed', prompt: 'a wall bed that folds down',
    size: { w: 1.5, d: 0.45, h: 2.1 }, openSize: { w: 1.5, d: 2.15, h: 2.1 }, parts: [], model: 'rules', latencyMs: 0, createdAt: 0,
    motions: [{ group: 'bed', label: 'Fold down', kind: 'hinge', pivot: [0, 0.2, 0.2], axis: [1, 0, 0], open: Math.PI / 2 }],
    semantics: {
      category: 'wall bed', role: 'sleeping', wallBacked: true, frontClearanceM: 0.6, sideClearanceM: 0,
      pairsWith: [], faces: 'room', tall: true, description: 'A bed that folds up into a wall cabinet.',
    },
  };
  return {
    id: 'fold-bed', catalogId: 'generated', name: 'Fold-down wall bed', category: 'wall bed', x: 1, y: 1, rotation: 0,
    w: 1.5, d: 0.45, h: 2.1, clearance: { front: 0.6, back: 0, left: 0, right: 0 }, locked: false, owned: false,
    priceSek: 0, priceStatus: 'estimated', color: '#d9cbb5', sourceKind: 'generated', custom: spec,
  };
}

const bay: Vec2[] = [{ x: 0, y: 0 }, { x: 1.5, y: 0 }, { x: 1.9, y: -0.6 }, { x: 3.1, y: -0.6 }, { x: 3.5, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4.5 }, { x: 0, y: 4.5 }];
const ell: Vec2[] = [{ x: 0, y: 0 }, { x: 7, y: 0 }, { x: 7, y: 3.6 }, { x: 4, y: 3.6 }, { x: 4, y: 6.5 }, { x: 0, y: 6.5 }];

export const SCENARIOS: Scenario[] = [
  {
    key: 'a-office', title: 'Home office for two, 3.6 x 4.2 m', minScore: 70,
    model: room(rect(3.6, 4.2), [opening('door', 'door', 2, 2.8, 0.8, 'in'), opening('win', 'window', 0, 1.8, 1.4)]),
    ids: [['desk-140', 1], ['desk-120', 1], ['office-chair', 2], ['bookshelf', 1], ['plant', 1]], req: null!,
  },
  {
    key: 'b-bedroom', title: 'Bedroom, 3.4 x 4.2 m', minScore: 70,
    model: room(rect(3.4, 4.2), [opening('door', 'door', 2, 2.8, 0.8, 'in'), opening('win', 'window', 0, 1.7, 1.4)]),
    ids: [['bed-double', 1], ['nightstand', 2], ['wardrobe-100', 1], ['desk-120', 1], ['desk-chair', 1]], req: null!,
  },
  {
    key: 'c-living', title: 'Living room, 4.5 x 5.5 m', minScore: 75,
    model: room(rect(4.5, 5.5), [opening('door', 'door', 2, 3.8, 0.9, 'in'), opening('win', 'window', 1, 2.75, 1.8)]),
    ids: [['sofa-3', 1], ['armchair', 1], ['coffee-table', 1], ['tv-unit', 1], ['rug-200', 1], ['bookshelf', 1]], req: null!,
  },
  {
    key: 'd-cafe', title: 'Cafe, 6 x 5 m', minScore: 70,
    model: room(rect(6, 5), [opening('door', 'door', 2, 1.0, 1.0, 'in'), opening('win1', 'window', 0, 2.0, 1.6), opening('win2', 'window', 0, 4.5, 1.6)]),
    ids: [['cafe-4', 4], ['chair', 12], ['counter', 1]], req: null!,
  },
  {
    key: 'f-kids', title: "Kid's dream room, 3.2 x 3.8 m", minScore: 65,
    model: room(rect(3.2, 3.8), [opening('door', 'door', 2, 2.6, 0.8, 'in'), opening('win', 'window', 0, 1.6, 1.2)]),
    ids: [['desk-120', 1], ['desk-chair', 1], ['toy-storage', 1], ['rug-160', 1], ['bookshelf-low', 1]], req: null!, extra: () => [princessBed()],
  },
  {
    key: 'g-studio', title: 'Studio flat, 5 x 6 m', minScore: 65,
    model: room(rect(5, 6), [opening('door', 'door', 2, 4.2, 0.9, 'in'), opening('win1', 'window', 0, 1.4, 1.4), opening('win2', 'window', 0, 3.6, 1.4)]),
    ids: [['bed-double', 1], ['nightstand', 2], ['sofa-2', 1], ['coffee-table', 1], ['dining-4', 1], ['chair', 2], ['desk-120', 1], ['desk-chair', 1], ['wardrobe-150', 1]], req: null!,
  },
  {
    key: 'h-meeting', title: 'Meeting room for 8, 4.6 x 6 m', minScore: 70,
    model: room(rect(4.6, 6), [opening('door', 'door', 2, 3.9, 0.9, 'in'), opening('win', 'window', 1, 3.0, 2.4)]),
    ids: [['dining-6', 1], ['chair', 8], ['tv-unit', 1], ['sideboard', 1], ['plant', 1]], req: null!,
  },
  {
    key: 'i-openoffice', title: 'Open office for 12 with a phone booth, 12 x 8 m', minScore: 65,
    model: room(rect(12, 8), [opening('door', 'door', 2, 10.8, 1.0, 'in'), opening('win1', 'window', 0, 3, 2.4), opening('win2', 'window', 0, 9, 2.4), opening('win3', 'window', 3, 4, 2.0)]),
    ids: [['desk-140', 12], ['office-chair', 12], ['office-pod', 1], ['storage-cabinet', 2], ['plant', 2]], req: null!,
  },
  {
    key: 'j-reception', title: 'Reception with seating, 6 x 5 m', minScore: 65,
    model: room(rect(6, 5), [opening('door', 'door', 2, 3.0, 1.0, 'in'), opening('door2', 'door', 0, 5.2, 0.9, 'in'), opening('win', 'window', 1, 2.5, 2.0)]),
    ids: [['reception-desk', 1], ['office-chair', 1], ['sofa-2', 1], ['armchair', 2], ['coffee-table', 1], ['plant', 2], ['display-shelf', 1]], req: null!,
  },
  {
    key: 'k-cafe30', title: 'Cafe with 30 seats, 10 x 8 m', minScore: 60,
    model: room(rect(10, 8), [opening('door', 'door', 2, 8.6, 1.2, 'in'), opening('win1', 'window', 0, 2.5, 2.4), opening('win2', 'window', 0, 7.0, 2.4), opening('win3', 'window', 3, 4, 2.4)]),
    ids: [['cafe-4', 6], ['cafe-2', 3], ['chair', 30], ['counter', 1], ['display-shelf', 1]], req: null!,
  },
  {
    key: 'l-narrow', title: 'Narrow room, 2.2 x 5 m', minScore: 60,
    model: room(rect(2.2, 5), [opening('door', 'door', 2, 1.6, 0.8, 'in'), opening('win', 'window', 0, 1.1, 1.2)]),
    ids: [['bed-single', 1], ['desk-120', 1], ['desk-chair', 1], ['bookshelf-low', 1]], req: null!,
  },
  {
    key: 'm-bay', title: 'Living room with two doors and a bay window, 5 x 4.5 m', minScore: 65,
    model: room(bay, [opening('door', 'door', 6, 4.2, 0.9, 'in'), opening('door2', 'door', 5, 3.7, 0.9, 'in'), opening('w1', 'window', 1, 0.36, 0.5), opening('w2', 'window', 2, 0.6, 1.0), opening('w3', 'window', 3, 0.36, 0.5)]),
    ids: [['sofa-3', 1], ['armchair', 2], ['coffee-table', 1], ['tv-unit', 1], ['rug-200', 1], ['bookshelf', 1], ['floor-lamp', 1]], req: null!,
  },
  {
    key: 'n-lshape', title: 'L-shaped living and dining room', minScore: 60,
    model: room(ell, [opening('door', 'door', 4, 3.2, 0.9, 'in'), opening('w1', 'window', 0, 1.8, 1.6), opening('w2', 'window', 0, 5.4, 1.6), opening('w3', 'window', 5, 3.2, 1.4)]),
    ids: [['sofa-3', 1], ['coffee-table', 1], ['tv-unit', 1], ['rug-200', 1], ['armchair', 1], ['dining-4', 1], ['chair', 4], ['sideboard', 1], ['plant', 1]], req: null!,
  },
];
for (const s of SCENARIOS) s.req = brief(s.ids);
// In a bedroom the way to the window is a secondary path (60 cm); the door-to-bed paths are scored by the rules.
for (const k of ['b-bedroom', 'f-kids', 'l-narrow']) SCENARIOS.find((s) => s.key === k)!.req.minRouteWidthM = 0.6;

let n = 0;
/** Fresh furniture for a scenario, ids unique across calls. */
export function scenarioItems(s: Scenario): FurnitureItem[] {
  const its = s.ids.flatMap(([id, q]) => Array.from({ length: q }, () => ({ ...makeItem(id), id: `${id}-${++n}` })));
  return [...its, ...(s.extra?.() ?? [])];
}
