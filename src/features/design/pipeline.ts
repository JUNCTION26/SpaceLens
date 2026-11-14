// The design pipeline: items -> concepts -> exact solve -> rules -> second opinion -> one round
// of relation fixes -> ranked candidates, each with its full decision trail.
// Every model step has a rule-based fallback, so the whole thing works offline.
import { aiReady } from '../../core/ai';
import { getState } from '../../core/store';
import type { DesignReport, FurnitureItem, Infeasibility, LayoutCandidate, Requirements, RuleVerdict, SpaceModel } from '../../core/types';
import { catalogEntry, makeItem } from '../furniture/catalog';
import { pointInPolygon, uid } from '../../core/geometry';
import { explainInfeasible } from '../layout/solver';
import { applyFixes, critique, type Critique } from './critic';
import { planConcepts, rulesConcept, type Concept } from './planner';
import { evaluateRules } from './rules';
import { designScore } from './score';
import { describeLayout, solveProgram } from './solve';
import { mergeFurniture, subModelFor } from '../building/submodel';
import { isThemedRequest } from '../themes/brief';
import { designThemedRoom } from '../themes/designThemed';
import { refineThemed } from '../themes/refine';
import { lastThemed, rememberThemed } from '../themes/session';

export type StageStatus = 'running' | 'done' | 'skipped' | 'failed';
export interface Stage { id: string; label: string; status: StageStatus; ms?: number; model?: string; detail?: string }

export interface DesignOpts {
  onStage?: (stages: Stage[]) => void;
  /** Number of concepts to ask for (1-3). */
  variants?: number;
  signal?: AbortSignal;
  /** The person's own words, given to the planner and critic for context. */
  brief?: string;
  /**
   * Called as better results arrive: first the rule-based layouts (right away), then the model's
   * concepts, then the second opinion. The returned promise still resolves with the final result.
   */
  onProgress?: (result: DesignResult, phase: 'rules' | 'concepts' | 'critic') => void;
  /** Set false to skip the second opinion. */
  critic?: boolean;
  /**
   * Room to design in a building with several rooms. The room is cut out as its own model, so the
   * planner, solver, rules and critic all see one room; each candidate's furniture comes back in
   * building coordinates with every other room's furniture kept as it was.
   */
  spaceId?: string;
}

export type FullReport = DesignReport & {
  critique?: Critique; conceptName?: string; idea?: string; revised?: boolean; designScore: number; finalScore: number;
  /** Per piece, sentences that are true of the solved layout (from its final poses and the rules that hold). */
  reasons?: Array<{ itemId: string; text: string }>;
};

export interface DesignResult { candidates: LayoutCandidate[]; reports: FullReport[]; infeasibility: Infeasibility | null; stages: Stage[] }

// ---------- items ----------

/** Items to place: requested catalogue pieces, kept pieces, and anything locked in the room. */
export function buildDesignItems(model: SpaceModel, req: Requirements): FurnitureItem[] {
  const items: FurnitureItem[] = [];
  const locked = new Set(req.lockedIds);
  for (const ri of req.items) {
    for (let k = 0; k < Math.max(1, ri.qty); k++) {
      const existing = k === 0 && ri.keepExistingId ? model.furniture.find((f) => f.id === ri.keepExistingId) : undefined;
      if (existing) {
        items.push({ ...existing, clearance: { ...existing.clearance }, locked: existing.locked || locked.has(existing.id) });
        continue;
      }
      if (!catalogEntry(ri.catalogId)) {
        // A generated object: copy one already in the room with that id or spec.
        const proto = model.furniture.find((f) => f.catalogId === ri.catalogId || f.custom?.id === ri.catalogId);
        if (proto) { items.push({ ...proto, id: uid('f'), clearance: { ...proto.clearance }, locked: false }); continue; }
      }
      items.push(makeItem(ri.catalogId));
    }
  }
  for (const f of model.furniture) {
    if ((f.locked || locked.has(f.id)) && !items.some((i) => i.id === f.id)) items.push({ ...f, clearance: { ...f.clearance }, locked: true });
  }
  return items;
}

// ---------- scoring ----------

/** designScore, clamped to 0..100. */
export function score100(verdicts: RuleVerdict[]): number {
  const s = Number(designScore(verdicts)) || 0;
  return Math.round(Math.min(100, Math.max(0, s)));
}

