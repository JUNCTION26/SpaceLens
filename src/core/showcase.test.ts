import { describe, expect, it } from 'vitest';
import { showcaseRoom } from './showcase';
import { catalogEntry } from '../features/furniture/catalog';
import { summarize, validateLayout } from '../features/referee/validate';
import { reqs } from '../features/referee/fixtures';

describe('showcaseRoom', () => {
  const m = showcaseRoom();
  const rs = validateLayout(m, m.furniture, reqs({ routeTargets: [{ kind: 'door' }] }));

  it('fails no referee check', () => {
    const bad = rs.filter((r) => r.result === 'fail').map((r) => r.details);
    expect(bad).toEqual([]);
    expect(summarize(rs).pass).toBeGreaterThan(10);
  });
  it('uses only catalogue entries and is named My room', () => {
    expect(m.name).toBe('My room');
    for (const f of m.furniture) expect(catalogEntry(f.catalogId), f.catalogId).toBeDefined();
  });
  it('has the door, the window and the full set of pieces', () => {
    expect(m.openings.map((o) => o.kind).sort()).toEqual(['door', 'window']);
    const cats = m.furniture.map((f) => f.category);
    for (const c of ['sofa', 'rug', 'coffee-table', 'armchair', 'desk', 'chair', 'bookshelf', 'lamp', 'plant']) expect(cats).toContain(c);
  });
  it('keeps the chair facing the desk', () => {
    const desk = m.furniture.find((f) => f.id === 'f_desk')!, chair = m.furniture.find((f) => f.id === 'f_chair')!;
    const face = { x: -Math.sin(chair.rotation), y: Math.cos(chair.rotation) };
    const to = { x: desk.x - chair.x, y: desk.y - chair.y }, len = Math.hypot(to.x, to.y);
    expect((face.x * to.x + face.y * to.y) / len).toBeGreaterThan(0.95);
  });
});
