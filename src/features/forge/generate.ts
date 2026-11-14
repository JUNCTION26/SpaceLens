// Words (or a photo) to a custom 3D object. The model streams parts; each partial is parsed,
// normalised and shown so the object assembles while it is still being written. The final
// object is fitted to the person's exact dimensions and validated; one repair pass runs if it
// comes back broken. Without a key, or on failure, the parametric templates take over.

import { ai, aiReady, partialJson } from '../../core/ai';
import { dataUrlToInlineData, fileToInlineData, type GeminiPart } from '../../core/gemini';
import { uid } from '../../core/geometry';
import type { ObjectSpec } from '../../core/types';
import { EXAMPLES } from './examples';
import { fitSpec } from './fit';
import { kindById, parseEdit, parseRequest, resolveSize, type ParsedRequest } from './parseRequest';
import { defaultSemantics, rulesObject } from './rulesFallback';
import { MATERIAL_IDS, normalizeSpec, PART_SHAPES, SPEC_JSON_SCHEMA } from './spec';
import { validateSpec } from './validate';

export interface GenerateOpts {
  onPartial?: (partial: ObjectSpec) => void;
  signal?: AbortSignal;
}

type Size = { w: number; d: number; h: number };
export { parseEdit };
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const cm = (m: number) => Math.round(m * 100);

// ---- prompt ------------------------------------------------------------------------------

const SYSTEM = `You are a master furniture and product designer who builds exact 3D models from parts.
Return ONE JSON object: {name, size:{w,d,h}, parts:[...], motions?:[...], openSize?, semantics:{...}}.

COORDINATES: metres. Origin at the floor centre of the footprint. +x right, +y up, +z is the FRONT (the side a person uses).
w = extent along x, d = along z, h = along y. Every part: {name, shape, size:[x,y,z] full extents, pos:[x,y,z] centre, rot?:[rx,ry,rz] radians, radius?, material, color?, profile?, group?}.
The union of all parts must fill the box x in [-w/2,w/2], y in [0,h], z in [-d/2,d/2] exactly: something touches every face of it.

SHAPES: ${PART_SHAPES.join(', ')}.
- box/panel: flat boards; rounded: softened block (radius); cushion: upholstery; leg/tube: slim posts, rails, rods; cylinder/cone/sphere: round parts (size gives the bounding box).
- extrude: a closed 2D outline profile [[x,y],...] in metres (centred on 0,0) extruded along z by size[2]. Use it for signature silhouettes: arched or scalloped headboards, heart shapes, curved armrests, wavy shelf sides, cut-out letters.
- lathe: profile [[radius,height],...] from bottom to top revolved around y. Use it for turned legs, vases, lamp bases and shades, bowls, round pedestals.
MATERIALS (only these ids): ${MATERIAL_IDS.join(', ')}. Add color (hex) whenever the person names or implies a colour, and match it exactly ("pink" means a clear pink like #f2a7c3, "Barbie" means hot pink #e0218a with white and light pink).

QUALITY BAR:
- 12-40 parts with realistic joinery: legs meet the top, rails meet legs, drawers sit inside carcasses, cushions rest on frames. No floating parts, no deep interpenetration.
- Real proportions: desk/table top 2.5-4 cm thick at 72-76 cm; seat height 42-47 cm; sofa seat depth 55-60 cm; shelves 30-38 cm apart, boards 1.8-2.5 cm; handles 1-2 cm; legs 3-6 cm.
- Character and fidelity, never a generic box: capture what makes THIS object recognisable (theme, era, signature shapes, colour palette, details like piping, tufting, handles, crowns, scallops). A themed request gets the full theme.
- Moving parts: if the object folds, opens or slides (wall bed, fold-down desk, drawers, doors, extendable table), give those parts a shared group and add motions [{group,label,kind:'hinge'|'slide',pivot,axis,open}] in the CLOSED pose; open = radians (hinge) or metres (slide). Add openSize for the footprint when fully open.
- semantics: {category (one lowercase word or hyphenated: desk, table, coffee-table, sofa, armchair, chair, office-chair, bed, bookshelf, wardrobe, dresser, nightstand, tv-unit, bench, lamp, rug, ...), role (seating|surface|storage|sleeping|decor|lighting|appliance|divider|floor), wallBacked, frontClearanceM, sideClearanceM, pairsWith [categories], faces (room|window|screen|table|none), tall (h>1.2), description (one plain sentence)}.
- Name: short and specific, as a shop would title it.
Exact numbers the person gives are law. Output parts in build order: base and legs first, then body, then details.`;

