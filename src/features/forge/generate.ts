// Words (or a photo) to a custom 3D object.
//
// 1. Instantly: a local silhouette (the template for the request) is shown as a ghost.
// 2. The model streams a short list of kit items and plain parts; kits expand in code into
//    detailed parts, so each streamed item drops a finished sub-assembly onto the screen.
// 3. Finishing is deterministic: counts, sides and named styles from the words are enforced on
//    the raw items, swapped axes are turned back, the object is fitted to the exact size, repaired,
//    and recoloured if the named colours did not come through.
// 4. On a strong, fast model a second pass adds detail; on lite models the budget stays lean.
// Without a key, or on failure, the kit templates take over.

import { ai, aiReady, aiRoute, partialJson } from '../../core/ai';
import { dataUrlToInlineData, fileToInlineData, type GeminiPart } from '../../core/gemini';
import { uid } from '../../core/geometry';
import type { ObjectPart, ObjectSpec } from '../../core/types';
import { coerceKit } from './kits';
import { KIT_EXAMPLES, type KitExample } from './kitExamples';
import { fitSpec } from './fit';
import { critique } from './critique';
import { fixAxes } from './orient';
import { kindById, parseEdit, parseRequest, resolveSize, type ParsedRequest } from './parseRequest';
import { enforceColors } from './recolor';
import { defaultSemantics, rulesObject } from './rulesFallback';
import { MATERIAL_IDS, normalizeSpec, SPEC_JSON_SCHEMA, specFootprint } from './spec';
import { validateSpec } from './validate';

export interface GenerateOpts {
  onPartial?: (partial: ObjectSpec) => void;
  signal?: AbortSignal;
  /** Run the automatic detail pass after the draft (default true). */
  detail?: boolean;
  /** Called once with the finished draft, before the detail pass starts. */
  onDraft?: (draft: ForgeSpec) => void;
  /** Abort this to cancel only the detail pass (the draft is then the result), e.g. when the person edits. */
  detailSignal?: AbortSignal;
}

/** How a spec was made: kept on the object for timing and quality checks. */
export interface GenInfo {
  model: string;
  tier: 'lean' | 'rich';
  firstPartsMs: number | null;
  totalMs: number;
  passes: number;
  /** Draft time and detail pass time in ms (detail is null when it did not run or was not used). */
  draftMs?: number;
  detailMs?: number | null;
  detailModel?: string;
  items: number;
  fixes: string[];
}

/** An ObjectSpec plus generation details and, while streaming, the ghost silhouette. */
export type ForgeSpec = ObjectSpec & { gen?: GenInfo; silhouette?: ObjectPart[] };

type Size = { w: number; d: number; h: number };
export { parseEdit };
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const cm = (m: number) => Math.round(m * 100);

// ---- model tiers -------------------------------------------------------------------------

/** Strong, fast models get a richer budget and a detail pass; lite models stay lean. */
export function modelTier(model: string | undefined): 'lean' | 'rich' {
  if (!model) return 'lean';
  const m = model.toLowerCase();
  if (/lite|nano|8b/.test(m)) return 'lean';
  return /gemini-4|hydrogen|carbon|argon|3\.[5-9]-flash|pro/.test(m) ? 'rich' : 'lean';
}

const BUDGET = { lean: '6 to 16 items', rich: '14 to 40 items' } as const;

// ---- prompt ------------------------------------------------------------------------------

