// Planner: asks a fast model for the design intent (zones and relations with reasons) and
// turns the answer into a strictly valid DesignProgram. Geometry is never decided here.
import { ai, aiReady } from '../../core/ai';
import { bounds, dist, distPointSegment, wallInwardNormal, wallSegment } from '../../core/geometry';
import type { DesignProgram, DesignZone, FurnitureItem, Relation, RelationKind, Requirements, SpaceModel } from '../../core/types';
import { defaultProgram } from './program';
import { semanticsOf } from './semantics';

export const RELATION_KINDS: RelationKind[] = [
  'against-wall', 'in-corner', 'near-window', 'away-from-door', 'faces', 'beside', 'flanks',
  'in-front-of', 'centered-on', 'paired-seat', 'on-rug', 'apart-from', 'aligned-with',
];
/** Kinds that only make sense with a target. */
const NEEDS_TARGET = new Set<RelationKind>(['faces', 'beside', 'flanks', 'in-front-of', 'centered-on', 'paired-seat', 'on-rug', 'apart-from', 'aligned-with']);

/** A program plus the short name and idea the planner gave it. */
export type Concept = DesignProgram & { name?: string; idea?: string };

export interface PlanOpts { signal?: AbortSignal; brief?: string; timeoutMs?: number }

// ---------- scene description ----------

export interface WallInfo { index: number; name: string; lengthM: number; door: boolean; window: boolean }

function compass(dx: number, dy: number): string {
  // Plan y grows downwards, so the top of the plan is north.
  const ns = dy < -0.38 ? 'north' : dy > 0.38 ? 'south' : '';
  const ew = dx > 0.38 ? 'east' : dx < -0.38 ? 'west' : '';
  return ns && ew ? `${ns}-${ew}` : ns || ew || 'north';
}

