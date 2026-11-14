import { describe, expect, it } from 'vitest';
import { CATEGORIES, makeItem } from '../furniture/catalog';
import { opening, rect, reqs, room } from '../referee/fixtures';
import { validateLayout } from '../referee/validate';
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
    expect(designScore(v)).toBeLessThanOrEqual(30);
    expect(explain(v, 3)[0]).toMatch(/^Must fix/);
  });
});

describe('score calibration', () => {
  const req = reqs({ routeTargets: [{ kind: 'window' }], minRouteWidthM: 0.6 });
  const valid = (m: ReturnType<typeof bedroom>, fs: ReturnType<typeof at>[]) => {
    const v = evaluateRules(m, fs, req);
    expect(v.filter((x) => x.severity === 'hard' && !x.pass).map((x) => x.message)).toEqual([]);
    return designScore(v);
  };
  // Bed head under the window, desk in the dark corner facing the wall, wardrobe 30 cm off its wall.
  const mediocre = () => [
    at('bed-double', 'bed', 1.7, 1.0, 0),
    at('desk-120', 'desk', 2.7, 3.9, Math.PI), at('desk-chair', 'ch', 2.7, 3.32, 0),
    at('wardrobe-100', 'w', 0.6, 2.85, -Math.PI / 2),
  ];
  // Head on the solid east wall with nightstands, desk beside the window, wardrobe flush on the west wall.
  const good = () => [
    { ...at('bed-double', 'bed', 2.4, 2.4, Math.PI / 2), clearance: { front: 0.6, back: 0, left: 0, right: 0 } },
    at('nightstand', 'n1', 3.2, 2.4 - 0.945, Math.PI / 2), at('nightstand', 'n2', 3.2, 2.4 + 0.945, Math.PI / 2),
    at('desk-120', 'desk', 0.3, 0.6, -Math.PI / 2), at('desk-chair', 'ch', 0.88, 0.6, Math.PI / 2),
    at('wardrobe-100', 'w', 0.3, 2.6, -Math.PI / 2),
  ];
  it('puts a valid but poorly arranged bedroom well below a well arranged one', () => {
    const m = bedroom();
    const sm = valid(m, mediocre()), sg = valid(m, good());
    expect(sm).toBeGreaterThanOrEqual(30);
    expect(sm).toBeLessThanOrEqual(68);
    expect(sg).toBeGreaterThanOrEqual(78);
    expect(sg - sm).toBeGreaterThanOrEqual(15);
  });
  it('caps any layout with a broken hard rule at 30', () => {
    const m = bedroom();
    const broken = [...good().slice(0, 3), at('wardrobe-100', 'w', 0.6, 3.9)];
    expect(designScore(evaluateRules(m, broken, req))).toBeLessThanOrEqual(30);
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
  }, 90000);
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
  }, 90000);
});

describe('repair', () => {
  const req = reqs({ routeTargets: [{ kind: 'window' }], minRouteWidthM: 0.6 });
  // A good bedroom with the wardrobe dragged into the door swing.
  const broken = () => [
    { ...at('bed-double', 'bed', 2.4, 2.4, Math.PI / 2), clearance: { front: 0.6, back: 0, left: 0, right: 0 } },
    at('nightstand', 'n1', 3.2, 2.4 - 0.945, Math.PI / 2), at('nightstand', 'n2', 3.2, 2.4 + 0.945, Math.PI / 2),
    at('desk-120', 'desk', 0.3, 0.6, -Math.PI / 2), at('desk-chair', 'ch', 0.88, 0.6, Math.PI / 2),
    at('wardrobe-100', 'w', 0.6, 3.7, 0),
  ];
  it('finds a few moves that make a broken layout valid and says why', async () => {
    const { repairLayout } = await import('./repair');
    const m = bedroom();
    expect(validateLayout(m, broken(), req).some((c) => c.result === 'fail')).toBe(true);
    const res = repairLayout(m, broken(), req);
    expect(res.valid).toBe(true);
    expect(validateLayout(m, res.furniture, req).filter((c) => c.result === 'fail')).toEqual([]);
    expect(new Set(res.moves.map((x) => x.itemId)).size).toBeLessThanOrEqual(2);
    expect(res.moves.every((x) => x.reason.length > 5)).toBe(true);
  }, 90000);
  it('offers one to three fixes for a single failed check, each clearing it', async () => {
    const { fixesFor } = await import('./repair');
    const m = bedroom();
    const check = validateLayout(m, broken(), req).find((c) => c.result === 'fail')!;
    const fixes = fixesFor(m, broken(), check, req);
    expect(fixes.length).toBeGreaterThanOrEqual(1);
    expect(fixes.length).toBeLessThanOrEqual(3);
    for (const f of fixes) {
      expect(f.label.length).toBeGreaterThan(4);
      expect(f.ops.length).toBeGreaterThan(0);
      expect(validateLayout(m, f.preview, req).some((c) => c.id === check.id && c.result === 'fail')).toBe(false);
    }
  }, 90000);
});

