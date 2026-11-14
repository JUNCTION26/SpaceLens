import { describe, expect, it } from 'vitest';
import type { FurnitureItem, Requirements, SpaceModel } from '../../core/types';
import { makeItem } from '../furniture/catalog';
import { opening, rect, reqs, room } from '../referee/fixtures';
import { validateLayout } from '../referee/validate';
import { defaultProgram } from './program';
import { renderPlanSvg } from './render';
import { evaluateRules } from './rules';
import { designScore, explain } from './score';
import { solveProgram } from './solve';

// Node built-ins loaded at run time (the project has no Node type definitions).
const nodeMod = (name: string): Promise<any> => import(/* @vite-ignore */ `node:${name}`);
const fs = await nodeMod('fs'), os = await nodeMod('os'), path = await nodeMod('path');
const join = (...p: string[]): string => path.join(...p);
const writeFileSync = (f: string, s: string): void => fs.writeFileSync(f, s);
export const OUT: string = join(os.tmpdir(), 'spacelens-design');
fs.mkdirSync(OUT, { recursive: true });

let n = 0;
const items = (ids: Array<[string, number]>): FurnitureItem[] => ids.flatMap(([id, q]) => Array.from({ length: q }, () => ({ ...makeItem(id), id: `${id}-${++n}` })));
const brief = (ids: Array<[string, number]>, patch: Partial<Requirements> = {}): Requirements =>
  reqs({ items: ids.map(([catalogId, qty]) => ({ catalogId, qty })), routeTargets: [{ kind: 'window' }], minRouteWidthM: 0.8, ...patch });

export interface Scenario { key: string; title: string; model: SpaceModel; ids: Array<[string, number]>; req: Requirements }
export const SCENARIOS: Scenario[] = [
  {
    key: 'a-office', title: 'Home office for two, 3.6 x 4.2 m',
    model: room(rect(3.6, 4.2), [opening('door', 'door', 2, 2.8, 0.8, 'in'), opening('win', 'window', 0, 1.8, 1.4)]),
    ids: [['desk-140', 1], ['desk-120', 1], ['office-chair', 2], ['bookshelf', 1], ['plant', 1]], req: null!,
  },
  {
    key: 'b-bedroom', title: 'Bedroom, 3.4 x 4.2 m',
    model: room(rect(3.4, 4.2), [opening('door', 'door', 2, 2.8, 0.8, 'in'), opening('win', 'window', 0, 1.7, 1.4)]),
    ids: [['bed-double', 1], ['nightstand', 2], ['wardrobe-100', 1], ['desk-120', 1], ['desk-chair', 1]], req: null!,
  },
  {
    key: 'c-living', title: 'Living room, 4.5 x 5.5 m',
    model: room(rect(4.5, 5.5), [opening('door', 'door', 2, 3.8, 0.9, 'in'), opening('win', 'window', 1, 2.75, 1.8)]),
    ids: [['sofa-3', 1], ['armchair', 1], ['coffee-table', 1], ['tv-unit', 1], ['rug-200', 1], ['bookshelf', 1]], req: null!,
  },
  {
    key: 'd-cafe', title: 'Cafe, 6 x 5 m',
    model: room(rect(6, 5), [opening('door', 'door', 2, 1.0, 1.0, 'in'), opening('win1', 'window', 0, 2.0, 1.6), opening('win2', 'window', 0, 4.5, 1.6)]),
    ids: [['cafe-4', 4], ['chair', 12], ['counter', 1]], req: null!,
  },
];
for (const s of SCENARIOS) s.req = brief(s.ids);
// In a bedroom the way to the window is a secondary path (60 cm); the door-to-bed paths are scored by the rules.
SCENARIOS[1].req.minRouteWidthM = 0.6;

export async function run(s: Scenario, opts: { seed?: number; variants?: number } = {}) {
  const its = items(s.ids);
  const program = defaultProgram(s.model, its, s.req);
  const t0 = performance.now();
  const res = await solveProgram(s.model, its, program, { req: s.req, seed: opts.seed ?? 1, variants: opts.variants ?? 3 });
  return { ...res, ms: performance.now() - t0, its, program };
}

describe('designer-quality scenarios', () => {
  for (const s of SCENARIOS) {
    it(`${s.title}: valid, varied, explained`, async () => {
      const res = await run(s);
      const lines = [`${s.title}: ${res.candidates.length} variants in ${Math.round(res.ms)} ms`];
      const results = res.candidates.map((c, i) => {
        const fails = validateLayout(s.model, c.furniture, s.req).filter((k) => k.result === 'fail');
        const v = evaluateRules(s.model, c.furniture, s.req);
        const score = designScore(v);
        lines.push(`  ${c.name} - score ${score}: ${c.summary}`);
        for (const e of explain(v, 5)) lines.push(`      ${e}`);
        writeFileSync(join(OUT, `${s.key}-${i + 1}.svg`), renderPlanSvg(s.model, c.furniture, { title: `${c.name} - ${score}/100`, subtitle: c.summary.slice(0, 120), clearance: true }));
        return { c, fails, v, score };
      });
      writeFileSync(join(OUT, `${s.key}.txt`), lines.join('\n'));
      console.log(lines.join('\n'));
      // Images first, assertions after, so a failing layout can still be looked at.
      expect(res.infeasibility).toBeNull();
      expect(res.candidates.length).toBeGreaterThanOrEqual(1); // usually 2-3; the local pass is time-boxed, so a loaded runner may return fewer
      expect(res.ms).toBeLessThan(30000); // ~0.2-1.0 s alone; headroom for a loaded test runner
      for (const { c, fails, v, score } of results) {
        expect(fails.map((f) => f.details)).toEqual([]);
        expect(c.furniture.length).toBe(res.its.length);
        expect(v.filter((x) => x.severity === 'hard' && !x.pass)).toEqual([]);
        expect(score).toBeGreaterThanOrEqual(80);
      }
      expect(new Set(res.candidates.map((c) => c.name)).size).toBe(res.candidates.length);
    }, 30000);
  }

  it('a 3 x 3 m room cannot take a bed, a sofa and a desk, and says why', async () => {
    const s: Scenario = { key: 'e-small', title: 'Small room 3 x 3 m', model: room(rect(3, 3), [opening('door', 'door', 2, 2.4, 0.8, 'in'), opening('win', 'window', 0, 1.5, 1.2)]), ids: [['bed-double', 1], ['sofa-3', 1], ['desk-140', 1]], req: null! };
    s.req = brief(s.ids);
    const res = await run(s);
    expect(res.candidates).toHaveLength(0);
    expect(res.infeasibility?.reasons.length).toBeGreaterThan(0);
    expect(res.infeasibility?.relaxations.length).toBeGreaterThan(0);
    writeFileSync(join(OUT, 'e-small.txt'), `${Math.round(res.ms)} ms\n${res.infeasibility!.reasons.join('\n')}\n${res.infeasibility!.relaxations.map((r) => r.label).join('\n')}`);
    console.log(`Small room: ${Math.round(res.ms)} ms\n  ${res.infeasibility!.reasons.join('\n  ')}`);
    expect(res.ms).toBeLessThan(30000);
  }, 30000);
});
