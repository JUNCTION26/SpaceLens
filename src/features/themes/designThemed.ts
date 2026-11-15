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
import { capFloorItems, findNames, rulesBrief, themeBrief, withNamePosters, WALL_RECIPES, type ThemeBrief, type ThemeObject } from './brief';
import { recipeSpec } from './recipes';
import { checkContract, essentialsOnly, planContract, type Contract, type Plan } from './contract';

export interface ThemedOpts {
  onStage?: (stages: Stage[]) => void;
  /** Each object as soon as it exists: code-built ones at once, model-built ones as they finish. */
  onObject?: (spec: ObjectSpec, obj: ThemeObject, index: number) => void;
  /** The laid-out room: first with code-built pieces, then again each time a model piece lands. */
  onProgress?: (result: DesignResult & { partial?: boolean }, phase: 'rules' | 'concepts' | 'critic') => void;
  signal?: AbortSignal;
  spaceId?: string;
  /** Use this brief instead of writing one (refinements). */
  brief?: ThemeBrief;
  /** Requirements to respect (route width, budget); the theme supplies the items. */
  req?: Requirements;
  /** Specs already made for objects (by object key), reused instead of building again. */
  reuse?: Map<string, ObjectSpec>;
  /** Build everything from code (kit pieces, no model calls); the wrapper upgrades pieces later. */
  offline?: boolean;
}

export interface ThemedResult extends DesignResult {
  brief: ThemeBrief;
  /** Final spec per object key (name + index). */
  specs: Map<string, ObjectSpec>;
  /** True on streamed in-progress rooms; the last emission and the returned result are never partial. */
  partial?: boolean;
  /** The room's name for the layout card (Gerard's room). */
  roomName?: string;
  /** Completeness check against the kit or brief, with what was compromised. */
  contract?: Contract;
  /** Which object each laid-out piece came from. */
  pieces?: Array<{ id: string; key: string; o: ThemeObject }>;
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
    if (o.hero) (f as FurnitureItem & { hero?: boolean }).hero = true;
    if (o.eyeM) f.elevationM = Math.max(0, Math.min(o.eyeM - f.h / 2, ceilingM - f.h - 0.05));
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

/**
 * Quick poses while a room assembles: floor pieces side by side along the walls facing in, wall
 * pieces along the walls at their height, rugs in the middle. Overlaps are possible; the solver
 * settles everything a moment later.
 */
export function draftPoses(model: SpaceModel, items: FurnitureItem[]): FurnitureItem[] {
  const poly = model.spaces[0]?.polygon ?? [];
  if (poly.length < 3) return items;
  let area2 = 0;
  poly.forEach((p, i) => { const q = poly[(i + 1) % poly.length]; area2 += p.x * q.y - q.x * p.y; });
  const sign = area2 >= 0 ? 1 : -1;
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  const mid = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  const cursor = { floor: { edge: 0, at: 0.1 }, wall: { edge: 0, at: 0.1 } };
  return items.map((f) => {
    if (f.category === 'rug') return { ...f, x: mid.x, y: mid.y, rotation: 0 };
    const c = f.mount === 'wall' ? cursor.wall : cursor.floor;
    for (let guard = 0; guard < poly.length * 2; guard++) {
      const p = poly[c.edge % poly.length], q = poly[(c.edge + 1) % poly.length];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      if (c.at + f.w <= len - 0.1 || guard === poly.length * 2 - 1) {
        const ux = (q.x - p.x) / len, uy = (q.y - p.y) / len;
        const nx = -uy * sign, ny = ux * sign;
        const along = c.at + f.w / 2, inset = f.d / 2 + 0.02;
        c.at += f.w + 0.15;
        return { ...f, x: p.x + ux * along + nx * inset, y: p.y + uy * along + ny * inset, rotation: Math.atan2(uy * sign, ux * sign) };
      }
      c.edge++; c.at = 0.1;
    }
    return { ...f, x: mid.x, y: mid.y };
  });
}

const ANCHORS = new Set(['table', 'desk', 'cafe-table', 'coffee-table', 'side-table']);
/** Items after a drop: when no table or desk is left, the chairs that belonged to it go too (no loose chairs). */
function dropWithChairs(items: FurnitureItem[], gone: Set<string>, left: string[]): FurnitureItem[] {
  let rest = items.filter((f) => !gone.has(f.id));
  if (rest.length !== items.length && !rest.some((f) => ANCHORS.has(f.category)) && items.some((f) => ANCHORS.has(f.category))) {
    const loose = rest.filter((f) => f.category === 'chair');
    for (const c of loose) left.push(c.name);
    rest = rest.filter((f) => f.category !== 'chair');
  }
  return rest;
}

function draftResult(model: SpaceModel, items: FurnitureItem[], text: string, stages: Stage[]): DesignResult {
  const furniture = draftPoses(model, items);
  return {
    candidates: [{
      id: 'draft', name: 'Assembling the room', summary: `Pieces arriving for "${text.slice(0, 60)}"`, parentVersion: model.version, furniture,
      metrics: { openAreaM2: 0, costSek: furniture.reduce((s, f) => s + (f.priceSek || 0), 0), minClearanceM: null, routeLenM: null, score: 0 },
      checks: [], assumptions: ['Draft placement while the layout is being solved.'], generator: 'theme',
    }],
    reports: [], infeasibility: null, stages: stages.map((s) => ({ ...s })),
  };
}

/** One line about the room for the brief, so the plan fits it. */
export function roomLine(model: SpaceModel): string {
  const s = model.spaces[0];
  if (!s) return '';
  const xs = s.polygon.map((p) => p.x), ys = s.polygon.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs), d = Math.max(...ys) - Math.min(...ys);
  let a = 0;
  s.polygon.forEach((p, i) => { const q = s.polygon[(i + 1) % s.polygon.length]; a += p.x * q.y - q.x * p.y; });
  const n = (k: string) => model.openings.filter((o) => o.spaceId === s.id && o.kind === k).length;
  return `${w.toFixed(1)} x ${d.toFixed(1)} m, floor ${Math.abs(a / 2).toFixed(0)} m2, ceiling ${model.ceilingM.toFixed(1)} m, ${n('door')} door, ${n('window')} window`;
}

