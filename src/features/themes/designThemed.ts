// Themed rooms: a sentence becomes a theme brief, the brief's custom pieces are built in parallel
// (each streams in as it completes), and the existing solver lays the room out with wall decor on
// the walls. The whole room is visible at once from code-built pieces; model-built pieces replace
// them in place at the same exact size, so the layout stays valid as they arrive.
import { aiReady } from '../../core/ai';
import type { FurnitureItem, LayoutCandidate, ObjectSpec, Relation, Requirements, SpaceModel } from '../../core/types';
import { catalogEntry, makeItem } from '../furniture/catalog';
import { mergeFurniture, subModelFor } from '../building/submodel';
import { fitSpec } from '../forge/fit';
import { generateObject } from '../forge/generate';
import { dominantColor, mainMaterial, specToItem } from '../forge/library';
import { rulesObject } from '../forge/rulesFallback';
import { rulesConcept } from '../design/planner';
import { evaluateRules } from '../design/rules';
import { describeLayout, solveProgram } from '../design/solve';
import type { DesignResult, FullReport, Stage } from '../design/pipeline';
import { designScore } from '../design/score';
import { wallElevation } from '../layout/wallItems';
import { themeBrief, WALL_RECIPES, type ThemeBrief, type ThemeObject } from './brief';
import { recipeSpec } from './recipes';

export interface ThemedOpts {
  onStage?: (stages: Stage[]) => void;
  /** Each object as soon as it exists: code-built ones at once, model-built ones as they finish. */
  onObject?: (spec: ObjectSpec, obj: ThemeObject, index: number) => void;
  /** The laid-out room: first with code-built pieces, then again each time a model piece lands. */
  onProgress?: (result: DesignResult, phase: 'rules' | 'concepts' | 'critic') => void;
  signal?: AbortSignal;
  spaceId?: string;
  /** Use this brief instead of writing one (refinements). */
  brief?: ThemeBrief;
  /** Requirements to respect (route width, budget); the theme supplies the items. */
  req?: Requirements;
  /** Specs already made for objects (by object key), reused instead of building again. */
  reuse?: Map<string, ObjectSpec>;
}

export interface ThemedResult extends DesignResult {
  brief: ThemeBrief;
  /** Final spec per object key (name + index). */
  specs: Map<string, ObjectSpec>;
  timings: { briefMs: number; firstObjectMs: number | null; roomMs: number | null; totalMs: number; models: number; fallbacks: number };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const abortIf = (s?: AbortSignal) => { if (s?.aborted) throw new DOMException('Aborted', 'AbortError'); };
export const objectKey = (o: ThemeObject, k = 0) => `${o.name.toLowerCase()}#${k}`;

function baseReq(req?: Requirements): Requirements {
  return {
    purpose: req?.purpose ?? 'themed room', people: req?.people ?? 1, budgetSek: null, items: [], routeTargets: req?.routeTargets ?? [{ kind: 'window' }],
    minRouteWidthM: req?.minRouteWidthM ?? 0.6, style: 'theme', lockedIds: [], notes: [], questions: [], compiledBy: 'rules',
  };
}

/** Room item for a spec, hung on the wall when the object is wall-mounted. */
function itemFor(spec: ObjectSpec, o: ThemeObject, ceilingM: number): FurnitureItem {
  const f = specToItem(spec);
  if (o.mount === 'wall' || (o.recipe && WALL_RECIPES.has(o.recipe))) {
    f.mount = 'wall';
    f.clearance = { front: 0, back: 0, left: 0, right: 0 };
    f.elevationM = wallElevation(f, ceilingM);
  }
  return f;
}

/** A catalogue piece, or a labelled stand-in for a store product. */
function catalogueItem(o: ThemeObject): FurnitureItem {
  const id = o.catalogId && catalogEntry(o.catalogId) ? o.catalogId : 'plant';
  const f = makeItem(id);
  if (o.source === 'store') f.name = `${catalogEntry(id)!.name} (stand-in for ${o.query ?? o.name})`;
  return f;
}

/** Relations that say where themed pieces want to be (litter box in a corner, perch at the window). */
function placeRelations(items: Array<{ f: FurnitureItem; o: ThemeObject }>): Relation[] {
  const out: Relation[] = [];
  for (const { f, o } of items) {
    if (f.mount === 'wall') continue;
    if (o.place === 'corner') out.push({ kind: 'in-corner', subject: f.id, weight: 0.8, reason: `${o.name} tucked into a corner.` });
    else if (o.place === 'window') out.push({ kind: 'near-window', subject: f.id, target: 'window', weight: 0.8, reason: `${o.name} by the window for the light and the view.` });
    else if (o.place === 'wall') out.push({ kind: 'against-wall', subject: f.id, weight: 0.6, reason: `${o.name} against a wall.` });
  }
  return out;
}

/** Look up a real product for a store item when a key allows; keeps the stand-in's size. */
async function attachListing(f: FurnitureItem, o: ThemeObject, signal?: AbortSignal): Promise<void> {
  if (!aiReady() || !o.query) return;
  try {
    const { searchProducts } = await import('../stores/search');
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000));
    const res = await Promise.race([searchProducts(o.query, { limit: 1, readPages: false, signal }), timeout]);
    const l = res[0];
    if (l) { f.listing = l; f.name = l.title.slice(0, 60); f.sourceKind = 'catalog'; }
  } catch { /* stand-in stays, labelled as such */ }
}