function compact(spec: ObjectSpec) {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return {
    name: spec.name,
    size: spec.size,
    parts: spec.parts.map((p) => ({ ...p, size: p.size.map(r), pos: p.pos.map(r), ...(p.rot ? { rot: p.rot.map(r) } : {}) })),
    ...(spec.motions ? { motions: spec.motions, openSize: spec.openSize } : {}),
    semantics: spec.semantics,
  };
}

/** The 2-3 exemplars most like the request, by category and words. */
export function pickExamples(prompt: string, parsed: ParsedRequest, n = 2): ObjectSpec[] {
  const words = new Set(prompt.toLowerCase().split(/[^a-zåäö]+/).filter((w) => w.length > 2));
  const cat = parsed.kind?.category, tmpl = parsed.kind?.template;
  const scored = EXAMPLES.map((e) => {
    let s = 0;
    if (cat && e.semantics.category === cat) s += 10;
    if (tmpl && (e.semantics.category.includes(tmpl) || e.name.toLowerCase().includes(tmpl))) s += 5;
    for (const w of `${e.name} ${e.prompt} ${e.semantics.category}`.toLowerCase().split(/[^a-zåäö]+/)) if (words.has(w)) s += 1;
    if (e.motions?.length && /fold|drop|murphy|wall bed|open|slide|drawer|bäddskåp|fäll/.test(prompt.toLowerCase())) s += 4;
    return { e, s };
  }).sort((a, b) => b.s - a.s);
  return scored.slice(0, n).map((x) => x.e);
}

function sizeLine(parsed: ParsedRequest, target: Size): string {
  const said = (['w', 'd', 'h'] as const).filter((k) => parsed[k] !== undefined);
  const lines = [`Target size: w ${target.w} m, d ${target.d} m, h ${target.h} m.`];
  if (said.length) lines.push(`The person stated ${said.map((k) => `${k}=${cm(parsed[k]!)} cm`).join(', ')}: these are exact.`);
  else lines.push('Size not stated: use the target size unless the object clearly needs another.');
  if (parsed.colors.length) lines.push(`Colours said: ${parsed.colors.map((c) => `${c.word} (${c.hex})`).join(', ')}.`);
  if (parsed.materials.length) lines.push(`Materials said: ${parsed.materials.join(', ')}.`);
  if (parsed.features.length) lines.push(`Must include: ${parsed.features.join(', ')}${parsed.side ? ` (on the ${parsed.side})` : ''}.`);
  if (parsed.seats) lines.push(`Seats ${parsed.seats} people.`);
  return lines.join(' ');
}

function userParts(prompt: string, parsed: ParsedRequest, target: Size, examples: ObjectSpec[]): GeminiPart[] {
  const shots = examples.map((e) => `Request: "${e.prompt}"\n${JSON.stringify(compact(e))}`).join('\n\n');
  return [{ text: `${shots ? `EXAMPLES (style and precision to match):\n${shots}\n\n` : ''}NOW BUILD:\nRequest: "${prompt}"\n${sizeLine(parsed, target)}` }];
}

// ---- finishing ---------------------------------------------------------------------------

interface Want { prompt: string; size: Size; name?: string }