async function designThemedCore(model: SpaceModel, text: string, opts: ThemedOpts = {}): Promise<ThemedResult> {
  if (opts.spaceId && model.spaces.length > 1) {
    const sub = subModelFor(model, opts.spaceId);
    if (sub) {
      const back = <R extends DesignResult>(r: R): R => ({ ...r, candidates: r.candidates.map((c) => ({ ...c, furniture: mergeFurniture(model, sub.spaceId, c.furniture, sub.offset) })) });
      const res = await designThemedCore(sub.model, text, { ...opts, spaceId: undefined, onProgress: opts.onProgress && ((r, ph) => opts.onProgress!(back(r), ph)) });
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
  // Model pieces start while the brief is still streaming: each object begins as soon as it is complete.
  const early = new Map<string, { quick: ObjectSpec; job: Promise<ObjectSpec> }>();
  let firstObjectMs: number | null = null;
  // Each streamed object also lands in a draft room right away, so the room assembles piece by
  // piece while the brief is still being written; the solver's layout then replaces the draft.
  const draft: FurnitureItem[] = [];
  const onEarly = (o: ThemeObject, i: number) => {
    let f: FurnitureItem;
    if (o.source !== 'custom') f = catalogueItem(o);
    else if (o.recipe) f = itemFor(recipeSpec(o, []) ?? rulesObject(o.prompt ?? o.name), o, model.ceilingM);
    else {
      const quick = early.get(o.name)?.quick ?? rulesObject(o.prompt ?? o.name);
      if (!early.has(o.name) && !opts.reuse?.has(objectKey(o))) {
        const job = generateObject(o.prompt ?? o.name, { signal: opts.signal, detail: false });
        job.catch(() => undefined);
        early.set(o.name, { quick, job });
      }
      f = itemFor(quick, o, model.ceilingM);
      opts.onObject?.(quick, o, i);
    }
    firstObjectMs ??= Math.round(now() - t0);
    for (let k = 0; k < Math.min(12, Math.max(1, o.qty ?? 1)); k++) draft.push(k ? { ...f, id: `${f.id}-${k}` } : f);
    if (opts.onProgress && !opts.signal?.aborted) opts.onProgress(draftResult(model, draft, text, stages), 'rules');
  };
  const brief0 = opts.brief ?? (await themeBrief(text, { signal: opts.signal, room: roomLine(model), onObject: onEarly }));
  // Keep layout fast (12 floor pieces plus wall decor) and the named poster present.
  const names = findNames(text);
  const withNames = withNamePosters(capFloorItems(brief0.objects), names, brief0.palette);
  // A named poster is always the hero: it takes the centre of the wall facing the door.
  const named = names.length ? withNames.find((o) => o.text?.toLowerCase() === names[0].toLowerCase()) : undefined;
  const brief: ThemeBrief = { ...brief0, objects: named ? withNames.map((o) => ({ ...o, hero: o === named ? true : undefined })) : withNames };
  const briefMs = Math.round(now() - t);
  end('brief', t, { label: brief.title, model: brief.by === 'gemini' ? brief.model : 'rules', detail: `${brief.objects.length} pieces` });
  abortIf(opts.signal);

  // (b) Objects: code-built at once; model-built in parallel, each replacing its stand-in on arrival.
  t = start('objects', 'Making the pieces', aiReady() ? 'parallel' : 'rules');
  const online = aiReady() && !opts.offline;
  const entries: Array<{ f: FurnitureItem; o: ThemeObject; key: string; idx: number }> = [];
  const specs = new Map<string, ObjectSpec>();
  const pending: Array<Promise<void>> = [];
  let models = 0, fallbacks = 0;
  const shared = new Map<string, Promise<ObjectSpec>>();
  let cands: LayoutCandidate[] = [];
  const reports: FullReport[] = [];
  brief.objects.forEach((o, i) => {
    for (let k = 0; k < Math.max(1, o.qty ?? 1); k++) {
      const key = objectKey(o, k);
      if (o.source !== 'custom') {
        const f = catalogueItem(o);
        if (o.source === 'store' && !opts.offline) pending.push(attachListing(f, o, opts.signal));
        entries.push({ f, o, key, idx: i });
        continue;
      }
      const reused = opts.reuse?.get(key);
      const pre = early.get(o.name);
      const quick = reused ?? pre?.quick ?? recipeSpec(o, brief.palette) ?? rulesObject(o.prompt ?? o.name);
      const f = itemFor(quick, o, model.ceilingM);
      specs.set(key, quick);
      entries.push({ f, o, key, idx: i });
      firstObjectMs ??= Math.round(now() - t0);
      opts.onObject?.(quick, o, i);
      // Pieces with a recipe are finished in code (exact words, instant); the model makes the rest.
      if (reused || !online || o.recipe) continue;
      // One model call per distinct object; copies (two gaming chairs) share it.
      const job = shared.get(o.name) ?? pre?.job ?? generateObject(o.prompt ?? o.name, { signal: opts.signal, detail: false });
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
  let solved = await solveProgram(model, items, concept, { variants: 1, seed: model.version * 31 + 7, signal: opts.signal, req, timeBudgetMs: 900 });
  // Too much for the room: leave out plain catalogue pieces first, then the bulkiest extras.
  for (let tries = 0; !solved.candidates.length && tries < 4; tries++) {
    const floor = entries.filter((e) => items.includes(e.f) && e.f.mount !== 'wall' && e.f.category !== 'rug' && e.idx > 0);
    const spare = floor.filter((e) => !e.o.essential);
    const drop = (spare.length ? spare : floor).filter((e) => e.o.source !== 'custom').sort((a, b) => b.f.w * b.f.d - a.f.w * a.f.d)[0] ?? (spare.length ? spare : floor).sort((a, b) => b.f.w * b.f.d - a.f.w * a.f.d)[0];
    if (!drop) break;
    left.push(drop.f.name);
    items = dropWithChairs(items, new Set([drop.f.id]), left);
    concept = conceptFor(items);
    solved = await solveProgram(model, items, concept, { variants: 1, seed: model.version * 31 + 7 + tries, signal: opts.signal, req, timeBudgetMs: 700 });
  }
  if (left.length && solved.candidates.length) brief.notes.push(`Left out to fit the room: ${left.join(', ')}.`);
  abortIf(opts.signal);
  const score = (c: LayoutCandidate) => { const v = evaluateRules(model, c.furniture, req); const ds = Math.round(Math.min(100, Math.max(0, Number(designScore(v)) || 0))); return { v, ds }; };
  /** Take a solve's layouts as the current ones; pieces that already landed keep their look (same size and id). */
  const adopt = (s: typeof solved) => {
    const byId = new Map(entries.map((e) => [e.f.id, e.f]));
    cands = s.candidates.map((c, k) => ({
      ...c, name: k === 0 ? brief.title : `${brief.title} ${k + 1}`,
      furniture: c.furniture.map((g) => { const f = byId.get(g.id); return f && f.custom !== g.custom ? { ...g, custom: f.custom, name: f.name, color: f.color, material: f.material } : g; }),
    }));
    reports.length = 0;
    for (const c of cands) {
      const { v, ds } = score(c);
      reports.push({ candidateId: c.id, program: s.reports.find((r) => r.candidateId === c.id)?.program ?? concept, verdicts: v, designScore: ds, finalScore: ds, conceptName: brief.title, idea: concept.idea });
    }
  };
  adopt(solved);
  // Checks still failing (walkways, reach, room to open): leave out the least needed piece the
  // failures name and solve again, keeping a round only when it fails fewer checks. Runs while
  // the model pieces are still being made, after the first layout is already on screen.
  const failing = (c: LayoutCandidate) => evaluateRules(model, c.furniture, req).filter((v) => !v.pass && v.severity !== 'preference');
  const failsOf = (s: typeof solved) => Math.min(Infinity, ...s.candidates.map((c) => failing(c).length));
  async function clearChecks() {
    const tClear = now();
    const cleared: string[] = [];
    let movedEssential = false;
    for (let round = 0; solved.candidates.length && failsOf(solved) > 0 && round < 3 && now() - tClear < 3000; round++) {
      const worst = solved.candidates.map(failing).sort((a, b) => a.length - b.length)[0];
      const blamed = new Map<string, number>();
      for (const v of worst) for (const id of v.itemIds) blamed.set(id, (blamed.get(id) ?? 0) + 1);
      const rank = (e: (typeof entries)[number]) => (blamed.get(e.f.id) ?? 0) * 2 + (e.key.endsWith('#0') ? 0 : 3) + (e.o.source === 'custom' ? 0 : 2)
        + (/plant|lamp|decor|lighting/.test(e.f.category) ? 2 : 0) - (e.o.essential ? 8 : 0);
      const pool = entries.filter((e) => items.some((f) => f.id === e.f.id) && e.f.mount !== 'wall' && e.f.category !== 'rug' && !e.o.essential && !(e.idx === 0 && e.key.endsWith('#0')));
      const drop = pool.filter((e) => blamed.has(e.f.id) || !e.key.endsWith('#0')).sort((a, b) => rank(b) - rank(a))[0];
      const blamedHard = entries.some((e) => blamed.has(e.f.id) && items.some((f) => f.id === e.f.id) && e.f.mount !== 'wall' && e.f.category !== 'rug');
      if (!drop || !pool.some((e) => blamed.has(e.f.id))) {
        // Only an essential piece is in the way: move it (a new arrangement, then without its placement wish) instead of removing it.
        if (!blamedHard) { if (!drop) break; } else {
          const base = failsOf(solved);
          let moved: typeof solved | undefined;
          for (let attempt = 0; attempt < 4 && !moved; attempt++) {
            const c = conceptFor(items);
            if (attempt >= 2) c.relations = c.relations.filter((r) => !(blamed.has(r.subject) && ['in-corner', 'near-window', 'against-wall'].includes(r.kind)));
            const again = await solveProgram(model, items, c, { variants: 1, seed: model.version * 31 + 101 + round * 7 + attempt, signal: opts.signal, req, timeBudgetMs: 700 });
            if (again.candidates.length && failsOf(again) < base && again.candidates.every((c) => items.every((f) => c.furniture.some((g) => g.id === f.id)))) moved = again;
          }
          if (moved) { solved = moved; cleared.push('moved'); movedEssential = true; continue; }
          if (!drop) break;
        }
      }
      if (!drop) break;
      const extra: string[] = [];
      const next = dropWithChairs(items, new Set([drop.f.id]), extra);
      const again = await solveProgram(model, next, conceptFor(next), { variants: 1, seed: model.version * 31 + 41 + round, signal: opts.signal, req, timeBudgetMs: 900 });
      if (!again.candidates.length || failsOf(again) >= failsOf(solved)) break;
      items = next; solved = again; concept = conceptFor(next); cleared.push(drop.f.name, ...extra);
    }
    if (!cleared.length) return;
    const gone = cleared.filter((c) => c !== 'moved');
    if (gone.length) brief.notes.push(`Left out to keep walkways clear: ${gone.join(', ')}.`);
    if (movedEssential) brief.notes.push('An essential piece was moved to keep the walkway clear.');
    adopt(solved);
    opts.onProgress?.(snapshot(), 'concepts');
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

  // (d) Wait for the model pieces (each already swapped in as it landed) and the check clearing.
  await Promise.all([...pending, cands.length ? clearChecks().catch((e) => { if ((e as Error).name === 'AbortError') throw e; }) : undefined]);
  abortIf(opts.signal);
  const objStage = stages.find((s) => s.id === 'objects');
  if (objStage) Object.assign(objStage, { status: 'done', ms: Math.round(now() - t0), detail: online ? `${models - fallbacks} made by the model${fallbacks ? `, ${fallbacks} from templates` : ''}` : 'made from templates' });
  // Store listings may have renamed stand-ins: carry the names into the layouts.
  for (const c of cands) c.furniture = c.furniture.map((g) => { const e = entries.find((x) => x.f.id === g.id); return e && e.o.source === 'store' ? { ...g, name: e.f.name, listing: e.f.listing } : g; });
  for (const [i, c] of cands.entries()) { const { v, ds } = score(c); Object.assign(reports[i], { verdicts: v, designScore: ds, finalScore: ds }); }
  emit();
  const res = snapshot();
  return { ...res, brief, specs, pieces: entries.map((e) => ({ id: e.f.id, key: e.key, o: e.o })), timings: { briefMs, firstObjectMs, roomMs, totalMs: Math.round(now() - t0), models, fallbacks } };
}

/** A layout worth showing: it has furniture and a real score. */
export const usableCandidate = (c: LayoutCandidate) => c.furniture.length > 0 && (c.metrics.score ?? 0) > 0;

/** Drops layouts with no items or a zero score (a timed-out brief can leave one). */
export function dropJunk<R extends DesignResult>(r: R): R {
  const keep = r.candidates.filter(usableCandidate).map((c) => c.id);
  return { ...r, candidates: r.candidates.filter((c) => keep.includes(c.id)), reports: r.reports.filter((x) => keep.includes(x.candidateId)) };
}


/** Model objects: at most this many hero pieces per room get a model call. */
export const MAX_AI_OBJECTS = 6;
/** After this long the room is final; late model pieces are dropped. */
export const UPGRADE_LIMIT_MS = 20000;
const POOL = 3;

const WORD_NOISE = new Set(['cat', 'dog', 'room', 'for', 'you', 'the', 'and', 'with', 'small', 'big', 'large']);
const words = (t: string) => t.toLowerCase().split(/[^a-zåäö]+/).map((w) => w.replace(/s$/, '')).filter((w) => w.length > 2 && !WORD_NOISE.has(w));

/** The room's own name for the layout card. */
export function roomNameOf(brief: ThemeBrief, names: string[]): string {
  return names[0] ? `${names[0]}'s room` : brief.title;
}

type Piece = NonNullable<ThemedResult['pieces']>[number];

/** Model objects for hero pieces: each gets the kit piece it most resembles, else an unused optional one. */
export function matchUpgrades(ai: ThemeObject[], pieces: Piece[]): Array<{ ai: ThemeObject; piece: Piece }> {
  const seen = new Set<string>();
  const heroes = ai.filter((o) => o.source === 'custom' && !o.recipe && o.mount !== 'wall' && !o.text).filter((o) => {
    const k = o.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).slice(0, MAX_AI_OBJECTS);
  const free = pieces.filter((p) => p.o.source === 'custom' && !p.o.text && p.o.mount !== 'wall' && p.key.endsWith('#0'));
  const used = new Set<string>();
  const out: Array<{ ai: ThemeObject; piece: Piece }> = [];
  const rest: ThemeObject[] = [];
  for (const o of heroes) {
    const w = new Set(words(`${o.name} ${o.catalogId ?? ''}`));
    let best: Piece | undefined, bestN = 0;
    for (const p of free) {
      if (used.has(p.id)) continue;
      const n = words(p.o.name).filter((x) => w.has(x)).length;
      if (n > bestN) { best = p; bestN = n; }
    }
    if (best) { used.add(best.id); out.push({ ai: o, piece: best }); } else rest.push(o);
  }
  for (const o of rest) {
    const p = free.find((x) => !used.has(x.id) && !x.o.essential);
    if (p) { used.add(p.id); out.push({ ai: o, piece: p }); }
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/**
 * Themed room that always ends complete. The room is placed from the offline kit at once (no model
 * calls); the model's hero pieces then replace kit pieces in place, inside the old footprint and at
 * the old position, until UPGRADE_LIMIT_MS. A failed, refused or late model piece simply leaves the
 * kit's version. Streamed rooms carry `partial: true`; the last emission is the returned result.
 */
export async function designThemedRoom(model: SpaceModel, text: string, opts: ThemedOpts = {}): Promise<ThemedResult> {
  if (!model.spaces.length) return legacyThemedRoom(model, text, opts);
  const given = opts.brief;
  const t0 = now();
  const sub = opts.spaceId && model.spaces.length > 1 ? subModelFor(model, opts.spaceId) : null;
  const pm = sub ? sub.model : model;
  const back = <R extends DesignResult>(r: R): R => (sub ? { ...r, candidates: r.candidates.map((c) => ({ ...c, furniture: mergeFurniture(model, sub.spaceId, c.furniture, sub.offset) })) } : r);
  let plan: Plan = planContract(pm, text, given ?? rulesBrief(text), given?.names ?? []);
  const names = plan.brief.names;
  const stamp = (r: DesignResult, partial: boolean, brief: ThemeBrief): DesignResult & { partial: boolean } => {
    const roomName = roomNameOf(brief, names);
    const m = back(r);
    return { ...m, candidates: m.candidates.map((c, i) => ({ ...c, name: i === 0 ? roomName : `${roomName} ${i + 1}` })), partial };
  };
  const aiP = !given && aiReady() && !opts.signal?.aborted
    ? themeBrief(text, { signal: opts.signal, room: roomLine(pm) }).then((b) => (b.by === 'gemini' ? b : null), (e) => { if ((e as Error).name === 'AbortError') throw e; return null; })
    : null;
  aiP?.catch(() => undefined);

  // (1) The room from kit pieces, checked against the contract; one smaller try when it fails.
  const run = (p: Plan) => designThemedCore(pm, text, {
    ...opts, spaceId: undefined, brief: p.brief, offline: given ? opts.offline : true, reuse: given ? opts.reuse : undefined,
    onProgress: opts.onProgress && ((r, ph) => opts.onProgress!(stamp(r, true, p.brief), ph)),
  });
  const contractOf = (p: Plan, r: DesignResult, pcs: Piece[] | undefined, c: LayoutCandidate | undefined): Contract => {
    const byId = new Map((pcs ?? []).map((x) => [x.id, x.o.name]));
    return c ? checkContract(p, c.furniture.map((f) => byId.get(f.id) ?? f.name), c.furniture.length) : checkContract(p, [], 0);
  };
  const verdict = (p: Plan, r: ThemedResult): { res: ThemedResult; contract: Contract } => {
    const clean = dropJunk(r);
    const good = clean.candidates.filter((c) => contractOf(p, clean, r.pieces, c).complete);
    const pick = good.length ? good : clean.candidates;
    return { res: { ...clean, candidates: pick, reports: clean.reports.filter((x) => pick.some((c) => c.id === x.candidateId)) }, contract: contractOf(p, clean, r.pieces, pick[0]) };
  };
  // A second plan carries two spare wall pieces: walkway clearing may drop a piece after layout.
  const plans = [plan, planContract(pm, text, given ?? rulesBrief(text), given?.names ?? [], 2), essentialsOnly(plan, pm, text)];
  let best: { res: ThemedResult; contract: Contract; plan: Plan } | undefined;
  let lastErr: unknown;
  for (const p of plans) {
    try {
      const v = verdict(p, await run(p));
      if (!best || (v.res.candidates.length > 0 && (!best.res.candidates.length || v.contract.missing.length < best.contract.missing.length || (v.contract.missing.length === best.contract.missing.length && v.contract.pieces > best.contract.pieces)))) best = { ...v, plan: p };
      if (v.contract.complete && v.res.candidates.length) break;
    } catch (e) { if ((e as Error).name === 'AbortError' || opts.signal?.aborted) throw e; lastErr = e; }
  }
  if (!best || (given && !best.res.candidates.length)) {
    if (given && !opts.signal?.aborted) return legacyThemedRoom(model, text, { ...opts, brief: undefined });
    throw lastErr ?? new Error('Could not lay out the room');
  }
  plan = best.plan;
  const brief: ThemeBrief = { ...best.res.brief, title: roomNameOf(best.res.brief, names), notes: [...best.res.brief.notes] };
  let cur: ThemedResult = { ...best.res, brief };
  const specs = cur.specs;
  const pieces = cur.pieces ?? [];
  const contractNow = () => contractOf(plan, cur, pieces, cur.candidates[0]);
  if (!contractNow().complete) brief.notes.push('The room could not hold every essential piece; the contract lists what is missing.');
  const emitPartial = () => { if (opts.onProgress && !opts.signal?.aborted) opts.onProgress(stamp(cur, true, brief), 'concepts'); };
  if (cur.candidates.length) emitPartial();

  // (2) Upgrades: model pieces replace kit pieces in place until the time limit.
  let models = 0, fallbacks = 0, closed = false;
  if (aiP && cur.candidates.length) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener('abort', onAbort);
    const left = () => UPGRADE_LIMIT_MS - (now() - t0);
    const timer = setTimeout(() => { closed = true; ctrl.abort(); }, Math.max(0, left()));
    const patch = (id: string, fn: (g: FurnitureItem) => FurnitureItem) => {
      cur = { ...cur, candidates: cur.candidates.map((c) => ({ ...c, furniture: c.furniture.map((g) => (g.id === id ? fn(g) : g)) })) };
    };
    try {
      const aiBrief = await Promise.race([aiP, sleep(left()).then(() => null)]);
      if (aiBrief && !closed) {
        const jobs = matchUpgrades(aiBrief.objects, pieces);
        const todo = [...jobs];
        const worker = async () => {
          for (let j = todo.shift(); j && !closed; j = todo.shift()) {
            const { ai: o, piece } = j;
            const quick = specs.get(piece.key);
            if (!quick) continue;
            models++;
            try {
              const spec = await Promise.race([generateObject(o.prompt ?? o.name, { signal: ctrl.signal, detail: false }), sleep(left()).then(() => null)]);
              if (!spec || closed || spec.model === 'rules') { fallbacks++; continue; }
              const fitted: ObjectSpec = { ...fitSpec(spec, quick.size), semantics: { ...spec.semantics, category: quick.semantics.category } };
              specs.set(piece.key, fitted);
              patch(piece.id, (g) => ({ ...g, custom: fitted, name: fitted.name || g.name, color: dominantColor(fitted), material: mainMaterial(fitted) }));
              opts.onObject?.(fitted, piece.o, brief.objects.indexOf(piece.o));
              emitPartial();
            } catch (e) { if (opts.signal?.aborted) throw e; fallbacks++; }
          }
        };
        const listings = pieces.filter((p) => p.o.source === 'store' && p.key.endsWith('#0')).map(async (p) => {
          const stub = { name: p.o.name } as FurnitureItem;
          await attachListing(stub, p.o, ctrl.signal);
          if (stub.listing && !closed) { patch(p.id, (g) => ({ ...g, name: stub.name, listing: stub.listing, sourceKind: 'catalog' })); emitPartial(); }
        });
        await Promise.all([...Array.from({ length: Math.min(POOL, jobs.length) }, worker), ...listings]);
      }
    } finally {
      closed = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
    abortIf(opts.signal);
    if (fallbacks) brief.notes.push(`${fallbacks} custom piece${fallbacks === 1 ? '' : 's'} could not be made in time, so the ready-made version${fallbacks === 1 ? ' was' : 's were'} kept.`);
  }

  // (3) Final result: same callback, never partial.
  const contract = contractNow();
  contract.compromises.push(...(fallbacks ? [`${fallbacks} model-made piece${fallbacks === 1 ? '' : 's'} replaced by the kit version.`] : []));
  const final: ThemedResult = {
    ...stamp(cur, false, brief), brief, specs, pieces, roomName: roomNameOf(brief, names), contract, partial: false,
    timings: { ...cur.timings, totalMs: Math.round(now() - t0), models: cur.timings.models + models, fallbacks: cur.timings.fallbacks + fallbacks },
  };
  opts.onProgress?.(final, 'critic');
  return final;
}

/** Refinements: the caller's own brief, with the model making changed pieces; junk is filtered and the kit steps in when nothing is left. */
async function legacyThemedRoom(model: SpaceModel, text: string, opts: ThemedOpts = {}): Promise<ThemedResult> {
  let res: ThemedResult | undefined;
  try { res = await designThemedCore(model, text, opts); }
  catch (e) { if ((e as Error).name === 'AbortError' || opts.signal?.aborted || !model.spaces.length) throw e; }
  if (res) {
    const clean = dropJunk(res);
    if (clean.candidates.length || !model.spaces.length) return { ...clean, partial: false };
  }
  const brief = rulesBrief(text);
  const kit = await designThemedCore(model, text, { ...opts, brief, onProgress: undefined });
  const out = dropJunk(kit);
  out.brief.notes = [...out.brief.notes, 'The model took too long, so this room is the ready-made kit for the closest room type.'];
  return { ...out, partial: false };
}