const KIT_GUIDE = `KITS (code expands each into detailed, correctly joined parts inside its box; use them wherever they fit):
- legs: count 4|6|3; style square|round|tapered|splayed|turned|hairpin|bun|sled|trestle|panel. Box = the leg zone under the body.
- casters: five-star office or gaming chair base with castors and gas lift (chairs only; beds and trolleys get small cylinder wheels). Box = base footprint, height up to the seat.
- pedestal: centre column with base for round tables; style column|tulip|cross|turned|drum.
- frame: rails along the box edges; style top|apron|base|full|sides; radius = rail thickness / 2.
- carcass: cabinet body (sides, top, bottom, back, plinth) with an open front; count = bays; style plinth|legs.
- drawers: count drawers filling a front zone (box depth = drawer depth); style bar|knob|cup|cutout|push, add "2col" for two columns. Moving parts included.
- doors: count doors across a front zone; style hinged|sliding|glass|cane|shaker|fluted|flip|lift, add "push" for no handle. Moving parts included.
- shelves: count boards bottom to top; style books|decor|glass. bookcase: carcass + count shelves, style books|decor.
- books: a row of books. plant: pot + foliage.
- cushions: count cushions side by side along x; style seat|back|pillows|bolster|tufted|channel.
- bedding: mattress + duvet (color) + pillows (count) + throw and accent cushions (accent); style heart|plain|bare. Box = mattress footprint, height to the top of the bedding.
- headboard: style rect|arch|scallop|heart|wave|crown|cloud|shell|round|channel|tufted|wingback.
- canopy: four posts, rails, fabric top and drapes (accent = fabric colour); style drapes|princess|curtains|frame.
- arc: a curved band seen from above. size = [outer chord width, height, curve depth (how far the middle sits behind the ends)]; radius = band thickness; inset moves it inward; count = segments; style concave (ends come forward, curved sofas) or convex (bulges forward, reception desks). Arcs with the same width and depth share one curve.
- plan: an outline seen from above, extruded upward; style piano|kidney|oval|round|rounded|d-shape|l-shape|u-shape|boat|hexagon|octagon, or profile [[x,z],...].
- ladder (count rungs), slide (playground slide; style front|left|right = the way it runs down), slats (count bars; vertical|horizontal; cot sides, railings), screen (TV, monitor, arcade display; accent = picture colour), keyboard (piano keys), wallbed (a complete fold-down wall bed in its cabinet, bedding and motion included; accent = cabinet colour).
PLAIN PARTS: shape box|rounded|panel|leg|tube|cylinder|cone|sphere|cushion|extrude|lathe. extrude + style (heart, arch, scallop, star, wave, cloud...) gives that outline. mirror "x" adds the right-hand twin of a left part, "z" the back twin, "xz" all four corners. count + step [dx,dy,dz] repeats a part.`;

function systemPrompt(tier: 'lean' | 'rich'): string {
  return `You are a master furniture and product designer. You build exact, characterful 3D objects from a few kit items and plain parts.
Return ONE JSON object: {name, size:{w,d,h}, parts:[...items], semantics:{...}}.

COORDINATES: metres. Origin at the floor centre of the footprint. +x right, +y UP, +z is the FRONT (the side a person uses). w is along x, d along z, h along y: a desk 160x80 is 1.6 wide (x) and 0.8 deep (z), standing 0.75 tall (y). Each item: size = full box [x,y,z], pos = box centre. The lowest item touches y=0, items touch each other, and together they fill the w x d x h box.

${KIT_GUIDE}

MATERIALS (ids only): ${MATERIAL_IDS.join(', ')}. color and accent are hex. Use the exact hex values in the request line for the parts that carry them: a coloured request must look that colour at a glance, never beige or grey.
QUALITY: real proportions (seat 42-47 cm high, desk and table tops 72-76 cm, mattress top 45-55 cm, counters 90-110 cm, shelves 30-38 cm apart, boards 1.8-2.5 cm). Capture what makes THIS object recognisable: signature silhouette, theme, palette and details. Exact numbers and counts the person gives are law. ${BUDGET[tier]}; base and legs first, then body, then details.
semantics: {category (desk, table, sofa, armchair, chair, office-chair, bed, bunk-bed, crib, bookshelf, wardrobe, dresser, cabinet, tv-unit, counter, bench, lamp, piano, ...), role (seating|surface|storage|sleeping|decor|lighting|appliance|divider|floor), wallBacked, frontClearanceM, sideClearanceM, pairsWith [categories], faces (room|window|screen|table|none), description (one plain sentence)}.`;
}

