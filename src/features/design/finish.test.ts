import { describe, expect, it } from 'vitest';
import type { FurnitureItem } from '../../core/types';
import { makeItem } from '../furniture/catalog';
import { opening, rect, reqs, room } from '../referee/fixtures';
import { validateLayout } from '../referee/validate';
import { finishCandidates, finishLayout, wallGaps } from './finish';
import { localY } from './place.testkit';

const at = (catalogId: string, id: string, x: number, y: number, rotation = 0): FurnitureItem => ({ ...makeItem(catalogId, { x, y, rotation }), id });
const overlaps = (m: ReturnType<typeof room>, fs: FurnitureItem[]) =>
  new Set(validateLayout(m, fs, reqs()).filter((r) => r.rule === 'No overlap' && r.result === 'fail').map((r) => r.id));
const failures = (m: ReturnType<typeof room>, fs: FurnitureItem[]) =>
  new Set(validateLayout(m, fs, reqs()).filter((r) => r.result === 'fail').map((r) => `${r.id}|${[...r.subjectIds].sort().join(',')}`));

// 5 x 4 m living room: sofa on the bottom wall facing up, 7 cm off the wall and off centre; TV 10 cm off the top wall.
const living = () => room(rect(5, 4), [opening('door', 'door', 3, 1.0, 0.9, 'in'), opening('win', 'window', 1, 1.0, 1.2)]);
const livingItems = () => [
  at('sofa-3', 'sofa', 2.3, 4 - 0.46 - 0.07, Math.PI),
  at('coffee-table', 'ct', 2.3, 4 - 0.46 - 0.07 - 0.46 - 0.3 - 0.3, Math.PI),
  at('tv-unit', 'tv', 2.3, 0.2 + 0.1, 0),
  at('armchair', 'arm', 4.0, 2.3, -Math.PI / 2 + 0.03),
];

// 3.4 x 4.2 m bedroom: bed on the top wall, 8 cm off it, nightstands at unequal gaps; wardrobe 10 cm off the left wall.
const bedroom = () => room(rect(3.4, 4.2), [opening('door', 'door', 2, 2.8, 0.8, 'in'), opening('win', 'window', 1, 2.6, 1.2)]);
const bedItems = () => [
  at('bed-double', 'bed', 1.8, 1.08, 0),
  at('nightstand', 'nsL', 1.8 - 0.7 - 0.05 - 0.225, 0.26, 0),
  at('nightstand', 'nsR', 1.8 + 0.7 + 0.12 + 0.225, 0.27, 0),
  at('wardrobe-100', 'wardrobe', 0.1 + 0.3, 3.0, -Math.PI / 2),
];

describe('finishLayout', () => {
  it('puts a rug under the sofa group: under the coffee table and the sofa front legs', () => {
    const m = living();
    const { furniture, added } = finishLayout(m, livingItems(), { req: reqs() });
    const rug = furniture.find((f) => f.category === 'rug');
    expect(rug, `added ${added.join(', ')}`).toBeTruthy();
    const sofa = furniture.find((f) => f.id === 'sofa')!, ct = furniture.find((f) => f.id === 'ct')!;
    // Coffee table centre on the rug, rug starts under the sofa's front.
    const ry = localY(sofa, rug!), short = Math.min(rug!.w, rug!.d);
    expect(ry - short / 2).toBeLessThan(sofa.d / 2 - 0.05);
    expect(ry + short / 2).toBeGreaterThan(localY(sofa, ct) + ct.d / 2);
    expect(Math.abs(Math.cos(rug!.rotation - sofa.rotation)) > 0.99 ? rug!.w : rug!.d).toBeGreaterThanOrEqual(sofa.w * 0.9);
    // A floor lamp beside the sofa and a plant near the window.
    expect(furniture.some((f) => f.category === 'lamp')).toBe(true);
    expect(furniture.some((f) => f.category === 'plant')).toBe(true);
  });

  it('gives each nightstand a lamp and evens their gaps to the bed', () => {
    const m = bedroom();
    const { furniture } = finishLayout(m, bedItems(), { req: reqs() });
    const bed = furniture.find((f) => f.id === 'bed')!;
    for (const id of ['nsL', 'nsR']) {
      const ns = furniture.find((f) => f.id === id)!;
      const lamps = furniture.filter((f) => f.category === 'lamp' && Math.hypot(f.x - ns.x, f.y - ns.y) < 0.9);
      expect(lamps.length, id).toBe(1);
    }
    const gap = (id: string) => { const ns = furniture.find((f) => f.id === id)!; return Math.abs(ns.x - bed.x) - bed.w / 2 - ns.w / 2; };
    expect(gap('nsL')).toBeCloseTo(gap('nsR'), 3);
    expect(furniture.some((f) => f.category === 'rug')).toBe(true);
  });

  it('leaves no 2-14 cm gaps to the walls', () => {
    for (const [m, items] of [[living(), livingItems()], [bedroom(), bedItems()]] as const) {
      expect(wallGaps(m, items).some((g) => g.gap >= 0.02 && g.gap <= 0.14)).toBe(true);
      const { furniture } = finishLayout(m, items, { req: reqs() });
      const bad = wallGaps(m, furniture).filter((g) => g.gap >= 0.02 && g.gap <= 0.14);
      expect(bad, JSON.stringify(bad)).toEqual([]);
    }
  });

  it('adds no overlap and no new failure', () => {
    for (const [m, items] of [[living(), livingItems()], [bedroom(), bedItems()]] as const) {
      const before = overlaps(m, items), fb = failures(m, items);
      const { furniture, added } = finishLayout(m, items, { req: reqs() });
      expect(added.length).toBeGreaterThan(0);
      for (const id of overlaps(m, furniture)) expect(before.has(id), id).toBe(true);
      for (const k of failures(m, furniture)) expect(fb.has(k), k).toBe(true);
    }
  });

  it('never moves a locked piece and is deterministic', () => {
    const m = bedroom(), items = bedItems().map((f) => (f.id === 'bed' ? { ...f, locked: true } : f));
    const a = finishLayout(m, items, { req: reqs() }), b = finishLayout(m, items, { req: reqs() });
    const bed = a.furniture.find((f) => f.id === 'bed')!;
    expect([bed.x, bed.y, bed.rotation]).toEqual([1.8, 1.08, 0]);
    expect(a.furniture).toEqual(b.furniture);
  });

  it('refreshes checks and cost on finished candidates', () => {
    const m = living(), items = livingItems();
    const cand = { id: 'c1', name: 'A', summary: '', parentVersion: 1, furniture: items, metrics: { openAreaM2: 0, costSek: 1000, minClearanceM: null, routeLenM: null, score: 50 }, checks: [], assumptions: [], generator: 'test' };
    const out = finishCandidates(m, { candidates: [cand] }, reqs()).candidates[0];
    expect(out.furniture.length).toBeGreaterThan(items.length);
    expect(out.metrics.costSek).toBeGreaterThan(1000);
    expect(out.checks.length).toBeGreaterThan(0);
  });
});