describe('multi-room', () => {
  // Two rooms side by side; furnish the second in place.
  const twoRooms = () => {
    const m = room(rect(4, 4), [opening('door', 'door', 2, 2.0, 0.9, 'in'), opening('win', 'window', 0, 2.0, 1.2)]);
    const r2 = [{ x: 4, y: 0 }, { x: 7.4, y: 0 }, { x: 7.4, y: 4.2 }, { x: 4, y: 4.2 }];
    m.spaces.push({ id: 's2', name: 'Bedroom', polygon: r2, walls: r2.map(() => ({ thicknessM: 0.1, sourceKind: 'manual' as const, status: 'verified' as const })) });
    m.openings.push({ ...opening('door2', 'door', 2, 2.8, 0.8, 'in'), spaceId: 's2' }, { ...opening('win2', 'window', 0, 1.7, 1.4), spaceId: 's2' });
    return m;
  };
  it('solves and checks the room it is given, not the first one', async () => {
    const m = twoRooms();
    const items = [at('bed-double', 'bed', 1, 1), at('nightstand', 'n1', 1, 1), at('wardrobe-100', 'w', 1, 1)];
    const req = reqs({ routeTargets: [{ kind: 'window' }], minRouteWidthM: 0.6 });
    const res = await solveProgram(m, items, defaultProgram(m, items, req), { req, seed: 3, spaceId: 's2', variants: 1 });
    expect(res.candidates.length).toBeGreaterThan(0);
    for (const f of res.candidates[0].furniture) expect(f.x).toBeGreaterThan(4);
    expect(validateLayout(m, res.candidates[0].furniture, req, { spaceId: 's2' }).filter((c) => c.result === 'fail')).toEqual([]);
    // The same furniture judged against the first room sticks out of it.
    expect(validateLayout(m, res.candidates[0].furniture, req, { spaceId: 's1' }).some((c) => c.rule === 'Inside room' && c.result === 'fail')).toBe(true);
    expect(evaluateRules(m, res.candidates[0].furniture, req, { spaceId: 's2' }).filter((v) => v.severity === 'hard' && !v.pass)).toEqual([]);
  }, 90000);
});

describe('generated objects', () => {
  it('checks a fold-down bed with its open footprint and honours its semantics', async () => {
    const { foldBed } = await import('./scenarios');
    const m = bedroom();
    // Against the south wall, folding north: open, it reaches 2.15 m into the room and hits a desk there.
    const bed = { ...foldBed(), x: 2.4, y: 4.2 - 0.225, rotation: Math.PI };
    const checks = validateLayout(m, [bed, at('desk-120', 'desk', 2.4, 2.4, 0)]);
    expect(checks.some((c) => c.rule === 'Unfolded fits' && c.result === 'fail')).toBe(true);
    expect(validateLayout(m, [bed]).some((c) => c.result === 'fail')).toBe(false);
    const v = evaluateRules(m, [{ ...foldBed(), x: 3.4 - 0.225, y: 2.1, rotation: Math.PI / 2 }]);
    expect(v.find((x) => x.ruleId === 'unfold')).toBeTruthy();
    expect(semanticsOf(foldBed()).role).toBe('sleeping');
  });
});

describe('planner programs', () => {
  it('gives each desk its own chair facing it, even when a planner pairs both chairs with one desk', async () => {
    const m = room(rect(3.6, 4.2), [opening('door', 'door', 2, 2.8, 0.8, 'in'), opening('win', 'window', 0, 1.8, 1.4)]);
    const items = [at('desk-140', 'd1', 1, 1), at('desk-120', 'd2', 1, 1), at('office-chair', 'c1', 1, 1), at('office-chair', 'c2', 1, 1)];
    const req = reqs({ routeTargets: [{ kind: 'window' }], minRouteWidthM: 0.8 });
    const p = defaultProgram(m, items, req);
    const bad = { ...p, relations: [...p.relations.filter((r) => r.kind !== 'paired-seat'), { kind: 'paired-seat' as const, subject: 'c1', target: 'd1', weight: 1, reason: 'Chair at the main desk.' }, { kind: 'paired-seat' as const, subject: 'c2', target: 'd1', weight: 1, reason: 'Chair faces the secondary desk.' }] };
    const res = await solveProgram(m, items, bad, { req, seed: 2, variants: 2 });
    expect(res.candidates.length).toBeGreaterThan(0);
    for (const c of res.candidates) {
      const v = evaluateRules(m, c.furniture, req).filter((x) => x.ruleId === 'seats-face');
      expect(v.length).toBe(2);
      expect(v.every((x) => x.score >= 0.9)).toBe(true);
      expect(new Set(v.map((x) => x.itemIds[1]))).toEqual(new Set(['d1', 'd2']));
    }
    // Reasons shown with a layout belong to relations it honours.
    for (const r of res.reports) expect(r.program.relations.some((x) => x.reason === 'Chair faces the secondary desk.' && x.target === 'd1')).toBe(false);
  }, 90000);
});
