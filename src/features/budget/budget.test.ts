import { describe, expect, it } from 'vitest';
import type { FurnitureItem } from '../../core/types';
import { makeItem } from '../furniture/catalog';
import { opening, rect, room } from '../referee/fixtures';
import { validateLayout } from '../referee/validate';
import { argueItems } from './argue';
import { kr, totalOf } from './money';
import { applySwaps, newFailures, optimiseBudget } from './optimise';
import { planPhases } from './phases';

// A 5 x 4 m shared office-bedroom: wall-backed pieces, nothing overlapping, room to walk.
const model = room(rect(5, 4), [opening('d', 'door', 2, 4.4, 0.9, 'in'), opening('w', 'window', 0, 2.5, 1.6)]);
const at = (id: string, x: number, y: number, rotation = 0, patch: Partial<FurnitureItem> = {}) => ({ ...makeItem(id, { x, y, rotation }), ...patch });

function office(): FurnitureItem[] {
  return [
    at('desk-160', 1.0, 0.4, 0, { id: 'deskA' }),
    at('desk-160', 3.0, 0.4, 0, { id: 'deskB' }),
    at('office-chair', 1.0, 1.35, Math.PI, { id: 'chA' }),
    at('office-chair', 3.0, 1.35, Math.PI, { id: 'chB' }),
    at('bookshelf', 4.86, 2.6, Math.PI / 2, { id: 'shelf' }),
    at('rug-160', 2.5, 2.6, 0, { id: 'rug' }),
    at('plant', 4.6, 3.7, 0, { id: 'plant' }),
    at('floor-lamp', 4.7, 0.3, 0, { id: 'lamp' }),
  ];
}

const fails = (items: FurnitureItem[]) => validateLayout(model, items).filter((r) => r.result === 'fail');

describe('budget optimiser', () => {
  it('fixture has no failing checks', () => {
    expect(fails(office()).map((f) => f.details)).toEqual([]);
  });

  it('reaches a reachable target without adding a failing check', () => {
    const items = office(), before = totalOf(items);
    const target = before - 3000;
    const r = optimiseBudget(model, items, target);
    expect(r.feasible).toBe(true);
    expect(r.total).toBeLessThanOrEqual(target);
    expect(r.saved).toBe(before - r.total);
    expect(r.plan.length).toBeGreaterThan(0);
    expect(newFailures(model, items, applySwaps(items, r.plan)).map((f) => f.details)).toEqual([]);
    expect(totalOf(applySwaps(items, r.plan))).toBe(r.total);
  });

  it('never replaces or drops owned items', () => {
    const items = office().map((f) => (f.id === 'deskA' || f.id === 'rug' ? { ...f, owned: true, priceSek: 0, priceStatus: 'owned' as const } : f));
    const r = optimiseBudget(model, items, 3000);
    expect(r.plan.every((s) => s.itemId !== 'deskA' && s.itemId !== 'rug')).toBe(true);
    expect(r.kept.length).toBe(2);
    const after = applySwaps(items, r.plan);
    expect(after.find((f) => f.id === 'deskA')?.catalogId).toBe('desk-160');
    expect(after.some((f) => f.id === 'rug')).toBe(true);
  });

  it('only shrinks or keeps the footprint when swapping', () => {
    const items = office();
    const r = optimiseBudget(model, items, 4000);
    for (const s of r.plan) if (s.after) { expect(s.after.w).toBeLessThanOrEqual(s.before.w + 0.01); expect(s.after.d).toBeLessThanOrEqual(s.before.d + 0.01); expect(s.after.priceSek).toBeLessThan(s.before.priceSek); }
  });

  it('explains an impossible target with the lowest total and what blocks it', () => {
    const items = office().map((f) => (f.category === 'desk' ? { ...f, locked: true } : f));
    const r = optimiseBudget(model, items, 1000);
    expect(r.feasible).toBe(false);
    expect(r.total).toBeGreaterThan(1000);
    expect(r.notes.join(' ')).toMatch(/lowest/);
    expect(r.notes.join(' ')).toContain(kr(2 * 3490));
    expect(r.notes.join(' ')).toMatch(/two desks alone cost/);
    expect(newFailures(model, items, applySwaps(items, r.plan))).toEqual([]);
  });

  it('does nothing when already within budget', () => {
    const items = office();
    const r = optimiseBudget(model, items, 999999);
    expect(r.plan).toEqual([]);
    expect(r.feasible).toBe(true);
  });
});

describe('phases and arguments', () => {
  it('puts sleep and work first, decor last, and totals add up', () => {
    const items = office();
    const ph = planPhases(items, 2000);
    expect(ph.map((p) => p.key)).toEqual(['now', 'next', 'later']);
    expect(ph[0].items.map((f) => f.id)).toContain('deskA');
    expect(ph[2].items.map((f) => f.id)).toEqual(expect.arrayContaining(['rug', 'plant', 'lamp']));
    expect(ph.reduce((t, p) => t + p.total, 0)).toBe(totalOf(items));
    expect(ph[2].paidByMonth).toBe(Math.ceil(totalOf(items) / 2000));
    expect(planPhases(items, 0)[0].paidByMonth).toBeNull();
  });

  it('argues each item from the data', () => {
    const items = office();
    const r = optimiseBudget(model, items, totalOf(items) - 3000);
    const args = argueItems(items, r.plan);
    expect(args.length).toBe(items.length);
    const swapped = r.plan.find((s) => s.kind !== 'drop');
    if (swapped) expect(args.find((a) => a.itemId === swapped.itemId)!.text).toContain(kr(swapped.saving));
    expect(args.every((a) => /estimate/.test(a.text))).toBe(true);
  });
});
