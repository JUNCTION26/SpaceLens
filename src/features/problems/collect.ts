import { centroid, openingSegment } from '../../core/geometry';
import type { FurnitureItem, Requirements, RuleVerdict, SpaceModel, ValidationResult, Vec2 } from '../../core/types';
import { validateLayout } from '../referee/validate';
import { evaluateRules } from '../design/rules';
import { quickFindings, type SafetyFinding } from '../safety/assess';
import { SEVERITY_ORDER, type Problem, type ProblemSeverity } from './types';

const cm = (m: number) => `${Math.round(m * 100)} cm`;
const sek = (v: number) => `${Math.round(v).toLocaleString('sv-SE')} kr`;
const list = (names: string[]) => (names.length <= 1 ? names[0] ?? '' : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const sentence = (s: string) => { const t = s.trim(); return t ? t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.') : t; };

export interface CollectOptions {
  /** Include the referee checks (default on). */
  checks?: boolean;
  /** Include design rule verdicts (strong ones as warnings, weak preferences as tips). */
  design?: boolean;
  /** Include escape route and access findings. */
  safety?: boolean;
}

/** What the source checks said, kept so fixes can confirm the problem is gone. */
export type ProblemRaw =
  | { source: 'check'; result: ValidationResult }
  | { source: 'design'; verdict: RuleVerdict }
  | { source: 'safety'; finding: SafetyFinding };

export interface CollectResult { problems: Problem[]; raw: Map<string, ProblemRaw>; checks: ValidationResult[] }

function openingCentre(model: SpaceModel, id: string): Vec2 | null {
  const o = model.openings.find((x) => x.id === id); if (!o) return null;
  const s = model.spaces.find((x) => x.id === o.spaceId); if (!s || o.wallIndex >= s.polygon.length) return null;
  return openingSegment(s, o).c;
}

/** Rewrites a referee result as one plain sentence with numbers. */
export function checkTitle(r: ValidationResult, byId: Map<string, FurnitureItem>, model: SpaceModel): string {
  const items = r.subjectIds.map((id) => byId.get(id)).filter((f): f is FurnitureItem => !!f);
  const nm = (f?: FurnitureItem) => f?.name ?? 'An item';
  const first = items[0];
  switch (r.rule) {
    case 'Inside room': return `${nm(first)} sticks ${cm(r.measured ?? 0)} out of the room.`;
    case 'Ceiling height': return `${nm(first)} is ${cm(r.measured ?? 0)} tall, more than the ${cm(r.threshold ?? model.ceilingM)} ceiling.`;
    case 'No overlap': return `${nm(items[0])} and ${nm(items[1])} overlap by ${cm(r.measured ?? 0)}.`;
    case 'Clearance': {
      const side = r.id.split(':').pop() ?? 'front';
      const where = side === 'front' ? 'in front' : side === 'back' ? 'behind' : `on the ${side}`;
      const blockers = items.slice(1).map((f) => f.name);
      if (/a wall\)/.test(r.details)) blockers.push('the wall');
      const by = blockers.length ? ` ${sentence(list(blockers)).replace(/\.$/, '')} ${blockers.length > 1 ? 'are' : 'is'} in the way.` : '';
      return `${nm(first)} needs ${cm(r.threshold ?? 0)} ${where}, has ${cm(r.measured ?? 0)}.${by}`;
    }
    case 'Door swing': return `${list(items.map((f) => f.name)) || 'Something'} ${items.length > 1 ? 'block' : 'blocks'} the door from opening.`;
    case 'Door approach': return `${list(items.map((f) => f.name)) || 'Something'} ${items.length > 1 ? 'are' : 'is'} within 80 cm of the door.`;
    case 'Window access': return `${list(items.map((f) => f.name))} ${items.length > 1 ? 'are' : 'is'} tall and stand${items.length > 1 ? '' : 's'} within 40 cm of the window.`;
    case 'Unfolded fits': return sentence(r.details.replace(/\s*\(\d+ cm\)/, ''));
    case 'Clear route': return r.measured != null && r.threshold != null
      ? `The walkway from the door narrows to ${cm(r.measured)}; it needs ${cm(r.threshold)}.`
      : 'There is no clear walkway from the door.';
    case 'Budget': return r.measured != null && r.threshold != null
      ? `New items cost ${sek(r.measured)}, ${sek(r.measured - r.threshold)} over the ${sek(r.threshold)} budget.`
      : sentence(r.details);
    case 'Room shape': return 'The room outline crosses itself.';
    case 'Opening on wall': return sentence(r.details.replace(/\s*\(spans.*\)/, ''));
    default: return sentence(r.details);
  }
}

const designSeverity = (v: RuleVerdict): ProblemSeverity | null =>
  v.pass || v.severity === 'hard' ? null : v.severity === 'strong' ? 'warn' : v.score < 0.3 ? 'tip' : null;
const safetySeverity = (f: SafetyFinding): ProblemSeverity => (f.severity === 'critical' ? 'error' : f.severity === 'important' ? 'warn' : 'tip');

/** Merges referee checks, design rule verdicts and safety findings into one list, worst first. Fixes are added later. */
export function collectProblems(model: SpaceModel, furniture: FurnitureItem[], req: Requirements | null, opts: CollectOptions = {}): CollectResult {
  const byId = new Map(furniture.map((f) => [f.id, f]));
  const openingIds = new Set(model.openings.map((o) => o.id));
  const raw = new Map<string, ProblemRaw>();
  const out: Problem[] = [];
  const atOf = (itemIds: string[], opIds: string[], fallback?: Vec2 | null): Vec2 | null => {
    const f = itemIds.map((id) => byId.get(id)).find(Boolean);
    if (f) return { x: f.x, y: f.y };
    for (const id of opIds) { const c = openingCentre(model, id); if (c) return c; }
    return fallback ?? null;
  };

  const checks = opts.checks === false ? [] : validateLayout(model, furniture, req);
  for (const r of checks) {
    if (r.result !== 'fail') continue;
    const itemIds = r.subjectIds.filter((id) => byId.has(id));
    const opIds = r.subjectIds.filter((id) => openingIds.has(id));
    const space = model.spaces.find((s) => r.subjectIds.includes(s.id));
    const p: Problem = {
      id: `check:${r.id}`, severity: r.rule === 'Budget' ? 'warn' : 'error', source: 'check', rule: r.rule, itemIds, openingIds: opIds,
      at: atOf(itemIds, opIds, space ? centroid(space.polygon) : null), title: checkTitle(r, byId, model), fixes: [],
    };
    out.push(p); raw.set(p.id, { source: 'check', result: r });
  }

  if (opts.design) {
    let verdicts: RuleVerdict[] = [];
    try { verdicts = evaluateRules(model, furniture, req); } catch { verdicts = []; }
    for (const v of verdicts) {
      const severity = designSeverity(v); if (!severity) continue;
      const itemIds = v.itemIds.filter((id) => byId.has(id));
      const p: Problem = {
        id: `design:${v.ruleId}:${[...v.itemIds].sort().join(',')}`, severity, source: 'design', rule: v.name, itemIds, openingIds: v.itemIds.filter((id) => openingIds.has(id)),
        at: atOf(itemIds, []), title: sentence(v.message), fixes: [],
      };
      if (raw.has(p.id)) continue;
      out.push(p); raw.set(p.id, { source: 'design', verdict: v });
    }
  }

  if (opts.safety) {
    let findings: SafetyFinding[] = [];
    try { findings = quickFindings(model, furniture); } catch { findings = []; }
    for (const f of findings) {
      const itemIds = f.itemIds.filter((id) => byId.has(id));
      const text = f.message && f.message.length <= 140 ? f.message : f.title;
      const p: Problem = {
        id: `safety:${f.kind}:${[...f.itemIds].sort().join(',')}:${Math.round(f.at.x * 10)},${Math.round(f.at.y * 10)}`,
        severity: safetySeverity(f), source: 'safety', rule: f.title, itemIds, openingIds: f.itemIds.filter((id) => openingIds.has(id)),
        at: f.at, title: sentence(text), fixes: [],
      };
      if (raw.has(p.id)) continue;
      out.push(p); raw.set(p.id, { source: 'safety', finding: f });
    }
  }

  return { problems: rankProblems(out), raw, checks };
}

/** Worst first; a lower or equal ranked problem from another source about exactly the same items is dropped. */
export function rankProblems(list: Problem[]): Problem[] {
  const key = (p: Problem) => [...p.itemIds].sort().join(',');
  const out = [...list].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || srcRank(a) - srcRank(b));
  const kept: Problem[] = [];
  for (const p of out) {
    const k = key(p);
    if (k && p.source !== 'check' && kept.some((q) => q.source !== p.source && key(q) === k && SEVERITY_ORDER[q.severity] <= SEVERITY_ORDER[p.severity])) continue;
    if (kept.some((q) => q.id === p.id)) continue;
    kept.push(p);
  }
  return kept;
}

const srcRank = (p: Problem) => (p.source === 'check' ? 0 : p.source === 'safety' ? 1 : 2);