/** Size the object must end with: stated numbers first, then the model's, then defaults. */
function finalSize(parsed: ParsedRequest, modelSize: Partial<Size> | undefined, fallback: Size): Size {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0.005 && v < 12;
  const pick = (k: keyof Size) => parsed[k] ?? (ok(modelSize?.[k]) ? modelSize![k]! : fallback[k]);
  const s = { w: pick('w'), d: pick('d'), h: pick('h') };
  if (parsed.round && parsed.w !== undefined && parsed.d === undefined) s.d = parsed.w;
  return s;
}

function withSemantics(spec: ObjectSpec, parsed: ParsedRequest): ObjectSpec {
  const sem = spec.semantics;
  const cat = (sem?.category || parsed.kind?.category || 'object').toLowerCase().trim().replace(/\s+/g, '-');
  const base = defaultSemantics(cat, spec.size, sem?.description ?? '');
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    ...spec,
    semantics: {
      category: cat,
      role: sem?.role ?? base.role,
      wallBacked: typeof sem?.wallBacked === 'boolean' ? sem.wallBacked : base.wallBacked,
      frontClearanceM: num(sem?.frontClearanceM, 0, 1.5, base.frontClearanceM),
      sideClearanceM: num(sem?.sideClearanceM, 0, 1.2, base.sideClearanceM),
      pairsWith: Array.isArray(sem?.pairsWith) ? sem.pairsWith.filter((x) => typeof x === 'string').slice(0, 6) : base.pairsWith,
      faces: sem?.faces ?? base.faces,
      tall: spec.size.h > 1.2,
      description: (sem?.description || base.description || `${spec.name}, ${cm(spec.size.w)} × ${cm(spec.size.d)} × ${cm(spec.size.h)} cm.`).slice(0, 220),
    },
  };
}

interface Finished { spec: ObjectSpec; ok: boolean; issues: unknown[] }

const normWant = (parsed: ParsedRequest, want: Want) => ({ prompt: want.prompt, name: want.name, w: parsed.w, d: parsed.d, h: parsed.h });

/** normalizeSpec plus moving parts carried over from the raw JSON. */
function normalize(raw: unknown, parsed: ParsedRequest, want: Want): ObjectSpec {
  const norm = normalizeSpec(raw, normWant(parsed, want));
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<ObjectSpec>;
  if (!norm.motions && Array.isArray(o.motions)) {
    const groups = new Set(norm.parts.map((q) => q.group).filter(Boolean));
    const motions = o.motions.filter((m) => m && typeof m.group === 'string' && groups.has(m.group) && Array.isArray(m.axis) && typeof m.open === 'number'
      && (m.kind === 'hinge' || m.kind === 'slide'));
    if (motions.length) {
      norm.motions = motions.map((m) => ({ group: m.group, label: String(m.label || 'Open').slice(0, 30), kind: m.kind, axis: m.axis, open: m.open, ...(m.pivot ? { pivot: m.pivot } : {}) }));
      const os = o.openSize;
      if (os && [os.w, os.d, os.h].every((v) => typeof v === 'number' && v > 0 && v < 12)) norm.openSize = { w: os.w, d: os.d, h: os.h };
    }
  }
  return norm;
}

function finish(raw: unknown, parsed: ParsedRequest, want: Want): Finished {
  const norm = normalize(raw, parsed, want);
  const size = finalSize(parsed, norm.size, want.size);
  const fitted = fitSpec(norm, size);
  const v = validateSpec(fitted);
  const spec = withSemantics({ ...v.fixed, size: v.fixed.size ?? size }, parsed);
  return { spec, ok: v.ok, issues: v.issues as unknown[] };
}

const issueText = (i: unknown) => (typeof i === 'string' ? i : typeof i === 'object' && i && 'message' in i ? String((i as { message: unknown }).message) : JSON.stringify(i));
const broken = (f: Finished) => !f.ok && (f.issues.length >= 3 || f.spec.parts.length < 4);

