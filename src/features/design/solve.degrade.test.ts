import { describe, expect, it } from 'vitest';
import { makeItem } from '../furniture/catalog';
import { opening, rect, reqs, room } from '../referee/fixtures';
import { validateLayout } from '../referee/validate';
import { defaultProgram } from './program';
import { solveProgram } from './solve';

const at = (id: string, key: string) => ({ ...makeItem(id, { x: 1, y: 1, rotation: 0 }), id: key });

describe('solveProgram degrades instead of returning nothing', () => {
  it('waiting room with eight chairs returns layouts with at least five chairs and names what was left out', async () => {
    const m = room(rect(4, 5), [opening('door', 'door', 2, 2, 0.9, 'in'), opening('win', 'window', 0, 2, 1.2)]);
    const items = [
      ...Array.from({ length: 8 }, (_, i) => at('waiting-chair', `c${i}`)),
      at('reception-desk', 'desk'), at('coffee-table', 'low'), at('plant', 'p1'), at('plant', 'p2'),
    ];
    const req = reqs({ routeTargets: [{ kind: 'window' }], minRouteWidthM: 0.9 });
    const res = await solveProgram(m, items, defaultProgram(m, items, req), { seed: 3, req });
    expect(res.candidates.length).toBeGreaterThan(0);
    const best = res.candidates[0];
    expect(best.furniture.filter((f) => f.catalogId === 'waiting-chair').length).toBeGreaterThanOrEqual(5);
    expect(best.furniture.some((f) => f.catalogId === 'reception-desk')).toBe(true);
    expect(res.infeasibility?.reasons[0]).toMatch(/left out/i);
    expect(best.assumptions.some((a) => /left out/i.test(a))).toBe(true);
    expect(validateLayout(m, best.furniture, req).some((c) => c.result === 'fail')).toBe(false);
  }, 60000);

  it('narrow L-shaped hall keeps the shoe cabinet', async () => {
    const poly = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 0.9 }, { x: 0.9, y: 0.9 }, { x: 0.9, y: 3.5 }, { x: 0, y: 3.5 }];
    const m = room(poly, [opening('door', 'door', 4, 0.45, 0.85, 'in')]);
    const items = [at('shoe-bench', 'shoes'), at('plant', 'p1')];
    const req = reqs({ minRouteWidthM: 0.8 });
    const res = await solveProgram(m, items, defaultProgram(m, items, req), { seed: 2, req });
    expect(res.candidates.length).toBeGreaterThan(0);
    expect(res.candidates[0].furniture.some((f) => f.catalogId === 'shoe-bench')).toBe(true);
    expect(res.infeasibility?.reasons.length).toBeGreaterThan(0);
  }, 60000);
});

describe('degraded layouts are marked and judged honestly', () => {
  const hall = () => {
    const poly = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 0.9 }, { x: 0.9, y: 0.9 }, { x: 0.9, y: 3.5 }, { x: 0, y: 3.5 }];
    const m = room(poly, [opening('door', 'door', 4, 0.45, 0.85, 'in')]);
    const items = [at('shoe-bench', 'shoes'), at('plant', 'p1')];
    return { m, items, req: reqs({ minRouteWidthM: 0.8 }) };
  };
  it('carries a machine-readable flag and reports the referee at full clearances', async () => {
    const { m, items, req } = hall();
    const res = await solveProgram(m, items, defaultProgram(m, items, req), { seed: 2, req });
    const c = res.candidates[0];
    expect(c.degraded).toBeDefined();
    expect(c.degraded!.clearanceFactor).toBeGreaterThanOrEqual(0.25);
    const full = validateLayout(m, c.furniture.map((f) => ({ ...f, clearance: items.find((i) => i.id === f.id)!.clearance })), req);
    expect(c.checks.map((k) => k.result)).toEqual(full.map((k) => k.result));
  }, 60000);
  it('a layout found at 25% clearance is not reported as passing', async () => {
    const m = room(rect(3, 0.9), [opening('door', 'door', 1, 0.45, 0.7, 'in')]);
    const b = at('shoe-bench', 'a');
    const items = [{ ...b, clearance: { ...b.clearance, back: 0.6, left: 0.6, right: 0.6 } }];
    const req = reqs({ minRouteWidthM: 0.5 });
    const res = await solveProgram(m, items, defaultProgram(m, items, req), { seed: 1, req });
    const c = res.candidates[0];
    expect(c.degraded?.clearanceFactor).toBe(0.25);
    expect(c.checks.some((k) => k.result === 'fail')).toBe(true);
    expect(c.assumptions.join(' ')).toMatch(/does not pass/i);
  }, 60000);
});
