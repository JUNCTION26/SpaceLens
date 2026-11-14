import { describe, expect, it } from 'vitest';
import { item, opening, rect, reqs, room } from '../referee/fixtures';
import { validateLayout } from '../referee/validate';
import { placeWallItems } from './wallItems';

describe('wall-mounted items', () => {
  // 3 x 3 room: door on the bottom wall, window on the right wall.
  const model = room(rect(3, 3), [opening('door', 'door', 0, 0.6, 0.8, 'in'), opening('win', 'window', 1, 1.5, 1.2)]);
  const bed = item('bed', 1.5, 2.0, 1.4, 2.0, { category: 'bed', h: 0.9, rotation: Math.PI });

  it('hang flat on a wall, clear of doors and windows, and pass the referee', () => {
    const posters = [1, 2, 3].map((k) => item(`poster${k}`, 0, 0, 0.5, 0.03, { category: 'poster', name: `Poster ${k}`, h: 0.7, mount: 'wall' }));
    const { placed, skipped } = placeWallItems(model, [bed], posters);
    expect(skipped).toHaveLength(0);
    const rs = validateLayout(model, [bed, ...placed], reqs({ routeTargets: [{ kind: 'window' }] }));
    for (const p of placed) {
      expect(rs.find((r) => r.id === `wall:${p.id}`)?.result, p.name).toBe('pass');
      expect(p.elevationM! + p.h / 2).toBeCloseTo(1.4, 1);
    }
    // Hanging them changes nothing on the floor: the same checks fail with and without them.
    const ids = new Set(placed.map((p) => p.id));
    expect(rs.filter((r) => r.result === 'fail' && r.subjectIds.some((id) => ids.has(id))).map((r) => r.details)).toEqual([]);
    const bare = validateLayout(model, [bed], reqs({ routeTargets: [{ kind: 'window' }] }));
    expect(rs.filter((r) => r.result === 'fail').length).toBe(bare.filter((r) => r.result === 'fail').length);
  });

  it('never block a route or count as floor overlap', () => {
    // A poster hung right in the door approach and over the walkway stays out of floor checks.
    const p = item('p', 1.5, 0.015, 0.6, 0.03, { category: 'poster', h: 0.6, mount: 'wall', elevationM: 2.1 - 0.6 - 0.05, rotation: 0 });
    const rs = validateLayout(model, [p], reqs({ routeTargets: [{ kind: 'window' }] }));
    expect(rs.some((r) => r.rule === 'Clear route' && r.result === 'fail')).toBe(false);
    expect(rs.some((r) => r.rule === 'Door approach' && r.result === 'fail')).toBe(false);
  });

  it('the referee fails a wall item that covers a window or floats off the wall', () => {
    const over = item('over', 3 - 0.015, 1.5, 0.6, 0.03, { name: 'Poster', h: 0.6, mount: 'wall', elevationM: 1.1, rotation: Math.PI / 2 });
    const off = item('off', 1.5, 1.5, 0.6, 0.03, { name: 'Sign', h: 0.3, mount: 'wall', elevationM: 1.4 });
    const rs = validateLayout(model, [over, off]);
    expect(rs.find((r) => r.id === 'wall:over')?.details).toMatch(/covers a window/);
    expect(rs.find((r) => r.id === 'wall:off')?.result).toBe('fail');
  });
});