/** Compass name per wall, from its outward normal; duplicates get a number. */
export function wallInfo(model: SpaceModel): WallInfo[] {
  const sp = model.spaces[0];
  if (!sp) return [];
  const raw = sp.polygon.map((_, i) => {
    const n = wallInwardNormal(sp, i);
    const [a, b] = wallSegment(sp, i);
    const ops = model.openings.filter((o) => o.spaceId === sp.id && o.wallIndex === i);
    return { index: i, name: compass(-n.x, -n.y), lengthM: dist(a, b), door: ops.some((o) => o.kind === 'door' || o.kind === 'opening'), window: ops.some((o) => o.kind === 'window') };
  });
  const seen = new Map<string, number>();
  const total = new Map<string, number>();
  for (const w of raw) total.set(w.name, (total.get(w.name) ?? 0) + 1);
  return raw.map((w) => {
    if ((total.get(w.name) ?? 0) < 2) return w;
    const k = (seen.get(w.name) ?? 0) + 1; seen.set(w.name, k);
    return { ...w, name: `${w.name} ${k}` };
  });
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Where an item is, in words: nearest wall and what its front looks towards. */
export function describePlacement(model: SpaceModel, f: FurnitureItem, walls = wallInfo(model)): string {
  const sp = model.spaces[0];
  if (!sp) return 'placed';
  let best = -1, bestD = Infinity;
  for (let i = 0; i < sp.polygon.length; i++) {
    const [a, b] = wallSegment(sp, i);
    const d = distPointSegment(f, a, b) - Math.min(f.w, f.d) / 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  const front = compass(-Math.sin(f.rotation), Math.cos(f.rotation));
  const wall = walls[best]?.name ?? 'a';
  const where = bestD < 0.15 ? `against the ${wall} wall` : bestD < 0.6 ? `near the ${wall} wall (${Math.round(bestD * 100)} cm)` : `in the open, ${r2(bestD)} m from the ${wall} wall`;
  return `${where}, facing ${front}`;
}

export interface SceneRefs { toShort: Map<string, string>; toLong: Map<string, string> }

/** Short ids (i1, i2, ...) are easier for a model to copy back exactly than generated ids. */
export function sceneRefs(items: FurnitureItem[]): SceneRefs {
  const toShort = new Map<string, string>(), toLong = new Map<string, string>();
  items.forEach((f, i) => { const s = `i${i + 1}`; toShort.set(f.id, s); toLong.set(s, f.id); });
  return { toShort, toLong };
}

export function sceneDescription(model: SpaceModel, items: FurnitureItem[], req: Requirements | null, refs = sceneRefs(items), withPlacement = false): string {
  const sp = model.spaces[0];
  const lines: string[] = [];
  if (sp) {
    const b = bounds(sp.polygon);
    lines.push(`Room: ${r2(b.maxX - b.minX)} x ${r2(b.maxY - b.minY)} m bounding box, ${sp.polygon.length} walls, ceiling ${r2(model.ceilingM)} m. North is the top of the plan.`);
    lines.push('Walls (target as wall:<index>):');
    for (const w of wallInfo(model)) lines.push(`  wall:${w.index} ${w.name}, ${r2(w.lengthM)} m${w.door ? ', has door' : ''}${w.window ? ', has window' : ''}`);
  }
  if (req) {
    lines.push(`Purpose: ${req.purpose || 'unspecified'}; people: ${req.people}; style: ${req.style || 'any'}; walkway at least ${Math.round(req.minRouteWidthM * 100)} cm.`);
    if (req.notes.length) lines.push(`Notes: ${req.notes.slice(0, 4).join(' ')}`);
  }
  lines.push('Items:');
  for (const f of items) {
    const s = semanticsOf(f);
    const flags = [s.role, s.wallBacked ? 'wall-backed' : '', s.tall ? 'tall' : '', s.faces !== 'none' ? `faces ${s.faces}` : '', s.pairsWith.length ? `pairs with ${s.pairsWith.join('/')}` : '', f.locked ? 'locked in place' : '']
      .filter(Boolean).join(', ');
    const at = withPlacement ? `; ${describePlacement(model, f)}` : '';
    lines.push(`  ${refs.toShort.get(f.id)} ${f.name} (${f.category}) ${Math.round(f.w * 100)}x${Math.round(f.d * 100)}x${Math.round(f.h * 100)} cm; ${flags}${at}`);
  }
  return lines.join('\n');
}

// ---------- schema ----------

export const RELATION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    kind: { type: 'STRING', enum: RELATION_KINDS },
    subject: { type: 'STRING' },
    target: { type: 'STRING', nullable: true },
    distanceM: { type: 'ARRAY', items: { type: 'NUMBER' }, nullable: true },
    weight: { type: 'NUMBER' },
    reason: { type: 'STRING' },
  },
  required: ['kind', 'subject', 'weight', 'reason'],
};

const CONCEPT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING' },
    idea: { type: 'STRING' },
    focalItemId: { type: 'STRING', nullable: true },
    zones: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { id: { type: 'STRING' }, name: { type: 'STRING' }, purpose: { type: 'STRING' }, itemIds: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['id', 'name', 'purpose', 'itemIds'] },
    },
    relations: { type: 'ARRAY', items: RELATION_SCHEMA },
    notes: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['name', 'idea', 'zones', 'relations'],
};

export const CONCEPTS_SCHEMA = { type: 'OBJECT', properties: { concepts: { type: 'ARRAY', items: CONCEPT_SCHEMA } }, required: ['concepts'] };

export const SYSTEM = 'You are an experienced interior designer. You decide intent, not coordinates: which zones exist, what goes against which wall, what faces what, and why. Exact positions are computed by a geometric solver afterwards. Use only the ids given. Every reason is one short plain sentence a homeowner understands. Output only JSON matching the schema.';

// ---------- validation ----------

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export interface RefCtx { ids: Set<string>; wallCount: number; toLong?: Map<string, string> }