/** The two examples most like the request, by words and category. */
export function pickExamples(prompt: string, parsed: ParsedRequest, n = 2): KitExample[] {
  const words = new Set(prompt.toLowerCase().split(/[^a-zåäö]+/).filter((w) => w.length > 2));
  const cat = parsed.kind?.category;
  const scored = KIT_EXAMPLES.map((e, i) => {
    let s = 0;
    const sem = (e.json.semantics ?? {}) as { category?: string };
    if (cat && sem.category === cat) s += 6;
    for (const w of `${e.prompt} ${String(e.json.name)}`.toLowerCase().split(/[^a-zåäö]+/)) if (words.has(w)) s += 2;
    if (/fold|drop|murphy|wall bed|drawer|door|slid/.test(prompt.toLowerCase()) && /drawers|doors|wallbed/.test(JSON.stringify(e.json))) s += 2;
    return { e, s: s - i * 0.01 };
  }).sort((a, b) => b.s - a.s);
  return scored.slice(0, n).map((x) => x.e);
}

/** Words in the request that call for a particular kit. */
const HINTS: Array<[RegExp, string]> = [
  [/curved|curve|crescent|semi.?circ|rounded sofa/, 'arc kits for the curved body (base, back, cushions share one width and curve depth)'],
  [/canopy|four.?poster|princess|barbie|dream bed/, 'a canopy kit over the bed'],
  [/heart/, 'heart outlines (headboard style heart, bedding style heart)'],
  [/slide/, 'a slide kit'], [/ladder/, 'a ladder kit'], [/drawer|pedestal/, 'a drawers kit inside a carcass'],
  [/sliding door/, 'a doors kit with style sliding'], [/fold|murphy|wall bed|drop.?down|pull.?down/, 'the wallbed kit'],
  [/grand piano|baby grand/, 'a plan kit style piano for the case and lid, a keyboard kit, three legs'],
  [/\bpiano\b/, 'a keyboard kit'], [/bookcase|bookshelf|shelving|library/, 'a bookcase kit with books'],
  [/gaming chair|office chair|desk chair|swivel/, 'a casters kit'], [/pedestal|round.*table|table.*round/, 'a pedestal kit'],
  [/arcade/, 'a body extruded with style arcade (the side silhouette, rot [0,1.5708,0]), a screen kit, joystick, buttons and a lit marquee'], [/cot\b|crib/, 'slats kits on all four sides'],
  [/booth|pod/, 'glass doors kit and felt panels'],
  [/bar counter|home bar|cocktail bar/, 'a raised bar top on the customer side (+z), a brass foot rail, back shelves with bottles'],
  [/standing desk|sit.?stand|height.?adjust/, 'two T-shaped lifting legs (legs kit style trestle in black-metal) and a small control panel'],
  [/hospital|care bed/, 'a raised back section, side rails (slats kit style horizontal), head and foot panels and four small cylinder wheels'],
];

function requestLines(parsed: ParsedRequest, target: Size): string {
  const said = (['w', 'd', 'h'] as const).filter((k) => parsed[k] !== undefined);
  const lines = [`Target size: w ${target.w} m, d ${target.d} m, h ${target.h} m.`];
  if (said.length) lines.push(`Stated exactly: ${said.map((k) => `${k} = ${cm(parsed[k]!)} cm`).join(', ')}.`);
  if (parsed.colors.length) lines.push(`Colours (exact): ${parsed.colors.map((c, i) => `${c.word} ${c.hex}${i === 0 ? ' (main)' : i === 1 ? ' (accent)' : ''}`).join(', ')}.`);
  if (parsed.theme) lines.push(`Theme: ${parsed.theme.brief}`);
  if (parsed.materials.length) lines.push(`Materials: ${parsed.materials.join(', ')}.`);
  const counts = Object.entries(parsed.counts);
  if (counts.length) lines.push(`Exactly: ${counts.map(([k, v]) => `${v} ${k}`).join(', ')}.`);
  if (parsed.features.length) lines.push(`Must include: ${parsed.features.join(', ')}${parsed.side ? ` (on the ${parsed.side}, +x is right)` : ''}.`);
  if (parsed.seats) lines.push(`Seats ${parsed.seats} people.`);
  const hints = HINTS.filter(([re]) => re.test(parsed.text.toLowerCase())).map(([, h]) => h);
  if (hints.length) lines.push(`Use: ${hints.join('; ')}.`);
  return lines.join('\n');
}