/** Rules carry most of the weight; the critic can move a layout by at most 25 points. */
export function blend(rules: number, critic?: Critique): number {
  if (!critic || critic.by === 'rules') return rules;
  return Math.round(rules * 0.75 + critic.score * 10 * 0.25);
}

// ---------- pipeline ----------

const abortIf = (s?: AbortSignal) => { if (s?.aborted) throw new DOMException('Aborted', 'AbortError'); };
const now = () => performance.now();

type SolveOut = Awaited<ReturnType<typeof solveProgram>>;

/**
 * The room a request is about in a building: the selected room, the room of the selected item or
 * wall, else the first room. Null for a single-room model.
 */
export function activeSpaceId(model: SpaceModel): string | null {
  if (model.spaces.length < 2) return null;
  const sel = getState().selection;
  if (sel?.kind === 'space' && model.spaces.some((s) => s.id === sel.id)) return sel.id;
  if (sel?.kind === 'wall' || sel?.kind === 'opening') {
    const id = sel.kind === 'wall' ? sel.id.slice(0, sel.id.lastIndexOf(':')) : model.openings.find((o) => o.id === sel.id)?.spaceId;
    if (id && model.spaces.some((s) => s.id === id)) return id;
  }
  if (sel?.kind === 'furniture') {
    const f = model.furniture.find((x) => x.id === sel.id);
    const s = f && model.spaces.find((sp) => pointInPolygon(f, sp.polygon));
    if (s) return s.id;
  }
  return model.spaces[0].id;
}

/**
 * Themed or personal briefs ("a room for my cat named Gerard") go to the theme pipeline: custom
 * pieces, printed names and wall decor. Follow-ups saved on the requirements as "Change: ..." edit
 * the last themed room in place.
 */
async function designThemed(model: SpaceModel, req: Requirements, text: string, opts: DesignOpts, spaceId: string | null): Promise<DesignResult> {
  const changes = req.notes.filter((n) => n.startsWith('Change: ')).map((n) => n.slice(8));
  const prev = lastThemed();
  const topts = { onStage: opts.onStage, onProgress: opts.onProgress, signal: opts.signal, spaceId: spaceId ?? undefined, req };
  if (prev && prev.text === text && changes.length > prev.applied.length && prev.applied.every((c, i) => changes[i] === c)) {
    let result = prev.result;
    for (const c of changes.slice(prev.applied.length)) result = await refineThemed(model, result, c, topts);
    rememberThemed({ text, result, applied: changes });
    return result;
  }
  const result = await designThemedRoom(model, text, topts);
  rememberThemed({ text, result, applied: [] });
  if (changes.length) return designThemed(model, req, text, opts, spaceId);
  return result;
}

export async function designRoom(model: SpaceModel, req: Requirements, opts: DesignOpts = {}): Promise<DesignResult> {
  const spaceId = opts.spaceId ?? activeSpaceId(model);
  if (req.style === 'theme' || (opts.brief && isThemedRequest(opts.brief))) return designThemed(model, req, opts.brief ?? req.purpose, opts, spaceId);
  if (spaceId && model.spaces.length > 1) {
    const sub = subModelFor(model, spaceId);
    if (!sub) return { candidates: [], reports: [], infeasibility: { reasons: ['That room is not in this plan'], relaxations: [] }, stages: [] };
    const back = (r: DesignResult): DesignResult => ({ ...r, candidates: r.candidates.map((c) => ({ ...c, furniture: mergeFurniture(model, sub.spaceId, c.furniture, sub.offset) })) });
    const res = await designOneRoom(sub.model, req, { ...opts, spaceId: undefined, onProgress: opts.onProgress && ((r, ph) => opts.onProgress!(back(r), ph)) });
    return back(res);
  }
  return designOneRoom(model, req, opts);
}

