// Critic: a fast second opinion on a solved layout. It judges each major decision and may
// propose at most three fixes, always as relation edits. It never moves geometry itself:
// fixes go back through the solver and the rules like any other program.
import { ai, aiReady, type AiTask } from '../../core/ai';
import { dataUrlToInlineData, type GeminiPart } from '../../core/gemini';
import type { DesignCritique, DesignProgram, DesignReport, LayoutCandidate, Relation, RelationKind, SpaceModel } from '../../core/types';
import { RELATION_KINDS, RELATION_SCHEMA, cleanRelation, describePlacement, sceneDescription, sceneRefs, wallInfo, withTimeout, type RefCtx } from './planner';
import { renderPlanPng } from './render';
import { semanticsOf } from './semantics';

export type Fix =
  | { op: 'add'; relation: Relation; why: string }
  | { op: 'remove'; subject: string; kind: RelationKind; target?: string; why: string }
  | { op: 'reweight'; subject: string; kind: RelationKind; target?: string; weight: number; why: string };

export type Critique = DesignCritique & { ops?: Fix[] };

export interface CritiqueOpts { signal?: AbortSignal; image?: boolean; timeoutMs?: number; brief?: string }

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    score: { type: 'NUMBER' },
    decisions: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { itemId: { type: 'STRING' }, verdict: { type: 'STRING', enum: ['keep', 'change'] }, reason: { type: 'STRING' } }, required: ['itemId', 'verdict', 'reason'] },
    },
    fixes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          op: { type: 'STRING', enum: ['add', 'remove', 'reweight'] },
          relation: RELATION_SCHEMA,
          why: { type: 'STRING' },
        },
        required: ['op', 'relation', 'why'],
      },
    },
  },
  required: ['summary', 'score', 'decisions'],
};

const SYSTEM = 'You are a senior interior designer reviewing a junior colleague\'s furniture layout. Judge each major decision: keep or change, and why, in one short plain sentence. Be honest and specific; praise only what works. Fixes are relation edits for a geometric solver, never coordinates. Output only JSON matching the schema.';

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const MINOR = new Set(['decor', 'lighting', 'floor']);

function relationLines(p: DesignProgram, short: (id: string) => string): string {
  return p.relations.map((r) => `  ${r.kind} ${short(r.subject)}${r.target ? ` -> ${r.target.startsWith('wall:') || ['window', 'door', 'room-centre'].includes(r.target) ? r.target : short(r.target)}` : ''} (w ${r.weight.toFixed(1)}): ${r.reason}`).join('\n');
}

export async function critique(model: SpaceModel, candidate: LayoutCandidate, report: DesignReport, opts: CritiqueOpts = {}): Promise<Critique> {
  if (!aiReady()) throw new Error('No model key');
  const items = candidate.furniture;
  const refs = sceneRefs(items);
  const short = (id: string) => refs.toShort.get(id) ?? id;
  const ctx: RefCtx = { ids: new Set(items.map((f) => f.id)), wallCount: model.spaces[0]?.polygon.length ?? 0, toLong: refs.toLong };
  const major = items.filter((f) => !MINOR.has(semanticsOf(f).role));
  const verdicts = report.verdicts.map((v) => `  ${v.pass ? 'PASS' : 'FAIL'} [${v.severity}] ${v.name}${v.itemIds.length ? ` (${v.itemIds.map(short).join(', ')})` : ''}: ${v.message}`).join('\n');
  const prompt = [
    opts.brief ? `The person asked: """${opts.brief.slice(0, 600)}"""` : '',
    sceneDescription(model, items, null, refs, true),
    '',
    'Design program the solver followed:',
    relationLines(report.program, short),
    '',
    'Measured rule results:',
    verdicts || '  none',
    '',
    `Judge these major items: ${major.map((f) => short(f.id)).join(', ') || 'none'}.`,
    'score: 0..10 overall. fixes: at most 3, only when a change clearly helps; each is a relation to add, remove or reweight.',
    `Relation kinds: ${RELATION_KINDS.join(', ')}. Targets: an item id, "window", "door", "wall:<index>", "room-centre".`,
  ].join('\n').trim();

  const parts: GeminiPart[] = [{ text: prompt }];
  let task: AiTask = 'fast';
  if (opts.image !== false) {
    try {
      const png = renderPlanPng(model, items);
      if (png) { parts.push(dataUrlToInlineData(png)); task = 'vision'; parts[0] = { text: `${prompt}\nThe image is the top-down plan of this layout.` }; }
    } catch { /* no canvas: text only */ }
  }

  const t0 = performance.now();
  const res = await withTimeout(ai<Record<string, unknown>>({ task, system: SYSTEM, parts, schema: SCHEMA, signal: opts.signal, temperature: 0.2 }), opts.timeoutMs ?? 25000, opts.signal);
  const raw = res.data ?? {};
  const known = new Set(items.map((f) => f.id));
  const decisions: DesignCritique['decisions'] = [];
  for (const d of Array.isArray(raw.decisions) ? raw.decisions : []) {
    if (!d || typeof d !== 'object') continue;
    const dd = d as Record<string, unknown>;
    const id = refs.toLong.get(text(dd.itemId, 20)) ?? text(dd.itemId, 80);
    if (!known.has(id) || decisions.some((x) => x.itemId === id)) continue;
    decisions.push({ itemId: id, verdict: dd.verdict === 'change' ? 'change' : 'keep', reason: text(dd.reason, 200) || 'No reason given.' });
  }
  const ops = cleanFixes(raw.fixes, ctx);
  const score = Math.min(10, Math.max(0, Number(raw.score) || 0));
  return {
    by: res.model, latencyMs: Math.round(res.ms || performance.now() - t0),
    summary: text(raw.summary, 300), decisions, score,
    ...(ops.length ? { ops } : {}),
  };
}

