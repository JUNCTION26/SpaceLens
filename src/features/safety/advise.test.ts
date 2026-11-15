import { describe, expect, it } from 'vitest';
import { pointInPolygon, itemCorners } from '../../core/geometry';
import { applyOp } from '../../core/ops';
import { assessAccess } from './access';
import { applyPlacement, planPlacement } from './placement';
import { door, item, model, rect, space, twoRoomFlat } from './fixtures';

function bedRoom() {
  // 5 x 3 room, door on the left; a bed leaves 70 cm below it and 30 cm above it; the desk sits beyond the bed.
  return model([space('r', 'Studio', rect(0, 0, 5, 3))], [door('exit', 'r', 3, 1.5, 1.0, 'out')],
    [item('bed', 'bed', 2.5, 1.3, 1.0, 2.0, { name: 'Bed' }), item('desk', 'desk', 4.3, 1.5, 0.6, 1.2, { name: 'Desk', rotation: Math.PI / 2 })]);
}

describe('wheelchair journey', () => {
  it('bed blocking the route to the desk: blocker is the bed, fix is a verified move up', () => {
    const m = bedRoom();
    const r = assessAccess(m, m.furniture);
    const desk = r.destinations.find((d) => d.id === 'item:desk')!;
    expect(desk.reachable).toBe(false);
    expect(desk.blocking?.id).toBe('bed');
    expect(desk.fix?.kind).toBe('move');
    expect(desk.fix?.itemId).toBe('bed');
    expect(desk.fix?.dir).toBe('up');
    expect(desk.fix?.cm).toBeGreaterThanOrEqual(10);
    let next = m;
    for (const op of desk.fix!.ops) next = applyOp(next, op);
    const after = assessAccess(next, next.furniture, { skipFixes: true });
    expect(after.destinations.find((d) => d.id === 'item:desk')!.reachable).toBe(true);
    expect(r.score).toBeLessThan(1);
  });

  it('a 0.7 m door is the blocking point and widening is the fix', () => {
    const m = twoRoomFlat();
    m.openings = m.openings.map((o) => (o.id === 'inner' ? { ...o, widthM: 0.7 } : o));
    const r = assessAccess(m, m.furniture);
    const bedroom = r.destinations.find((d) => d.id === 'room:bed')!;
    expect(bedroom.reachable).toBe(false);
    expect(bedroom.blocking).toMatchObject({ kind: 'door', id: 'inner' });
    expect(bedroom.fix?.kind).toBe('widen-door');
    expect(bedroom.fix?.toM).toBeGreaterThanOrEqual(0.8);
    expect(bedroom.fix?.verified).toBe(true);
  });

  it('clear plan scores 1', () => {
    const m = twoRoomFlat();
    m.openings = m.openings.map((o) => (o.id === 'inner' ? { ...o, widthM: 1.0 } : o));
    expect(assessAccess(m, m.furniture).score).toBe(1);
  });
});

describe('equipment placement', () => {
  const L = [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 5 }, { x: 0, y: 5 }];
  it('smoke alarm sits inside an L-shaped room and clear of furniture', () => {
    const m = model([space('l', 'Living', L)], [door('exit', 'l', 5, 2.5, 0.9, 'out')], [item('sofa', 'sofa', 1, 2.5, 1.8, 0.9, { rotation: Math.PI / 2 })]);
    const p = planPlacement(m, m.furniture);
    const alarms = p.suggestions.filter((s) => s.kind === 'smoke-alarm');
    expect(alarms.length).toBeGreaterThan(0);
    for (const a of alarms) expect(pointInPolygon(a.at, L)).toBe(true);
    expect(p.suggestions.some((s) => s.kind === 'extinguisher')).toBe(true);
    expect(p.suggestions.some((s) => s.kind === 'exit-sign')).toBe(true);
  });

  it('no suggestion sits inside furniture; labels are short; every one names an assumption', () => {
    const m = model([space('k', 'Kitchen', rect(0, 0, 4, 3))], [door('exit', 'k', 3, 1.5, 0.9, 'out')],
      [item('cooker', 'cooker', 2, 0.4, 0.6, 0.6, { name: 'Cooker' }), item('table', 'table', 2, 1.8, 1.4, 0.9)]);
    const p = planPlacement(m, m.furniture);
    expect(p.suggestions.some((s) => s.kind === 'fire-blanket')).toBe(true);
    for (const s of p.suggestions) {
      for (const f of m.furniture) if (s.kind !== 'exit-sign') expect(pointInPolygon(s.at, itemCorners(f))).toBe(false);
      expect(s.label.split(' ').length).toBeLessThanOrEqual(3);
      expect(s.assumptionId).toBeTruthy();
    }
    const alarm = p.suggestions.find((s) => s.kind === 'smoke-alarm')!;
    expect(Math.hypot(alarm.at.x - 2, alarm.at.y - 0.4)).toBeGreaterThanOrEqual(1.0);
  });

  it('applyPlacement places nothing without catalogue entries, mounted items with them', () => {
    const m = model([space('k', 'Room', rect(0, 0, 4, 3))], [door('exit', 'k', 3, 1.5, 0.9, 'out')]);
    const p = planPlacement(m, m.furniture);
    expect(applyPlacement(p.suggestions)).toEqual([]);
    const ops = applyPlacement(p.suggestions, { 'smoke-alarm': item('t', 'alarm', 0, 0, 0.1, 0.1) });
    expect(ops.length).toBeGreaterThan(0);
    expect(ops[0]).toMatchObject({ type: 'PLACE_OBJECT', item: { mount: 'ceiling' } });
  });
});
