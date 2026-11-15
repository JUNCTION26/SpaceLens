import { describe, expect, it } from 'vitest';
import type { FurnitureItem, SpaceModel } from '../../core/types';
import { makeItem, makeOwnItem } from '../furniture/catalog';
import { opening, rect, room } from '../referee/fixtures';
import { applyMoves, planBudget, totalAfter, totalFor } from './plan';

const at = (id: string, x: number, y: number, rotation = 0, patch: Partial<FurnitureItem> = {}) => ({ ...makeItem(id, { x, y, rotation }), ...patch });
const base = room(rect(5, 4), [opening('d', 'door', 2, 4.4, 0.9, 'in')]);
const withItems = (items: FurnitureItem[]): SpaceModel => ({ ...base, furniture: items });
const items = (): FurnitureItem[] => [
  at('desk-160', 1, 0.4, 0, { id: 'desk' }), at('bed-160', 3.5, 2.5, 0, { id: 'bed' }), at('rug-200', 2.5, 2.5, 0, { id: 'rug' }),
  at('plant', 4.6, 3.7, 0, { id: 'plant' }), at('floor-lamp', 4.7, 0.3, 0, { id: 'lamp' }),
];

describe('planBudget', () => {
  it('reaches the budget with the fewest moves', () => {
    const m = withItems(items());
    const p = planBudget(m, totalFor(m.furniture) - 2400);
    const picked = p.moves.filter((x) => x.suggested);
    expect(p.afterSek).toBeLessThanOrEqual(p.budgetSek);
    expect(picked.length).toBe(1);
    expect(totalAfter(m, picked)).toBe(p.afterSek);
  });

  it('suggests nothing when under budget', () => {
    const p = planBudget(withItems(items()), 999999);
    expect(p.overSek).toBeLessThan(0);
    expect(p.moves.some((x) => x.suggested)).toBe(false);
  });

  it('owned items cost nothing and are kept', () => {
    const own = makeOwnItem('Old sofa', 'sofa', 2, 0.9, 0.8, { x: 2, y: 2 });
    const m = withItems([own, at('plant', 4, 3, 0, { id: 'plant' })]);
    expect(totalFor(m.furniture)).toBe(390);
    const p = planBudget(m, 0);
    const k = p.moves.find((x) => x.itemId === own.id)!;
    expect(k.kind).toBe('keep');
    expect(k.tag).toBe('Already owned');
    expect(applyMoves(m, p.moves).some((o) => 'id' in o && o.id === own.id)).toBe(false);
  });

  it('never drops essentials, even at a zero budget', () => {
    const m = withItems(items());
    const p = planBudget(m, 0);
    const essentialIds = ['desk', 'bed'];
    expect(p.moves.some((x) => x.kind === 'drop' && essentialIds.includes(x.itemId))).toBe(false);
    const ops = applyMoves(m, p.moves);
    expect(ops.some((o) => o.type === 'REMOVE_OBJECT' && essentialIds.includes(o.id))).toBe(false);
    expect(ops.some((o) => o.type === 'REMOVE_OBJECT' && o.id === 'rug')).toBe(true);
  });

  it('swaps stay inside the same footprint, back edge in place', () => {
    for (const rotation of [0, Math.PI / 2, Math.PI]) {
      const f = at('desk-160', 2, 1, rotation, { id: 'desk' });
      const m = withItems([f]);
      const op = applyMoves(m, planBudget(m, 0).moves).find((o) => o.type === 'UPDATE_OBJECT');
      expect(op).toBeTruthy();
      if (op?.type !== 'UPDATE_OBJECT') return;
      const n = { ...f, ...op.patch } as FurnitureItem;
      expect(n.w).toBeLessThanOrEqual(f.w + 1e-6);
      expect(n.d).toBeLessThanOrEqual(f.d + 1e-6);
      const back = (i: FurnitureItem) => [i.x + Math.sin(i.rotation) * (i.d / 2), i.y - Math.cos(i.rotation) * (i.d / 2)];
      expect(back(n)[0]).toBeCloseTo(back(f)[0], 6);
      expect(back(n)[1]).toBeCloseTo(back(f)[1], 6);
    }
  });
});
