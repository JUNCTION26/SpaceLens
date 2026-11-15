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

describe('two rooms sharing a wall', () => {
  const sq = (x0: number) => [{ x: x0, y: 0 }, { x: x0 + 4, y: 0 }, { x: x0 + 4, y: 4 }, { x: x0, y: 4 }];
  const at = (id: string, spaceId: string, kind: Opening['kind'], wallIndex: number, offsetM: number, widthM = 0.9): Opening => ({
    id, kind, spaceId, wallIndex, offsetM, widthM, heightM: 2.05, sillM: kind === 'window' ? 0.9 : 0,
    swing: 'none', hinge: 'start', sourceKind: 'generated', status: 'estimated',
  });
  const half = { ...wall, thicknessM: 0.05 };
  const pair = (withDoor: boolean): SpaceModel => ({
    id: 'b', name: 'pair', version: 1, units: 'm', ceilingM: 2.6, sourceLabel: '',
    spaces: [
      { id: 'A', name: 'Hall', polygon: sq(0), walls: [wall, half, wall, wall] },
      { id: 'B', name: 'Kitchen', polygon: sq(4), walls: [wall, wall, wall, half] },
    ],
    openings: [
      at('in', 'A', 'door', 3, 2),
      ...(withDoor ? [at('d~A', 'A', 'door', 1, 1), at('d~B', 'B', 'door', 3, 3)] : []),
      at('w', 'B', 'window', 1, 2, 1.2),
    ],
    furniture: [], measurements: [], evidence: [],
  });

  it('finds the shared wall once with both door gaps', async () => {
    const { wallEdges, solidSegments, entranceSpawn } = await import('./walls');
    const edges = wallEdges(pair(true));
    const shared = edges.filter((e) => e.neighbour);
    expect(shared.length).toBe(2);
    expect(shared.filter((e) => e.owner).length).toBe(1);
    expect(shared[0].gaps.filter((g) => g.kind === 'door').length).toBe(1);
    const interior = solidSegments(pair(true)).filter((s) => s.interior);
    expect(interior.length).toBe(2);
    expect(interior[0].halfM).toBeCloseTo(0.05);
    const sp = entranceSpawn(pair(true));
    expect(sp.spaceId).toBe('A');
    expect(sp.pos.x).toBeCloseTo(0.8);
  });

  it('routes from the entrance go through the door, not the wall', () => {
    const r = runRoutes(pair(true), [], 'adult').routes.find((x) => x.label === 'Entrance to Kitchen')!;
    expect(r.ok).toBe(true);
    const crossing = r.points.find((p, i) => i > 0 && (r.points[i - 1].x - 4) * (p.x - 4) <= 0)!;
    const prev = r.points[r.points.indexOf(crossing) - 1];
    const t = (4 - prev.x) / (crossing.x - prev.x || 1);
    expect(Math.abs(prev.y + (crossing.y - prev.y) * t - 1)).toBeLessThan(0.3);
  });

  it('a wall without a door blocks the way', () => {
    const r = runRoutes(pair(false), [], 'adult').routes.find((x) => x.label === 'Entrance to Kitchen')!;
    expect(r.ok).toBe(false);
  });

  it('crowd enters by the entrance and reaches the next room', () => {
    const f = [item('t', 6, 2, 0.8, 0.8, 0.75, 'table')];
    const c = runCrowd(pair(true), f, 6, 3)!;
    expect(c.stats.paths).toBe(12);
  });

  it('the tour walks from the entrance into every room through the door', async () => {
    const { planTour } = await import('./tour');
    const { buildGrid } = await import('./grid');
    const m = pair(true);
    const t = planTour(m, buildGrid(m, []), { x: 0.8, y: 2 });
    expect(t.stops.map((s) => s.name)).toEqual(['Hall', 'Kitchen']);
    expect(Math.max(...t.points.map((q) => q.x))).toBeGreaterThan(4);
    expect(Math.hypot(t.points.at(-1)!.x - 0.8, t.points.at(-1)!.y - 2)).toBeLessThan(0.1);
    expect(planTour(pair(false), buildGrid(pair(false), []), { x: 0.8, y: 2 }).stops.length).toBe(1);
  });
});

describe('imported plan: rooms are net floor areas with the wall between them', () => {
  const rect = (x0: number, x1: number) => [{ x: x0, y: 0 }, { x: x1, y: 0 }, { x: x1, y: 4 }, { x: x0, y: 4 }];
  const half = { ...wall, thicknessM: 0.1 };
  const op = (id: string, spaceId: string, kind: Opening['kind'], wallIndex: number, offsetM: number): Opening => ({
    id, kind, spaceId, wallIndex, offsetM, widthM: 0.9, heightM: 2.05, sillM: 0, swing: 'none', hinge: 'start', sourceKind: 'pdf-annotation', status: 'estimated',
  });
  const plan = (door: boolean): SpaceModel => ({
    id: 'g', name: 'gap', version: 1, units: 'm', ceilingM: 2.6, sourceLabel: '',
    spaces: [
      { id: 'room-1', name: 'Corridoio', polygon: rect(0, 4), walls: [wall, half, wall, wall] },
      { id: 'room-2', name: 'Stanza', polygon: rect(4.2, 8.2), walls: [wall, wall, wall, half] },
    ],
    openings: [op('in', 'room-1', 'door', 3, 2), ...(door ? [op('d~1', 'room-1', 'door', 1, 1), op('d~2', 'room-2', 'door', 3, 3)] : [])],
    furniture: [], measurements: [], evidence: [],
  });

  it('sees the wall across the gap from both sides', async () => {
    const { wallEdges } = await import('./walls');
    const shared = wallEdges(plan(true)).filter((e) => e.neighbour);
    expect(shared.length).toBe(2);
    expect(shared.every((e) => e.owner && Math.abs(e.gapM - 0.2) < 1e-6)).toBe(true);
  });

  it('routes pass through the doorway across the wall, and a wall without a door blocks', () => {
    expect(runRoutes(plan(true), [], 'adult').routes.find((x) => x.label === 'Entrance to Stanza')!.ok).toBe(true);
    expect(runRoutes(plan(false), [], 'adult').routes.find((x) => x.label === 'Entrance to Stanza')!.ok).toBe(false);
  });

  it('door halves a wall apart form one link and only the front door leads outside', async () => {
    const { roomGraph } = await import('../building/connectivity');
    const g = roomGraph(plan(true));
    expect(g.links.length).toBe(1);
    expect(g.exits.map((e) => e.id)).toEqual(['in']);
  });
});

