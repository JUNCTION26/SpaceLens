import { describe, it, expect } from 'vitest';
import { applyOp } from './ops';
import { sampleRoom } from './sample';
import { area, dist } from './geometry';
import type { Op, SpaceModel, Vec2 } from './types';

const ortho = (p: Vec2[]) => p.every((a, i) => { const b = p[(i + 1) % p.length]; return Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.y - b.y) < 1e-9; });
const Lmodel = (): SpaceModel => {
  const m = sampleRoom();
  const poly = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 4 }, { x: 0, y: 4 }];
  m.spaces[0] = { ...m.spaces[0], polygon: poly, walls: poly.map(() => ({ ...m.spaces[0].walls[0] })) };
  return m;
};

describe('ops', () => {
  it('SET_WALL_LENGTH keeps rectangle rectangular', () => {
    const m = sampleRoom();
    for (const wi of [0, 1, 2, 3]) {
      const n = applyOp(m, { type: 'SET_WALL_LENGTH', spaceId: 's1', wallIndex: wi, lengthM: 5 } as Op);
      const p = n.spaces[0].polygon;
      expect(dist(p[wi], p[(wi + 1) % 4])).toBeCloseTo(5);
      expect(dist(p[(wi + 2) % 4], p[(wi + 3) % 4])).toBeCloseTo(5);
      expect(ortho(p)).toBe(true);
      expect(n.spaces[0].walls[wi].status).toBe('verified');
      expect(n.spaces[0].walls[wi].sourceKind).toBe('manual');
    }
    const z = applyOp(m, { type: 'SET_WALL_LENGTH', spaceId: 's1', wallIndex: 0, lengthM: 0 } as Op);
    expect(z.spaces[0].polygon).toEqual(m.spaces[0].polygon);
  });

  it('SET_WALL_LENGTH keeps L-shape orthogonal', () => {
    const m = Lmodel();
    for (let wi = 0; wi < 6; wi++) {
      const n = applyOp(m, { type: 'SET_WALL_LENGTH', spaceId: 's1', wallIndex: wi, lengthM: 3 } as Op);
      const p = n.spaces[0].polygon;
      expect(dist(p[wi], p[(wi + 1) % 6])).toBeCloseTo(3);
      expect(ortho(p)).toBe(true);
      expect(area(p)).toBeGreaterThan(0);
    }
  });

  it('INSERT/REMOVE_VERTEX reindex openings', () => {
    const m = sampleRoom();
    const ins = applyOp(m, { type: 'INSERT_VERTEX', spaceId: 's1', afterIndex: 0, at: { x: 1.7, y: 0 } } as Op);
    expect(ins.spaces[0].polygon).toHaveLength(5);
    expect(ins.spaces[0].walls).toHaveLength(5);
    expect(ins.openings.find((o) => o.id === 'door1')!.wallIndex).toBe(3);
    expect(ins.openings.find((o) => o.id === 'win1')!.wallIndex).toBe(0);
    const rem = applyOp(ins, { type: 'REMOVE_VERTEX', spaceId: 's1', index: 1 } as Op);
    expect(rem.spaces[0].polygon).toEqual(m.spaces[0].polygon);
    expect(rem.openings.find((o) => o.id === 'door1')!.wallIndex).toBe(2);
    const rem2 = applyOp(m, { type: 'REMOVE_VERTEX', spaceId: 's1', index: 2 } as Op);
    expect(rem2.openings.find((o) => o.id === 'door1')).toBeUndefined();
    const tri = applyOp(rem2, { type: 'REMOVE_VERTEX', spaceId: 's1', index: 0 } as Op);
    expect(tri.spaces[0].polygon).toHaveLength(3);
  });

  it('bumps version on every op, including REPLACE_MODEL', () => {
    let m = sampleRoom();
    const ops = [
      { type: 'SET_CEILING', heightM: 2.7 }, { type: 'RENAME', name: 'X' },
      { type: 'MOVE_VERTEX', spaceId: 's1', index: 0, to: { x: 0.1, y: 0 } },
      { type: 'REMOVE_OBJECT', id: 'f_desk' }, { type: 'REMOVE_OPENING', id: 'win1' },
      { type: 'SET_WALL_LENGTH', spaceId: 's1', wallIndex: 1, lengthM: 4 },
    ] as Op[];
    for (const op of ops) { const n = applyOp(m, op); expect(n.version).toBe(m.version + 1); m = n; }
    const other = { ...sampleRoom(), name: 'Other', version: 1 };
    const r = applyOp(m, { type: 'REPLACE_MODEL', model: other } as Op);
    expect(r.name).toBe('Other');
    expect(r.version).toBe(m.version + 1);
  });
});
