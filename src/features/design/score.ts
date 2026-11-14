import type { RuleVerdict } from '../../core/types';

export const SEVERITY_WEIGHT: Record<RuleVerdict['severity'], number> = { hard: 4, strong: 3, preference: 1 };

/**
 * Points a rule can cost when it is fully broken. The score starts at 100 and each rule takes away
 * its points times how far it falls short, so rules that trivially pass do not pad the result.
 * A valid but mediocre room lands around 60, a good one around 80, an excellent one above 92.
 */
export const RULE_POINTS: Record<string, number> = {
  // circulation
  'walkway-main': 14, 'walkway-secondary': 10, 'open-floor': 5, 'natural-paths': 6, 'dead-corners': 6,
  // beds
  'bed-headboard': 12, 'bed-access': 12, 'bed-command': 4, 'bed-window': 8, 'bed-door-wall': 6, nightstands: 8, symmetry: 4,
  // desks
  'desk-pullout': 10, 'desk-glare': 6, 'desk-door': 4, 'desk-daylight': 8, 'desk-pair': 8,
  // seats and tables
  'seats-face': 10, 'seats-even': 3, 'dining-pullout': 10, 'table-centred': 4, aligned: 4,
  // lounge
  'sofa-focal': 10, 'tv-distance': 8, 'coffee-reach': 8, conversation: 4, 'armchair-group': 5, 'seat-outlook': 8,
  'rug-anchor': 5, 'rug-door': 4, 'lamp-seat': 3,
  // storage
  'storage-access': 10, 'tall-walls': 7, 'wardrobe-bed': 3,
  // composition
  balance: 6, 'focal-point': 4, zones: 8, parallel: 10, 'wall-backed': 10, 'dead-gaps': 4, 'no-floating': 10,
  'small-room': 6, 'large-room': 6, services: 0,
};
const DEFAULT_POINTS: Record<RuleVerdict['severity'], number> = { hard: 0, strong: 10, preference: 4 };
export const pointsOf = (ruleId: string, severity: RuleVerdict['severity']) => RULE_POINTS[ruleId] ?? DEFAULT_POINTS[severity];

/** Mean score per rule, so a rule with twelve chairs counts as much as a rule with one bed. */
function perRule(verdicts: RuleVerdict[]): Array<{ id: string; severity: RuleVerdict['severity']; score: number }> {
  const m = new Map<string, { severity: RuleVerdict['severity']; sum: number; n: number; min: number }>();
  for (const v of verdicts) {
    const e = m.get(v.ruleId) ?? { severity: v.severity, sum: 0, n: 0, min: 1 };
    e.sum += v.score; e.n++; e.min = Math.min(e.min, v.score);
    m.set(v.ruleId, e);
  }
  // Blend mean and worst: one cramped chair should show even among eleven good ones.
  return [...m.entries()].map(([id, e]) => ({ id, severity: e.severity, score: 0.5 * (e.sum / e.n) + 0.5 * e.min }));
}

/** Score points lost per rule (hard rules excluded), largest first. */
export function deductions(verdicts: RuleVerdict[]): Array<{ ruleId: string; points: number }> {
  return perRule(verdicts).filter((r) => r.severity !== 'hard')
    .map((r) => ({ ruleId: r.id, points: pointsOf(r.id, r.severity) * (1 - r.score) }))
    .filter((d) => d.points > 0.05).sort((a, b) => b.points - a.points);
}

/** 0..100: 100 minus the points every rule loses. Any broken hard rule caps the score at 30 (less for several). */
export function designScore(verdicts: RuleVerdict[]): number {
  if (!verdicts.length) return 0;
  const lost = deductions(verdicts).reduce((t, d) => t + d.points, 0);
  const base = Math.max(0, 100 - lost);
  const hardFails = verdicts.filter((v) => v.severity === 'hard' && !v.pass).length;
  const capped = hardFails ? Math.min(base, Math.max(0, 30 - 5 * (hardFails - 1))) : base;
  return Math.round(capped);
}

/** How many score points a verdict costs, for ordering explanations. */
export function impact(v: RuleVerdict, all: RuleVerdict[]): number {
  const same = all.filter((x) => x.ruleId === v.ruleId).length || 1;
  return (pointsOf(v.ruleId, v.severity) * (1 - v.score)) / Math.sqrt(same) + (v.severity === 'hard' && !v.pass ? 100 : 0);
}

export interface Explained { ruleId: string; name: string; severity: RuleVerdict['severity']; pass: boolean; score: number; message: string; itemIds: string[] }

/** The verdicts worth reading, worst problems first, then the strongest points. */
export function explainDetailed(verdicts: RuleVerdict[], limit = 6): Explained[] {
  const toE = (v: RuleVerdict): Explained => ({ ruleId: v.ruleId, name: v.name, severity: v.severity, pass: v.pass, score: v.score, message: v.message, itemIds: v.itemIds });
  const problems = verdicts.filter((v) => v.score < 0.95 && pointsOf(v.ruleId, v.severity) + (v.severity === 'hard' ? 1 : 0) > 0).sort((a, b) => impact(b, verdicts) - impact(a, verdicts));
  const seen = new Set<string>();
  const out: Explained[] = [];
  for (const v of problems) { if (out.length >= limit) break; const k = v.ruleId + v.message; if (!seen.has(k)) { seen.add(k); out.push(toE(v)); } }
  const strengths = verdicts.filter((v) => v.pass && v.score >= 0.95 && v.severity !== 'hard' && pointsOf(v.ruleId, v.severity) > 0)
    .sort((a, b) => pointsOf(b.ruleId, b.severity) - pointsOf(a.ruleId, a.severity));
  for (const v of strengths) { if (out.length >= limit) break; if (!seen.has(v.ruleId)) { seen.add(v.ruleId); out.push(toE(v)); } }
  return out;
}

/** Plain sentences, worst first: "Desk chair pull-out: Only 62 cm behind the desk ...". */
export function explain(verdicts: RuleVerdict[], limit = 6): string[] {
  return explainDetailed(verdicts, limit).map((e) => `${e.pass ? '' : e.severity === 'hard' ? 'Must fix: ' : 'Could be better: '}${e.message}`);
}
