import { describe, expect, it } from 'vitest';
import type { FurnitureItem, Opening, SpaceModel } from '../../core/types';
import { runRoutes } from './routes';
import { testPassage } from './passage';
import { castSightlines } from './sightlines';
import { runCrowd } from './crowd';

const wall = { thicknessM: 0.1, sourceKind: 'manual' as const, status: 'verified' as const };
const op = (id: string, kind: Opening['kind'], wallIndex: number, widthM: number): Opening => ({
  id, kind, spaceId: 's', wallIndex, offsetM: 2, widthM, heightM: 2.1, sillM: kind === 'window' ? 0.9 : 0,
  swing: 'none', hinge: 'start', sourceKind: 'manual', status: 'verified',
});
const room = (doorW = 0.8): SpaceModel => ({
  id: 'm', name: 't', version: 1, units: 'm', ceilingM: 2.5, sourceLabel: '',
  spaces: [{ id: 's', name: 'r', polygon: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }], walls: [wall, wall, wall, wall] }],
  openings: [op('d', 'door', 3, doorW), op('w', 'window', 1, 1.2)], furniture: [], measurements: [], evidence: [],
});
const item = (id: string, x: number, y: number, w: number, d: number, h = 2, category = 'storage'): FurnitureItem => ({
  id, catalogId: id, name: id, category, x, y, rotation: 0, w, d, h, clearance: { front: 0, back: 0, left: 0, right: 0 },
  locked: false, owned: false, priceSek: 0, priceStatus: 'estimated', color: '#888', sourceKind: 'manual',
});

describe('routes', () => {
  it('open 4x4 room: door to window is clear', () => {
    const r = runRoutes(room(), [], 'adult').routes.find((x) => x.id.startsWith('d>w'))!;
    expect(r.ok).toBe(true);
    expect(r.lengthM!).toBeGreaterThan(3); expect(r.lengthM!).toBeLessThan(4);
    expect(r.narrowestM!).toBeGreaterThan(0.6);
  });
  it('wall-to-wall shelf blocks the route and reports the choke', () => {
    const r = runRoutes(room(), [item('shelf', 2, 2, 0.4, 4)], 'adult').routes.find((x) => x.id.startsWith('d>w'))!;
    expect(r.ok).toBe(false);
    expect(r.points.length).toBeGreaterThan(0);
    expect(r.narrowestAt).toBeDefined();
  });
  it('wheelchair finds a turning circle in an empty room', () => {
    expect(runRoutes(room(), [], 'wheelchair').turn?.ok).toBe(true);
  });
});

describe('passage', () => {
  it('2.2 x 0.95 sofa fails a 0.80 m door', () => {
    const r = testPassage(room(0.8), [], { id: 'sofa', name: 'Sofa', w: 2.2, d: 0.95, h: 0.85 }, 'd');
    expect(r.ok).toBe(false);
    expect(r.details).toMatch(/Too wide/);
  });
  it('1.8 x 0.6 bookshelf passes a 0.90 m door', () => {
    const r = testPassage(room(0.9), [], { id: 'bs', name: 'Shelf', w: 1.8, d: 0.6, h: 2 }, 'd');
    expect(r.ok).toBe(true);
    expect(r.poses.length).toBeGreaterThan(1);
    expect(r.poses.length).toBeLessThanOrEqual(61);
  });
});

describe('sightlines and crowd', () => {
  it('tall item hides the window', () => {
    const open = castSightlines(room(), [], { x: 1, y: 2 });
    expect(open.find((s) => s.b.x === 4)?.visible).toBe(true);
    const hid = castSightlines(room(), [item('tall', 2.5, 2, 0.3, 1, 2)], { x: 1, y: 2 });
    expect(hid.find((s) => s.b.x === 4)?.visible).toBe(false);
    expect(hid.length).toBe(74);
  });
  it('crowd is deterministic per seed', () => {
    const f = [item('t1', 3, 1, 0.8, 0.8, 0.75, 'table'), item('t2', 3, 3, 0.8, 0.8, 0.75, 'table')];
    const a = runCrowd(room(), f, 10, 7)!, b = runCrowd(room(), f, 10, 7)!;
    expect(a.stats.meanPathM).toBeCloseTo(b.stats.meanPathM);
    expect(a.stats.paths).toBe(20);
    expect(Math.max(...a.heat.values)).toBe(1);
  });
});
