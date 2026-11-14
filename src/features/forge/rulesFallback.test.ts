import { describe, expect, it } from 'vitest';
import { KINDS, parseRequest } from './parseRequest';
import { partsBounds, rulesObject, semanticLine } from './rulesFallback';

const close = (a: number, b: number) => Math.abs(a - b) < 1e-3;

function expectFills(prompt: string, size: { w: number; d: number; h: number }) {
  const spec = rulesObject(prompt, { size });
  const b = partsBounds(spec.parts);
  const got = { w: b.max[0] - b.min[0], d: b.max[2] - b.min[2], h: b.max[1] - b.min[1] };
  expect(close(got.w, size.w) && close(got.d, size.d) && close(got.h, size.h), `${prompt}: ${JSON.stringify(got)} vs ${JSON.stringify(size)}`).toBe(true);
  expect(close(b.min[1], 0)).toBe(true);
  expect(close(b.min[0], -b.max[0]) && close(b.min[2], -b.max[2])).toBe(true);
  expect(spec.size).toEqual(size);
  for (const p of spec.parts) for (const v of [...p.size, ...p.pos]) expect(Number.isFinite(v)).toBe(true);
  return spec;
}

describe('rules templates', () => {
  it('every kind fills its default size exactly', () => {
    for (const k of KINDS) {
      const size = { w: k.size[0], d: k.size[1], h: k.size[2] };
      expectFills(k.en[0], size);
    }
  });

  it('honours the requested size for the brief examples', () => {
    const desk = rulesObject('walnut desk 160 by 80 with drawers on the right');
    expect(desk.size).toEqual({ w: 1.6, d: 0.8, h: 0.74 });
    expect(desk.parts.some((p) => /drawer/i.test(p.name))).toBe(true);
    expect(desk.parts.every((p) => p.material !== 'oak')).toBe(true);
    // Drawers on the right: the pedestal sits at +x.
    expect(desk.parts.find((p) => p.name === 'Drawer pedestal')!.pos[0]).toBeGreaterThan(0);
    expectFills('walnut desk 160 by 80 with drawers on the right', desk.size);

    const bench = rulesObject('low oak TV bench 180 wide');
    expect(bench.size.w).toBe(1.8);
    expect(bench.semantics.category).toBe('tv-unit');
    expectFills('low oak TV bench 180 wide', bench.size);

    const table = rulesObject('round marble table for six');
    expect(table.size.w).toBe(table.size.d);
    expect(table.parts[0]).toMatchObject({ shape: 'cylinder', material: 'marble' });
    expectFills('round marble table for six', table.size);
  });

  it('fills odd sizes too', () => {
    expectFills('sofa', { w: 3.1, d: 1.05, h: 0.7 });
    expectFills('bookshelf', { w: 1.6, d: 0.4, h: 2.4 });
    expectFills('wardrobe with drawers', { w: 2.0, d: 0.62, h: 2.3 });
    expectFills('bed', { w: 0.9, d: 2.0, h: 0.8 });
    expectFills('chair with armrests', { w: 0.55, d: 0.55, h: 0.9 });
    expectFills('floor lamp', { w: 0.5, d: 0.5, h: 1.9 });
    expectFills('bench with storage', { w: 2.0, d: 0.4, h: 0.46 });
  });

  it('builds a fold-down wall bed with a hinge motion', () => {
    const spec = expectFills('wall bed', { w: 1.56, d: 0.45, h: 2.2 });
    expect(spec.motions?.[0]).toMatchObject({ group: 'bed', kind: 'hinge' });
    expect(spec.parts.some((p) => p.group === 'bed')).toBe(true);
    expect(spec.openSize!.d).toBeGreaterThan(2);
  });

  it('applies said colours and keeps semantics sensible', () => {
    const sofa = rulesObject('pink velvet sofa 220 wide');
    expect(sofa.parts.some((p) => p.material === 'velvet' && p.color)).toBe(true);
    expect(sofa.semantics).toMatchObject({ category: 'sofa', role: 'seating', wallBacked: true });
    const desk = rulesObject('white desk');
    expect(desk.parts[0].material).toBe('white-laminate');
    expect(semanticLine(desk.semantics)).toBe('Desk · wall-backed · needs 90 cm in front');
    expect(rulesObject('tall bookshelf').semantics.tall).toBe(true);
  });

  it('still builds something for unknown objects', () => {
    const p = parseRequest('a hammock stand');
    expect(p.kind).toBeNull();
    const spec = rulesObject('a hammock stand');
    expect(spec.parts.length).toBeGreaterThan(3);
    expect(spec.model).toBe('rules');
  });
});
