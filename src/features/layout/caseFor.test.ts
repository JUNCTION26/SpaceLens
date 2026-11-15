import { describe, expect, it } from 'vitest';
import type { FurnitureItem, LayoutCandidate, SpaceModel } from '../../core/types';
import { caseFor, leftOutOf, whyText } from './caseFor';

const item = (id: string, category: string, x: number, y: number): FurnitureItem => ({
  id, catalogId: category, name: category, category, x, y, rotation: 0, w: 1, d: 0.6, h: 0.75,
  clearance: { front: 0.6, back: 0, left: 0, right: 0 }, locked: false, owned: false, priceSek: 100, priceStatus: 'catalog', color: '#888', sourceKind: 'catalog',
});
const model: SpaceModel = {
  id: 'm', name: 'Room', version: 1, units: 'm', ceilingM: 2.5, sourceLabel: '', furniture: [], measurements: [], evidence: [],
  openings: [{ id: 'w', kind: 'window', spaceId: 's', wallIndex: 0, offsetM: 2, widthM: 1, heightM: 1.2, sillM: 0.9, swing: 'none' }, { id: 'd', kind: 'door', spaceId: 's', wallIndex: 2, offsetM: 1, widthM: 0.9, heightM: 2, sillM: 0, swing: 'in' }],
  spaces: [{ id: 's', name: 'Room', polygon: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }], walls: [] }],
} as unknown as SpaceModel;
const cand = (id: string, furniture: FurnitureItem[], m: Partial<LayoutCandidate['metrics']> = {}, assumptions: string[] = []): LayoutCandidate => ({
  id, name: id, summary: '', parentVersion: 1, furniture, assumptions, generator: 'x', checks: [],
  metrics: { openAreaM2: 6, costSek: 3000, minClearanceM: 0.9, routeLenM: null, score: 70, ...m },
});
const set = [
  cand('a', [item('d', 'desk', 2, 0.5), item('b', 'bed', 3, 2.5)], { openAreaM2: 8, costSek: 2800 }),
  cand('b', [item('d', 'desk', 2, 2.5), item('b', 'bed', 1, 2.5), item('w', 'wardrobe', 0.5, 1)], { openAreaM2: 6, costSek: 4000, minClearanceM: 0.7 }),
  cand('c', [item('d', 'desk', 3.5, 1.5), item('b', 'bed', 0.6, 0.6)], { openAreaM2: 7, costSek: 3200 }, ['Left out the sofa: no layout of the full set passes the checks']),
];

describe('caseFor', () => {
  const cases = set.map((c) => caseFor(c, undefined, model, set.filter((x) => x !== c)));
  it('gives every layout its own short title', () => {
    const t = cases.map((c) => c.title);
    expect(new Set(t).size).toBe(t.length);
    for (const x of t) { expect(x.split(' ').length).toBeLessThanOrEqual(4); expect(x).not.toMatch(/^Layout/); }
  });
  it('limits chips to three and names what differs', () => {
    for (const c of cases) expect(c.chips.length).toBeLessThanOrEqual(3);
    expect(cases[0].chips).toContain('Desk by window');
  });
  it('flags a trade-off and the left-out items', () => {
    expect(cases[1].tradeoff).toBeTruthy();
    expect(cases[2].leftOut).toEqual(['sofa']);
    expect(leftOutOf(set[0])).toEqual([]);
  });
  it('is stable regardless of other order', () => {
    expect(caseFor(set[0], undefined, model, [set[2], set[1]])).toEqual(cases[0]);
  });
  it('writes one paragraph for speech', () => {
    expect(whyText(cases[0], set[0])).toMatch(/checks/);
  });
});
