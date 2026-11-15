import { describe, expect, it } from 'vitest';
import { applyOp } from '../../core/ops';
import { dist } from '../../core/geometry';
import { assessAccess } from './access';
import { planPlacement } from './placement';
import { door, item, longRoom, model, officeFloor, rect, space } from './fixtures';

/** 5 x 4 studio, 1.0 m door on the left; bed, desk, WC cubicle and cooker all inside. */
function studio(deskX = 4.3) {
  return model([space('r', 'Studio', rect(0, 0, 5, 4))], [door('exit', 'r', 3, 2, 1.0, 'out')],
    [item('bed', 'bed', 2.5, 0.9, 1.4, 2.0, { name: 'Bed', rotation: Math.PI / 2 }),
      item('desk', 'desk', deskX, 3.4, 1.2, 0.6, { name: 'Desk' }),
      item('wc', 'toilet', 4.6, 0.4, 0.4, 0.6, { name: 'Toilet' }),
      item('hob', 'cooker', 0.4, 3.6, 0.6, 0.6, { name: 'Cooker' })]);
}

describe('wheelchair access', () => {
  it('open studio: every destination (room, bed, desk, WC, kitchen) is reachable and the score is 1', () => {
    const m = studio();
    const r = assessAccess(m, m.furniture);
    for (const id of ['room:r', 'item:bed', 'item:desk', 'item:wc', 'item:hob']) expect(r.destinations.find((d) => d.id === id)?.reachable, id).toBe(true);
    expect(r.destinations.find((d) => d.id === 'item:hob')!.kind).toBe('kitchen');
    expect(r.score).toBe(1);
    expect(r.entranceId).toBe('exit');
  });

  it('every route is at least 0.9 m wide', () => {
    const m = studio();
    const r = assessAccess(m, m.furniture);
    for (const d of r.destinations.filter((x) => x.reachable && x.narrowestM !== null)) expect(d.narrowestM!).toBeGreaterThanOrEqual(0.89);
  });

  it('a room too cluttered for a 1.5 m turning circle names the item and gives before and after widths', () => {
    const m = model([space('r', 'Box', rect(0, 0, 3, 3))], [door('exit', 'r', 3, 1.5, 1.0, 'out')],
      [item('table', 'table', 1.6, 1.5, 1.2, 1.2, { name: 'Table' })]);
    const r = assessAccess(m, m.furniture);
    const room = r.destinations.find((d) => d.id === 'room:r')!;
    expect(room.reachable).toBe(false);
    expect(room.blocking?.reason).toBe('turn');
    expect(room.blocking?.id).toBe('table');
    if (room.fix) {
      expect(room.fix.kind).toBe('move');
      expect(room.fix.afterM!).toBeGreaterThan(room.fix.beforeM ?? 0);
      let next = m;
      for (const op of room.fix.ops) next = applyOp(next, op);
      expect(assessAccess(next, next.furniture, { skipFixes: true }).destinations.find((d) => d.id === 'room:r')!.reachable).toBe(true);
    }
  });

  it('a 0.7 m door gives before 0.7-ish, after at least 0.8', () => {
    const m = model([space('a', 'Hall', rect(0, 0, 4, 4)), space('b', 'WC', rect(4, 0, 2, 2))],
      [door('exit', 'a', 3, 2, 1.0, 'out'), door('wcd', 'a', 1, 1, 0.7, 'in')], [item('wc', 'toilet', 5, 1, 0.4, 0.6, { name: 'Toilet' })]);
    const r = assessAccess(m, m.furniture);
    const wc = r.destinations.find((d) => d.id === 'item:wc')!;
    expect(wc.reachable).toBe(false);
    expect(wc.blocking).toMatchObject({ kind: 'door', id: 'wcd' });
    expect(wc.fix?.kind).toBe('widen-door');
    expect(wc.fix!.beforeM!).toBeLessThan(0.75);
    expect(wc.fix!.afterM!).toBeGreaterThanOrEqual(0.8);
    expect(wc.fix!.verified).toBe(true);
  });

  it('desk behind a bed: blocker is the bed, the fix moves it and widens the passage', () => {
    const m = model([space('r', 'Studio', rect(0, 0, 5, 3))], [door('exit', 'r', 3, 1.5, 1.0, 'out')],
      [item('bed', 'bed', 2.5, 1.3, 1.0, 2.0, { name: 'Bed' }), item('desk', 'desk', 4.3, 1.5, 0.6, 1.2, { name: 'Desk', rotation: Math.PI / 2 })]);
    const d = assessAccess(m, m.furniture).destinations.find((x) => x.id === 'item:desk')!;
    expect(d.blocking?.id).toBe('bed');
    expect(d.fix?.afterM!).toBeGreaterThanOrEqual(0.9);
    expect(d.fix!.afterM!).toBeGreaterThan(d.fix!.beforeM ?? 0);
  });

  it('no exit: nothing is reachable and the report says so instead of throwing', () => {
    const m = model([space('r', 'Box', rect(0, 0, 3, 3))], [], [item('bed', 'bed', 1.5, 1.5, 1, 2)]);
    const r = assessAccess(m, m.furniture);
    expect(r.entranceId).toBeNull();
    expect(r.score).toBe(0);
    expect(r.destinations.every((d) => !d.reachable)).toBe(true);
  });
});

describe('equipment', () => {
  it('50 m hall: extinguishers keep every point within the travel distance', () => {
    const m = longRoom(50);
    const p = planPlacement(m, m.furniture);
    const ex = p.suggestions.filter((s) => s.kind === 'extinguisher');
    const limit = ex.length ? p.assumptions.find((a) => 'value' in a && a.id.includes('ext')) : undefined;
    expect(ex.length).toBeGreaterThanOrEqual(2);
    for (let x = 0.5; x < 50; x += 0.5) for (const y of [0.5, 2, 3.5]) expect(Math.min(...ex.map((e) => dist(e.at, { x, y })))).toBeLessThanOrEqual(25);
    expect(limit === undefined || limit.value <= 25).toBe(true);
  });

  it('small room: one extinguisher per exit, at the exit, inside the room', () => {
    const m = longRoom(6);
    const p = planPlacement(m, m.furniture);
    const ex = p.suggestions.filter((s) => s.kind === 'extinguisher');
    expect(ex.length).toBe(1);
    expect(ex[0].doorId).toBe('exit');
    expect(dist(ex[0].at, { x: 0, y: 2 })).toBeLessThan(2);
  });

  it('office floor: a smoke alarm in every room and in the corridor, one exit sign per exit', () => {
    const m = officeFloor();
    const p = planPlacement(m, m.furniture);
    const alarms = p.suggestions.filter((s) => s.kind === 'smoke-alarm');
    for (const s of m.spaces) expect(alarms.some((a) => a.spaceId === s.id), s.id).toBe(true);
    const signs = p.suggestions.filter((s) => s.kind === 'exit-sign');
    expect(signs.map((s) => s.doorId).sort()).toEqual(['exitL', 'exitR']);
    expect(p.suggestions.filter((s) => s.kind === 'extinguisher').some((s) => s.doorId === 'exitL')).toBe(true);
  });

  it('every suggestion names an assumption that is listed', () => {
    const m = officeFloor();
    const p = planPlacement(m, m.furniture);
    const ids = new Set(p.assumptions.map((a) => a.id));
    for (const s of p.suggestions) expect(ids.has(s.assumptionId), s.id).toBe(true);
  });
});
