// One room's layout job, the same wherever it runs (worker or main thread).
import type { DesignProgram, FurnitureItem, Requirements, SpaceModel } from '../../core/types';
import { generateLayouts } from '../layout/solver';
import { solveProgram } from '../design/solve';

export type SolveJob =
  | { id: number; kind: 'layout'; sub: SpaceModel; req: Requirements; seed: number; timeBudgetMs: number }
  | { id: number; kind: 'program'; sub: SpaceModel; req: Requirements; seed: number; items: FurnitureItem[]; program: DesignProgram };

/** The same work, wherever it runs: rule-based layout, or the exact solve of a planned program. */
export async function runSolveJob(j: SolveJob): Promise<FurnitureItem[] | null> {
  if (j.kind === 'program') {
    const res = await solveProgram(j.sub, j.items, j.program, { variants: 1, seed: j.seed, req: j.req });
    return res.candidates[0]?.furniture ?? null;
  }
  const res = await generateLayouts(j.sub, j.req, { variants: 1, seed: j.seed, timeBudgetMs: j.timeBudgetMs });
  return res.candidates[0]?.furniture ?? null;
}
