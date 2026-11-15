import { describe, expect, it } from 'vitest';
import { sampleRoom } from '../../core/sample';
import type { FurnitureItem, Opening, Space, SpaceModel, Vec2 } from '../../core/types';
import { ifcToModel } from './ifcRead';
import { modelToIfc } from './ifcWrite';

const area = (p: Vec2[]) => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + (a.x * b.y - b.x * a.y); }, 0)) / 2;
const room = (id: string, name: string, x0: number, x1: number, t: number): Space => ({
  id, name, polygon: [{ x: x0, y: 0 }, { x: x1, y: 0 }, { x: x1, y: 3 }, { x: x0, y: 3 }],
  walls: [0, 1, 2, 3].map(() => ({ thicknessM: t, sourceKind: 'manual' as const, status: 'verified' as const })),
});
const op = (id: string, kind: Opening['kind'], spaceId: string, wallIndex: number, offsetM: number, widthM: number, heightM: number, sillM: number, hinge: 'start' | 'end'): Opening =>
  ({ id, kind, spaceId, wallIndex, offsetM, widthM, heightM, sillM, swing: kind === 'door' ? 'in' : 'none', hinge, sourceKind: 'manual', status: 'verified' });
const item = (id: string, category: string, x: number, y: number, rotation: number, w: number, d: number, h: number, elevationM?: number): FurnitureItem => ({
  ...sampleRoom().furniture[0], id, name: category, category, x, y, rotation, w, d, h, elevationM,
});

const three = (): SpaceModel => ({
  ...sampleRoom(), id: 'three', name: 'Flat', ceilingM: 2.6,
  spaces: [room('a', 'Kitchen', 0, 4, 0.2), room('b', 'Bedroom', 4, 7, 0.12), room('c', 'Hall', 7, 10, 0.12)],
  openings: [
    op('d1', 'door', 'a', 1, 1.5, 0.9, 2.05, 0, 'start'),
    op('d2', 'door', 'c', 3, 1.0, 0.8, 2.0, 0, 'end'), // on the wall shared with the bedroom, listed from the hall side
    op('w1', 'window', 'a', 0, 2.0, 1.2, 1.3, 0.9, 'start'),
    op('w2', 'window', 'b', 0, 1.5, 1.0, 1.2, 0.95, 'start'),
    op('w3', 'window', 'c', 2, 1.0, 0.6, 0.6, 1.4, 'start'),
  ],
  furniture: [
    item('f1', 'bed', 5.5, 1.5, Math.PI / 2, 1.6, 2.0, 0.5),
    item('f2', 'desk', 1.0, 0.5, 0, 1.4, 0.7, 0.74),
    item('f3', 'shelf', 9.2, 2.6, Math.PI, 0.9, 0.3, 1.8, 1.0),
    item('f4', 'sofa', 2.5, 2.0, -Math.PI / 4, 2.0, 0.9, 0.8),
  ],
});

/** World position of an opening centre on the plan, so rooms can list a shared wall from either side. */
const centre = (m: SpaceModel, o: Opening) => {
  const sp = m.spaces.find((s) => s.id === o.spaceId)!;
  const p = sp.polygon[o.wallIndex], q = sp.polygon[(o.wallIndex + 1) % sp.polygon.length];
  const L = Math.hypot(q.x - p.x, q.y - p.y);
  return { x: p.x + ((q.x - p.x) / L) * o.offsetM, y: p.y + ((q.y - p.y) / L) * o.offsetM };
};

