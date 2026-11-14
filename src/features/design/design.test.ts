import { describe, expect, it } from 'vitest';
import { CATEGORIES, makeItem } from '../furniture/catalog';
import { opening, rect, reqs, room } from '../referee/fixtures';
import { generateLayouts, lastReports } from '../layout/solver';
import { defaultProgram } from './program';
import { renderPlanSvg } from './render';
import { RULES, evaluateRules } from './rules';
import { designScore, explain } from './score';
import { SEMANTICS, semanticsOf } from './semantics';
import { solveProgram } from './solve';

const bedroom = () => room(rect(3.4, 4.2), [opening('door', 'door', 2, 2.8, 0.8, 'in'), opening('win', 'window', 0, 1.7, 1.4)]);
const at = (id: string, key: string, x: number, y: number, rotation = 0) => ({ ...makeItem(id, { x, y, rotation }), id: key });

describe('semantics', () => {
  it('has a row for every catalogue category', () => {
    for (const c of CATEGORIES) expect(SEMANTICS[c], c).toBeTruthy();
  });
  it('prefers the semantics a generated object carries', () => {
    const f = makeItem('desk-120');
    const own = { ...semanticsOf(f), description: 'mine', wallBacked: false };
    expect(semanticsOf({ ...f, custom: { semantics: own } as never }).description).toBe('mine');
  });
});

describe('rules', () => {
  it('has around thirty named rules with unique ids and every severity', () => {
    expect(RULES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    expect(new Set(RULES.map((r) => r.severity))).toEqual(new Set(['hard', 'strong', 'preference']));
  });
  it('rewards a headboard on the wall with nightstands, and penalises a floating bed', () => {
    const m = bedroom();
    // Bed head on the east wall (front faces -x), nightstands flanking.
    const rot = Math.PI / 2;
    // As the solver does: nightstands at the head take over the bed's side boxes there.
    const good = [{ ...at('bed-double', 'bed', 3.4 - 1.0, 2.0, rot), clearance: { front: 0.6, back: 0, left: 0, right: 0 } }, at('nightstand', 'n1', 3.4 - 0.2, 2.0 - 0.7 - 0.25, rot), at('nightstand', 'n2', 3.4 - 0.2, 2.0 + 0.7 + 0.25, rot)];
    const bad = [at('bed-double', 'bed', 1.7, 2.0, rot), at('nightstand', 'n1', 0.3, 0.5), at('nightstand', 'n2', 0.3, 3.0)];
    const vg = evaluateRules(m, good), vb = evaluateRules(m, bad);
    const s = (v: typeof vg, id: string) => v.filter((x) => x.ruleId === id).reduce((t, x) => Math.min(t, x.score), 1);
    expect(s(vg, 'bed-headboard')).toBe(1);
    expect(s(vb, 'bed-headboard')).toBeLessThan(0.5);
    expect(s(vg, 'nightstands')).toBeGreaterThan(0.9);
    expect(s(vb, 'nightstands')).toBeLessThan(0.3);
    expect(designScore(vg)).toBeGreaterThan(designScore(vb));
    for (const v of vg) expect(v.message.length).toBeGreaterThan(10);
  });
  it('caps the score when a hard rule breaks and explains it first', () => {
    const m = bedroom();
    const v = evaluateRules(m, [at('wardrobe-100', 'w', 0.6, 3.9)]); // in the door swing
    expect(v.some((x) => x.ruleId === 'door-swing' && !x.pass)).toBe(true);
    expect(designScore(v)).toBeLessThanOrEqual(35);
    expect(explain(v, 3)[0]).toMatch(/^Must fix/);
  });
});

describe('program', () => {
  it('hangs dependents on anchors with a reason for each relation', () => {
    const items = [at('bed-double', 'bed', 1, 1), at('nightstand', 'n1', 1, 1), at('desk-120', 'desk', 1, 1), at('desk-chair', 'ch', 1, 1), at('sofa-3', 'sofa', 1, 1), at('coffee-table', 'ct', 1, 1), at('tv-unit', 'tv', 1, 1)];
    const p = defaultProgram(bedroom(), items, reqs());
    const has = (kind: string, subject: string, target: string) => p.relations.some((r) => r.kind === kind && r.subject === subject && r.target === target);
    expect(has('flanks', 'n1', 'bed')).toBe(true);
    expect(has('paired-seat', 'ch', 'desk')).toBe(true);
    expect(has('in-front-of', 'ct', 'sofa')).toBe(true);
    expect(has('faces', 'sofa', 'tv')).toBe(true);
    expect(p.relations.every((r) => r.reason.length > 15)).toBe(true);
    expect(p.focalItemId).toBe('tv');
    expect(p.zones.map((z) => z.name)).toEqual(expect.arrayContaining(['Sleeping', 'Work', 'Lounge']));
  });
});

describe('solveProgram', () => {
  it('is deterministic for a seed', async () => {
    const m = bedroom();
    const items = [at('bed-double', 'bed', 1, 1), at('nightstand', 'n1', 1, 1), at('nightstand', 'n2', 1, 1), at('wardrobe-100', 'w', 1, 1)];
    const req = reqs({ routeTargets: [{ kind: 'window' }], minRouteWidthM: 0.6 });
    const run = () => solveProgram(m, items, defaultProgram(m, items, req), { seed: 5, req });
    const [a, b] = [await run(), await run()];
    expect(a.candidates.length).toBeGreaterThan(0);
    expect(a.candidates.map((c) => c.furniture.map((f) => [f.x, f.y, f.rotation]))).toEqual(b.candidates.map((c) => c.furniture.map((f) => [f.x, f.y, f.rotation])));
    expect(a.reports.map((r) => r.candidateId)).toEqual(a.candidates.map((c) => c.id));
  }, 20000);
});

describe('render', () => {
  it('draws the room and labels every piece', () => {
    const svg = renderPlanSvg(bedroom(), [at('bed-double', 'bed', 1.7, 1.2), at('wardrobe-100', 'w', 0.5, 3.0)], { title: 'Test' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Double bed 140x200');
    expect(svg).toContain('Wardrobe 100');
    expect(svg).toContain('Test');
  });
});

describe('generateLayouts with design reports', () => {
  it('returns rule verdicts for every candidate', async () => {
    const req = reqs({ items: [{ catalogId: 'bed-single', qty: 1 }, { catalogId: 'desk-120', qty: 1 }, { catalogId: 'desk-chair', qty: 1 }], routeTargets: [{ kind: 'window' }], minRouteWidthM: 0.8 });
    const res = await generateLayouts(bedroom(), req, { seed: 2 });
    expect(res.candidates.length).toBeGreaterThan(0);
    expect(res.reports).toHaveLength(res.candidates.length);
    expect(lastReports()).toBe(res.reports);
    for (const c of res.candidates) expect(c.metrics.score).toBeGreaterThan(50);
  }, 20000);
});
