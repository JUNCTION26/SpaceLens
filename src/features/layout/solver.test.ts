import { describe, expect, it } from 'vitest';
import type { Requirements, SpaceModel } from '../../core/types';
import { convexOverlap, itemCorners } from '../../core/geometry';
import { CATALOG } from '../furniture/catalog';
import { generateLayouts, genomeOf } from './solver';

const ensure = (id: string, category: string, w: number, d: number, h: number, front: number, price: number) => {
  if (!CATALOG.some((c) => c.id === id)) CATALOG.push({ id, name: id, category, w, d, h, clearance: { front, back: 0, left: 0, right: 0 }, priceSek: price, color: '#888', tags: [] });
};
ensure('t-desk', 'desk', 1.2, 0.6, 0.74, 0.8, 1500);
ensure('t-chair', 'chair', 0.5, 0.5, 0.8, 0, 500);
ensure('t-bed', 'bed', 1.4, 2.0, 0.5, 0.6, 4000);
ensure('t-wardrobe', 'wardrobe', 1.0, 0.6, 2.0, 0.6, 3000);

function room(W: number, H: number): SpaceModel {
  const wall = { thicknessM: 0.1, sourceKind: 'manual' as const, status: 'verified' as const };
  return {
    id: 'm', name: 'r', version: 1, units: 'm', ceilingM: 2.5, sourceLabel: 't', furniture: [], measurements: [], evidence: [],
    spaces: [{ id: 's', name: 'r', polygon: [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }], walls: [wall, wall, wall, wall] }],
    openings: [
      { id: 'd', kind: 'door', spaceId: 's', wallIndex: 2, offsetM: W - 0.6, widthM: 0.8, heightM: 2, sillM: 0, swing: 'in', hinge: 'start', sourceKind: 'manual', status: 'verified' },
      { id: 'w', kind: 'window', spaceId: 's', wallIndex: 0, offsetM: W / 2, widthM: 1.2, heightM: 1.2, sillM: 0.9, swing: 'none', hinge: 'start', sourceKind: 'manual', status: 'verified' },
    ],
  };
}
const req = (ids: string[]): Requirements => ({
  purpose: 'bedroom', people: 1, budgetSek: null, items: ids.map((catalogId) => ({ catalogId, qty: 1 })), routeTargets: [{ kind: 'window' }],
  minRouteWidthM: 0.8, style: '', lockedIds: [], notes: [], questions: [], compiledBy: 'rules',
});

describe('generateLayouts', () => {
  it('finds a feasible layout in a 3.4 x 4.2 room', async () => {
    const m = room(3.4, 4.2);
    const { candidates } = await generateLayouts(m, req(['t-desk', 't-chair', 't-bed']), { seed: 3, timeBudgetMs: 2000 });
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.checks.every((k) => k.result !== 'fail')).toBe(true);
      for (const f of c.furniture) for (const p of itemCorners(f)) { expect(p.x).toBeGreaterThan(-0.02); expect(p.x).toBeLessThan(3.42); expect(p.y).toBeGreaterThan(-0.02); expect(p.y).toBeLessThan(4.22); };
      for (let i = 0; i < c.furniture.length; i++) for (let j = i + 1; j < c.furniture.length; j++)
        expect(convexOverlap(itemCorners(c.furniture[i]), itemCorners(c.furniture[j]))).toBeLessThan(0.01);
      expect(genomeOf(c, m).focal).toBeTruthy();
    }
  }, 20000);

  it('explains why a 2 x 2 room cannot fit bed, wardrobe and desk', async () => {
    const { candidates, infeasibility } = await generateLayouts(room(2, 2), req(['t-bed', 't-wardrobe', 't-desk']), { seed: 1, timeBudgetMs: 800 });
    expect(candidates.length).toBe(0);
    expect(infeasibility?.reasons.length).toBeGreaterThan(0);
    expect(infeasibility?.relaxations.length).toBeGreaterThan(0);
  }, 20000);
});