describe('ifc round trip: write then read', () => {
  const src = three();
  const { model: back, report } = ifcToModel(modelToIfc(src), 'flat.ifc', { now: 1 });

  it('keeps room names, outlines and areas within 1 cm', () => {
    expect(back.spaces.map((s) => s.name)).toEqual(['Kitchen', 'Bedroom', 'Hall']);
    back.spaces.forEach((s, i) => {
      expect(Math.abs(area(s.polygon) - area(src.spaces[i].polygon))).toBeLessThan(0.01);
      for (const c of src.spaces[i].polygon) expect(s.polygon.some((p) => Math.hypot(p.x - c.x, p.y - c.y) < 0.01)).toBe(true);
    });
    expect(report.storeys).toEqual([{ name: 'Level 0', elevationM: 0 }]);
    expect(back.ceilingM).toBeCloseTo(2.6, 2);
  });

  it('reads one wall per distinct edge with axis, thickness and height', () => {
    expect(report.walls).toBe(10); // 4 + 3 + 3: the two shared edges are single walls
    const shared = report.wallList.find((w) => Math.abs(w.a.x - 4) < 0.01 && Math.abs(w.b.x - 4) < 0.01)!;
    expect(shared.thicknessM).toBeCloseTo(0.2, 2); // the thicker of the two rooms' walls
    expect(Math.abs(Math.hypot(shared.b.x - shared.a.x, shared.b.y - shared.a.y) - 3)).toBeLessThan(0.01);
    expect(shared.heightM).toBeCloseTo(2.6, 2);
    expect(back.spaces[0].walls.every((w) => Math.abs(w.thicknessM - 0.2) < 0.005)).toBe(true);
    // vertex order may differ after reading, so judge each edge by where it lies
    const bed = back.spaces[1];
    bed.polygon.forEach((p, i) => {
      const q = bed.polygon[(i + 1) % bed.polygon.length];
      const onSharedWithKitchen = Math.abs(p.x - 4) < 0.01 && Math.abs(q.x - 4) < 0.01;
      expect(bed.walls[i].thicknessM).toBeCloseTo(onSharedWithKitchen ? 0.2 : 0.12, 2);
    });
  });

  it('puts doors and windows back into their host walls with width, height and sill', () => {
    expect(back.openings).toHaveLength(src.openings.length);
    expect(report.doors).toBe(2);
    expect(report.windows).toBe(3);
    for (const o of src.openings) {
      const c = centre(src, o);
      const hit = back.openings.find((b) => b.kind === o.kind && Math.hypot(centre(back, b).x - c.x, centre(back, b).y - c.y) < 0.01);
      expect(hit, o.id).toBeDefined();
      expect(Math.abs(hit!.widthM - o.widthM)).toBeLessThan(0.01);
      expect(Math.abs(hit!.heightM - o.heightM)).toBeLessThan(0.01);
      expect(Math.abs(hit!.sillM - o.sillM)).toBeLessThan(0.01);
    }
  });

  it('reads door operation as swing into the room with the hinge the file implies', () => {
    const d1 = back.openings.find((o) => o.id.startsWith('door') && Math.abs(centre(back, o).y - 1.5) < 0.01 && Math.abs(centre(back, o).x - 4) < 0.01)!;
    expect(d1.swing).toBe('in');
    expect(d1.hinge).toBe('start');
    expect(report.warnings.some((w) => /swing/i.test(w))).toBe(true);
  });

  it('reads furniture with position, size, rotation, elevation and category', () => {
    expect(back.furniture).toHaveLength(4);
    expect(report.furniture).toBe(4);
    for (const f of src.furniture) {
      const g = back.furniture.find((x) => x.category === f.category)!;
      expect(Math.hypot(g.x - f.x, g.y - f.y)).toBeLessThan(0.01);
      expect(Math.abs(g.w - f.w)).toBeLessThan(0.01);
      expect(Math.abs(g.d - f.d)).toBeLessThan(0.01);
      expect(Math.abs(g.h - f.h)).toBeLessThan(0.01);
      expect(Math.cos(g.rotation)).toBeCloseTo(Math.cos(f.rotation), 2);
      expect(Math.sin(g.rotation)).toBeCloseTo(Math.sin(f.rotation), 2);
      expect(g.elevationM ?? 0).toBeCloseTo(f.elevationM ?? 0, 2);
    }
    expect(back.furniture.find((x) => x.category === 'desk')!.catalogId).toBe('desk-140');
  });

  it('is marked estimated and has nothing skipped', () => {
    expect(back.openings.every((o) => o.status === 'estimated')).toBe(true);
    expect(report.skipped).toEqual({});
    expect(report.openingsSkipped).toBe(0);
  });
});

describe('ifc reader skip report and odd input', () => {
  it('counts unsupported building elements instead of dropping them silently', () => {
    const ifc = modelToIfc(three());
    const at = ifc.lastIndexOf('ENDSEC;');
    const extra = "#9001=IFCSLAB('g',$,'Slab',$,$,$,$,$,.FLOOR.);\n#9002=IFCCOLUMN('g',$,'C1',$,$,$,$,$,$);\n#9003=IFCCOLUMN('g',$,'C2',$,$,$,$,$,$);\n";
    const { report } = ifcToModel(ifc.slice(0, at) + extra + ifc.slice(at), 'x.ifc');
    expect(report.skipped).toEqual({ IFCSLAB: 1, IFCCOLUMN: 2 });
    expect(report.warnings.some((w) => w.includes('2 x IFCCOLUMN'))).toBe(true);
    expect(report.walls).toBe(10);
  });

  it('reads a model without rooms: walls and furniture are still returned, openings reported as unplaced', () => {
    const m = three();
    const { report, model } = ifcToModel(modelToIfc({ ...m, spaces: m.spaces.map((s) => s), openings: m.openings }).replace(/#\d+=IFCSPACE\([^;]*;\n/g, ''), 'n.ifc');
    expect(model.spaces).toHaveLength(0);
    expect(report.walls).toBe(10);
    expect(report.furniture).toBe(4);
    expect(report.openingsSkipped).toBe(5);
  });
});