async function designOneRoom(model: SpaceModel, req: Requirements, opts: DesignOpts): Promise<DesignResult> {
  const stages: Stage[] = [];
  const emit = () => opts.onStage?.(stages.map((s) => ({ ...s })));
  const start = (id: string, label: string, model?: string) => { const t0 = now(); stages.push({ id, label, status: 'running', model }); emit(); return t0; };
  const end = (id: string, t0: number, patch: Partial<Stage> = {}) => {
    const s = stages.find((x) => x.id === id);
    if (s) Object.assign(s, { status: 'done', ms: Math.round(now() - t0) }, patch);
    emit();
  };
  const online = aiReady();
  const modelName = online ? getState().settings.geminiModel : undefined;

  if (!model.spaces.length) return { candidates: [], reports: [], infeasibility: { reasons: ['No room outline yet'], relaxations: [] }, stages };

  // 1. Items
  let t = start('room', 'Understanding the room');
  const items = buildDesignItems(model, req);
  end('room', t);
  if (!items.length) return { candidates: [], reports: [], infeasibility: { reasons: ['Nothing to place yet'], relaxations: [] }, stages };
  abortIf(opts.signal);

  // 2. Concepts
  const want = Math.min(3, Math.max(1, opts.variants ?? 3));
  t = start('plan', online ? `Planning ${want} concept${want > 1 ? 's' : ''}` : 'Planning with rules', modelName);
  const planP = planConcepts(model, items, req, online ? want : 1, { signal: opts.signal, brief: opts.brief });
  if (online && opts.onProgress) {
    // Show rule-based layouts at once while the model is still thinking.
    planP.catch(() => undefined);
    try {
      const early = await solveProgram(model, items, rulesConcept(model, items, req), { variants: Math.max(2, want), seed: model.version * 31 + 500, signal: opts.signal, req });
      const cands = early.candidates.map((cand) => {
        const verdicts = evaluateRules(model, cand.furniture, req);
        return { cand, verdicts, ds: score100(verdicts) };
      }).sort((a, b) => b.ds - a.ds);
      if (cands.length) {
        const desc = cands.map(({ cand }) => describeLayout(model, cand.furniture, req));
        opts.onProgress({
          candidates: cands.map(({ cand, ds }, k) => ({ ...cand, name: desc[k].name || cand.name, summary: desc[k].summary || cand.summary, metrics: { ...cand.metrics, score: ds } })),
          reports: cands.map(({ cand, verdicts, ds }, k) => ({ candidateId: cand.id, program: early.reports?.find((r) => r.candidateId === cand.id)?.program ?? rulesConcept(model, items, req), verdicts, designScore: ds, finalScore: ds, reasons: desc[k].reasons })),
          infeasibility: null, stages: stages.map((x) => ({ ...x })),
        }, 'rules');
      }
    } catch (e) { if ((e as Error).name === 'AbortError') throw e; }
  }
  const concepts: Concept[] = await planP;
  const planned = concepts[0]?.by === 'gemini';
  end('plan', t, {
    label: planned ? `Planned ${concepts.length} concept${concepts.length > 1 ? 's' : ''}` : 'Planned with rules',
    model: planned ? concepts[0].model : 'rules',
    detail: planned ? concepts.map((c) => c.name).join(', ') : concepts[0]?.notes.find((n) => n.startsWith('Planner unavailable')),
    status: online && !planned ? 'failed' : 'done',
  });
  abortIf(opts.signal);

  // 3. Solve every concept in parallel. Without a planner, ask the solver for several variants.
  t = start('solve', 'Solving', 'geometry');
  const perConcept = concepts.length > 1 ? 1 : Math.max(2, want);
  const solved: SolveOut[] = await Promise.all(concepts.map((c, i) =>
    Promise.resolve(solveProgram(model, items, c, { variants: perConcept, seed: model.version * 31 + i + 1, signal: opts.signal, req }))));
  type Entry = { cand: LayoutCandidate; concept: Concept; report?: DesignReport };
  const entries: Entry[] = [];
  solved.forEach((s, i) => s.candidates.forEach((cand, k) => {
    const c = concepts[i];
    const name = planned && c.name ? (k === 0 ? c.name : `${c.name} ${k + 1}`) : cand.name;
    entries.push({ cand: { ...cand, name }, concept: c, report: s.reports?.find((r) => r.candidateId === cand.id) });
  }));
  end('solve', t, { detail: `${entries.length} layout${entries.length === 1 ? '' : 's'}` });
  abortIf(opts.signal);

  if (!entries.length) {
    const inf = solved.find((s) => s.infeasibility)?.infeasibility ?? explainInfeasible(model, req);
    return { candidates: [], reports: [], infeasibility: inf, stages };
  }

  // 4. Rules (the referee is independent of the solver).
  t = start('rules', 'Checking rules', 'rules');
  const reports: FullReport[] = entries.map(({ cand, concept, report }) => {
    const verdicts = evaluateRules(model, cand.furniture, req);
    const ds = score100(verdicts);
    return { candidateId: cand.id, program: report?.program ?? concept, verdicts, conceptName: concept.name, idea: concept.idea, designScore: ds, finalScore: ds };
  });
  const ruleCount = new Set(reports.flatMap((r) => r.verdicts.map((v) => v.ruleId))).size;
  end('rules', t, { label: `Checked ${ruleCount} rules`, detail: `best ${Math.max(...reports.map((r) => r.designScore))}/100` });
  abortIf(opts.signal);
  // Card text comes only from the solved layout, never from what a concept hoped for: the name,
  // summary and per-piece reasons describe final poses and the rules that actually hold.
  const described = new WeakMap<FurnitureItem[], ReturnType<typeof describeLayout>>();
  const describe = (f: FurnitureItem[]) => { let d = described.get(f); if (!d) { d = describeLayout(model, f, req); described.set(f, d); } return d; };
  const snapshot = (): DesignResult => {
    const ranked = entries.map((e, i) => ({ e, r: reports[i] })).sort((a, b) => b.r.finalScore - a.r.finalScore);
    const candidates = ranked.map(({ e, r }) => {
      const d = describe(e.cand.furniture);
      return { ...e.cand, name: d.name || e.cand.name, summary: d.summary || e.cand.summary, metrics: { ...e.cand.metrics, score: r.finalScore }, generator: r.critique ? `${e.cand.generator} + critic` : e.cand.generator };
    });
    const out: FullReport[] = ranked.map(({ e, r }) => ({ ...r, idea: undefined, reasons: describe(e.cand.furniture).reasons }));
    return { candidates, reports: out, infeasibility: null, stages: stages.map((x) => ({ ...x })) };
  };
  if (planned) opts.onProgress?.(snapshot(), 'concepts');

  // 5. Second opinion on the strongest few, in parallel; one round of relation fixes.
  if (online && opts.critic !== false) {
    t = start('critic', 'Second opinion', modelName);
    const order = reports.map((_, i) => i).sort((a, b) => reports[b].designScore - reports[a].designScore).slice(0, 3);
    let revisedCount = 0, failed = 0, criticModel: string | undefined;
    await Promise.all(order.map(async (i) => {
      const rep = reports[i];
      let cr: Critique;
      try { cr = await critique(model, entries[i].cand, rep, { signal: opts.signal, brief: opts.brief }); }
      catch (e) { if ((e as Error).name === 'AbortError') throw e; failed++; return; }
      criticModel = cr.by;
      rep.critique = cr;
      rep.finalScore = blend(rep.designScore, cr);
      if (!cr.ops?.length || !cr.decisions.some((d) => d.verdict === 'change')) return;
      const program = applyFixes(rep.program, cr.ops);
      const again = await Promise.resolve(solveProgram(model, items, program, { variants: 1, seed: model.version * 31 + 97 + i, signal: opts.signal, req }));
      const next = again.candidates[0];
      if (!next) return;
      const verdicts = evaluateRules(model, next.furniture, req);
      const ds = score100(verdicts);
      // Keep the revision only if the measured rules do not get worse.
      if (ds < rep.designScore) { rep.program = { ...rep.program, notes: [...rep.program.notes, 'Second-opinion fixes were tried and made the measured result worse, so they were not kept.'] }; return; }
      revisedCount++;
      const cand: LayoutCandidate = { ...next, id: entries[i].cand.id, name: entries[i].cand.name };
      entries[i] = { ...entries[i], cand };
      Object.assign(rep, { program, verdicts, designScore: ds, finalScore: blend(ds, cr), revised: true });
    }));
    end('critic', t, {
      model: criticModel ?? modelName,
      status: failed === order.length ? 'failed' : 'done',
      detail: failed === order.length ? 'unavailable' : revisedCount ? `${revisedCount} layout${revisedCount > 1 ? 's' : ''} revised` : 'no changes',
    });
    opts.onProgress?.(snapshot(), 'critic');
  } else {
    stages.push({ id: 'critic', label: 'Second opinion', status: 'skipped', detail: online ? 'off' : 'no model key' }); emit();
  }

  // 6. Rank.
  return snapshot();
}