export async function designThemedRoom(model: SpaceModel, text: string, opts: ThemedOpts = {}): Promise<ThemedResult> {
  if (opts.spaceId && model.spaces.length > 1) {
    const sub = subModelFor(model, opts.spaceId);
    if (sub) {
      const back = <R extends DesignResult>(r: R): R => ({ ...r, candidates: r.candidates.map((c) => ({ ...c, furniture: mergeFurniture(model, sub.spaceId, c.furniture, sub.offset) })) });
      const res = await designThemedRoom(sub.model, text, { ...opts, spaceId: undefined, onProgress: opts.onProgress && ((r, ph) => opts.onProgress!(back(r), ph)) });
      return back(res);
    }
  }
  const t0 = now();
  const stages: Stage[] = [];
  const emit = () => opts.onStage?.(stages.map((s) => ({ ...s })));
  const start = (id: string, label: string, m?: string) => { stages.push({ id, label, status: 'running', model: m }); emit(); return now(); };
  const end = (id: string, t: number, patch: Partial<Stage> = {}) => { const s = stages.find((x) => x.id === id); if (s) Object.assign(s, { status: 'done', ms: Math.round(now() - t) }, patch); emit(); };
  if (!model.spaces.length) return { candidates: [], reports: [], infeasibility: { reasons: ['No room outline yet'], relaxations: [] }, stages, brief: opts.brief ?? (await themeBrief(text)), specs: new Map(), timings: { briefMs: 0, firstObjectMs: null, roomMs: null, totalMs: 0, models: 0, fallbacks: 0 } };

  // (a) Brief.
  let t = start('brief', 'Reading the idea');
  const brief = opts.brief ?? (await themeBrief(text, opts.signal));
  const briefMs = Math.round(now() - t);
  end('brief', t, { label: brief.title, model: brief.by === 'gemini' ? brief.model : 'rules', detail: `${brief.objects.length} pieces` });
  abortIf(opts.signal);

  // (b) Objects: code-built at once; model-built in parallel, each replacing its stand-in on arrival.
  t = start('objects', 'Making the pieces', aiReady() ? 'parallel' : 'rules');
  const online = aiReady();
  const entries: Array<{ f: FurnitureItem; o: ThemeObject; key: string; idx: number }> = [];
  const specs = new Map<string, ObjectSpec>();
  const pending: Array<Promise<void>> = [];
  let firstObjectMs: number | null = null, models = 0, fallbacks = 0;
  const shared = new Map<string, Promise<ObjectSpec>>();
  let cands: LayoutCandidate[] = [];
  const reports: FullReport[] = [];
  brief.objects.forEach((o, i) => {
    for (let k = 0; k < Math.max(1, o.qty ?? 1); k++) {
      const key = objectKey(o, k);
      if (o.source !== 'custom') {
        const f = catalogueItem(o);
        if (o.source === 'store') pending.push(attachListing(f, o, opts.signal));
        entries.push({ f, o, key, idx: i });
        continue;
      }
      const reused = opts.reuse?.get(key);
      const quick = reused ?? recipeSpec(o, brief.palette) ?? rulesObject(o.prompt ?? o.name);
      const f = itemFor(quick, o, model.ceilingM);
      specs.set(key, quick);
      entries.push({ f, o, key, idx: i });
      firstObjectMs ??= Math.round(now() - t0);
      opts.onObject?.(quick, o, i);
      // Pieces with a recipe are finished in code (exact words, instant); the model makes the rest.
      if (reused || !online || o.recipe) continue;
      // One model call per distinct object; copies (two gaming chairs) share it.
      const job = shared.get(o.name) ?? generateObject(o.prompt ?? o.name, { signal: opts.signal });
      shared.set(o.name, job);
      models += k === 0 ? 1 : 0;
      pending.push(job.then((spec) => {
        if (spec.model === 'rules') { fallbacks += k === 0 ? 1 : 0; return; }
        const fitted: ObjectSpec = { ...fitSpec(spec, quick.size), semantics: { ...spec.semantics, category: quick.semantics.category } };
        specs.set(key, fitted);
        const e = entries.find((x) => x.key === key)!;
        e.f = { ...e.f, custom: fitted, name: fitted.name || e.f.name, color: dominantColor(fitted), material: mainMaterial(fitted) };
        for (const c of cands) c.furniture = c.furniture.map((g) => (g.id === e.f.id ? { ...g, custom: fitted, name: e.f.name, color: e.f.color, material: e.f.material } : g));
        opts.onObject?.(fitted, o, i);
        if (cands.length) opts.onProgress?.(snapshot(), 'concepts');
      }, () => { fallbacks += k === 0 ? 1 : 0; }));
    }
  });
  end('objects', t, { status: 'running', detail: online ? `${models} being made, ${entries.length - models} ready` : `${entries.length} ready` });

  // (c) Lay out with the solver; the referee-backed rules score each layout.
  t = start('solve', 'Laying out the room', 'geometry');
  const req = baseReq(opts.req);
  let items = entries.map((e) => e.f);
  const left: string[] = [];
  const conceptFor = (list: FurnitureItem[]) => {
    const c = rulesConcept(model, list, req);
    const ids = new Set(list.map((f) => f.id));
    c.relations = [...c.relations, ...placeRelations(entries.filter((e) => ids.has(e.f.id)))];
    c.name = brief.title; c.idea = `${brief.mood}; for ${brief.forWhom}.`;
    return c;
  };
  let concept = conceptFor(items);
  let solved = await solveProgram(model, items, concept, { variants: 2, seed: model.version * 31 + 7, signal: opts.signal, req, timeBudgetMs: 1200 });
  // Too much for the room: leave out plain catalogue pieces first, then the bulkiest extras.
  for (let tries = 0; !solved.candidates.length && tries < 4; tries++) {
    const floor = entries.filter((e) => items.includes(e.f) && e.f.mount !== 'wall' && e.f.category !== 'rug' && e.idx > 0);
    const drop = floor.filter((e) => e.o.source !== 'custom').sort((a, b) => b.f.w * b.f.d - a.f.w * a.f.d)[0] ?? floor.sort((a, b) => b.f.w * b.f.d - a.f.w * a.f.d)[0];
    if (!drop) break;
    left.push(drop.f.name);
    items = items.filter((f) => f !== drop.f);
    concept = conceptFor(items);
    solved = await solveProgram(model, items, concept, { variants: 2, seed: model.version * 31 + 7 + tries, signal: opts.signal, req, timeBudgetMs: 1200 });
  }
  if (left.length && solved.candidates.length) brief.notes.push(`Left out to fit the room: ${left.join(', ')}.`);
  abortIf(opts.signal);
  // Pieces that landed while solving: same size and id, so only their look changes.
  const byId = new Map(entries.map((e) => [e.f.id, e.f]));
  cands = solved.candidates.map((c, k) => ({
    ...c, name: k === 0 ? brief.title : `${brief.title} ${k + 1}`,
    furniture: c.furniture.map((g) => { const f = byId.get(g.id); return f && f.custom !== g.custom ? { ...g, custom: f.custom, name: f.name, color: f.color, material: f.material } : g; }),
  }));
  const score = (c: LayoutCandidate) => { const v = evaluateRules(model, c.furniture, req); const ds = Math.round(Math.min(100, Math.max(0, Number(designScore(v)) || 0))); return { v, ds }; };
  for (const c of cands) {
    const { v, ds } = score(c);
    reports.push({ candidateId: c.id, program: solved.reports.find((r) => r.candidateId === c.id)?.program ?? concept, verdicts: v, designScore: ds, finalScore: ds, conceptName: brief.title, idea: concept.idea });
  }
  const roomMs = cands.length ? Math.round(now() - t0) : null;
  end('solve', t, { detail: `${cands.length} layout${cands.length === 1 ? '' : 's'}` });
  function snapshot(): DesignResult {
    const order = cands.map((c, i) => ({ c, r: reports[i] })).sort((a, b) => b.r.finalScore - a.r.finalScore);
    return {
      candidates: order.map(({ c, r }) => { const d = describeLayout(model, c.furniture, req); return { ...c, summary: d.summary || c.summary, metrics: { ...c.metrics, score: r.finalScore }, generator: 'theme' }; }),
      reports: order.map(({ c, r }) => ({ ...r, reasons: describeLayout(model, c.furniture, req).reasons })),
      infeasibility: cands.length ? null : solved.infeasibility, stages: stages.map((s) => ({ ...s })),
    };
  }
  if (cands.length) opts.onProgress?.(snapshot(), 'rules');

  // (d) Wait for the model pieces (each already swapped in as it landed).
  await Promise.all(pending);
  abortIf(opts.signal);
  const objStage = stages.find((s) => s.id === 'objects');
  if (objStage) Object.assign(objStage, { status: 'done', ms: Math.round(now() - t0), detail: online ? `${models - fallbacks} made by the model${fallbacks ? `, ${fallbacks} from templates` : ''}` : 'made from templates' });
  // Store listings may have renamed stand-ins: carry the names into the layouts.
  for (const c of cands) c.furniture = c.furniture.map((g) => { const e = entries.find((x) => x.f.id === g.id); return e && e.o.source === 'store' ? { ...g, name: e.f.name, listing: e.f.listing } : g; });
  for (const [i, c] of cands.entries()) { const { v, ds } = score(c); Object.assign(reports[i], { verdicts: v, designScore: ds, finalScore: ds }); }
  emit();
  const res = snapshot();
  return { ...res, brief, specs, timings: { briefMs, firstObjectMs, roomMs, totalMs: Math.round(now() - t0), models, fallbacks } };
}
