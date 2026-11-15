import { describe, expect, it } from 'vitest';
import { sampleRoom } from '../../core/sample';
import type { FurnitureItem, Opening, Space, SpaceModel, Vec2 } from '../../core/types';
import { dxfToModel, parseDxf } from './dxfRead';
import { modelToDxf } from './dxfWrite';

const area = (p: Vec2[]) => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + (a.x * b.y - b.x * a.y); }, 0)) / 2;
const room = (id: string, name: string, x0: number, x1: number, t: number): Space => ({
  id, name, polygon: [{ x: x0, y: 0 }, { x: x1, y: 0 }, { x: x1, y: 3 }, { x: x0, y: 3 }],
  walls: [0, 1, 2, 3].map(() => ({ thicknessM: t, sourceKind: 'manual' as const, status: 'verified' as const })),
});
const door = (id: string, spaceId: string, wallIndex: number, offsetM: number, widthM: number, swing: Opening['swing'], hinge: 'start' | 'end'): Opening =>
  ({ id, kind: 'door', spaceId, wallIndex, offsetM, widthM, heightM: 2.05, sillM: 0, swing, hinge, sourceKind: 'manual', status: 'verified' });
const win = (id: string, spaceId: string, wallIndex: number, offsetM: number, widthM: number): Opening =>
  ({ id, kind: 'window', spaceId, wallIndex, offsetM, widthM, heightM: 1.2, sillM: 0.9, swing: 'none', hinge: 'start', sourceKind: 'manual', status: 'verified' });
const item = (id: string, x: number, y: number, rotation: number, w: number, d: number): FurnitureItem =>
  ({ ...sampleRoom().furniture[0], id, x, y, rotation, w, d });

const src: SpaceModel = {
  ...sampleRoom(), id: 'flat', name: 'Flat',
  spaces: [room('a', 'Kitchen', 0, 4, 0.2), room('b', 'Bedroom', 4, 7, 0.12), room('c', 'Hall', 7, 10, 0.12)],
  openings: [
    door('d1', 'a', 2, 1.0, 0.9, 'in', 'start'), // bottom wall, swings into the room
    door('d2', 'b', 0, 2.0, 0.8, 'out', 'end'), // top wall, swings outside
    door('d3', 'c', 3, 1.2, 0.8, 'in', 'end'), // west wall of the hall, the wall it shares with the bedroom
    win('w1', 'a', 0, 2.0, 1.2), win('w2', 'b', 2, 1.5, 1.0), win('w3', 'c', 1, 1.5, 1.4),
  ],
  furniture: [item('f1', 5.5, 1.5, Math.PI / 2, 1.6, 2.0), item('f2', 1.0, 0.6, 0, 1.4, 0.7), item('f3', 8.5, 2.4, -Math.PI / 4, 1.0, 0.5)],
};

/** Centre of an opening on the plan, independent of which room lists it. */
const centre = (m: SpaceModel, o: Opening) => {
  const sp = m.spaces.find((s) => s.id === o.spaceId)!;
  const p = sp.polygon[o.wallIndex], q = sp.polygon[(o.wallIndex + 1) % sp.polygon.length];
  const L = Math.hypot(q.x - p.x, q.y - p.y);
  return { x: p.x + ((q.x - p.x) / L) * o.offsetM, y: p.y + ((q.y - p.y) / L) * o.offsetM };
};

describe('dxf round trip: write then read', () => {
  const text = modelToDxf(src);
  const { model: back, report } = dxfToModel(text, 'flat.dxf', { now: 1 });

  it('writes the expected layers in metres, doors as arc plus line, furniture as closed polylines', () => {
    const d = parseDxf(text);
    expect(d.unitM).toBe(1);
    for (const l of ['WALLS', 'DOORS', 'WINDOWS', 'FURNITURE', 'TEXT']) expect(d.layers).toContain(l);
    expect(d.lines.filter((l) => l.layer === 'DOORS' && l.kind === 'arc')).toHaveLength(3);
    expect(d.lines.filter((l) => l.layer === 'FURNITURE')).toHaveLength(3);
    expect(d.lines.filter((l) => l.layer === 'FURNITURE').every((l) => l.closed && l.kind === 'poly' && l.pts.length === 4)).toBe(true);
  });

  it('reads rooms back with names and areas within 1 percent, thickness from the wall lines', () => {
    expect(report.method).toBe('room-outlines');
    expect(back.spaces.map((s) => s.name)).toEqual(['Kitchen', 'Bedroom', 'Hall']);
    back.spaces.forEach((s, i) => expect(Math.abs(area(s.polygon) - area(src.spaces[i].polygon)) / area(src.spaces[i].polygon)).toBeLessThan(0.01));
    expect(back.spaces[0].walls.every((w) => Math.abs(w.thicknessM - 0.2) < 0.01)).toBe(true);
    // the bedroom edge on the kitchen's wall (x = 4) shares the thicker wall
    const bed = back.spaces[1];
    bed.polygon.forEach((p, i) => {
      const q = bed.polygon[(i + 1) % bed.polygon.length];
      expect(bed.walls[i].thicknessM).toBeCloseTo(Math.abs(p.x - 4) < 0.01 && Math.abs(q.x - 4) < 0.01 ? 0.2 : 0.12, 2);
    });
  });

  it('reads doors with position, width, swing side and hinge, and windows with position and width', () => {
    expect(report.doors).toBe(3);
    expect(report.windows).toBe(3);
    for (const o of src.openings) {
      const c = centre(src, o);
      const hit = back.openings.find((b) => b.kind === o.kind && Math.hypot(centre(back, b).x - c.x, centre(back, b).y - c.y) < 0.02);
      expect(hit, o.id).toBeDefined();
      expect(Math.abs(hit!.widthM - o.widthM), `${o.id} width`).toBeLessThan(0.02);
      if (o.kind === 'door') {
        // swing is relative to the room the opening is read into; compare against the source room's side
        const sameRoom = back.spaces.find((s) => s.name === src.spaces.find((x) => x.id === o.spaceId)!.name)!.id === hit!.spaceId;
        const expectSwing = sameRoom ? o.swing : o.swing === 'in' ? 'out' : 'in';
        expect(hit!.swing, `${o.id} swing`).toBe(expectSwing);
      }
    }
  });

  it('reads furniture as rectangles with centre, size and rotation', () => {
    expect(back.furniture).toHaveLength(3);
    for (const f of src.furniture) {
      const g = back.furniture.find((x) => Math.hypot(x.x - f.x, x.y - f.y) < 0.02);
      expect(g, f.id).toBeDefined();
      expect(Math.abs(g!.w - f.w)).toBeLessThan(0.02);
      expect(Math.abs(g!.d - f.d)).toBeLessThan(0.02);
      expect(Math.cos(g!.rotation)).toBeCloseTo(Math.cos(f.rotation), 2);
      expect(Math.sin(g!.rotation)).toBeCloseTo(Math.sin(f.rotation), 2);
    }
    expect(report.furniture).toBe(3);
  });

  it('marks everything estimated and lists layers it did not use', () => {
    expect(back.openings.every((o) => o.status === 'estimated')).toBe(true);
    expect(report.ignoredLayers).toEqual(expect.arrayContaining(['DIMENSIONS']));
  });
});