export function cleanFixes(raw: unknown, ctx: RefCtx): Fix[] {
  const out: Fix[] = [];
  for (const f of Array.isArray(raw) ? raw : []) {
    if (out.length >= 3) break;
    if (!f || typeof f !== 'object') continue;
    const ff = f as Record<string, unknown>;
    const rel = cleanRelation(ff.relation, ctx);
    if (!rel) continue;
    const why = text(ff.why, 200) || rel.reason;
    if (ff.op === 'remove') out.push({ op: 'remove', subject: rel.subject, kind: rel.kind, target: rel.target, why });
    else if (ff.op === 'reweight') out.push({ op: 'reweight', subject: rel.subject, kind: rel.kind, target: rel.target, weight: rel.weight, why });
    else if (ff.op === 'add') out.push({ op: 'add', relation: { ...rel, reason: rel.reason || why }, why });
  }
  return out;
}

const same = (r: Relation, f: { subject: string; kind: RelationKind; target?: string }) => r.subject === f.subject && r.kind === f.kind && (f.target === undefined || r.target === f.target);

/** The program with the critic's relation edits applied. Pure; positions are left to the solver. */
export function applyFixes(p: DesignProgram, fixes: Fix[]): DesignProgram {
  let relations = [...p.relations];
  for (const f of fixes) {
    if (f.op === 'remove') relations = relations.filter((r) => !same(r, f));
    else if (f.op === 'reweight') relations = relations.map((r) => (same(r, f) ? { ...r, weight: Math.min(1, Math.max(0, f.weight)), reason: f.why || r.reason } : r));
    else {
      const i = relations.findIndex((r) => same(r, f.relation));
      if (i >= 0) relations[i] = f.relation; else relations.push(f.relation);
    }
  }
  return { ...p, relations, notes: [...p.notes, ...fixes.map((f) => `Second opinion: ${f.why}`)] };
}

/** Short plain description of a fix for the decision trail. */
export function describeFix(f: Fix, name: (id: string) => string, model?: SpaceModel): string {
  const walls = model ? wallInfo(model) : [];
  const tgt = (t?: string) => !t ? '' : t.startsWith('wall:') ? ` the ${walls[Number(t.slice(5))]?.name ?? t} wall` : t === 'room-centre' ? ' the room centre' : t === 'window' || t === 'door' ? ` the ${t}` : ` ${name(t)}`;
  const k = (kind: RelationKind) => kind.replace(/-/g, ' ');
  if (f.op === 'add') return `${name(f.relation.subject)}: ${k(f.relation.kind)}${tgt(f.relation.target)}`;
  if (f.op === 'remove') return `${name(f.subject)}: no longer ${k(f.kind)}${tgt(f.target)}`;
  return `${name(f.subject)}: ${f.weight >= 0.5 ? 'stronger' : 'weaker'} ${k(f.kind)}${tgt(f.target)}`;
}

export { describePlacement };