/** Reveal a finished object part by part (used for the template path so it still assembles). */
async function reveal(spec: ObjectSpec, onPartial?: (s: ObjectSpec) => void, signal?: AbortSignal) {
  if (!onPartial) return;
  const step = Math.max(1, Math.ceil(spec.parts.length / 14));
  for (let i = step; i < spec.parts.length; i += step) {
    if (signal?.aborted) return;
    onPartial({ ...spec, parts: spec.parts.slice(0, i) });
    await new Promise((r) => setTimeout(r, 28));
  }
  onPartial(spec);
}

function streamer(parsed: ParsedRequest, want: Want, onPartial?: (s: ObjectSpec) => void) {
  let lastCount = 0;
  return (text: string) => {
    if (!onPartial) return;
    const raw = partialJson(text) as { parts?: unknown[] } | undefined;
    const n = Array.isArray(raw?.parts) ? raw!.parts.length : 0;
    if (!n || n === lastCount) return;
    try {
      const spec = normalize(raw, parsed, want);
      if (spec.parts.length) { lastCount = n; onPartial(spec); }
    } catch { /* incomplete part: wait for more text */ }
  };
}

async function callModel(system: string, parts: GeminiPart[], parsed: ParsedRequest, want: Want, opts: GenerateOpts, task: 'fast' | 'vision' = 'fast') {
  const res = await ai<unknown>({ task, system, parts, schema: SPEC_JSON_SCHEMA, onPartial: streamer(parsed, want, opts.onPartial), signal: opts.signal, temperature: 0.4 });
  return { data: res.data, model: res.model };
}

async function withRepair(first: { data: unknown; model: string }, parsed: ParsedRequest, want: Want, opts: GenerateOpts, task: 'fast' | 'vision' = 'fast') {
  let f = finish(first.data, parsed, want), model = first.model;
  if (broken(f) && !opts.signal?.aborted) {
    try {
      const fix = await callModel(SYSTEM, [{ text: `This object for "${want.prompt}" has problems:\n- ${f.issues.slice(0, 12).map(issueText).join('\n- ')}\n\nReturn the corrected full JSON. Keep size ${want.size.w} × ${want.size.d} × ${want.size.h} m.\n${JSON.stringify(compact(f.spec))}` }], parsed, want, opts, task === 'vision' ? 'fast' : task);
      const g = finish(fix.data, parsed, want);
      if (g.ok || g.issues.length < f.issues.length) { f = g; model = fix.model; }
    } catch (e) { if (opts.signal?.aborted) throw e; }
  }
  return { f, model };
}

// ---- public API --------------------------------------------------------------------------

/** A custom object built to the person's words and exact numbers. Never rejects except on abort. */
export async function generateObject(prompt: string, opts: GenerateOpts = {}): Promise<ObjectSpec> {
  const t0 = now();
  const parsed = parseRequest(prompt);
  const target = resolveSize(parsed);
  if (!aiReady()) {
    const spec = rulesObject(prompt, { parsed, t0 });
    await reveal(spec, opts.onPartial, opts.signal);
    return spec;
  }
  const want: Want = { prompt, size: target };
  try {
    const first = await callModel(SYSTEM, userParts(prompt, parsed, target, pickExamples(prompt, parsed, parsed.kind ? 2 : 3)), parsed, want, opts);
    const { f, model } = await withRepair(first, parsed, want, opts);
    if (f.spec.parts.length < 3) throw new Error('empty object');
    return { ...f.spec, id: f.spec.id || uid('obj'), prompt, model, latencyMs: Math.round(now() - t0), createdAt: Date.now() };
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    const spec = rulesObject(prompt, { parsed, t0 });
    await reveal(spec, opts.onPartial, opts.signal);
    return spec;
  }
}

