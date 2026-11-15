import { describe, expect, it } from 'vitest';
import { opening, rect, reqs, room } from '../referee/fixtures';
import { validateLayout } from '../referee/validate';
import { defaultProgram } from './program';
import { renderPlanSvg } from './render';
import { evaluateRules } from './rules';
import { SCENARIOS, scenarioItems, type Scenario } from './scenarios';
import { designScore, explain } from './score';
import { solveProgram } from './solve';

// Node built-ins loaded at run time (the project has no Node type definitions).
const nodeMod = (name: string): Promise<any> => import(/* @vite-ignore */ `node:${name}`);
const fs = await nodeMod('fs'), os = await nodeMod('os'), path = await nodeMod('path');
const join = (...p: string[]): string => path.join(...p);
const writeFileSync = (f: string, s: string): void => fs.writeFileSync(f, s);
export const OUT: string = join(os.tmpdir(), 'spacelens-design');
fs.mkdirSync(OUT, { recursive: true });

export async function run(s: Scenario, opts: { seed?: number; variants?: number } = {}) {
  const its = scenarioItems(s);
  const program = defaultProgram(s.model, its, s.req);
  const t0 = performance.now();
  const res = await solveProgram(s.model, its, program, { req: s.req, seed: opts.seed ?? 1, variants: opts.variants ?? 3 });
  return { ...res, ms: performance.now() - t0, its, program };
}

// Set SCENARIOS_ALL=1 to run every reference room; the default run covers the quick ones.
const env = (globalThis as { process?: { env?: Record<string, string> } }).process?.env ?? {};
const QUICK = new Set(['a-office', 'b-bedroom', 'c-living', 'd-cafe', 'f-kids']);
const chosen = env.SCENARIOS_ALL ? SCENARIOS : SCENARIOS.filter((s) => QUICK.has(s.key));

describe('designer-quality scenarios', () => {
  for (const s of chosen) {
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
      expect(res.candidates.length).toBeGreaterThanOrEqual(1);
      for (const { c, fails, v } of results) {
        expect(fails.map((f) => f.details)).toEqual([]);
        expect(c.furniture.length).toBe(res.its.length);
        expect(v.filter((x) => x.severity === 'hard' && !x.pass)).toEqual([]);
      }
      expect(Math.max(...results.map((r) => r.score))).toBeGreaterThanOrEqual(s.minScore);
      expect(new Set(res.candidates.map((c) => c.name)).size).toBe(res.candidates.length);
    }, 120000);
  }

  it('a 3 x 3 m room cannot take a bed, a sofa and a desk: it leaves pieces out and says why', async () => {
    const ids: Array<[string, number]> = [['bed-double', 1], ['sofa-3', 1], ['desk-140', 1]];
    const s: Scenario = {
      key: 'e-small', title: 'Small room 3 x 3 m', minScore: 0, ids,
      model: room(rect(3, 3), [opening('door', 'door', 2, 2.4, 0.8, 'in'), opening('win', 'window', 0, 1.5, 1.2)]),
      req: reqs({ items: ids.map(([catalogId, qty]) => ({ catalogId, qty })), routeTargets: [{ kind: 'window' }], minRouteWidthM: 0.8 }),
    };
    const res = await run(s);
    // Never the full set: either nothing, or a layout that names what it left out.
    for (const c of res.candidates) expect(c.furniture.length).toBeLessThan(3);
    if (res.candidates.length) expect(res.infeasibility?.reasons[0]).toMatch(/left out/i);
    expect(res.infeasibility?.reasons.length).toBeGreaterThan(0);
    expect(res.infeasibility?.relaxations.length).toBeGreaterThan(0);
    writeFileSync(join(OUT, 'e-small.txt'), `${Math.round(res.ms)} ms\n${res.infeasibility!.reasons.join('\n')}\n${res.infeasibility!.relaxations.map((r) => r.label).join('\n')}`);
  }, 60000);
});
