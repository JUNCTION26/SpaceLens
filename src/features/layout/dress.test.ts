import { describe, expect, it } from 'vitest';
import { item, opening, rect, reqs, room } from '../referee/fixtures';
import { validateLayout } from '../referee/validate';
import { evaluateRules } from '../design/rules';
import { dressWalls } from './dress';

// 4 x 3.5 room. Walls: 0 top (y=0), 1 right (x=4), 2 bottom (y=3.5), 3 left (x=0).
// Window centred on the top wall; door on the bottom wall.
const model = room(rect(4, 3.5), [opening('win', 'window', 0, 2.0, 1.2), opening('door', 'door', 2, 0.6, 0.9, 'in')]);
// Sofa with its back to the left wall, facing +x (rotation -90deg: front = (-sin, cos) = (1, 0)).
const sofa = item('sofa', 0.45, 1.75, 2.0, 0.9, { category: 'sofa', h: 0.82, rotation: -Math.PI / 2 });
// Bed with its headboard on the right wall, facing -x.
const bed = item('bed', 3.0, 1.75, 1.4, 2.0, { category: 'bed', h: 0.95, rotation: Math.PI / 2 });
const desk = item('desk', 0.45, 0.3, 0.8, 0.6, { category: 'desk', h: 0.74, rotation: 0 });

describe('wall dressing', () => {
  it('hangs art centred over the sofa, bottom 25 cm above its back', () => {
    const art = dressWalls(model, [sofa]).find((p) => p.category === 'wall-art')!;
    expect(art).toBeTruthy();
    expect(art.mount).toBe('wall');
    expect(art.elevationM).toBeCloseTo(0.82 + 0.25, 3);
    expect(art.y).toBeCloseTo(sofa.y, 3); // centred on the sofa along the wall
    expect(art.x).toBeLessThan(0.1); // on the left wall
    expect(art.x).toBeGreaterThan(0);
    expect(art.w).toBeLessThanOrEqual(sofa.w);
  });

  it('hangs art centred over the bed headboard', () => {
    const art = dressWalls(model, [bed]).find((p) => p.category === 'wall-art')!;
    expect(art.elevationM).toBeCloseTo(0.95 + 0.25, 3);
    expect(art.y).toBeCloseTo(bed.y, 3);
    expect(art.x).toBeGreaterThan(3.9);
  });

  it('flanks each window with a floor-length curtain panel', () => {
    const panels = dressWalls(model, []).filter((p) => p.category === 'curtain');
    expect(panels).toHaveLength(2);
    const xs = panels.map((p) => p.x).sort((a, b) => a - b);
    expect(xs[0]).toBeLessThan(2.0 - 0.6);
    expect(xs[1]).toBeGreaterThan(2.0 + 0.6);
    expect((xs[0] + xs[1]) / 2).toBeCloseTo(2.0, 3);
    for (const p of panels) { expect(p.elevationM).toBe(0); expect(p.h).toBeGreaterThan(2.2); }
  });

  it('puts a shelf over the desk, a mirror in the bedroom and a TV opposite the sofa', () => {
    const out = dressWalls(model, [sofa, desk], { tv: true }).concat(dressWalls(model, [bed]));
    const shelf = out.find((p) => p.category === 'wall-shelf')!;
    expect(shelf.x).toBeCloseTo(desk.x, 3);
    expect(shelf.elevationM!).toBeGreaterThan(1.1);
    expect(out.some((p) => p.category === 'wall-mirror')).toBe(true);
    const tv = out.find((p) => p.category === 'wall-tv')!;
    expect(tv.x).toBeGreaterThan(3.9); // right wall, across from the sofa
    expect(tv.y).toBeCloseTo(sofa.y, 3);
  });

  it('wall items never block walkways or count as floor obstacles', () => {
    const floor = [sofa, desk, bed];
    const dressed = [...floor, ...dressWalls(model, floor, { tv: true })];
    const r = reqs({ routeTargets: [{ kind: 'window' }] });
    const before = validateLayout(model, floor, r), after = validateLayout(model, dressed, r);
    const fails = (rs: typeof before) => rs.filter((x) => x.result === 'fail' && x.rule !== 'Hangs on a wall').map((x) => x.id).sort();
    expect(fails(after)).toEqual(fails(before));
    expect(after.filter((x) => x.rule === 'Hangs on a wall').every((x) => x.result === 'pass')).toBe(true);
    const rb = evaluateRules(model, floor, r), ra = evaluateRules(model, dressed, r);
    expect(ra.map((v) => `${v.ruleId}:${v.score ?? ''}`)).toEqual(rb.map((v) => `${v.ruleId}:${v.score ?? ''}`));
  });
});