/** A variation of an existing object: "make it 20 cm wider", "in walnut", "add a shelf". */
export async function editObject(base: ObjectSpec, instruction: string, opts: GenerateOpts = {}): Promise<ObjectSpec> {
  const t0 = now();
  const prompt = `${base.prompt}; ${instruction}`;
  const delta = parseEdit(instruction, base.size);
  const parsed: ParsedRequest = { ...parseRequest(prompt), w: delta.w, d: delta.d, h: delta.h };
  const target = { w: delta.w ?? base.size.w, d: delta.d ?? base.size.d, h: delta.h ?? base.size.h };
  const finishLocal = (): ObjectSpec => {
    // Without a model: resize, recolour/re-material, or rebuild from the template with the new features.
    const p2 = parseRequest(instruction);
    if (p2.features.length || (base.model === 'rules' && (p2.materials.length || p2.colors.length))) {
      const merged = { ...parseRequest(prompt), kind: parseRequest(base.prompt).kind ?? kindById(base.semantics.category) ?? null };
      return { ...rulesObject(prompt, { parsed: merged, size: target, t0 }), name: base.name };
    }
    let parts = base.parts;
    if (p2.materials.length) parts = parts.map((q) => (q.material === base.parts[0]?.material ? { ...q, material: p2.materials[0], color: undefined } : q));
    if (p2.colors.length) parts = parts.map((q) => (q.material === base.parts[0]?.material || q.color ? { ...q, color: p2.colors[0].hex } : q));
    const fitted = fitSpec({ ...base, parts }, target);
    return { ...withSemantics(fitted, parsed), id: uid('obj'), prompt, model: 'rules', latencyMs: Math.round(now() - t0), createdAt: Date.now() };
  };
  if (!aiReady()) { const s = finishLocal(); await reveal(s, opts.onPartial, opts.signal); return s; }
  const want: Want = { prompt, size: target, name: base.name };
  try {
    const first = await callModel(SYSTEM, [{ text: `Current object:\n${JSON.stringify(compact(base))}\n\nChange requested: "${instruction}"\nApply only that change and keep everything else (style, colours, parts) the same. ${sizeLine(parsed, target)}\nReturn the full updated JSON.` }], parsed, want, opts);
    const { f, model } = await withRepair(first, parsed, want, opts);
    if (f.spec.parts.length < 3) throw new Error('empty object');
    return { ...f.spec, id: uid('obj'), prompt, model, latencyMs: Math.round(now() - t0), createdAt: Date.now() };
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    const s = finishLocal(); await reveal(s, opts.onPartial, opts.signal); return s;
  }
}

/** Reproduce a pictured product (shop listing photo) as an object; stated numbers win. */
export async function generateFromImage(image: Blob | string, hint: { name?: string; w?: number; d?: number; h?: number } = {}, opts: GenerateOpts = {}): Promise<ObjectSpec> {
  const t0 = now();
  const prompt = hint.name ?? 'Product from photo';
  const parsed: ParsedRequest = { ...parseRequest(prompt), w: hint.w, d: hint.d, h: hint.h };
  const target = resolveSize(parsed);
  if (!aiReady()) return rulesObject(prompt, { parsed, size: target, t0 });
  const want: Want = { prompt, size: target, name: hint.name };
  const img = typeof image === 'string' ? dataUrlToInlineData(image) : await fileToInlineData(image);
  try {
    const first = await callModel(SYSTEM, [img, { text: `Reproduce the product in this photo as an exact 3D object: its silhouette, proportions, parts, colours (as hex) and materials. Ignore the background and props.${hint.name ? ` It is listed as "${hint.name}".` : ''} ${sizeLine(parsed, target)}` }], parsed, want, opts, 'vision');
    const { f, model } = await withRepair(first, parsed, want, opts, 'vision');
    if (f.spec.parts.length < 3) throw new Error('empty object');
    return { ...f.spec, id: uid('obj'), name: hint.name ?? f.spec.name, prompt, model, latencyMs: Math.round(now() - t0), createdAt: Date.now() };
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    return rulesObject(prompt, { parsed, size: target, t0 });
  }
}
