import type { FurnitureItem, SpaceModel } from './types';
import { makeItem } from '../features/furniture/catalog';

/** Light oak, warm white and a sage accent: one palette across every piece. */
const OAK = '#d2b48a';
const WARM_WHITE = '#f1ece2';
const SAGE = '#9aab8d';
const SAGE_DEEP = '#7d9272';

interface Spec { id: string; cat: string; x: number; y: number; rot: number; color: string; material?: string; name?: string }

// Room is 4.5 m wide (x) by 3.8 m deep (y). Rotation 0 faces +y (south); PI faces north; PI/2 faces west.
// North wall: window above the desk. East wall: door near the north corner. Long south wall: the sofa.
const SPECS: Spec[] = [
  { id: 'f_rug', cat: 'rug-200', x: 2.0, y: 2.35, rot: Math.PI / 2, color: WARM_WHITE, material: 'wool', name: 'Rug' },
  { id: 'f_sofa', cat: 'sofa-3', x: 2.0, y: 3.8 - 0.46, rot: Math.PI, color: SAGE, material: 'linen', name: 'Sofa' },
  { id: 'f_coffee', cat: 'coffee-table', x: 2.0, y: 2.05, rot: 0, color: OAK, material: 'light oak', name: 'Coffee table' },
  { id: 'f_arm', cat: 'armchair-wing', x: 3.65, y: 1.95, rot: 1.0, color: SAGE_DEEP, material: 'velvet', name: 'Armchair' },
  { id: 'f_lamp', cat: 'floor-lamp', x: 3.3, y: 3.55, rot: 0, color: WARM_WHITE, name: 'Floor lamp' },
  { id: 'f_shelf', cat: 'bookshelf', x: 0.14, y: 2.75, rot: -Math.PI / 2, color: WARM_WHITE, name: 'Bookshelf' },
  { id: 'f_desk', cat: 'desk-140', x: 1.4, y: 0.35, rot: 0, color: OAK, material: 'light oak', name: 'Desk' },
  { id: 'f_chair', cat: 'desk-chair', x: 1.4, y: 1.0, rot: Math.PI, color: WARM_WHITE, name: 'Desk chair' },
  { id: 'f_plant', cat: 'plant', x: 0.3, y: 0.3, rot: 0, color: '#5f8a55', name: 'Plant' },
];

/** The room people see first: a furnished living-and-work studio, hand-placed to pass every layout check. */
export function showcaseRoom(): SpaceModel {
  const now = Date.now();
  const W = 4.5, D = 3.8;
  const furniture: FurnitureItem[] = SPECS.map((s) => {
    const it = makeItem(s.cat, { x: s.x, y: s.y, rotation: s.rot });
    return { ...it, id: s.id, name: s.name ?? it.name, color: s.color, material: s.material ?? it.material, sourceKind: 'manual' };
  });
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
