import type { Infeasibility, LayoutCandidate, Requirements, SpaceModel } from '../../core/types';

export interface SolveOptions { variants?: number; seed?: number; timeBudgetMs?: number; onProgress?: (p: number) => void }

export async function generateLayouts(model: SpaceModel, req: Requirements, opts: SolveOptions = {}): Promise<{ candidates: LayoutCandidate[]; infeasibility: Infeasibility | null }> {
  return { candidates: [], infeasibility: null };
}
