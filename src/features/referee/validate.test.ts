import { describe, expect, it } from 'vitest';
import { firstFailure, summarize, validateLayout } from './validate';
import { bowtie, item, lShape, mulberry32, opening, rect, reqs, room, trapezoid } from './fixtures';

const get = (rs: ReturnType<typeof validateLayout>, id: string) => {
  const r = rs.find((x) => x.id === id);
  if (!r) throw new Error(`missing ${id}: ${rs.map((x) => x.id).join(', ')}`);
  return r;
};

describe('validateLayout', () => {
  it('3x4 rectangle is valid with area 12', () => {
    const r = get(validateLayout(room(rect(3, 4)), []), 'room:s1');
    expect(r.result).toBe('pass');
    expect(r.measured).toBeCloseTo(12);
  });

  it('item in the notch of an L-shaped room fails inside', () => {
    const rs = validateLayout(room(lShape), [item('a', 3, 1, 0.8, 0.8), item('b', 1, 3, 0.8, 0.8)]);
    expect(get(rs, 'inside:a').result).toBe('fail');
    expect(get(rs, 'inside:a').details).toMatch(/cm outside/);
    expect(get(rs, 'inside:b').result).toBe('pass');
  });

  it('item straddling the L reflex corner fails', () => {
    const rs = validateLayout(room(lShape), [item('a', 2.2, 1.8, 1, 1)]);
    expect(get(rs, 'inside:a').result).toBe('fail');
  });

  it('trapezoid room: centre item passes, item in the slanted corner fails', () => {
    const m = room(trapezoid);
    expect(get(validateLayout(m, []), 'room:s1').measured).toBeCloseTo(9);
    const rs = validateLayout(m, [item('in', 2, 1.5, 1, 1), item('out', 0.4, 0.4, 0.6, 0.6)]);
    expect(get(rs, 'inside:in').result).toBe('pass');
    expect(get(rs, 'inside:out').result).toBe('fail');
  });

  it('two overlapping items fail with overlap depth', () => {
    const rs = validateLayout(room(rect(3, 4)), [item('a', 1, 1, 1, 1), item('b', 1.7, 1, 1, 1), item('rug', 1, 1, 2, 2, { category: 'rug' })]);
    const r = get(rs, 'overlap:a:b');
    expect(r.result).toBe('fail');
    expect(r.measured).toBeCloseTo(0.3);
    expect(rs.some((x) => x.id.includes('rug') && x.rule === 'No overlap')).toBe(false);
  });

  it('chair inside the table clearance fails', () => {
    const table = item('table', 1.5, 2, 1.2, 0.8, { clearance: { front: 0.7, back: 0, left: 0, right: 0 } });
    const chair = item('chair', 1.5, 2.7, 0.4, 0.4);
    const r = get(validateLayout(room(rect(3, 4)), [table, chair]), 'clearance:table:front');
    expect(r.result).toBe('fail');
    expect(r.threshold).toBe(0.7);
    expect(r.measured!).toBeLessThan(0.7);
    expect(r.subjectIds).toContain('chair');
  });

  it('a chair may sit in the front zone of the desk it belongs to, facing it', () => {
    // Desk against the top wall, front facing +y; chair 10 cm in front of it, turned to face the desk.
    const desk = item('desk', 1.5, 0.31, 1.2, 0.6, { category: 'desk', clearance: { front: 0.75, back: 0, left: 0, right: 0 } });
    const chair = item('chair', 1.5, 0.96, 0.5, 0.5, { category: 'chair', rotation: Math.PI, clearance: { front: 0.75, back: 0, left: 0, right: 0 } });
    const rs = validateLayout(room(rect(3, 4)), [desk, chair]);
    expect(rs.filter((r) => r.result === 'fail').map((r) => r.details)).toEqual([]);
    expect(get(rs, 'clearance:all').result).toBe('pass');
  });

  it('a chair in the zone of a desk it does not belong to still fails', () => {
    const deskB = item('deskB', 1, 1, 1.2, 0.6, { category: 'desk', clearance: { front: 1.5, back: 0, left: 0, right: 0 } });
    const deskA = item('deskA', 2.2, 2.4, 0.6, 0.6, { category: 'desk' });
    const chair = item('chair', 1.4, 2.4, 0.4, 0.4, { category: 'chair' }); // nearer deskA, inside deskB's zone
    const r = get(validateLayout(room(rect(3, 4)), [deskB, deskA, chair]), 'clearance:deskB:front');
    expect(r.result).toBe('fail');
    expect(r.subjectIds).toContain('chair');
  });

  it('a seated chair still may not overlap its desk', () => {
    const desk = item('desk', 1.5, 1, 1.2, 0.6, { category: 'desk', clearance: { front: 0.75, back: 0, left: 0, right: 0 } });
    const chair = item('chair', 1.5, 1.4, 0.5, 0.5, { category: 'chair', rotation: Math.PI });
    expect(get(validateLayout(room(rect(3, 4)), [desk, chair]), 'overlap:desk:chair').result).toBe('fail');
  });

  it('rotated clearance hits a wall', () => {
    // Rotated 90 deg: front faces -x, towards the left wall 0.5 m away.
    const bed = item('bed', 0.9, 2, 1.4, 0.8, { rotation: Math.PI / 2, clearance: { front: 0.6, back: 0, left: 0, right: 0 } });
    const rs = validateLayout(room(rect(3, 4)), [bed]);
    expect(get(rs, 'clearance:bed:front').result).toBe('fail');
  });

  it('door swing blocked by a wardrobe fails', () => {
    const m = room(rect(3, 4), [opening('d', 'door', 2, 1.5, 0.8, 'in')]);
    const rs = validateLayout(m, [item('wardrobe', 1.5, 3.6, 1, 0.6, { h: 2 })]);
    expect(get(rs, 'swing:d').result).toBe('fail');
    expect(get(rs, 'swing:d').subjectIds[0]).toBe('wardrobe');
    expect(get(rs, 'approach:d').result).toBe('fail');
    expect(get(validateLayout(m, []), 'swing:d').result).toBe('pass');
  });

  it('tall item in front of a window fails', () => {
    const m = room(rect(3, 4), [opening('w', 'window', 0, 1.5, 1.2)]);
    expect(get(validateLayout(m, [item('shelf', 1.5, 0.2, 1, 0.3, { h: 1.8 })]), 'window:w').result).toBe('fail');
    expect(get(validateLayout(m, [item('bench', 1.5, 0.2, 1, 0.3, { h: 0.5 })]), 'window:w').result).toBe('pass');
  });

  it('sofa bed that cannot unfold fails', () => {
    const sofa = item('sofa', 1.5, 3, 2, 0.9, { unfoldedD: 2.1 });
    expect(get(validateLayout(room(rect(3, 4)), [sofa]), 'unfold:sofa').result).toBe('fail');
    expect(get(validateLayout(room(rect(3, 4)), [{ ...sofa, y: 0.6 }]), 'unfold:sofa').result).toBe('pass');
  });

  it('item taller than the ceiling fails', () => {
    const r = get(validateLayout(room(rect(3, 4), [], 2.4), [item('tall', 1, 1, 0.5, 0.5, { h: 2.6 })]), 'ceiling:tall');
    expect(r.result).toBe('fail');
  });

  it('self-intersecting polygon is invalid', () => {
    expect(get(validateLayout(room(bowtie), []), 'room:s1').result).toBe('fail');
  });

  it('opening beyond its wall fails', () => {
    const r = get(validateLayout(room(rect(3, 4), [opening('w', 'window', 0, 2.8, 1)]), []), 'opening:w');
    expect(r.result).toBe('fail');
    expect(r.measured).toBeCloseTo(0.3);
  });

  describe('route', () => {
    const m = room(rect(3, 4), [opening('d', 'door', 2, 1.5, 0.8, 'in'), opening('w', 'window', 0, 1.5, 1.2)]);
    const req = reqs({ routeTargets: [{ kind: 'window' }], minRouteWidthM: 0.8 });

    it('wall-to-wall bookshelf blocks the route', () => {
      const r = get(validateLayout(m, [item('shelf', 1.5, 2, 3, 0.3, { h: 2 })], req), 'route:d:w');
      expect(r.result).toBe('fail');
      expect(r.measured).toBeLessThan(0.8);
      expect(r.subjectIds).toContain('shelf');
    });

    it('1.0 m gap lets the route through', () => {
      const r = get(validateLayout(m, [item('shelf', 1, 2, 2, 0.3, { h: 2 })], req), 'route:d:w');
      expect(r.result).toBe('pass');
      expect(r.measured!).toBeGreaterThan(2);
    });

    it('no doors -> route unknown', () => {
      const r = get(validateLayout(room(rect(3, 4), [opening('w', 'window', 0, 1.5, 1.2)]), [], req), 'route:nodoor');
      expect(r.result).toBe('unknown');
    });
  });

  it('budget over fails, owned items excluded', () => {
    const fs = [item('a', 1, 1, 0.5, 0.5, { priceSek: 6000 }), item('b', 2, 2, 0.5, 0.5, { priceSek: 5000 }), item('c', 1, 3, 0.5, 0.5, { priceSek: 9000, owned: true })];
    const r = get(validateLayout(room(rect(3, 4)), fs, reqs({ budgetSek: 10000 })), 'budget');
    expect(r.result).toBe('fail');
    expect(r.measured).toBe(11000);
    expect(get(validateLayout(room(rect(3, 4)), fs, reqs({ budgetSek: 12000 })), 'budget').result).toBe('pass');
    expect(get(validateLayout(room(rect(3, 4)), fs), 'budget').result).toBe('unknown');
  });

  it('summarize and firstFailure', () => {
    const rs = validateLayout(room(rect(3, 4)), [item('a', 1, 1, 1, 1), item('b', 1.5, 1, 1, 1)]);
    const s = summarize(rs);
    expect(s.pass + s.fail + s.unknown).toBe(rs.length);
    expect(firstFailure(rs)?.id).toBe('overlap:a:b');
  });

  it('seeded random rectangles with a centred item pass inside', () => {
    const rnd = mulberry32(42);
    for (let i = 0; i < 200; i++) {
      const W = 1.5 + rnd() * 6, H = 1.5 + rnd() * 6;
      const w = 0.2 + rnd() * (W - 0.3), d = 0.2 + rnd() * (H - 0.3);
      const rs = validateLayout(room(rect(W, H)), [item('x', W / 2, H / 2, w, d)]);
      expect(get(rs, 'inside:x').result).toBe('pass');
      expect(get(rs, 'room:s1').result).toBe('pass');
    }
  });
});
