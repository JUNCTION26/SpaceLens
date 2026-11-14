import type { RuleVerdict } from '../../core/types';

export const SEVERITY_WEIGHT: Record<RuleVerdict['severity'], number> = { hard: 4, strong: 3, preference: 1 };

/** Mean score per rule, so a rule with twelve chairs counts as much as a rule with one bed. */
function perRule(verdicts: RuleVerdict[]): Array<{ id: string; severity: RuleVerdict['severity']; score: number }> {
  const m = new Map<string, { severity: RuleVerdict['severity']; sum: number; n: number; min: number }>();
  for (const v of verdicts) {
    const e = m.get(v.ruleId) ?? { severity: v.severity, sum: 0, n: 0, min: 1 };
    e.sum += v.score; e.n++; e.min = Math.min(e.min, v.score);
    m.set(v.ruleId, e);
  }
  // Blend mean and worst: one cramped chair should show even among eleven good ones.
  return [...m.entries()].map(([id, e]) => ({ id, severity: e.severity, score: 0.7 * (e.sum / e.n) + 0.3 * e.min }));
}

/** 0..100. Weighted by severity; any broken hard rule caps the score at 35. */
export function designScore(verdicts: RuleVerdict[]): number {
  if (!verdicts.length) return 0;
  let w = 0, s = 0;
  for (const r of perRule(verdicts)) { const k = SEVERITY_WEIGHT[r.severity]; w += k; s += k * r.score; }
  const base = w ? (100 * s) / w : 0;
  const hardFails = verdicts.filter((v) => v.severity === 'hard' && !v.pass).length;
  const capped = hardFails ? Math.min(base, Math.max(0, 35 - 5 * (hardFails - 1))) : base;
  return Math.round(capped);
}

/** How many score points a verdict costs, for ordering explanations. */
export function impact(v: RuleVerdict, all: RuleVerdict[]): number {
  const same = all.filter((x) => x.ruleId === v.ruleId).length || 1;
  return (SEVERITY_WEIGHT[v.severity] * (1 - v.score)) / Math.sqrt(same) + (v.severity === 'hard' && !v.pass ? 100 : 0);
}

export interface Explained { ruleId: string; name: string; severity: RuleVerdict['severity']; pass: boolean; score: number; message: string; itemIds: string[] }

/** The verdicts worth reading, worst problems first, then the strongest points. */
export function explainDetailed(verdicts: RuleVerdict[], limit = 6): Explained[] {
  const toE = (v: RuleVerdict): Explained => ({ ruleId: v.ruleId, name: v.name, severity: v.severity, pass: v.pass, score: v.score, message: v.message, itemIds: v.itemIds });
  const problems = verdicts.filter((v) => v.score < 0.95).sort((a, b) => impact(b, verdicts) - impact(a, verdicts));
  const seen = new Set<string>();
  const out: Explained[] = [];
  for (const v of problems) { if (out.length >= limit) break; const k = v.ruleId + v.message; if (!seen.has(k)) { seen.add(k); out.push(toE(v)); } }
  const strengths = verdicts.filter((v) => v.pass && v.score >= 0.95 && v.severity !== 'hard' && v.ruleId !== 'services')
    .sort((a, b) => (b.severity === 'strong' ? 1 : 0) - (a.severity === 'strong' ? 1 : 0));
  for (const v of strengths) { if (out.length >= limit) break; if (!seen.has(v.ruleId)) { seen.add(v.ruleId); out.push(toE(v)); } }
  return out;
}

/** Plain sentences, worst first: "Desk chair pull-out: Only 62 cm behind the desk ...". */
export function explain(verdicts: RuleVerdict[], limit = 6): string[] {
  return explainDetailed(verdicts, limit).map((e) => `${e.pass ? '' : e.severity === 'hard' ? 'Must fix: ' : 'Could be better: '}${e.message}`);
}
