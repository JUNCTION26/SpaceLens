import { describe, expect, it } from 'vitest';
import { planToSvg, uncertainWalls } from './svg';
import { quantities } from './quantities';
import { scheduleCsv } from './csv';
import { validateModel } from './validate';
import { wallPieces } from './glb';
import type { SpaceModel, FurnitureItem } from '../../core/types';

const wall = (status: 'verified' | 'estimated' = 'verified') => ({ thicknessM: 0.1, sourceKind: 'manual' as const, status });
const model: SpaceModel = {
  id: 'm', name: 'Test flat', version: 7, units: 'm', ceilingM: 2.5, sourceLabel: 'Sample',
  spaces: [{ id: 's', name: 'Living', polygon: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }], walls: [wall(), wall('estimated'), wall(), wall()] }],
  openings: [
    { id: 'd', kind: 'door', spaceId: 's', wallIndex: 2, offsetM: 1, widthM: 0.9, heightM: 2, sillM: 0, swing: 'in', hinge: 'start', sourceKind: 'manual', status: 'verified' },
    { id: 'w', kind: 'window', spaceId: 's', wallIndex: 0, offsetM: 2, widthM: 1, heightM: 1, sillM: 0.9, swing: 'none', hinge: 'start', sourceKind: 'manual', status: 'verified' },
  ],
  furniture: [], measurements: [], evidence: [],
};
const sofa = { id: 'f', name: 'Sofa, "big"', category: 'seating', x: 2, y: 1, rotation: Math.PI / 2, w: 2, d: 0.9, h: 0.8, owned: false, priceSek: 5000, priceStatus: 'estimated', color: '#888' } as FurnitureItem;

describe('export', () => {
  it('svg has title block, version and dimensions', () => {
    const s = planToSvg(model, [sofa], new Date('2026-01-02'));
    expect(s).toContain('Version 7');
    expect(s).toContain('Dimensions in cm');
    expect(s).toContain('>400<');
    expect(s).toContain('300?');
    expect(s).toContain('12.0 m²');
    expect(s).toContain('Sofa, &quot;big&quot;');
    expect(uncertainWalls(model)).toEqual(['Living wall 2 (estimated)']);
  });
  it('quantities', () => {
    const q = quantities(model);
    expect(q.floorM2).toBeCloseTo(12);
    expect(q.wallNetM2).toBeCloseTo(14 * 2.5 - 1.8 - 1);
    expect(q.skirtingM).toBeCloseTo(13.1);
    expect(q.paintL).toBeCloseTo((32.2 * 2) / 10);
  });
  it('csv', () => {
    const c = scheduleCsv([sofa, { ...sofa, owned: true }]).split('\n');
    expect(c[1]).toBe('"Sofa, ""big""",seating,200,90,80,2.00,1.00,90,no,5000,estimated');
    expect(c[3]).toContain('Total');
    expect(c[3]).toContain('5000');
  });
  it('validate', () => {
    expect(validateModel(JSON.parse(JSON.stringify(model))).version).toBe(7);
    expect(() => validateModel({ ...model, units: 'ft' })).toThrow(/metres/);
    expect(() => validateModel({ ...model, spaces: [{ polygon: [{ x: 0, y: 0 }] }] })).toThrow(/3 corners/);
    expect(() => validateModel(null)).toThrow();
  });
  it('wall pieces split around openings', () => {
    const p = wallPieces(4, 2.5, [{ offsetM: 2, widthM: 1, sillM: 0.9, heightM: 1 }]);
    expect(p).toEqual([[0, 1.5, 0, 2.5], [1.5, 2.5, 0, 0.9], [1.5, 2.5, 1.9, 2.5], [2.5, 4, 0, 2.5]]);
  });
});