function userParts(prompt: string, parsed: ParsedRequest, target: Size, examples: KitExample[]): GeminiPart[] {
  const shots = examples.map((e) => `Request: "${e.prompt}"\n${JSON.stringify(e.json)}`).join('\n\n');
  return [{ text: `EXAMPLES (match this style and precision):\n${shots}\n\nNOW BUILD:\nRequest: "${prompt}"\n${requestLines(parsed, target)}` }];
}

// ---- deterministic repairs on the raw items ------------------------------------------------

type RawItem = Record<string, unknown>;
const HEADBOARD_STYLES: Array<[RegExp, string]> = [
  [/\bheart/, 'heart'], [/\barch(ed)?\b/, 'arch'], [/\bscallop/, 'scallop'], [/\bwav(e|y)\b/, 'wave'], [/\bcrown|tiara/, 'crown'],
  [/\bcloud/, 'cloud'], [/\bchannel/, 'channel'], [/\btufted|button/, 'tufted'], [/\bwing/, 'wingback'], [/\bshell|fan\b/, 'shell'],
];

/** Make the raw items obey what the words said: counts, sides and named shapes. Returns the fixes made. */
export function repairItems(raw: unknown, parsed: ParsedRequest): string[] {
  const fixes: string[] = [];
  const o = raw && typeof raw === 'object' ? (raw as { parts?: unknown }) : null;
  if (!o || !Array.isArray(o.parts)) return fixes;
  const items = o.parts.filter((p): p is RawItem => !!p && typeof p === 'object');
  const kitOf = (it: RawItem) => coerceKit(it.kit);
  const text = parsed.text.toLowerCase();
  const setCount = (kit: string, n: number | undefined) => {
    if (!n) return;
    const hits = items.filter((it) => kitOf(it) === kit || (kit === 'shelves' && kitOf(it) === 'bookcase'));
    if (hits.length !== 1 || hits[0].count === n) return;
    if (typeof hits[0].mirror === 'string' && kit !== 'shelves') return; // a mirrored pair carries half each
    hits[0].count = n; fixes.push(`${kit} count ${n}`);
  };
  setCount('drawers', parsed.counts.drawers);
  setCount('doors', parsed.counts.doors);
  setCount('shelves', parsed.counts.shelves);
  setCount('legs', parsed.counts.legs);
  setCount('ladder', parsed.counts.rungs);
  // Side: a pedestal or drawer stack said to be on the right sits at +x.
  if (parsed.side) {
    const want = parsed.side === 'right' ? 1 : -1;
    for (const it of items) {
      const name = String(it.name ?? '').toLowerCase();
      if (!/pedestal|drawer/.test(name) && kitOf(it) !== 'drawers') continue;
      const pos = Array.isArray(it.pos) ? it.pos : null;
      if (pos && typeof pos[0] === 'number' && Math.abs(pos[0]) > 0.05 && Math.sign(pos[0]) !== want && typeof it.mirror !== 'string') {
        pos[0] = -pos[0]; fixes.push(`moved ${name || 'drawers'} to the ${parsed.side}`);
      }
    }
  }
  // Headboard shape named in the words.
  const style = HEADBOARD_STYLES.find(([re]) => re.test(text))?.[1];
  if (style && /headboard|bed\b/.test(text)) {
    const hb = items.find((it) => kitOf(it) === 'headboard') ?? items.find((it) => /headboard/i.test(String(it.name ?? '')) && !it.profile);
    if (hb && String(hb.style ?? '') !== style && !(kitOf(hb) !== 'headboard' && /heart/.test(String(hb.style)))) {
      hb.kit = 'headboard'; hb.style = style; delete hb.shape; fixes.push(`${style} headboard`);
    }
  }
  // A plain part named like a kit becomes that kit ("Pedestal base" on a round table).
  for (const it of items) {
    if (kitOf(it)) continue;
    const name = String(it.name ?? '').toLowerCase();
    if (/pedestal|centre column|center column/.test(name) && /table/.test(text)) { it.kit = 'pedestal'; it.style = it.style ?? (/brass|steel|chrome/.test(String(it.material)) ? 'tulip' : 'column'); delete it.shape; fixes.push('pedestal kit'); }
    else if (/canopy/.test(name) && !/drape|top|rail/.test(name)) { it.kit = 'canopy'; delete it.shape; fixes.push('canopy kit'); }
  }
  // Sliding doors asked for: doors kits slide.
  if (/sliding|slide-?by|bypass/.test(text) && /door/.test(text)) for (const it of items) if (kitOf(it) === 'doors' && !/slid/.test(String(it.style ?? ''))) { it.style = `sliding ${String(it.style ?? '')}`.trim(); fixes.push('sliding doors'); }
  // A slide runs down away from the object, on the side it was placed.
  for (const it of items) {
    if (kitOf(it) !== 'slide' || !Array.isArray(it.pos)) continue;
    const [x, , z] = it.pos as number[];
    const want = Math.abs(x) > 0.3 && Math.abs(x) >= Math.abs(z) ? (x > 0 ? 'right' : 'left') : z > 0.3 ? 'front' : undefined;
    if (want && !String(it.style ?? '').includes(want)) { it.style = want; fixes.push(`slide runs ${want}`); }
  }
  // Grand piano: the case and lid take the piano outline, and the lid stands open on its prop.
  if (/grand piano|baby grand|concert grand/.test(text)) {
    for (const it of items) {
      const name = String(it.name ?? '').toLowerCase();
      if (kitOf(it) === 'plan' || !Array.isArray(it.size) || !Array.isArray(it.pos)) continue;
      const [w, h] = it.size as number[];
      if (/case|body|rim|cabinet/.test(name) && w > 0.8) { it.kit = 'plan'; it.style = 'piano'; delete it.shape; fixes.push('piano case outline'); }
      else if (/lid|top/.test(name) && w > 0.8 && h < 0.1) {
        const a = 0.5, pos = it.pos as number[];
        it.kit = 'plan'; it.style = 'piano'; delete it.shape; it.rot = [0, 0, a];
        pos[0] += (w / 2) * (1 - Math.cos(a)); pos[1] += (w / 2) * Math.sin(a);
        items.push({ name: 'Lid prop', shape: 'tube', size: [0.02, w * 0.75 * Math.sin(a), 0.02], pos: [pos[0] + w * 0.28, pos[1] - (w / 2) * Math.sin(a) + w * 0.375 * Math.sin(a), pos[2]], material: 'brass' });
        (o.parts as unknown[]).push(items[items.length - 1]);
        fixes.push('piano lid open');
      }
    }
  }
  // Arcade cabinet: the body takes the classic side silhouette.
  if (/arcade/.test(text) && !items.some((it) => it.style === 'arcade')) {
    const body = items.filter((it) => Array.isArray(it.size) && /body|cabinet|side/.test(String(it.name ?? '').toLowerCase()) && !coerceKit(it.kit))
      .sort((a, b) => (b.size as number[])[1] - (a.size as number[])[1])[0];
    if (body && (body.size as number[])[1] > 1.2) {
      const [w, h, d] = body.size as number[];
      body.shape = 'extrude'; body.style = 'arcade'; delete body.profile; body.rot = [0, Math.PI / 2, 0]; body.size = [d, h, w];
      if (!body.color && !String(body.material).includes('black')) body.material = 'black-laminate';
      // Full-height side art slabs follow the same silhouette, standing just proud of the body.
      for (const it of items) {
        if (it === body || !Array.isArray(it.size) || !/side|art|stripe/.test(String(it.name ?? '').toLowerCase())) continue;
        const [sw, sh, sd] = it.size as number[];
        if (sh < h * 0.7 || sw > 0.08) continue;
        it.shape = 'extrude'; it.style = 'arcade'; delete it.profile; it.rot = [0, Math.PI / 2, 0]; it.size = [sd * 0.92, sh * 0.92, sw];
      }
      fixes.push('arcade side profile');
    }
  }
  // Reception desks bulge toward the visitor.
  if (/reception|front desk|counter/.test(text)) for (const it of items) if (kitOf(it) === 'arc' && !it.style) { it.style = 'convex'; fixes.push('convex curve'); }
  return fixes;
}

