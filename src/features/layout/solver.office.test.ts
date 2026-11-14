import { describe, expect, it } from 'vitest';
import { applyOp } from '../../core/ops';
import { sampleRoom } from '../../core/sample';
import type { Requirements } from '../../core/types';
import { opening, rect, room } from '../referee/fixtures';
import { validateLayout } from '../referee/validate';
import { generateLayouts } from './solver';

/** Home office for two in the 3.6 x 4.2 m sample room: keep the existing desk, add a desk, two chairs and a bookshelf. */
function officeRequest(): Requirements {
  return {
    purpose: 'office', people: 2, budgetSek: 12000,
    items: [
      { catalogId: 'desk-140', qty: 1, keepExistingId: 'f_desk' },
      { catalogId: 'desk-120', qty: 1 },
      { catalogId: 'desk-chair', qty: 2 },
      { catalogId: 'bookshelf', qty: 1 },
    ],
    routeTargets: [{ kind: 'window' }], minRouteWidthM: 0.8, style: '', lockedIds: ['f_desk'], notes: [], questions: [], compiledBy: 'rules',
  };
}
const officeRoom = () => applyOp(sampleRoom(), { type: 'SET_WALL_LENGTH', spaceId: 's1', wallIndex: 0, lengthM: 3.6 });

describe('generateLayouts: home office for two', () => {
  it('finds at least two layouts that pass every referee check', async () => {
    const model = officeRoom(), req = officeRequest();
    const t0 = performance.now();
    const { candidates, infeasibility } = await generateLayouts(model, req, { seed: 1 });
    const ms = performance.now() - t0;
    expect(infeasibility).toBeNull();
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(ms).toBeLessThan(6000);
    for (const c of candidates) {
      const checks = validateLayout(model, c.furniture, req);
      expect(checks.filter((k) => k.result === 'fail').map((k) => k.details)).toEqual([]);
      expect(c.furniture.filter((f) => f.category === 'desk')).toHaveLength(2);
      expect(c.furniture.filter((f) => f.category === 'chair')).toHaveLength(2);
      // The kept desk stays where it is.
      const kept = c.furniture.find((f) => f.id === 'f_desk')!;
      expect(kept.x).toBeCloseTo(0.4);
      expect(kept.y).toBeCloseTo(1.4);
    }
  }, 20000);

  it('seats every chair at a desk front, facing the desk', async () => {
    const { candidates } = await generateLayouts(officeRoom(), officeRequest(), { seed: 2, variants: 2 });
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      const desks = c.furniture.filter((f) => f.category === 'desk');
      for (const chair of c.furniture.filter((f) => f.category === 'chair')) {
        const desk = desks.reduce((a, b) => (Math.hypot(a.x - chair.x, a.y - chair.y) <= Math.hypot(b.x - chair.x, b.y - chair.y) ? a : b));
        // Chair front direction points at the desk centre.
        const fx = -Math.sin(chair.rotation), fy = Math.cos(chair.rotation);
        const dx = desk.x - chair.x, dy = desk.y - chair.y, l = Math.hypot(dx, dy);
        expect((fx * dx + fy * dy) / l).toBeGreaterThan(0.95);
        expect(l).toBeLessThan(desk.d / 2 + desk.clearance.front);
      }
    }
  }, 20000);

  it('still reports infeasibility for the same office in a 2 x 2 m room', async () => {
    const model = room(rect(2, 2), [opening('door1', 'door', 2, 1.4, 0.8, 'in'), opening('win1', 'window', 0, 1, 1)]);
    const req = { ...officeRequest(), items: officeRequest().items.map((i) => ({ ...i, keepExistingId: undefined })), lockedIds: [] };
    const { candidates, infeasibility } = await generateLayouts(model, req, { seed: 1, timeBudgetMs: 800 });
    expect(candidates).toHaveLength(0);
    expect(infeasibility?.reasons.length).toBeGreaterThan(0);
  }, 20000);
});
