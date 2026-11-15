import { describe, expect, it } from 'vitest';
import { demoBuilding } from '../building/demo';
import { furnishBuilding } from '../building/furnish';
import { collectProblems } from './collect';

describe('villa demo', () => {
  it.runIf(!!(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VILLA_MEASURE)('furnished villa shows a plausible number of problems', async () => {
    const m = demoBuilding('villa')!;
    expect(m).toBeTruthy();
    const res = await furnishBuilding(m, {}, { parallel: 3, timeBudgetMs: 900 });
    console.log('furnished', res.furniture.length, 'items');
    const t0 = Date.now();
    const model = { ...m, furniture: res.furniture };
    const { problems } = collectProblems(model, res.furniture, null, { checks: true, design: true, safety: true });
    console.log('collect ms', Date.now() - t0);
    console.log(`villa problems: ${problems.length} (items ${res.furniture.length})`);
    problems.slice(0, 10).forEach((p, i) => console.log(`${i + 1}. [${p.severity}/${p.source}] ${p.title}`));
    expect(problems.length).toBeLessThan(20);
  }, 120000);
});
