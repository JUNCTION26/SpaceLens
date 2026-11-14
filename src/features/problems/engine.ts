import type { FurnitureItem, Requirements, SpaceModel, ValidationResult } from '../../core/types';
import { collectProblems, rankProblems } from './collect';
import { findFixes, fixContext, loadSolverFixes } from './fixes';
import type { Fix, Problem } from './types';

export interface RunInput { gen: number; model: SpaceModel; furniture: FurnitureItem[]; req: Requirements | null; safety: boolean }
export type EngineMessage =
  | { type: 'problems'; gen: number; problems: Problem[]; checks: ValidationResult[]; withSafety: boolean }
  | { type: 'fixes'; gen: number; id: string; fixes: Fix[] }
  | { type: 'core-done'; gen: number }
  | { type: 'done'; gen: number };

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Works out problems and their fixes in steps, posting results as they are ready:
 * referee checks and design rules first, then fixes for each, then the slower escape route findings.
 * Stops early when `stale()` says a newer run has started.
 */
export async function runProblems(input: RunInput, post: (m: EngineMessage) => void, stale: () => boolean): Promise<void> {
  const { gen, model, furniture, req } = input;
  await loadSolverFixes();
  if (stale()) return;
  const core = collectProblems(model, furniture, req, { design: true });
  post({ type: 'problems', gen, problems: core.problems, checks: core.checks, withSafety: false });
  const ctx = fixContext(model, furniture, req, core.raw);
  for (const p of core.problems) {
    await tick(); if (stale()) return;
    try { p.fixes = findFixes(ctx, p); } catch { p.fixes = []; }
    post({ type: 'fixes', gen, id: p.id, fixes: p.fixes });
  }
  post({ type: 'core-done', gen });
  if (!input.safety) { post({ type: 'done', gen }); return; }

  await tick(); if (stale()) return;
  const saf = collectProblems(model, furniture, req, { checks: false, safety: true });
  if (stale()) return;
  for (const [k, v] of saf.raw) ctx.raw.set(k, v);
  const merged = rankProblems([...core.problems, ...saf.problems]);
  post({ type: 'problems', gen, problems: merged, checks: core.checks, withSafety: true });
  for (const p of merged) {
    if (p.source !== 'safety') continue;
    await tick(); if (stale()) return;
    try { p.fixes = findFixes(ctx, p, 16); } catch { p.fixes = []; }
    post({ type: 'fixes', gen, id: p.id, fixes: p.fixes });
  }
  post({ type: 'done', gen });
}