// ---- finishing ---------------------------------------------------------------------------

interface Want { prompt: string; size: Size; name?: string }

/**
 * Final size: stated numbers are law. Unstated ones keep the model's own proportions, scaled by
 * how much the stated ones were scaled, within a sane range of the kind's default.
 */
export function finalSize(parsed: ParsedRequest, raw: Size, fallback: Size): Size {
  const keys = ['w', 'd', 'h'] as const;
  const stated = keys.filter((k) => parsed[k] !== undefined);
  const ok = (v: number) => Number.isFinite(v) && v > 0.02 && v < 12;
  const logs = stated.filter((k) => ok(raw[k])).map((k) => Math.log(parsed[k]! / raw[k]));
  const k = logs.length ? Math.exp(logs.reduce((a, b) => a + b, 0) / logs.length) : 1;
  const out = { ...fallback };
  for (const key of keys) {
    if (parsed[key] !== undefined) { out[key] = parsed[key]!; continue; }
    const v = raw[key] * k;
    out[key] = ok(v) ? Math.round(Math.min(fallback[key] * 1.7, Math.max(fallback[key] * 0.6, v)) * 1000) / 1000 : fallback[key];
  }
  if (parsed.round && parsed.w !== undefined && parsed.d === undefined) out.d = parsed.w;
  return out;
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

interface Finished { spec: ObjectSpec; ok: boolean; issues: string[]; fixes: string[]; items: number }

const normWant = (parsed: ParsedRequest, want: Want) => ({ prompt: want.prompt, name: want.name, w: parsed.w, d: parsed.d, h: parsed.h });
const itemCount = (raw: unknown) => (raw && typeof raw === 'object' && Array.isArray((raw as { parts?: unknown }).parts) ? (raw as { parts: unknown[] }).parts.length : 0);

/** The whole deterministic finish for one model reply. */
export function finish(raw: unknown, parsed: ParsedRequest, want: Want): Finished {
  const fixes = repairItems(raw, parsed);
  let norm = normalizeSpec(raw, normWant(parsed, want));
  const stated = { w: parsed.w !== undefined, d: parsed.d !== undefined, h: parsed.h !== undefined };
  const turned = fixAxes(norm, want.size, stated);
  if (turned.fixed) { norm = turned.spec; fixes.push(`axes ${turned.fixed}`); }
  const checked = critique(norm);
  norm = checked.spec; fixes.push(...checked.fixes);
  const fp = specFootprint(norm);
  const size = finalSize(parsed, { w: fp.w, d: fp.d, h: fp.h }, want.size);
  const fitted = fitSpec(norm, size);
  const v = validateSpec(fitted);
  const colored = enforceColors(v.fixed, parsed);
  fixes.push(...colored.fixes);
  const spec = withSemantics({ ...colored.spec, size: colored.spec.size ?? size }, parsed);
  return { spec, ok: v.ok, issues: v.issues, fixes, items: itemCount(raw) };
}

const broken = (f: Finished) => !f.ok && (f.issues.length >= 4 || f.spec.parts.length < 4);

/** Reveal a finished object part by part (the template path still assembles). */
async function reveal(spec: ObjectSpec, onPartial?: (s: ObjectSpec) => void, signal?: AbortSignal) {
  if (!onPartial) return;
  const step = Math.max(1, Math.ceil(spec.parts.length / 14));
  for (let i = step; i < spec.parts.length; i += step) {
    if (signal?.aborted) return;
    onPartial({ ...spec, parts: spec.parts.slice(0, i) });
    await new Promise((r) => setTimeout(r, 24));
  }
  onPartial(spec);
}

interface StreamState { firstPartsMs: number | null; t0: number }

function streamer(parsed: ParsedRequest, want: Want, st: StreamState, onPartial?: (s: ObjectSpec) => void, silhouette?: ObjectPart[]) {
  let lastCount = 0;
  return (text: string) => {
    if (!onPartial) return;
    const raw = partialJson(text) as { parts?: unknown[] } | undefined;
    const n = Array.isArray(raw?.parts) ? raw!.parts.length : 0;
    if (!n || n === lastCount) return;
    try {
      const spec: ForgeSpec = normalizeSpec(raw, normWant(parsed, want));
      if (!spec.parts.length) return;
      lastCount = n;
      if (st.firstPartsMs === null) st.firstPartsMs = Math.round(now() - st.t0);
      // The ghost bridges the wait for the first real parts only.
      if (silhouette && spec.parts.length < 3) spec.silhouette = silhouette;
      onPartial(spec);
    } catch { /* incomplete item: wait for more text */ }
  };
}

async function callModel(system: string, parts: GeminiPart[], parsed: ParsedRequest, want: Want, opts: GenerateOpts, st: StreamState, silhouette?: ObjectPart[], task: 'fast' | 'vision' = 'fast') {
  const res = await ai<unknown>({ task, system, parts, schema: SPEC_JSON_SCHEMA, onPartial: streamer(parsed, want, st, opts.onPartial, silhouette), signal: opts.signal, temperature: 0.35 });
  return { data: res.data, model: res.model, ms: res.ms };
}

const issueList = (f: Finished) => f.issues.filter((i) => !/was floating; moved|duplicated/.test(i)).slice(0, 10);

/** One fix-up call when the first reply is broken. */
async function withRepair(first: { data: unknown; model: string }, parsed: ParsedRequest, want: Want, opts: GenerateOpts, st: StreamState, system: string, task: 'fast' | 'vision' = 'fast') {
  let f = finish(first.data, parsed, want), model = first.model, data = first.data, passes = 1;
  if (broken(f) && !opts.signal?.aborted) {
    try {
      const fix = await callModel(system, [{ text: `This object for "${want.prompt}" has problems:\n- ${issueList(f).join('\n- ')}\n\nReturn the corrected full JSON (kits welcome). Keep size ${want.size.w} x ${want.size.d} x ${want.size.h} m.\n${JSON.stringify(first.data)}` }], parsed, want, opts, st, undefined, task === 'vision' ? 'fast' : task);
      passes++;
      const g = finish(fix.data, parsed, want);
      if (g.ok || g.issues.length < f.issues.length) { f = g; model = fix.model; data = fix.data; }
    } catch (e) { if (opts.signal?.aborted) throw e; }
  }
  return { f, model, data, passes };
}

/** The detail pass: a stronger model refines the same object; the result replaces the draft only when valid. */
async function refine(prev: { f: Finished; data: unknown; model: string }, prompt: string, parsed: ParsedRequest, want: Want, opts: GenerateOpts, system: string, signal: AbortSignal) {
  const text = `Here is a fast first draft of "${prompt}" as JSON. Refine THE SAME object into a finished one: keep its overall size and character, improve proportions against real-world dimensions, add parts (up to 40 items in total; real hardware, trim, supports, panels, small accessories that belong to it), choose better materials, and print real words on signs, screens, labels or logos with the text field where the object has any. Every part must touch another part or the floor. Fix anything that does not match the request.
${requestLines(parsed, want.size)}
${JSON.stringify(prev.data)}`;
  const res = await ai<unknown>({ task: 'smart', system, parts: [{ text }], schema: SPEC_JSON_SCHEMA, signal, temperature: 0.35 });
  const g = finish(res.data, parsed, want);
  const better = g.ok && g.spec.parts.length >= prev.f.spec.parts.length;
  return { took: better, f: better ? g : prev.f, data: better ? res.data : prev.data, model: better ? res.model : prev.model, detailModel: res.model };
}

// ---- public API --------------------------------------------------------------------------

function stamp(spec: ObjectSpec, info: GenInfo): ForgeSpec {
  return { ...spec, gen: info };
}

/** A custom object built to the person's words and exact numbers. Never rejects except on abort. */
export async function generateObject(prompt: string, opts: GenerateOpts = {}): Promise<ForgeSpec> {
  const t0 = now();
  const parsed = parseRequest(prompt);
  const target = resolveSize(parsed);
  const sil = rulesObject(prompt, { parsed, t0 });
  if (!aiReady()) {
    await reveal(sil, opts.onPartial, opts.signal);
    return stamp(sil, { model: 'rules', tier: 'lean', firstPartsMs: 0, totalMs: Math.round(now() - t0), passes: 0, items: 0, fixes: [] });
  }
  // Instant silhouette while the model starts.
  opts.onPartial?.({ ...sil, parts: [], silhouette: sil.parts } as ForgeSpec);
  const want: Want = { prompt, size: target };
  const tier = modelTier(aiRoute('fast')[0]);
  const system = systemPrompt(tier);
  const st: StreamState = { firstPartsMs: null, t0 };
  try {
    const first = await callModel(system, userParts(prompt, parsed, target, pickExamples(prompt, parsed, 2)), parsed, want, opts, st, sil.parts);
    let r = await withRepair(first, parsed, want, opts, st, system);
    let passes = r.passes;
    const draftMs = Math.round(now() - t0);
    let detailMs: number | null = null, detailModel: string | undefined;
    if (r.f.spec.parts.length >= 3 && opts.detail !== false && !opts.signal?.aborted && !opts.detailSignal?.aborted) {
      const draft = stamp({ ...r.f.spec, id: r.f.spec.id || uid('obj'), prompt, model: r.model, latencyMs: draftMs, createdAt: Date.now() },
        { model: r.model, tier: modelTier(r.model), firstPartsMs: st.firstPartsMs, totalMs: draftMs, draftMs, detailMs: null, passes, items: r.f.items, fixes: r.f.fixes });
      opts.onDraft?.(draft);
      opts.onPartial?.(draft);
      const ctl = new AbortController();
      const stop = () => ctl.abort();
      for (const sg of [opts.signal, opts.detailSignal]) sg?.addEventListener('abort', stop, { once: true });
      const td = now();
      try {
        const g = await refine(r, prompt, parsed, want, opts, systemPrompt('rich'), ctl.signal);
        detailMs = Math.round(now() - td); detailModel = g.detailModel; passes++;
        if (g.took) r = { ...r, f: g.f, data: g.data, model: g.model };
        else detailModel = `${g.detailModel} (kept draft)`;
      } catch (e) { if (opts.signal?.aborted) throw e; /* cancelled or failed: the draft stands */ }
      finally { for (const sg of [opts.signal, opts.detailSignal]) sg?.removeEventListener('abort', stop); }
    }
    const { f, model } = r;
    if (f.spec.parts.length < 3) throw new Error('empty object');
    const totalMs = Math.round(now() - t0);
    return stamp({ ...f.spec, id: f.spec.id || uid('obj'), prompt, model, latencyMs: totalMs, createdAt: Date.now() },
      { model, tier: modelTier(model), firstPartsMs: st.firstPartsMs, totalMs, draftMs, detailMs, detailModel, passes, items: f.items, fixes: f.fixes });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    await reveal(sil, opts.onPartial, opts.signal);
    return stamp(sil, { model: 'rules', tier: 'lean', firstPartsMs: null, totalMs: Math.round(now() - t0), passes: 0, items: 0, fixes: ['model failed'] });
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
  const system = systemPrompt(modelTier(aiRoute('fast')[0]));
  const st: StreamState = { firstPartsMs: null, t0 };
  // Edits keep everything else: stated sizes become the current size.
  const p3: ParsedRequest = { ...parsed, w: target.w, d: target.d, h: target.h };
  try {
    const first = await callModel(system, [{ text: `Current object:\n${JSON.stringify({ name: base.name, size: base.size, parts: base.parts, motions: base.motions, semantics: base.semantics })}\n\nChange requested: "${instruction}"\nApply only that change and keep everything else (style, colours, parts) the same. You may use kits for new pieces.\n${requestLines(p3, target)}\nReturn the full updated JSON.` }], p3, want, opts, st);
    const { f, model } = await withRepair(first, p3, want, opts, st, system);
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
  const system = systemPrompt('rich');
  const st: StreamState = { firstPartsMs: null, t0 };
  try {
    const first = await callModel(system, [img, { text: `Reproduce the product in this photo as an exact 3D object: its silhouette, proportions, parts, colours (as hex) and materials. Ignore the background and props.${hint.name ? ` It is listed as "${hint.name}".` : ''}\n${requestLines(parsed, target)}` }], parsed, want, opts, st, undefined, 'vision');
    const { f, model } = await withRepair(first, parsed, want, opts, st, system, 'vision');
    if (f.spec.parts.length < 3) throw new Error('empty object');
    return { ...f.spec, id: uid('obj'), name: hint.name ?? f.spec.name, prompt, model, latencyMs: Math.round(now() - t0), createdAt: Date.now() };
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    return rulesObject(prompt, { parsed, size: target, t0 });
  }
}
