import type { SpaceModel } from './types';

/** A 3.4 m x 4.2 m sample room with one door and one window. Marked as sample data everywhere. */
export function sampleRoom(): SpaceModel {
  const now = Date.now();
  return {
    id: 'sample',
    name: 'Sample room',
    version: 1,
    units: 'm',
    ceilingM: 2.5,
    sourceLabel: 'Sample',
    spaces: [
      {
        id: 's1',
        name: 'Room',
        purpose: 'bedroom',
        polygon: [
          { x: 0, y: 0 },
          { x: 3.4, y: 0 },
          { x: 3.4, y: 4.2 },
          { x: 0, y: 4.2 },
        ],
        walls: [
          { thicknessM: 0.12, sourceKind: 'sample', status: 'verified', measurementId: 'm_w0' },
          { thicknessM: 0.12, sourceKind: 'sample', status: 'verified', measurementId: 'm_w1' },
          { thicknessM: 0.12, sourceKind: 'sample', status: 'estimated' },
          { thicknessM: 0.12, sourceKind: 'sample', status: 'estimated' },
        ],
      },
    ],
    openings: [
      { id: 'door1', kind: 'door', spaceId: 's1', wallIndex: 2, offsetM: 2.8, widthM: 0.8, heightM: 2.05, sillM: 0, swing: 'in', hinge: 'start', sourceKind: 'sample', status: 'verified', measurementId: 'm_door' },
      { id: 'win1', kind: 'window', spaceId: 's1', wallIndex: 0, offsetM: 1.7, widthM: 1.4, heightM: 1.3, sillM: 0.85, swing: 'none', hinge: 'start', sourceKind: 'sample', status: 'estimated' },
    ],
    furniture: [
      {
        id: 'f_desk', catalogId: 'desk-140', name: 'Desk', category: 'desk', x: 0.4, y: 1.4, rotation: -Math.PI / 2,
        w: 1.4, d: 0.7, h: 0.74, clearance: { front: 0.9, back: 0, left: 0, right: 0 }, locked: false, owned: true,
        priceSek: 0, priceStatus: 'owned', color: '#b08a5a', material: 'oak', sourceKind: 'sample',
      },
    ],
    measurements: [
      { id: 'm_w0', label: 'North wall', valueM: 3.4, sourceKind: 'sample', status: 'verified', evidenceIds: ['ev_sample'], targetId: 's1:0', toleranceM: 0.01 },
      { id: 'm_w1', label: 'East wall', valueM: 4.2, sourceKind: 'sample', status: 'verified', evidenceIds: ['ev_sample'], targetId: 's1:1', toleranceM: 0.01 },
      { id: 'm_door', label: 'Door width', valueM: 0.8, sourceKind: 'sample', status: 'verified', evidenceIds: ['ev_sample'], targetId: 'door1', toleranceM: 0.005 },
    ],
    evidence: [
      { id: 'ev_sample', kind: 'sample', label: 'Sample data, not a real measurement', createdAt: now },
    ],
  };
}

export function emptyModel(name = 'New space'): SpaceModel {
  return { ...sampleRoom(), id: `m_${Date.now().toString(36)}`, name, sourceLabel: 'Manual', furniture: [], measurements: [], evidence: [] };
}
