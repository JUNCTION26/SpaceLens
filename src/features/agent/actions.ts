// What the agent can do, how a reply is cleaned, how places are resolved, and how each action is
// first sketched on the plan and then carried out through the store and the feature modules.
import {
  add, centroid, dist, fmtSek, itemCorners, mul, norm, pointInPolygon, rotate, sub, uid, wallInwardNormal, wallSegment,
} from '../../core/geometry';
import { getState } from '../../core/store';
import type { FurnitureItem, ObjectSpec, SketchMark, SpaceModel, StoreListing, Vec2 } from '../../core/types';
import { catalogEntry, findByKeyword, makeItem, makeOwnItem } from '../furniture/catalog';
import { clampInside, findFreeSpot, resolveOverlap, rotationFacing, snapToWall, wallCompass } from '../objects/placement';
import { validateLayout } from '../referee/validate';
import { colorHex, parseSpoken } from '../voice/parse';
import { markGeometry } from './deixis';
import { loadMod, loadedMod, type PipelineReport } from './mods';
import { latestMark, useSketch, type AgentMark } from './sketchStore';
import { wallsOf, type Refs } from './world';

// ---------- reply shape ----------

export const ACTION_TYPES = [
  'create_object', 'add_catalog', 'add_wall', 'move', 'rotate', 'resize', 'remove', 'design_room', 'apply_layout',
  'explain', 'compare', 'check_safety', 'find_products', 'measure', 'set_view', 'undo',
] as const;
export type ActionType = typeof ACTION_TYPES[number];

/** One flat shape for every action (structured output has no unions); unused fields stay empty. */
export interface Action {
  type: ActionType;
  /** Item ref (i1), or for explain the item asked about. */
  id?: string;
  prompt?: string;
  catalogId?: string;
  /** Where: "here", a sketch ref (m1), item ref, wall ref (w2), "north|south|east|west", "window", "door", "centre", or "x,y". */
  place?: string;
  near?: string;
  wall?: string;
  x?: number; y?: number;
  /** rotate: degrees to turn (positive = clockwise on the plan). */
  angle?: number;
  w?: number; d?: number; h?: number;
  color?: string;
  brief?: string;
  candidateId?: string;
  topic?: string;
  a?: string; b?: string;
  query?: string;
  from?: string; to?: string;
  view?: '2d' | '3d' | 'split' | 'walk';
}

export interface SketchSpec {
  kind: SketchMark['kind'];
  points?: Vec2[];
  /** Instead of points: "here", m1, i2, w3, "x,y". */
  at?: string;
  text?: string;
  w?: number; d?: number;
  /** Degrees. */
  rotation?: number;
}

export interface AgentReply { say: string; sketch: SketchSpec[]; actions: Action[] }

const KINDS: SketchMark['kind'][] = ['stroke', 'arrow', 'circle', 'rect', 'zone', 'label', 'ghost'];
const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
const str = (v: unknown, max = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

function cleanPoints(v: unknown): Vec2[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const pts: Vec2[] = [];
  for (const p of v.slice(0, 64)) {
    const x = Array.isArray(p) ? p[0] : (p as Vec2 | null)?.x;
    const y = Array.isArray(p) ? p[1] : (p as Vec2 | null)?.y;
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 500 && Math.abs(y) < 500) pts.push({ x, y });
  }
  return pts.length ? pts : undefined;
}

export function cleanSketch(raw: unknown): SketchSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!KINDS.includes(r.kind as SketchMark['kind'])) return null;
  const s: SketchSpec = { kind: r.kind as SketchMark['kind'] };
  const pts = cleanPoints(r.points); if (pts) s.points = pts;
  const at = str(r.at, 40); if (at) s.at = at;
  const text = str(r.text, 60); if (text) s.text = text;
  const w = num(r.w, 0.05, 30); if (w) s.w = w;
  const d = num(r.d, 0.05, 30); if (d) s.d = d;
  const rot = num(r.rotation, -720, 720); if (rot !== undefined) s.rotation = rot;
  return s.points || s.at ? s : null;
}

export function cleanAction(raw: unknown): Action | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!ACTION_TYPES.includes(r.type as ActionType)) return null;
  const a: Action = { type: r.type as ActionType };
  for (const k of ['id', 'prompt', 'catalogId', 'place', 'near', 'wall', 'color', 'brief', 'candidateId', 'topic', 'a', 'b', 'query', 'from', 'to'] as const) {
    const v = str(r[k], k === 'prompt' || k === 'brief' ? 500 : 80); if (v) a[k] = v;
  }
  for (const k of ['x', 'y'] as const) { const v = num(r[k], -500, 500); if (v !== undefined) a[k] = v; }
  for (const k of ['w', 'd', 'h'] as const) { const v = num(r[k], 0.05, 12); if (v !== undefined) a[k] = v; }
  const ang = num(r.angle, -360, 360); if (ang !== undefined) a.angle = ang;
  if (['2d', '3d', 'split', 'walk'].includes(r.view as string)) a.view = r.view as Action['view'];
  return a;
}

