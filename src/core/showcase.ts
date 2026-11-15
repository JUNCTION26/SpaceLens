import type { FurnitureItem, SpaceModel } from './types';

// The pieces are frozen from the catalogue (light oak, warm white and a sage accent), so core stays free of feature code.
// Room is 4.5 m wide (x) by 3.8 m deep (y). North wall: window above the desk. East wall: door. Long south wall: the sofa.
const FURNITURE: FurnitureItem[] = [
  {
    "id": "f_rug",
    "catalogId": "rug-200",
    "name": "Rug",
    "category": "rug",
    "x": 2,
    "y": 2.35,
    "rotation": 1.5707963267948966,
    "w": 2,
    "d": 3,
    "h": 0.01,
    "clearance": {
      "front": 0,
      "back": 0,
      "left": 0,
      "right": 0
    },
    "locked": false,
    "owned": false,
    "priceSek": 2490,
    "priceStatus": "estimated",
    "color": "#f1ece2",
    "material": "wool",
    "sourceKind": "manual"
  },
  {
    "id": "f_sofa",
    "catalogId": "sofa-3",
    "name": "Sofa",
    "category": "sofa",
    "x": 2,
    "y": 3.34,
    "rotation": 3.141592653589793,
    "w": 2.1,
    "d": 0.92,
    "h": 0.82,
    "clearance": {
      "front": 0.45,
      "back": 0,
      "left": 0,
      "right": 0
    },
    "locked": false,
    "owned": false,
    "priceSek": 7990,
    "priceStatus": "estimated",
    "color": "#9aab8d",
    "material": "linen",
    "sourceKind": "manual"
  },
  {
    "id": "f_coffee",
    "catalogId": "coffee-table",
    "name": "Coffee table",
    "category": "coffee-table",
    "x": 2,
    "y": 2.05,
    "rotation": 0,
    "w": 1.1,
    "d": 0.6,
    "h": 0.45,
    "clearance": {
      "front": 0.3,
      "back": 0.3,
      "left": 0,
      "right": 0
    },
    "locked": false,
    "owned": false,
    "priceSek": 1290,
    "priceStatus": "estimated",
    "color": "#d2b48a",
    "material": "light oak",
    "sourceKind": "manual"
  },
  {
    "id": "f_arm",
    "catalogId": "armchair-wing",
    "name": "Armchair",
    "category": "armchair",
    "x": 3.65,
    "y": 1.95,
    "rotation": 1,
    "w": 0.82,
    "d": 0.85,
    "h": 1.05,
    "clearance": {
      "front": 0.4,
      "back": 0,
      "left": 0,
      "right": 0
    },
    "locked": false,
    "owned": false,
    "priceSek": 4490,
    "priceStatus": "estimated",
    "color": "#7d9272",
    "material": "velvet",
    "sourceKind": "manual"
  },
  {
    "id": "f_lamp",
    "catalogId": "floor-lamp",
    "name": "Floor lamp",
    "category": "lamp",
    "x": 3.3,
    "y": 3.55,
    "rotation": 0,
    "w": 0.35,
    "d": 0.35,
    "h": 1.6,
    "clearance": {
      "front": 0,
      "back": 0,
      "left": 0,
      "right": 0
    },
    "locked": false,
    "owned": false,
    "priceSek": 690,
    "priceStatus": "estimated",
    "color": "#f1ece2",
    "material": "steel and linen",
    "sourceKind": "manual"
  },
  {
    "id": "f_shelf",
    "catalogId": "bookshelf",
    "name": "Bookshelf",
    "category": "bookshelf",
    "x": 0.14,
    "y": 2.75,
    "rotation": -1.5707963267948966,
    "w": 0.8,
    "d": 0.28,
    "h": 2,
    "clearance": {
      "front": 0.6,
      "back": 0,
      "left": 0,
      "right": 0
    },
    "locked": false,
    "owned": false,
    "priceSek": 1290,
    "priceStatus": "estimated",
    "color": "#f1ece2",
    "material": "white laminate",
    "sourceKind": "manual"
  },
  {
    "id": "f_desk",
    "catalogId": "desk-140",
    "name": "Desk",
    "category": "desk",
    "x": 1.4,
    "y": 0.35,
    "rotation": 0,
    "w": 1.4,
    "d": 0.7,
    "h": 0.74,
    "clearance": {
      "front": 0.75,
      "back": 0,
      "left": 0,
      "right": 0
    },
    "locked": false,
    "owned": false,
    "priceSek": 2490,
    "priceStatus": "estimated",
    "color": "#d2b48a",
    "material": "light oak",
    "sourceKind": "manual"
  },
  {
    "id": "f_chair",
    "catalogId": "desk-chair",
    "name": "Desk chair",
    "category": "chair",
    "x": 1.4,
    "y": 1,
    "rotation": 3.141592653589793,
    "w": 0.5,
    "d": 0.5,
    "h": 0.85,
    "clearance": {
      "front": 0.75,
      "back": 0,
      "left": 0,
      "right": 0
    },
    "locked": false,
    "owned": false,
    "priceSek": 990,
    "priceStatus": "estimated",
    "color": "#f1ece2",
    "material": "plastic",
    "sourceKind": "manual"
  },
  {
    "id": "f_plant",
    "catalogId": "plant",
    "name": "Plant",
    "category": "plant",
    "x": 0.3,
    "y": 0.3,
    "rotation": 0,
    "w": 0.45,
    "d": 0.45,
    "h": 1.3,
    "clearance": {
      "front": 0,
      "back": 0,
      "left": 0,
      "right": 0
    },
    "locked": false,
    "owned": false,
    "priceSek": 390,
    "priceStatus": "estimated",
    "color": "#5f8a55",
    "material": "ceramic pot",
    "sourceKind": "manual"
  }
] as FurnitureItem[];

/** The room people see first: a furnished living-and-work studio, hand-placed to pass every layout check. */
export function showcaseRoom(): SpaceModel {
  const now = Date.now();
  const W = 4.5, D = 3.8;
  const furniture: FurnitureItem[] = FURNITURE.map((f) => ({ ...f, clearance: { ...f.clearance } }));
  const wall = (status: 'verified' | 'estimated' = 'estimated') => ({ thicknessM: 0.12, sourceKind: 'manual' as const, status });
  return {
    id: 'home-studio',
    name: 'My room',
    version: 1,
    units: 'm',
    ceilingM: 2.5,
    sourceLabel: 'Manual',
    spaces: [{
      id: 's1', name: 'Studio', purpose: 'living room',
      polygon: [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: D }, { x: 0, y: D }],
      walls: [wall(), wall(), wall(), wall()],
    }],
    openings: [
      { id: 'door1', kind: 'door', spaceId: 's1', wallIndex: 1, offsetM: 0.75, widthM: 0.8, heightM: 2.05, sillM: 0, swing: 'in', hinge: 'start', sourceKind: 'manual', status: 'estimated' },
      { id: 'win1', kind: 'window', spaceId: 's1', wallIndex: 0, offsetM: 1.4, widthM: 1.4, heightM: 1.3, sillM: 0.85, swing: 'none', hinge: 'start', sourceKind: 'manual', status: 'estimated' },
    ],
    furniture,
    measurements: [],
    evidence: [{ id: 'ev_manual', kind: 'manual', label: 'Typed in by hand', createdAt: now }],
  };
}