const resolveId = (v: unknown, ctx: RefCtx): string | null => {
  const s = text(v, 80);
  if (!s) return null;
  const long = ctx.toLong?.get(s) ?? s;
  return ctx.ids.has(long) ? long : null;
};

function resolveTarget(v: unknown, ctx: RefCtx): string | null | undefined {
  const s = text(v, 80);
  if (!s) return undefined;
  if (s === 'window' || s === 'door' || s === 'room-centre') return s;
  if (s === 'room-center') return 'room-centre';
  const w = s.match(/^wall:(\d+)$/);
  if (w) return Number(w[1]) < ctx.wallCount ? `wall:${Number(w[1])}` : null;
  return resolveId(s, ctx);
}

/** One relation, checked: known kind, known subject and target, sane numbers. Null when unusable. */
export function cleanRelation(raw: unknown, ctx: RefCtx): Relation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind as RelationKind;
  if (!RELATION_KINDS.includes(kind)) return null;
  const subject = resolveId(r.subject, ctx);
  if (!subject) return null;
  const target = resolveTarget(r.target, ctx);
  if (target === null) return null;
  if (NEEDS_TARGET.has(kind) && !target) return null;
  if (target === subject) return null;
  if (kind === 'against-wall' && target && !target.startsWith('wall:')) return null;
  if (kind === 'near-window' && target && target !== 'window') return null;
  const out: Relation = {
    kind, subject,
    weight: clamp(Number.isFinite(Number(r.weight)) ? Number(r.weight) : 0.5, 0, 1),
    reason: text(r.reason, 160) || 'Suggested by the planner.',
  };
  if (target) out.target = target;
  if (Array.isArray(r.distanceM) && r.distanceM.length >= 2) {
    const a = clamp(Number(r.distanceM[0]) || 0, 0, 10), b = clamp(Number(r.distanceM[1]) || 0, 0, 10);
    out.distanceM = [Math.min(a, b), Math.max(a, b)];
  }
  return out;
}

const relKey = (r: Pick<Relation, 'kind' | 'subject' | 'target'>) => `${r.kind}|${r.subject}|${r.target ?? ''}`;

/** Strictly validated program; anything unknown is dropped. */
export function cleanProgram(raw: unknown, ctx: RefCtx): Concept {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const used = new Set<string>();
  const zones: DesignZone[] = [];
  for (const z of Array.isArray(r.zones) ? r.zones : []) {
    if (!z || typeof z !== 'object') continue;
    const zz = z as Record<string, unknown>;
    const itemIds = (Array.isArray(zz.itemIds) ? zz.itemIds : []).map((x) => resolveId(x, ctx)).filter((x): x is string => !!x && !used.has(x));
    itemIds.forEach((x) => used.add(x));
    if (!itemIds.length) continue;
    zones.push({ id: text(zz.id, 40) || `zone-${zones.length + 1}`, name: text(zz.name, 40) || 'Zone', purpose: text(zz.purpose, 160), itemIds });
  }
  const seen = new Set<string>();
  const relations: Relation[] = [];
  for (const x of Array.isArray(r.relations) ? r.relations : []) {
    const rel = cleanRelation(x, ctx);
    if (!rel || seen.has(relKey(rel))) continue;
    seen.add(relKey(rel)); relations.push(rel);
  }
  const focal = resolveId(r.focalItemId, ctx) ?? undefined;
  return {
    zones, relations, focalItemId: focal,
    notes: (Array.isArray(r.notes) ? r.notes : []).map((n) => text(n, 200)).filter(Boolean).slice(0, 5),
    by: 'gemini',
    name: text(r.name, 40) || undefined,
    idea: text(r.idea, 200) || undefined,
  };
}

