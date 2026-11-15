import { describe, expect, it } from 'vitest';
import type { SpaceModel } from '../../core/types';
import { planTour } from './tour';

const room: SpaceModel = {
  id: 'm', name: 'My room', version: 1, ceilingM: 2.5,
  spaces: [{ id: 's1', name: 'Room', polygon: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }], walls: [] }],
  openings: [], furniture: [], evidence: [], measurements: [],
} as unknown as SpaceModel;

describe('tour of a single room', () => {
  it('walks a loop and has two stops', () => {
    const t = planTour(room, undefined, { x: 0.5, y: 1.5 });
    expect(t.stops.length).toBeGreaterThanOrEqual(2);
    expect(t.points.length).toBeGreaterThan(3);
  });
});