/** Spoken text without markdown. Prefix-stable, so streamed and final text line up. */
export const cleanSay = (s: unknown) => (typeof s === 'string' ? s.replace(/[*_#`]/g, '').trimStart().slice(0, 600) : '');

export function cleanReply(raw: unknown): AgentReply {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const say = cleanSay(r.say).trimEnd();
  const sketch = Array.isArray(r.sketch) ? r.sketch.map(cleanSketch).filter((s): s is SketchSpec => !!s).slice(0, 12) : [];
  const actions = Array.isArray(r.actions) ? r.actions.map(cleanAction).filter((a): a is Action => !!a).slice(0, 6) : [];
  return { say, sketch, actions };
}

// ---------- resolving references ----------

export interface Ctx {
  refs: Refs;
  turnId: string;
  utterance: string;
  signal?: AbortSignal;
  /** Show progress under the caption (not spoken). */
  status?: (text: string) => void;
}

export function resolveItem(ref: string | undefined, ctx: Ctx, model: SpaceModel = getState().model): FurnitureItem | undefined {
  const st = getState();
  const selected = st.selection?.kind === 'furniture' ? model.furniture.find((f) => f.id === st.selection!.id) : undefined;
  if (!ref) return selected;
  const r = ref.trim();
  const id = ctx.refs.items.get(r) ?? r;
  const direct = model.furniture.find((f) => f.id === id);
  if (direct) return direct;
  if (/^(it|this|that|selected|the selected one)$/i.test(r)) return selected;
  const low = r.toLowerCase();
  const byName = model.furniture.filter((f) => f.name.toLowerCase().includes(low) || f.category.toLowerCase() === low || low.includes(f.category.toLowerCase()));
  return byName.find((f) => f.id === selected?.id) ?? byName[byName.length - 1];
}

export interface Place {
  p: Vec2;
  /** A wall to back onto. */
  wall?: { spaceId: string; index: number; along?: number };
  /** The person's sketch, when "here" meant one. */
  mark?: SketchMark;
  /** Another item to sit next to. */
  item?: FurnitureItem;
}

const HERE = /^(here|there|this|that|this spot|that spot|this area|my sketch|sketch|här|där)$/i;

function wallBySide(model: SpaceModel, side: string): Place['wall'] | undefined {
  let best: Place['wall'] | undefined, bestLen = 0;
  for (const s of model.spaces) for (let i = 0; i < s.polygon.length; i++) {
    if (wallCompass(wallInwardNormal(s, i)) !== side) continue;
    const [a, b] = wallSegment(s, i); const L = dist(a, b);
    if (L > bestLen) { bestLen = L; best = { spaceId: s.id, index: i }; }
  }
  return best;
}

function wallMid(model: SpaceModel, w: NonNullable<Place['wall']>): Vec2 {
  const s = model.spaces.find((x) => x.id === w.spaceId)!;
  const [a, b] = wallSegment(s, w.index);
  const L = dist(a, b);
  const t = w.along !== undefined && L > 0 ? Math.min(1, Math.max(0, w.along / L)) : 0.5;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function resolvePlace(spec: string | undefined, ctx: Ctx, model: SpaceModel = getState().model): Place | null {
  if (!spec) return null;
  const s = spec.trim();
  const xy = s.match(/^\(?\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*\)?$/);
  if (xy) return { p: { x: +xy[1], y: +xy[2] } };
  const marks = useSketch.getState().marks;
  const mark = HERE.test(s) ? latestMark(marks, 'you') : ctx.refs.marks.get(s) ?? marks.find((m) => m.id === s);
  if (mark) { const g = markGeometry(mark); if (g) return { p: g.centroid, mark }; }
  if (HERE.test(s)) return null;
  const low = s.toLowerCase().replace(/^(the|near|by|next to|against)\s+/, '').replace(/\s+wall$/, '');
  const wr = wallsOf(model).find((w) => w.ref === low);
  if (wr) { const wall = { spaceId: wr.spaceId, index: wr.index }; return { p: wallMid(model, wall), wall }; }
  if (['north', 'south', 'east', 'west'].includes(low)) {
    const wall = wallBySide(model, low); if (wall) return { p: wallMid(model, wall), wall };
  }
  const side = ({ left: 'west', right: 'east', back: 'north', top: 'north', front: 'south', bottom: 'south' } as Record<string, string>)[low];
  if (side) { const wall = wallBySide(model, side); if (wall) return { p: wallMid(model, wall), wall }; }
  const op = /window|fönster/.test(low) ? model.openings.find((o) => o.kind === 'window') : /door|dörr/.test(low) ? model.openings.find((o) => o.kind === 'door') : undefined;
  if (op) {
    const wall = { spaceId: op.spaceId, index: op.wallIndex, along: op.offsetM };
    if (op.kind === 'door') {
      // Beside the door, never in front of it: shift along the wall past the opening.
      const sp = model.spaces.find((x) => x.id === op.spaceId)!;
      const L = dist(...wallSegment(sp, op.wallIndex));
      const along = op.offsetM + op.widthM / 2 + 0.6 < L - 0.3 ? op.offsetM + op.widthM / 2 + 0.6 : Math.max(0.3, op.offsetM - op.widthM / 2 - 0.6);
      return { p: wallMid(model, { ...wall, along }), wall: { ...wall, along } };
    }
    return { p: wallMid(model, wall), wall };
  }
  if (/^(centre|center|middle|room centre|room-centre)$/.test(low) && model.spaces[0]) return { p: centroid(model.spaces[0].polygon) };
  const item = resolveItem(s, ctx, model);
  if (item && !/^(it|this|that)$/i.test(s)) return { p: { x: item.x, y: item.y }, item };
  return null;
}

/** Item centre and rotation for `item` at `place`. */
export function poseAt(model: SpaceModel, item: FurnitureItem, place: Place, others: FurnitureItem[] = model.furniture.filter((f) => f.id !== item.id)) {
  let pose = { x: place.p.x, y: place.p.y, rotation: item.rotation };
  const space = model.spaces.find((s) => pointInPolygon(place.p, s.polygon)) ?? model.spaces[0];
  const roomC = space ? centroid(space.polygon) : place.p;
  if (place.wall) {
    const s = model.spaces.find((x) => x.id === place.wall!.spaceId)!;
    const n = wallInwardNormal(s, place.wall.index);
    const c = add(wallMid(model, place.wall), mul(n, item.d / 2 + 0.02));
    pose = { x: c.x, y: c.y, rotation: rotationFacing(n) };
    pose = snapToWall(model, { ...item, ...pose }) ?? pose;
  } else if (place.mark) {
    const g = markGeometry(place.mark);
    if (g?.straight || (g?.dir && g.lengthM > Math.max(item.w, item.d) * 0.6)) {
      // Lay the item along the stroke, front towards the room.
      const r0 = g!.angle;
      const front = (r: number) => rotate({ x: 0, y: 1 }, r);
      const towards = norm(sub(roomC, place.p));
      pose.rotation = front(r0).x * towards.x + front(r0).y * towards.y >= front(r0 + Math.PI).x * towards.x + front(r0 + Math.PI).y * towards.y ? r0 : r0 + Math.PI;
    }
    const snapped = snapToWall(model, { ...item, ...pose }, 0.35);
    if (snapped) pose = snapped;
  } else if (place.item) {
    // Next to the other item, on the side facing the room.
    const o = place.item;
    const away = norm(sub(roomC, { x: o.x, y: o.y }));
    const gap = (Math.max(o.w, o.d) + Math.max(item.w, item.d)) / 2 + 0.15;
    const dir = Math.hypot(away.x, away.y) > 0.01 ? away : { x: 1, y: 0 };
    pose = { x: o.x + dir.x * gap, y: o.y + dir.y * gap, rotation: item.rotation };
  }
  const placed = { ...item, ...pose };
  if (!place.mark) { const r = resolveOverlap(model, placed, others); if (r) { placed.x = r.x; placed.y = r.y; } }
  const c = clampInside(model, placed);
  return { x: c.x, y: c.y, rotation: pose.rotation };
}

// ---------- sketching ----------

const DRAW_MS: Partial<Record<SketchMark['kind'], number>> = { stroke: 650, arrow: 600, circle: 600, rect: 500, zone: 550, ghost: 450, label: 250 };

export function mark(kind: SketchMark['kind'], points: Vec2[], extra: Partial<AgentMark> = {}): AgentMark {
  return { id: uid('sk'), by: 'agent', kind, points, createdAt: Date.now(), drawMs: DRAW_MS[kind] ?? 400, ...extra };
}

const cm = (m: number) => Math.round(m * 100);
const dims = (f: { w: number; d: number }) => `${cm(f.w)} × ${cm(f.d)} cm`;
export const fmtLen = (m: number) => (m < 1 ? `${cm(m)} cm` : `${m.toFixed(2)} m`);

export function ghostOf(f: Pick<FurnitureItem, 'x' | 'y' | 'w' | 'd' | 'rotation'>, text: string | undefined, extra: Partial<AgentMark> = {}): AgentMark {
  return mark('ghost', [{ x: f.x, y: f.y }], { w: f.w, d: f.d, rotation: f.rotation, text, ...extra });
}

/** Turn the model's sketch specs into marks, staggered so they draw one after another. */
export function sketchMarks(specs: SketchSpec[], ctx: Ctx, startIndex = 0): AgentMark[] {
  const out: AgentMark[] = [];
  specs.forEach((s, i) => {
    let pts = s.points;
    if (!pts && s.at) { const pl = resolvePlace(s.at, ctx); if (pl) pts = [pl.p]; }
    if (!pts?.length) return;
    if ((s.kind === 'zone' || s.kind === 'rect') && pts.length === 2) {
      const [a, b] = pts; pts = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
    }
    if (s.kind === 'arrow' && pts.length < 2) return;
    if (s.kind === 'ghost' && !(s.w && s.d)) return;
    out.push(mark(s.kind, pts, {
      text: s.text, w: s.w, d: s.d, rotation: s.rotation !== undefined ? (s.rotation * Math.PI) / 180 : undefined,
      turnId: ctx.turnId, delayMs: (startIndex + i) * 140,
    }));
  });
  return out;
}

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((res) => {
  if (signal?.aborted) return res();
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
});

// ---------- execution ----------

export interface ExecResult {
  /** Short line for the transcript ("Moved Sofa 3-seat to the window"). */
  line?: string;
  /** Something worth saying aloud that the model could not have known in advance. */
  speak?: string;
  products?: StoreListing[];
  ok: boolean;
}

const PREVIEW_MS = 480;
const show = (ms: AgentMark[], ctx: Ctx) => useSketch.getState().addMany(ms.map((m) => ({ ...m, turnId: ctx.turnId })));
const shownFurniture = () => {
  const st = getState();
  return (st.activeCandidateId && st.candidates.find((c) => c.id === st.activeCandidateId)?.furniture) || st.model.furniture;
};

/** A furniture item for a generated object spec. */
export function itemFromSpec(spec: ObjectSpec): FurnitureItem {
  const sem = spec.semantics;
  const base = findByKeyword(sem?.category ?? spec.name);
  const color = spec.parts?.find((p) => p.color)?.color ?? base?.color ?? '#9aa3ad';
  const side = sem?.sideClearanceM ?? 0.1;
  return {
    id: uid('f'), catalogId: 'custom', name: spec.name, category: sem?.category ?? base?.category ?? 'custom', x: 0, y: 0, rotation: 0,
    w: spec.size.w, d: spec.size.d, h: spec.size.h,
    clearance: { front: sem?.frontClearanceM ?? 0.5, back: 0, left: side, right: side },
    unfoldedD: spec.openSize?.d, locked: false, owned: false, priceSek: base?.priceSek ?? 0, priceStatus: 'estimated',
    color, material: spec.parts?.[0]?.material, sourceKind: 'generated', custom: spec,
  };
}

/** Best guess at an item from words alone (used before generation finishes and offline). */
export function itemFromWords(text: string): FurnitureItem {
  const cmd = parseSpoken(text);
  const e = (cmd?.catalogId && catalogEntry(cmd.catalogId)) || findByKeyword(text);
  const item = e ? makeItem(e.id) : makeOwnItem(text.slice(0, 40) || 'Object', 'custom', 0.8, 0.6, 0.8, { x: 1, y: 1 });
  if (cmd?.w) item.w = cmd.w; if (cmd?.d) item.d = cmd.d; if (cmd?.h) item.h = cmd.h;
  const hex = cmd?.color && colorHex(cmd.color); if (hex) item.color = hex;
  if (!e) { item.owned = false; item.priceStatus = 'estimated'; item.sourceKind = 'generated'; }
  return item;
}

function placeNew(item: FurnitureItem, a: Action, ctx: Ctx): FurnitureItem {
  const model = getState().model;
  const where = resolvePlace(a.place ?? a.near ?? a.wall, ctx, model)
    ?? (a.x !== undefined && a.y !== undefined ? { p: { x: a.x, y: a.y } } : null);
  const pose = where ? poseAt(model, item, where) : findFreeSpot(model, item);
  return { ...item, ...pose };
}

async function addItem(item: FurnitureItem, label: string, ctx: Ctx): Promise<ExecResult> {
  show([ghostOf(item, `${label} · ${dims(item)}`)], ctx);
  await wait(PREVIEW_MS, ctx.signal);
  if (ctx.signal?.aborted) return { ok: false };
  getState().dispatch({ type: 'PLACE_OBJECT', item });
  getState().select({ kind: 'furniture', id: item.id });
  return { ok: true, line: `Added ${item.name} (${dims(item)})` };
}

function resolvePoint(spec: string | undefined, ctx: Ctx): Vec2 | null {
  if (!spec) return null;
  const pl = resolvePlace(spec, ctx);
  return pl ? pl.p : null;
}

function relationsFor(r: PipelineReport | undefined, id: string) {
  return r?.program?.relations?.filter((x) => x.subject === id || x.target === id) ?? [];
}

function currentReport(): PipelineReport | undefined {
  const st = getState();
  const id = st.activeCandidateId ?? st.candidates[0]?.id;
  const rs = loadedMod('reports')?.useReports.getState().reports;
  if (!rs) return undefined;
  return (id && rs[id]) || Object.values(rs)[0];
}

/** WHY answers, from the design trail when there is one. */
export function explain(a: Action, ctx: Ctx): string {
  const r = currentReport();
  const furniture = shownFurniture();
  const model = { ...getState().model, furniture };
  const item = a.id ? resolveItem(a.id, ctx, model) : undefined;
  const topic = (a.topic ?? '').toLowerCase();
  if (item) {
    const parts: string[] = [];
    if (/price|cost|expens|cheap/.test(topic)) {
      parts.push(item.listing
        ? `${item.name} is ${item.listing.price != null ? `${Math.round(item.listing.price)} ${item.listing.currency}` : 'unpriced'} at ${item.listing.store}, read ${new Date(item.listing.fetchedAt).toLocaleDateString()}.`
        : item.owned ? `You already own the ${item.name}, so it costs nothing.` : `${item.name} is about ${fmtSek(item.priceSek)}, a typical retail estimate rather than a quote.`);
    }
    const why = relationsFor(r, item.id).sort((x, y) => y.weight - x.weight).slice(0, 2).map((x) => x.reason);
    if (/face|direction|orient|turn/.test(topic)) { const f = relationsFor(r, item.id).find((x) => x.kind === 'faces'); if (f) why.unshift(f.reason); }
    parts.push(...why);
    const dec = r?.critique?.decisions?.find((d) => d.itemId === item.id);
    if (dec) parts.push(dec.reason);
    const bad = r?.verdicts?.find((v) => !v.pass && v.itemIds.includes(item.id));
    if (bad) parts.push(`One catch: ${bad.message}`);
    if (!parts.length) parts.push(`The ${item.name} is ${dims(item)} and sits where it has its ${cm(item.clearance.front)} cm of use space in front.`);
    return [...new Set(parts)].slice(0, 3).join(' ');
  }
  if (/price|cost|budget/.test(topic)) {
    const total = furniture.filter((f) => !f.owned).reduce((s, f) => s + (f.listing?.price ?? f.priceSek), 0);
    const top = [...furniture].sort((x, y) => y.priceSek - x.priceSek)[0];
    return `Everything new comes to about ${fmtSek(total)}${top ? `; the ${top.name} is the biggest part at ${fmtSek(top.priceSek)}` : ''}. Prices are estimates.`;
  }
  if (r) {
    const parts = [r.idea ?? r.critique?.summary ?? ''];
    parts.push(...(r.program?.relations ?? []).sort((x, y) => y.weight - x.weight).slice(0, 2).map((x) => x.reason));
    return parts.filter(Boolean).slice(0, 3).join(' ');
  }
  return 'There is no design trail yet. Ask me to design the room and I can explain each choice.';
}

function compare(a: Action, ctx: Ctx): string {
  const st = getState();
  const ca = a.a && (ctx.refs.candidates.get(a.a) ?? (st.candidates.some((c) => c.id === a.a) ? a.a : undefined));
  const cb = a.b && (ctx.refs.candidates.get(a.b) ?? (st.candidates.some((c) => c.id === a.b) ? a.b : undefined));
  if (ca && cb) {
    const [x, y] = [st.candidates.find((c) => c.id === ca)!, st.candidates.find((c) => c.id === cb)!];
    const line = (c: typeof x) => `"${c.name}" scores ${Math.round(c.metrics.score)}, costs ${fmtSek(c.metrics.costSek)} and leaves ${c.metrics.openAreaM2.toFixed(1)} m² open`;
    return `${line(x)}; ${line(y)}.`;
  }
  const fa = resolveItem(a.a, ctx), fb = resolveItem(a.b, ctx);
  if (fa && fb) {
    const line = (f: FurnitureItem) => `the ${f.name} is ${dims(f)} at ${f.owned ? 'no cost' : fmtSek(f.listing?.price ?? f.priceSek)}`;
    return `${line(fa)}; ${line(fb)}.`.replace(/^t/, 'T');
  }
  return 'I could not find both things to compare.';
}

interface Finding { message: string; ids: string[]; at?: Vec2 }

/** Read whatever shape the safety report has into plain findings. */
export function readFindings(rep: unknown): { summary?: string; findings: Finding[] } {
  const r = (rep && typeof rep === 'object' ? rep : {}) as Record<string, unknown>;
  const list = (['issues', 'findings', 'hazards', 'risks', 'items', 'checks'] as const).map((k) => r[k]).find(Array.isArray) as unknown[] | undefined;
  const findings: Finding[] = [];
  for (const raw of list ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const f = raw as Record<string, unknown>;
    if (f.pass === true || f.ok === true || f.result === 'pass') continue;
    const message = str(f.message) ?? str(f.text) ?? str(f.title) ?? str(f.label) ?? str(f.details) ?? str(f.description);
    if (!message) continue;
    const ids = Array.isArray(f.itemIds) ? f.itemIds.filter((x): x is string => typeof x === 'string')
      : Array.isArray(f.subjectIds) ? f.subjectIds.filter((x): x is string => typeof x === 'string')
      : typeof f.itemId === 'string' ? [f.itemId] : [];
    const at = f.at && typeof f.at === 'object' && typeof (f.at as Vec2).x === 'number' ? f.at as Vec2 : undefined;
    findings.push({ message, ids, at });
  }
  return { summary: str(r.summary), findings };
}

export async function execute(a: Action, ctx: Ctx): Promise<ExecResult> {
  const st = getState();
  const run = st.dispatch;
  switch (a.type) {
    case 'undo': st.undo(); return { ok: true, line: 'Undid the last change' };

    case 'set_view': {
      if (a.view === 'walk') {
        st.setMode('experience');
        try { const ui = await import('../../ui/uiStore'); ui.useUi.getState().setTab('experience', 'walk'); } catch { /* optional */ }
        return { ok: true, line: 'Walk-through' };
      }
      if (st.mode === 'experience' || st.mode === 'home') st.setMode('design');
      st.setView(a.view ?? '3d');
      return { ok: true, line: `${(a.view ?? '3d').toUpperCase()} view` };
    }

    case 'add_catalog': {
      const e = (a.catalogId && catalogEntry(a.catalogId)) || findByKeyword(a.catalogId ?? a.prompt ?? '');
      if (!e) return { ok: false, line: `No catalogue item "${a.catalogId}"`, speak: 'I could not find that in the catalogue.' };
      let item = makeItem(e.id);
      if (a.w) item.w = a.w; if (a.d) item.d = a.d; if (a.h) item.h = a.h;
      const hex = a.color && colorHex(a.color); if (hex) item.color = hex;
      item = placeNew(item, a, ctx);
      return addItem(item, e.name, ctx);
    }

    case 'create_object': {
      const prompt = a.prompt ?? ctx.utterance;
      let item = placeNew(itemFromWords(prompt), a, ctx);
      const ghost = ghostOf(item, `Making: ${prompt.slice(0, 32)}`);
      show([ghost], ctx);
      const forge = await loadMod('forge');
      if (forge) {
        try {
          ctx.status?.('Shaping the object…');
          const spec = await forge.generateObject(prompt, { signal: ctx.signal });
          if (ctx.signal?.aborted) return { ok: false };
          const made = itemFromSpec(spec);
          item = { ...made, ...poseAt(getState().model, { ...made, x: item.x, y: item.y, rotation: item.rotation }, { p: { x: item.x, y: item.y } }) };
        } catch { /* keep the catalogue stand-in */ }
      }
      useSketch.getState().remove(ghost.id);
      return addItem(item, item.name, ctx);
    }

    case 'add_wall': {
      const latest = latestMark([...ctx.refs.marks.values()], 'you');
      const g = latest ? markGeometry(latest) : null;
      let p1 = resolvePoint(a.from, ctx), p2 = resolvePoint(a.to, ctx);
      if ((!p1 || !p2) && g) { p1 = g.start; p2 = g.end; }
      if (!p1 || !p2 || dist(p1, p2) < 0.3) return { ok: false, line: 'Wall needs a start and an end', speak: 'Draw the line where the wall should go.' };
      const L = dist(p1, p2);
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const item = makeOwnItem('Partition wall', 'wall', L, 0.1, getState().model.ceilingM, mid);
      Object.assign(item, {
        rotation: Math.atan2(p2.y - p1.y, p2.x - p1.x), owned: false, priceSek: 0, priceStatus: 'estimated', sourceKind: 'manual',
        color: '#d4d4d8', clearance: { front: 0, back: 0, left: 0, right: 0 }, locked: true,
      });
      show([mark('stroke', [p1, p2], { text: fmtLen(L) }), mark('label', [mid], { text: `Wall ${fmtLen(L)}`, delayMs: 300 })], ctx);
      await wait(PREVIEW_MS, ctx.signal);
      if (ctx.signal?.aborted) return { ok: false };
      run({ type: 'PLACE_OBJECT', item });
      return { ok: true, line: `Partition wall ${fmtLen(L)}` };
    }

    case 'move': {
      const f = resolveItem(a.id, ctx);
      if (!f) return { ok: false, line: 'Nothing to move', speak: 'Which piece should I move?' };
      const model = getState().model;
      const where = resolvePlace(a.place ?? a.near ?? a.wall, ctx, model) ?? (a.x !== undefined && a.y !== undefined ? { p: { x: a.x, y: a.y } } : null);
      if (!where) return { ok: false, line: `No place for ${f.name}`, speak: `Where should the ${f.name.toLowerCase()} go? You can draw it.` };
      const pose = poseAt(model, f, where);
      show([mark('arrow', [{ x: f.x, y: f.y }, { x: pose.x, y: pose.y }]), ghostOf({ ...f, ...pose }, f.name, { delayMs: 250 })], ctx);
      await wait(PREVIEW_MS + 200, ctx.signal);
      if (ctx.signal?.aborted) return { ok: false };
      run({ type: 'UPDATE_OBJECT', id: f.id, patch: pose });
      return { ok: true, line: `Moved ${f.name}` };
    }

    case 'rotate': {
      const f = resolveItem(a.id, ctx);
      if (!f) return { ok: false, line: 'Nothing to rotate' };
      const rotation = f.rotation + ((a.angle ?? 90) * Math.PI) / 180;
      const c = clampInside(getState().model, { ...f, rotation });
      show([ghostOf({ ...f, ...c, rotation }, `${Math.round(a.angle ?? 90)}°`)], ctx);
      await wait(PREVIEW_MS, ctx.signal);
      if (ctx.signal?.aborted) return { ok: false };
      run({ type: 'UPDATE_OBJECT', id: f.id, patch: { rotation, x: c.x, y: c.y } });
      return { ok: true, line: `Turned ${f.name} ${Math.round(a.angle ?? 90)}°` };
    }

    case 'resize': {
      const f = resolveItem(a.id, ctx);
      if (!f) return { ok: false, line: 'Nothing to resize' };
      const patch: Partial<FurnitureItem> = {};
      if (a.w) patch.w = a.w; if (a.d) patch.d = a.d; if (a.h) patch.h = a.h;
      const hex = a.color && colorHex(a.color); if (hex) patch.color = hex;
      if (!Object.keys(patch).length) return { ok: false, line: 'No new size given', speak: `What size should the ${f.name.toLowerCase()} be?` };
      const next = { ...f, ...patch };
      const c = clampInside(getState().model, next);
      show([ghostOf({ ...next, ...c }, dims(next))], ctx);
      await wait(PREVIEW_MS, ctx.signal);
      if (ctx.signal?.aborted) return { ok: false };
      run({ type: 'UPDATE_OBJECT', id: f.id, patch: { ...patch, x: c.x, y: c.y } });
      return { ok: true, line: `${f.name} now ${dims(next)}` };
    }

    case 'remove': {
      const f = resolveItem(a.id, ctx);
      if (!f) return { ok: false, line: 'Nothing to remove' };
      show([ghostOf(f, 'Remove', { color: 'var(--bad, #f2555a)' })], ctx);
      await wait(PREVIEW_MS, ctx.signal);
      if (ctx.signal?.aborted) return { ok: false };
      run({ type: 'REMOVE_OBJECT', id: f.id });
      return { ok: true, line: `Removed ${f.name}` };
    }

    case 'measure': {
      const latest = latestMark([...ctx.refs.marks.values()], 'you');
      let p1 = resolvePoint(a.from, ctx), p2 = resolvePoint(a.to, ctx);
      let gap: number | null = null;
      const fa = a.from ? resolveItem(a.from, ctx) : undefined, fb = a.to ? resolveItem(a.to, ctx) : undefined;
      if (fa && fb && fa.id !== fb.id) {
        // Clear gap between the two footprints, measured between their nearest points.
        const A = itemCorners(fa), B = itemCorners(fb);
        let best = Infinity, pa = A[0], pb = B[0];
        const near = (P: Vec2[], Q: Vec2[], flip: boolean) => {
          for (const p of P) for (let i = 0; i < Q.length; i++) {
            const a0 = Q[i], b0 = Q[(i + 1) % Q.length];
            const ab = sub(b0, a0); const t = Math.max(0, Math.min(1, ((p.x - a0.x) * ab.x + (p.y - a0.y) * ab.y) / (ab.x * ab.x + ab.y * ab.y || 1)));
            const q = add(a0, mul(ab, t)); const dd = dist(p, q);
            if (dd < best) { best = dd; pa = flip ? q : p; pb = flip ? p : q; }
          }
        };
        near(A, B, false); near(B, A, true);
        p1 = pa; p2 = pb; gap = best;
      }
      if ((!p1 || !p2) && latest) { const g = markGeometry(latest); if (g) { p1 = g.start; p2 = g.end; } }
      if (!p1 || !p2) return { ok: false, line: 'Nothing to measure', speak: 'Draw a line and I will measure it.' };
      const L = gap ?? dist(p1, p2);
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      show([mark('arrow', [p1, p2]), mark('arrow', [p2, p1], { delayMs: 0 }), mark('label', [mid], { text: fmtLen(L), delayMs: 400 })], ctx);
      const say = gap !== null ? `There is ${fmtLen(L)} of clear space between them.` : `That is ${fmtLen(L)}.`;
      return { ok: true, line: `Measured ${fmtLen(L)}`, speak: say.replace(' m.', ' metres.').replace(' cm', ' centimetres') };
    }

    case 'explain': {
      const text = explain(a, ctx);
      const f = a.id ? resolveItem(a.id, ctx, { ...getState().model, furniture: shownFurniture() }) : undefined;
      if (f) show([mark('circle', circlePts({ x: f.x, y: f.y }, Math.max(f.w, f.d) / 2 + 0.2))], ctx);
      return { ok: true, line: text, speak: text };
    }

    case 'compare': {
      const text = compare(a, ctx);
      return { ok: true, line: text, speak: text };
    }

    case 'check_safety': {
      ctx.status?.('Checking safety…');
      const furniture = shownFurniture();
      const model = getState().model;
      const mod = await loadMod('safety');
      let summary: string | undefined; let findings: Finding[] = [];
      if (mod) { try { ({ summary, findings } = readFindings(await mod.assessSafety(model, furniture))); } catch { /* fall back */ } }
      if (!mod || (!summary && !findings.length)) {
        findings = validateLayout(model, furniture, st.requirements).filter((v) => v.result === 'fail').map((v) => ({ message: v.details, ids: v.subjectIds }));
      }
      const marks: AgentMark[] = [];
      findings.slice(0, 5).forEach((f, i) => {
        const it = furniture.find((x) => f.ids.includes(x.id));
        const at = f.at ?? (it ? { x: it.x, y: it.y } : undefined);
        if (at) marks.push(mark('circle', circlePts(at, it ? Math.max(it.w, it.d) / 2 + 0.15 : 0.4), { color: 'var(--warn, #e5a83b)', delayMs: i * 160, text: f.message.slice(0, 40) }));
      });
      show(marks, ctx);
      const n = findings.length;
      const text = summary ?? (n ? `${n} thing${n === 1 ? '' : 's'} to fix. First: ${findings[0].message}` : 'Nothing unsafe stands out.');
      return { ok: true, line: text, speak: text.split(/(?<=\.)\s/).slice(0, 2).join(' ') };
    }

    case 'find_products': {
      const q = a.query ?? a.prompt ?? ctx.utterance;
      const mod = await loadMod('stores');
      if (!mod) return { ok: false, line: 'Store search is not available', speak: 'Store search is not set up yet.' };
      ctx.status?.(`Searching stores for ${q}…`);
      try {
        const list = (await mod.searchProducts(q)).slice(0, 6);
        if (!list.length) return { ok: true, line: `No listings for "${q}"`, speak: `I found nothing for ${q}.` };
        const priced = list.filter((l) => l.price != null).sort((x, y) => x.price! - y.price!);
        const c = priced[0];
        const text = c ? `I found ${list.length}. The cheapest is ${c.title} at ${c.store} for ${Math.round(c.price!)} ${c.currency}.` : `I found ${list.length} listings.`;
        return { ok: true, line: `${list.length} listings for "${q}"`, speak: text, products: list };
      } catch {
        return { ok: false, line: 'Store search failed', speak: 'The store search did not answer.' };
      }
    }

    case 'design_room': {
      const brief = a.brief ?? ctx.utterance;
      const [intent, pipe, reports] = await Promise.all([loadMod('intent'), loadMod('pipeline'), loadMod('reports')]);
      if (!intent || !pipe) return { ok: false, line: 'Design engine not available', speak: 'The design engine is not loaded.' };
      ctx.status?.('Reading the brief…');
      const model = getState().model;
      const req = await intent.compileIntent(brief, model);
      if (ctx.signal?.aborted) return { ok: false };
      st.setRequirements(req);
      const res = await pipe.designRoom(model, req, {
        brief, signal: ctx.signal,
        onStage: (stages) => {
          reports?.useReports.getState().setStages?.(stages, true);
          const cur = [...stages].reverse().find((s) => s.status === 'running');
          if (cur) ctx.status?.(`${cur.label}…`);
        },
      });
      if (ctx.signal?.aborted) return { ok: false };
      reports?.useReports.getState().setReports(res.reports);
      reports?.useReports.getState().setStages?.([], false);
      getState().setCandidates(res.candidates, res.infeasibility);
      const best = res.candidates[0];
      if (!best) {
        const why = res.infeasibility?.reasons[0] ?? 'it does not fit';
        return { ok: false, line: `No layout: ${why}`, speak: `That does not fit: ${why}.` };
      }
      const rep = res.reports.find((r) => r.candidateId === best.id);
      // Zones as soft regions around the items that belong to them.
      const zm: AgentMark[] = [];
      (rep?.program?.zones ?? []).slice(0, 5).forEach((z, i) => {
        const its = best.furniture.filter((f) => z.itemIds.includes(f.id));
        if (!its.length) return;
        const pts = its.flatMap((f) => itemCorners(f));
        const minX = Math.min(...pts.map((p) => p.x)) - 0.25, maxX = Math.max(...pts.map((p) => p.x)) + 0.25;
        const minY = Math.min(...pts.map((p) => p.y)) - 0.25, maxY = Math.max(...pts.map((p) => p.y)) + 0.25;
        zm.push(mark('zone', [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }], { text: z.name, delayMs: i * 180 }));
      });
      show(zm, ctx);
      const n = res.candidates.length;
      const name = rep?.conceptName ?? best.name;
      const idea = rep?.idea ?? best.summary;
      return { ok: true, line: `${n} layout${n === 1 ? '' : 's'}; previewing "${name}"`, speak: `${n === 1 ? 'Here is one option' : `I have ${n} options`}. The best is ${name}: ${idea.replace(/\.$/, '')}.` };
    }

    case 'apply_layout': {
      const id = (a.candidateId && (ctx.refs.candidates.get(a.candidateId) ?? a.candidateId)) || st.activeCandidateId || st.candidates[0]?.id;
      const c = id ? st.candidates.find((x) => x.id === id) : undefined;
      if (!c) return { ok: false, line: 'No layout to apply', speak: 'There is no layout to apply yet.' };
      st.applyCandidate(c.id);
      return { ok: true, line: `Applied "${c.name}"` };
    }
  }
}

export function circlePts(c: Vec2, r: number, n = 28): Vec2[] {
  return Array.from({ length: n + 1 }, (_, i) => ({ x: c.x + Math.cos((i / n) * Math.PI * 2) * r, y: c.y + Math.sin((i / n) * Math.PI * 2) * r }));
}