/** Fills gaps from the rule-based program so every item has a zone and at least its default relations. */
export function mergeWithDefault(p: Concept, def: DesignProgram): Concept {
  const zoned = new Set(p.zones.flatMap((z) => z.itemIds));
  const zones = p.zones.map((z) => ({ ...z, itemIds: [...z.itemIds] }));
  for (const dz of def.zones) {
    const missing = dz.itemIds.filter((id) => !zoned.has(id));
    if (!missing.length) continue;
    missing.forEach((id) => zoned.add(id));
    const home = zones.find((z) => z.id === dz.id || z.name.toLowerCase() === dz.name.toLowerCase());
    if (home) home.itemIds.push(...missing);
    else zones.push({ ...dz, itemIds: missing });
  }
  const covered = new Set(p.relations.map((r) => r.subject));
  const keys = new Set(p.relations.map(relKey));
  const extra = def.relations.filter((r) => !covered.has(r.subject) && !keys.has(relKey(r)));
  return { ...p, zones, relations: [...p.relations, ...extra], focalItemId: p.focalItemId ?? def.focalItemId };
}

// ---------- calls ----------

function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)} s`)), ms);
    const onAbort = () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    p.then((v) => { clearTimeout(t); signal?.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { clearTimeout(t); signal?.removeEventListener('abort', onAbort); reject(e); });
  });
}
export { withTimeout };

const fallback = (def: DesignProgram, error?: string): Concept => ({ ...def, name: 'Balanced', notes: error ? [...def.notes, `Planner unavailable, used rules (${error.slice(0, 80)}).`] : def.notes });

/**
 * 1 to 3 alternative concepts from one fast call. Each is validated and merged with the rule
 * program so nothing is left unplaced. Without a key, or on any failure, returns the rule program.
 */
export async function planConcepts(model: SpaceModel, items: FurnitureItem[], req: Requirements, count = 3, opts: PlanOpts = {}): Promise<Concept[]> {
  const def = defaultProgram(model, items, req);
  if (!aiReady() || !items.length) return [fallback(def)];
  const n = clamp(Math.round(count), 1, 3);
  const refs = sceneRefs(items);
  const ctx: RefCtx = { ids: new Set(items.map((f) => f.id)), wallCount: model.spaces[0]?.polygon.length ?? 0, toLong: refs.toLong };
  const prompt = [
    opts.brief ? `The person asked: """${opts.brief.slice(0, 600)}"""` : '',
    sceneDescription(model, items, req, refs),
    '',
    `Propose ${n} clearly different design concept${n > 1 ? 's' : ''} for this room${n > 1 ? ' (for example: organised around the window, organised around the main piece, maximum open floor)' : ''}.`,
    'For each: a 1 to 3 word name, one sentence idea, zones (every item id in exactly one zone), a focal item, and relations.',
    `Relation kinds: ${RELATION_KINDS.join(', ')}. Targets: an item id, "window", "door", "wall:<index>" or "room-centre".`,
    'Give every item at least one relation. weight 0..1 is how much it matters. distanceM is an optional [min, max] in metres.',
  ].join('\n').trim();
  const t0 = performance.now();
  try {
    const res = await withTimeout(ai<{ concepts?: unknown[] }>({ task: 'fast', system: SYSTEM, parts: [{ text: prompt }], schema: CONCEPTS_SCHEMA, signal: opts.signal, temperature: 0.5 }), opts.timeoutMs ?? 30000, opts.signal);
    const ms = Math.round(res.ms || performance.now() - t0);
    const out = (Array.isArray(res.data?.concepts) ? res.data.concepts : []).slice(0, n)
      .map((c) => cleanProgram(c, ctx))
      .filter((c) => c.relations.length > 0)
      .map((c, i) => ({ ...mergeWithDefault(c, def), model: res.model, latencyMs: ms, name: c.name ?? `Concept ${i + 1}` }));
    return out.length ? out : [fallback(def, 'empty answer')];
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    return [fallback(def, (e as Error).message)];
  }
}

/** A single program: the planner's first concept, or the rule program. */
export async function planProgram(model: SpaceModel, items: FurnitureItem[], req: Requirements, opts: PlanOpts = {}): Promise<DesignProgram> {
  return (await planConcepts(model, items, req, 1, opts))[0];
}

