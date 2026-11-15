import { describe, expect, it } from 'vitest';
import { runDrill, personAt } from './drill';
import { buildSafetyGrid, cellAt } from './field';
import { door, item, model, rect, space, twoRoomFlat } from './fixtures';

const oneDoor = () => model([space('r', 'Room', rect(0, 0, 5, 4))], [door('d', 'r', 3, 2, 0.9, 'out')]);

describe('fire drill', () => {
  it('one door, four people: empties in the expected time', () => {
    const m = oneDoor();
    const starts = [{ x: 4.5, y: 1 }, { x: 4.5, y: 3 }, { x: 3.5, y: 2 }, { x: 4, y: 2 }];
    const r = runDrill(m, [], { starts });
    expect(r.allOut).toBe(true);
    // longest walk about 4.5 m at 1.2 m/s plus a short queue at the door
    expect(r.totalS).toBeGreaterThan(2.5);
    expect(r.totalS).toBeLessThan(8);
    expect(r.pass).toBe(true);
    expect(runDrill(m, [], { starts }).totalS).toBe(r.totalS);
  });

  it('a blocked door sends everyone to the other one', () => {
    const m = model([space('r', 'Room', rect(0, 0, 6, 4))], [door('l', 'r', 3, 2, 0.9, 'out'), door('rt', 'r', 1, 2, 0.9, 'out')]);
    const starts = [{ x: 1, y: 1 }, { x: 1.2, y: 3 }, { x: 2, y: 2 }];
    const open = runDrill(m, [], { starts, fire: { x: 0.8, y: 2 } });
    const shut = runDrill(m, [], { starts, fire: { x: 0.8, y: 2 }, blockExit: true });
    expect(shut.blockedId).toBe('l');
    expect(shut.people.every((p) => p.escaped && p.exitId === 'rt')).toBe(true);
    expect(open.people.every((p) => p.exitId === 'l')).toBe(true);
    expect(shut.totalS).toBeGreaterThan(open.totalS);
  });

  it('a chair in a 0.6 m gap is the bottleneck', () => {
    const wall = [item('w1', 'wardrobe', 3, 0.85, 0.5, 1.7, { locked: true }), item('w2', 'wardrobe', 3, 3.15, 0.5, 1.7, { locked: true })];
    const m = model([space('r', 'Room', rect(0, 0, 7, 4))], [door('d', 'r', 3, 2, 0.9, 'out')], wall);
    const starts = [4.5, 5, 5.5, 6, 6.5].flatMap((x) => [{ x, y: 1.2 }, { x, y: 2.8 }]);
    const r = runDrill(m, wall, { starts });
    expect(r.allOut).toBe(true);
    expect(r.bottleneck).not.toBeNull();
    expect(r.bottleneck!.kind).toBe('gap');
    expect(r.bottleneck!.widthM).toBeGreaterThan(0.5);
    expect(r.bottleneck!.widthM).toBeLessThan(0.65);
    expect(r.bottleneck!.queue).toBeGreaterThan(2);
    expect(r.bottleneck!.lostS).toBeGreaterThan(1);
    expect(r.fix?.label).toMatch(/^Move /);
    expect(r.fix?.itemId).toMatch(/^w[12]$/);
  });

  it('nobody walks through walls or furniture', () => {
    const m = twoRoomFlat();
    const r = runDrill(m, m.furniture, { occupants: 6, seed: 3 });
    const g = buildSafetyGrid(m, m.furniture);
    expect(r.occupants).toBe(6);
    expect(r.allOut).toBe(true);
    for (const p of r.people) for (const q of p.track) {
      const c = cellAt(g, q);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(g.free[c]).toBe(1);
    }
    const p0 = r.people[0];
    expect(personAt(p0, 0, r.dt)).toEqual(p0.start);
    expect(personAt(p0, (p0.exitS ?? 0) + 1, r.dt)).toBeNull();
  });
});
