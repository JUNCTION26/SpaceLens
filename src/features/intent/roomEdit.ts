// Follow-up sentences that change a room that already exists. An offline rule layer answers the common
// phrases at once (English, Swedish, Finnish); everything else goes to the AI layer. Both end in the
// same validator, so no change leaves furniture outside the room, overlapping, or blocking a door.
import { gemini, hasGemini } from '../../core/gemini';
import { applyOp } from '../../core/ops';
import {
  area, centroid, convexOverlap, dist, doorSwingPolygon, itemCorners, openingSegment, pointInPolygon, polygonInside, wallSegment,
  wallInwardNormal, distPointPolygonEdges, bounds, rotate as rot2,
} from '../../core/geometry';
import type { FurnitureItem, Op, Space, SpaceModel, Vec2 } from '../../core/types';
import { CATALOG, catalogEntry, findByKeyword, makeItem, type CatalogEntry } from '../furniture/catalog';
import { clampInside, findFreeSpot, resolveOverlap, rotationFacing, wallCompass } from '../objects/placement';
import { isMounted } from '../layout/wallItems';
import { distPointRect } from '../referee/geom';
import { validateLayout } from '../referee/validate';

// ---- Result types ------------------------------------------------------------------------------

/** Which pieces the last sentences talked about, newest first. Pass the returned value back in with the next sentence. */
export interface RefMemory { last: string[] }
export const emptyMemory = (): RefMemory => ({ last: [] });

/** Machine-readable account of an edit: what moved, what was dropped, what was given up on the way. */
export interface EditReport {
  moved: Array<{ id: string; name: string; distM: number }>;
  removed: Array<{ id: string; name: string }>;
  added: Array<{ id: string; name: string }>;
  rotated: string[];
  compromises: string[];
  freeRect?: { cx: number; cy: number; w: number; d: number };
  freeAreaBefore?: number;
  freeAreaAfter?: number;
}
export interface FailedClause { clause: string; reason: string; nearest: string }

export interface RoomEditOk {
  ok: true; ops: Op[]; label: string; by: 'rules' | 'ai'; notes: string[]; undo?: boolean; noChange?: boolean;
  memory?: RefMemory; report?: EditReport; failed?: FailedClause[];
}
export interface RoomEditCannot { ok: false; cannot: true; reason: string; nearest: string; memory?: RefMemory; failed?: FailedClause[] }
export type RoomEdit = RoomEditOk | RoomEditCannot;

const cannot = (reason: string, nearest: string): RoomEditCannot => ({ ok: false, cannot: true, reason, nearest });

/** What a handler produces: the whole new furniture list plus a short label. */
interface Draft { furniture: FurnitureItem[]; label: string; notes: string[]; focus?: string[]; compromises?: string[]; extra?: Partial<EditReport> }
type Handler = (model: SpaceModel, clause: string, furniture: FurnitureItem[], mem?: RefMemory) => Draft | RoomEditCannot | null;

// ---- Small helpers -----------------------------------------------------------------------------

const clone = (f: FurnitureItem): FurnitureItem => ({ ...f, clearance: { ...f.clearance } });
const solidOf = (fs: FurnitureItem[]) => fs.filter((f) => f.category !== 'rug' && !isMounted(f));
const norm = (s: string) => s.toLowerCase().replace(/[“”"']/g, '').replace(/\s+/g, ' ').trim();
const ARTICLES = /^(?:the|my|our|a|an|one|that|this|den|det|en|ett|min|mitt|vår|vårt|se|tämä|tuo|minun)\s+/;
const stripArticle = (s: string) => { let t = s.trim(); for (let i = 0; i < 3 && ARTICLES.test(t); i++) t = t.replace(ARTICLES, ''); return t; };
const words3 = (s: string) => s.split(/\s+/).slice(0, 3).join(' ');
const NUM_WORDS: Record<string, number> = { one: 1, a: 1, an: 1, another: 1, two: 2, three: 3, four: 4, five: 5, six: 6, en: 1, ett: 1, två: 2, tre: 3, fyra: 4, yksi: 1, kaksi: 2, kolme: 3, neljä: 4 };

interface Noun { re: RegExp; cats: string[]; kw: string }
// Most specific first: the first noun that matches a phrase wins.
const NOUNS: Noun[] = [
  { re: /coffee ?table|soffbord|sohvapöytä|sohvapöydä/, cats: ['coffee-table'], kw: 'coffee table' },
  { re: /tv ?(unit|stand|bench)|tv-bänk|tv-taso|television/, cats: ['tv-unit'], kw: 'tv unit' },
  { re: /night ?stand|bedside|sängbord|yöpöytä|yöpöydä/, cats: ['nightstand'], kw: 'nightstand' },
  { re: /armchair|fåtölj|nojatuoli|lounge chair/, cats: ['armchair'], kw: 'armchair' },
  { re: /sofa ?bed|sleeper/, cats: ['sofa-bed'], kw: 'sofa bed' },
  { re: /sofa|couch|soffa|sohva/, cats: ['sofa', 'sofa-bed'], kw: 'sofa' },
  { re: /desk chair|office chair|kontorsstol|työtuoli/, cats: ['chair', 'office-chair'], kw: 'desk chair' },
  { re: /desk|skrivbord|työpöytä|työpöydä|kirjoituspöytä|kirjoituspöydä/, cats: ['desk'], kw: 'desk' },
  { re: /bunk/, cats: ['bunk-bed'], kw: 'bunk bed' },
  { re: /\bbeds?\b|säng|sänky|sängyn|vuode/, cats: ['bed', 'bunk-bed', 'crib'], kw: 'bed' },
  { re: /stool|pall|jakkara/, cats: ['stool'], kw: 'stool' },
  { re: /bench|bänk|penkki/, cats: ['bench'], kw: 'bench' },
  { re: /chair|stol|tuoli/, cats: ['chair', 'office-chair', 'stool'], kw: 'chair' },
  { re: /dining|table|bord|pöytä|pöydä/, cats: ['table', 'cafe-table'], kw: 'table' },
  { re: /plant|växt|planta|kasvi|kukka/, cats: ['plant'], kw: 'plant' },
  { re: /lamp|light|lampa|lamppu|valaisin/, cats: ['lamp'], kw: 'lamp' },
  { re: /rug|carpet|matta|matto/, cats: ['rug'], kw: 'rug' },
  { re: /book ?shelf|book ?case|shelf|shelves|hylla|hyllor|hylly|kirjahylly/, cats: ['bookshelf'], kw: 'bookshelf' },
  { re: /wardrobe|closet|garderob|vaatekaappi/, cats: ['wardrobe'], kw: 'wardrobe' },
  { re: /dresser|drawers|byrå|lipasto|sideboard/, cats: ['dresser'], kw: 'dresser' },
  { re: /storage|cabinet|cupboard|skåp|kaappi|förvaring|säilytys/, cats: ['storage-cabinet', 'filing-cabinet', 'wardrobe', 'dresser', 'bookshelf'], kw: 'storage' },
  { re: /counter|disk\b|tiski/, cats: ['counter'], kw: 'counter' },
];

const nounOf = (phrase: string): Noun | undefined => { const p = norm(phrase); return NOUNS.find((n) => n.re.test(p)); };

/** The items a phrase such as "the sofa" or "chairs" points at. */
export function findItems(furniture: FurnitureItem[], phrase: string): FurnitureItem[] {
  const p = stripArticle(norm(phrase));
  if (!p) return [];
  const byId = furniture.filter((f) => f.id === p);
  if (byId.length) return byId;
  const n = nounOf(p);
  if (n) {
    const hits = furniture.filter((f) => n.cats.includes(f.category.toLowerCase()) || n.re.test(f.name.toLowerCase()) || n.re.test(f.catalogId.toLowerCase()));
    if (hits.length) return hits;
  }
  const w = p.replace(/s$/, '');
  return furniture.filter((f) => w.length > 2 && (f.name.toLowerCase().includes(w) || f.category.toLowerCase().includes(w) || f.catalogId.toLowerCase().startsWith(w)));
}

// ---- Geometry search ---------------------------------------------------------------------------

interface Ctx { model: SpaceModel; zones: Vec2[][]; approach: Vec2[][]; windowZones: Vec2[][] }
/** The strip in front of an opening, `depth` deep, on the room side. */
function openingStrip(s: Space, o: SpaceModel['openings'][number], depth: number): Vec2[] {
  const g = openingSegment(s, o);
  return [g.a, g.b, { x: g.b.x + g.inward.x * depth, y: g.b.y + g.inward.y * depth }, { x: g.a.x + g.inward.x * depth, y: g.a.y + g.inward.y * depth }];
}
const ctxOf = (model: SpaceModel): Ctx => {
  const withSpace = model.openings.flatMap((o) => { const s = model.spaces.find((x) => x.id === o.spaceId); return s ? [{ o, s }] : []; });
  return {
    model,
    zones: model.openings.flatMap((o) => { const s = model.spaces.find((x) => x.id === o.spaceId); const z = s && doorSwingPolygon(s, o); return z ? [z] : []; }),
    approach: withSpace.filter(({ o }) => o.kind === 'door').map(({ o, s }) => openingStrip(s, o, 0.8)),
    windowZones: withSpace.filter(({ o }) => o.kind === 'window').map(({ o, s }) => openingStrip(s, o, 0.4)),
  };
};
/** True when a piece taller than the lowest sill would stand in front of window glass. */
function coversGlass(ctx: Ctx, item: FurnitureItem, p: Pose): boolean {
  const sill = Math.min(...ctx.model.openings.filter((o) => o.kind === 'window').map((o) => o.sillM ?? 0.9));
  return item.h > sill - 0.02 && ctx.windowZones.some((z) => convexOverlap(itemCorners({ ...item, ...p }), z) > 0.005);
}
const spaceAt = (model: SpaceModel, p: Vec2): Space | undefined => model.spaces.find((s) => pointInPolygon(p, s.polygon));
const OVERLAP_TOL = 0.03;

/** True when the item stands fully inside a room, clear of door swings and of other solid items. */
export function fitsAt(ctx: Ctx, item: FurnitureItem, pose: { x: number; y: number; rotation: number }, others: FurnitureItem[]): boolean {
  const it = { ...item, ...pose };
  const sp = spaceAt(ctx.model, pose);
  if (!sp) return false;
  const body = itemCorners(it);
  if (!polygonInside(body, sp.polygon)) return false;
  if (item.category === 'rug' || isMounted(item)) return true;
  for (const z of ctx.zones) if (convexOverlap(body, z) > 0) return false;
  for (const o of solidOf(others)) if (o.id !== item.id && convexOverlap(body, itemCorners(o)) > OVERLAP_TOL) return false;
  return true;
}

type Pose = { x: number; y: number; rotation: number };

/** Poses with the item's back against wall i, at steps along it. */
function wallPoses(space: Space, i: number, item: FurnitureItem, step = 0.1): Pose[] {
  const [a, b] = wallSegment(space, i);
  const L = dist(a, b);
  const n = wallInwardNormal(space, i);
  const dir = { x: (b.x - a.x) / (L || 1), y: (b.y - a.y) / (L || 1) };
  const out: Pose[] = [];
  const m = item.w / 2 + 0.03;
  for (let t = m; t <= L - m + 1e-9; t += step) {
    out.push({ x: a.x + dir.x * t + n.x * (item.d / 2 + 0.01), y: a.y + dir.y * t + n.y * (item.d / 2 + 0.01), rotation: rotationFacing(n) });
  }
  if (L - 2 * m > 0) out.push({ x: a.x + dir.x * (L - m) + n.x * (item.d / 2 + 0.01), y: a.y + dir.y * (L - m) + n.y * (item.d / 2 + 0.01), rotation: rotationFacing(n) });
  return out;
}

function gridPoses(model: SpaceModel, item: FurnitureItem, step = 0.2): Pose[] {
  const out: Pose[] = [];
  for (const s of model.spaces) {
    const bb = bounds(s.polygon);
    for (let x = bb.minX; x <= bb.maxX; x += step) for (let y = bb.minY; y <= bb.maxY; y += step) {
      out.push({ x, y, rotation: item.rotation }, { x, y, rotation: item.rotation + Math.PI / 2 });
    }
  }
  return out;
}

interface SearchOpts { walls?: boolean; grid?: boolean; wallFilter?: (space: Space, i: number) => boolean; extra?: (p: Pose) => boolean }
function searchPose(ctx: Ctx, item: FurnitureItem, others: FurnitureItem[], cost: (p: Pose) => number, o: SearchOpts = {}): Pose | null {
  const cands: Pose[] = [];
  if (o.walls !== false) for (const s of ctx.model.spaces) for (let i = 0; i < s.polygon.length; i++) if (!o.wallFilter || o.wallFilter(s, i)) cands.push(...wallPoses(s, i, item));
  if (o.grid) cands.push(...gridPoses(ctx.model, item));
  const scored = cands.map((p) => ({ p, c: cost(p) })).sort((a, b) => a.c - b.c);
  for (const s of scored) if (Number.isFinite(s.c) && fitsAt(ctx, item, s.p, others) && (!o.extra || o.extra(s.p))) return s.p;
  return null;
}

const centreOf = (m: SpaceModel): Vec2 => centroid((m.spaces[0] ?? { polygon: [{ x: 0, y: 0 }] }).polygon);
const setPose = (list: FurnitureItem[], id: string, p: Partial<FurnitureItem>) => list.map((f) => (f.id === id ? { ...f, ...p } : f));
/** Unit vector out of the item's front (local +y). */
const forwardOf = (rotation: number): Vec2 => rot2({ x: 0, y: 1 }, rotation);
const rectOf = (f: Pick<FurnitureItem, 'x' | 'y' | 'w' | 'd' | 'rotation'>) => ({ cx: f.x, cy: f.y, hw: f.w / 2, hd: f.d / 2, rot: f.rotation });
/** Shortest edge-to-edge gap between two footprints (0 when they touch or overlap). */
function gapBetween(a: Pick<FurnitureItem, 'x' | 'y' | 'w' | 'd' | 'rotation'>, b: Pick<FurnitureItem, 'x' | 'y' | 'w' | 'd' | 'rotation'>): number {
  const ra = rectOf(a), rb = rectOf(b);
  return Math.min(...itemCorners(a).map((p) => distPointRect(p, rb)), ...itemCorners(b).map((p) => distPointRect(p, ra)));
}
/**
 * Cost of standing `item` at pose p "next to" ref: a small edge gap, beside it rather than in its front
 * clearance (a lamp goes at the arm of a sofa, not in the legroom), and little travel from where it was.
 */
function besideCost(item: FurnitureItem, ref: FurnitureItem, here: Vec2, gap = 0.08) {
  return (p: Pose) => {
    const g = gapBetween({ ...item, ...p }, ref);
    const f = forwardOf(ref.rotation);
    const ahead = (p.x - ref.x) * f.x + (p.y - ref.y) * f.y;
    const inFront = ahead > ref.d / 2 && ahead < ref.d / 2 + Math.max(0.5, ref.clearance.front) ? 1.5 : 0;
    return Math.abs(g - gap) * 3 + inFront + 0.03 * dist(p, here);
  };
}
// ---- Chairs belong to a desk or table ----------------------------------------------------------

const SEATS = new Set(['chair', 'office-chair']);
const ANCHORS = new Set(['desk', 'table', 'cafe-table']);
/** The desk or table a chair belongs to: the nearest one within 1 m of the chair's footprint. */
function anchorOf(list: FurnitureItem[], chair: FurnitureItem): FurnitureItem | null {
  let best: FurnitureItem | null = null, bg = 1;
  for (const a of list) {
    if (!ANCHORS.has(a.category)) continue;
    const g = gapBetween(chair, a);
    if (g <= bg) { bg = g; best = a; }
  }
  return best;
}
const chairsOf = (list: FurnitureItem[], anchor: FurnitureItem) => list.filter((f) => SEATS.has(f.category) && anchorOf(list, f)?.id === anchor.id);
/** Items a piece drags along when it moves: a desk or table takes its chairs. */
const followersOf = (list: FurnitureItem[], f: FurnitureItem) => (ANCHORS.has(f.category) ? chairsOf(list, f).filter((c) => !c.locked) : []);

/**
 * Where a chair sits at an anchor: its free front slot first, then the sides, facing the anchor and
 * tucked 0.35 to 0.45 m from its edge. Null when every slot is taken.
 */
function seatSlot(ctx: Ctx, list: FurnitureItem[], anchor: FurnitureItem, chair: FurnitureItem): Pose | null {
  const f = forwardOf(anchor.rotation);
  const r = { x: f.y, y: -f.x };
  const sides: Array<{ n: Vec2; half: number; lateral: number[] }> = [{ n: f, half: anchor.d / 2, lateral: [0, 0.15, -0.15] }];
  if (anchor.category !== 'desk') sides.push({ n: { x: -f.x, y: -f.y }, half: anchor.d / 2, lateral: [0, 0.15, -0.15] });
  sides.push({ n: r, half: anchor.w / 2, lateral: [0] }, { n: { x: -r.x, y: -r.y }, half: anchor.w / 2, lateral: [0] });
  for (const sd of sides) for (const off of [0.4, 0.35, 0.45]) for (const lat of sd.lateral) {
    const t = { x: -sd.n.y, y: sd.n.x };
    const pose = { x: anchor.x + sd.n.x * (sd.half + off) + t.x * lat, y: anchor.y + sd.n.y * (sd.half + off) + t.y * lat, rotation: rotationFacing({ x: -sd.n.x, y: -sd.n.y }) };
    if (fitsAt(ctx, chair, pose, list)) return pose;
  }
  return null;
}

/** A new chair: at the desk or table with the fewest seats, else with its back to a wall. */
function placeChair(model: SpaceModel, list: FurnitureItem[], chair: FurnitureItem, prefer?: FurnitureItem): Pose | null {
  const ctx = ctxOf(model);
  const anchors = prefer ? [prefer] : list.filter((a) => ANCHORS.has(a.category)).sort((a, b) => chairsOf(list, a).length - chairsOf(list, b).length);
  for (const a of anchors) { const p = seatSlot(ctx, list, a, chair); if (p) return p; }
  return searchPose(ctx, chair, list, (q) => dist(q, centreOf(model)));
}

/** Move an item and carry its chairs with it, keeping their pose relative to it. */
function moveWithChairs(model: SpaceModel, list: FurnitureItem[], id: string, pose: Pose): FurnitureItem[] {
  const old = list.find((f) => f.id === id)!;
  const chairs = followersOf(list, old);
  let out = setPose(list, id, pose);
  if (!chairs.length) return out;
  const dr = pose.rotation - old.rotation;
  const ctx = ctxOf(model);
  for (const c of chairs) {
    const rel = rot2({ x: c.x - old.x, y: c.y - old.y }, dr);
    const np = { x: pose.x + rel.x, y: pose.y + rel.y, rotation: c.rotation + dr };
    const others = out.filter((f) => f.id !== c.id);
    const moved = fitsAt(ctx, c, np, others) ? np : seatSlot(ctx, others, out.find((f) => f.id === id)!, c);
    out = setPose(out, c.id, moved ?? np);
  }
  return out;
}

/** Pronouns that point back at the last piece talked about. */
const PRONOUN = /^(?:it|that|this|that one|this one|them|those|den|det|dem|den där|se|sitä|sen|ne)$/;
const ORDINALS: Record<string, number> = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3, första: 0, andra: 1, tredje: 2, fjärde: 3, ensimmäinen: 0, toinen: 1, kolmas: 2, neljäs: 3 };
const ORD_RE = /\b(first|1st|second|2nd|third|3rd|fourth|4th|last|other|första|andra|tredje|fjärde|sista|ensimmäinen|toinen|kolmas|neljäs|viimeinen)\s+/;
/**
 * Items a subject phrase points at, honouring pronouns ("it" = the last piece talked about) and ordinals
 * ("the second chair" = the second chair in the plan's order). Returns [] when nothing matches.
 */
function resolveSubject(furniture: FurnitureItem[], phrase: string, mem?: RefMemory): FurnitureItem[] {
  const p = stripArticle(norm(phrase));
  if (PRONOUN.test(p)) {
    for (const id of mem?.last ?? []) { const f = furniture.find((x) => x.id === id); if (f) return [f]; }
    return [];
  }
  const o = ORD_RE.exec(p);
  if (o) {
    const hits = findItems(furniture, p.replace(ORD_RE, ''));
    const k = /last|sista|viimeinen/.test(o[1]) ? hits.length - 1 : /other/.test(o[1]) ? hits.findIndex((h) => !(mem?.last ?? []).includes(h.id)) : ORDINALS[o[1]];
    return k >= 0 && hits[k] ? [hits[k]] : [];
  }
  return findItems(furniture, p);
}

// ---- Handlers ----------------------------------------------------------------------------------

const REL = String.raw`(away from|further from|farther from|far from|bort från|längre från|långt från|kauemmas|kauas|poispäin|near|close to|next to|beside|towards|by|nära|bredvid|intill|lähelle|viereen|lähellä|vieressä|to|into|against|onto|on|at|in|till|mot|vid|i|på|kohti)`;
const MOVE_RE = new RegExp(String.raw`^(?:please |can you |could you )?(?:move|put|place|push|shift|slide|relocate|set|flytta|sätt|ställ|skjut|siirrä|laita|työnnä)\s+(.+?)\s+${REL}\s+(.+)$`);

type Target = { kind: 'window' | 'door' | 'corner' | 'centre' | 'wall' | 'item'; compass?: string; text: string };
function classifyTarget(raw: string): Target {
  const t = norm(raw);
  const compass = /\b(left|west|vänster|väst|vasen|länsi)\b/.test(t) ? 'west' : /\b(right|east|höger|öst|oikea|itä)\b/.test(t) ? 'east'
    : /\b(top|back|north|norr|pohjoi|taka)\b/.test(t) ? 'north' : /\b(bottom|front|south|söder|etel|etu)\b/.test(t) ? 'south' : undefined;
  if (/corner|hörn|nurkka/.test(t)) return { kind: 'corner', text: t, compass };
  if (/window|fönst|ikkuna/.test(t)) return { kind: 'window', text: t };
  if (/door|entrance|entré|dörr|ovi\b|sisäänkäynti/.test(t)) return { kind: 'door', text: t };
  if (/cent(re|er)|middle|mitten|keskel|keskus/.test(t)) return { kind: 'centre', text: t };
  if (/\bwall|vägg|seinä/.test(t)) return { kind: 'wall', text: t, compass };
  return { kind: 'item', text: t };
}

function openingPoints(model: SpaceModel, kind: 'window' | 'door'): Vec2[] {
  return model.openings.filter((o) => (kind === 'window' ? o.kind === 'window' : o.kind !== 'window')).flatMap((o) => {
    const s = model.spaces.find((x) => x.id === o.spaceId);
    return s ? [openingSegment(s, o).c] : [];
  });
}

// Finnish puts the relation after the target: "siirrä sohva ikkunan viereen".
const MOVE_FI = /^(?:siirrä|laita|työnnä)\s+(\S+)\s+(.+?)\s+(lähelle|viereen|luo|luokse|kauemmas|kauas)$/;
const moveHandler: Handler = (model, clause, furniture, mem) => {
  const fi = MOVE_FI.exec(clause);
  const m = MOVE_RE.exec(clause) ?? (fi ? [fi[0], fi[1], fi[3], fi[2]] as unknown as RegExpExecArray : null);
  if (!m) return null;
  const subjects = resolveSubject(furniture, m[1], mem);
  if (!subjects.length) return cannot(`No ${stripArticle(m[1])} in the room`, 'Add it first');
  const item = subjects[0];
  if (item.locked || isMounted(item)) return cannot(`${item.name} is fixed`, 'Unlock it first');
  const away = /away|further|farther|far from|bort|längre|långt|kauemmas|kauas|poispäin/.test(m[2]);
  const tgt = classifyTarget(m[3]);
  const ctx = ctxOf(model);
  const carried = new Set(followersOf(furniture, item).map((c) => c.id));
  const others = furniture.filter((f) => f.id !== item.id && !carried.has(f.id));
  const here = { x: item.x, y: item.y };
  let pose: Pose | null = null;
  let label = 'Moved';
  if (tgt.kind === 'window' || tgt.kind === 'door') {
    const pts = openingPoints(model, tgt.kind);
    if (!pts.length) return cannot(`No ${tgt.kind} in the room`, 'Move to a wall');
    const near = (p: Vec2) => Math.min(...pts.map((q) => dist(p, q)));
    // Anything taller than a sill would cover the glass; it goes beside the window instead of in front of it.
    const clearGlass = (p: Pose) => !coversGlass(ctx, item, p);
    pose = away ? searchPose(ctx, item, others, (p) => -near(p) + 0.2 * dist(p, here), { grid: true, extra: clearGlass })
      // A piece that belongs on a wall keeps its back to one; a loose piece may stand free.
      : searchPose(ctx, item, others, (p) => near(p) + 0.02 * dist(p, here), { grid: !WALL_BOUND.has(item.category), extra: clearGlass })
        ?? searchPose(ctx, item, others, (p) => near(p) + 0.02 * dist(p, here), { grid: true, extra: clearGlass });
    label = `${away ? 'Away from' : 'By'} ${tgt.kind}`;
  } else if (tgt.kind === 'corner') {
    const cs = model.spaces.flatMap((s) => s.polygon);
    const pick = (p: Vec2) => Math.min(...cs.map((q) => dist(p, q)));
    pose = searchPose(ctx, item, others, (p) => pick(p) * 3 + dist(p, here) * 0.1);
    label = 'To corner';
  } else if (tgt.kind === 'centre') {
    const c = centreOf(model);
    const exact = [item.rotation, item.rotation + Math.PI / 2].map((rotation) => ({ x: c.x, y: c.y, rotation })).find((p) => fitsAt(ctx, item, p, others));
    pose = exact ?? searchPose(ctx, item, others, (p) => dist(p, c), { grid: true, walls: false });
    label = 'To centre';
  } else if (tgt.kind === 'wall') {
    pose = searchPose(ctx, item, others, (p) => dist(p, here), {
      wallFilter: (s, i) => !tgt.compass || wallCompass(wallInwardNormal(s, i)) === tgt.compass,
    });
    label = tgt.compass ? `${tgt.compass} wall` : 'To wall';
  } else {
    const refs = findItems(others, tgt.text);
    if (!refs.length) return cannot(`No ${stripArticle(tgt.text)} in the room`, 'Move to a wall');
    const r = refs[0];
    pose = away
      ? searchPose(ctx, item, others, (p) => -dist(p, r) + 0.2 * dist(p, here), { grid: true })
      : searchPose(ctx, item, others, besideCost(item, r, here), { grid: true });
    label = `${away ? 'Away from' : 'Next to'} ${r.category}`;
  }
  if (!pose) return cannot('No free spot there', 'Try another wall');
  return { furniture: moveWithChairs(model, furniture, item.id, pose), label: words3(label), notes: [], focus: [item.id, ...carried] };
};

// "move it a bit left", "shift the sofa 30 cm right". Plan directions: left = -x, up/back = -y.
const NUDGE_RE = /^(?:move|shift|nudge|push|slide|flytta|skjut|siirrä|työnnä)\s+(.+?)\s+(?:(a (?:bit|little|touch)|slightly|lite|en bit|hieman|vähän)\s+)?(?:(\d+(?:[.,]\d+)?)\s*(cm|m)\s+)?(?:to the\s+|åt\s+)?(left|right|up|down|back|forward|north|south|east|west|vänster|höger|upp|ner|vasemmalle|oikealle|ylös|alas)$/;
const DIRS: Array<[RegExp, Vec2]> = [[/left|west|vänster|vasemm/, { x: -1, y: 0 }], [/right|east|höger|oikea/, { x: 1, y: 0 }], [/up|back|north|upp|ylös/, { x: 0, y: -1 }], [/down|forward|south|ner|alas/, { x: 0, y: 1 }]];
const nudgeHandler: Handler = (model, clause, furniture, mem) => {
  const m = NUDGE_RE.exec(clause);
  if (!m) return null;
  const subj = resolveSubject(furniture, m[1], mem);
  if (!subj.length) return cannot(PRONOUN.test(stripArticle(m[1])) ? 'Which piece?' : `No ${stripArticle(m[1])} in the room`, 'Name the piece');
  const item = subj[0];
  if (item.locked || isMounted(item)) return cannot(`${item.name} is fixed`, 'Unlock it first');
  const dir = DIRS.find(([re]) => re.test(m[5]))![1];
  const want = m[3] ? numOf(m[3]) / (m[4] === 'cm' ? 100 : 1) : m[2] ? 0.3 : 0.5;
  const ctx = ctxOf(model);
  const carried = new Set(followersOf(furniture, item).map((c) => c.id));
  const others = furniture.filter((f) => f.id !== item.id && !carried.has(f.id));
  // Go as far as asked; when a wall, a door swing or another piece is in the way, stop at the last free step.
  for (let s = want; s > 0.019; s -= 0.02) {
    const p = { x: item.x + dir.x * s, y: item.y + dir.y * s, rotation: item.rotation };
    if (fitsAt(ctx, item, p, others)) {
      const short = want - s > 0.03;
      return { furniture: moveWithChairs(model, furniture, item.id, p), label: words3(`Nudged ${item.category}`), notes: short ? [`Only ${Math.round(s * 100)} cm free`] : [], focus: [item.id], compromises: short ? [`moved ${Math.round(s * 100)} of ${Math.round(want * 100)} cm`] : [] };
    }
  }
  return cannot(`No free space ${m[5]} of the ${item.category}`, 'Try the other side');
};

// "turn the chair to face the desk", "face the sofa towards the window".
const FACE_RE = /^(?:turn|rotate|face|point|angle|vänd|vrid|rikta|käännä)\s+(.+?)\s+(?:so it faces|to face|to look at|facing|towards|toward|to|at|mot|emot|kohti|kohden)\s+(.+)$/;
const faceHandler: Handler = (model, clause, furniture, mem) => {
  const m = FACE_RE.exec(clause);
  if (!m) return null;
  const subj = resolveSubject(furniture, m[1], mem);
  if (!subj.length) return null;
  const item = subj[0];
  if (item.locked || isMounted(item)) return cannot(`${item.name} is fixed`, 'Unlock it first');
  const tgt = classifyTarget(m[2]);
  let at: Vec2 | undefined;
  if (tgt.kind === 'window' || tgt.kind === 'door') {
    const pts = openingPoints(model, tgt.kind);
    at = pts.sort((a, b) => dist(a, item) - dist(b, item))[0];
  } else if (tgt.kind === 'centre') at = centreOf(model);
  else at = findItems(furniture.filter((f) => f.id !== item.id), tgt.text)[0];
  if (!at) return tgt.kind === 'item' ? null : cannot(`No ${tgt.kind} to face`, 'Name a piece in the room');
  const rotation = rotationFacing({ x: at.x - item.x, y: at.y - item.y });
  const ctx = ctxOf(model);
  const others = furniture.filter((f) => f.id !== item.id);
  let pose: Pose | null = { x: item.x, y: item.y, rotation };
  // Turning changes the footprint; if the turned piece hits something, slide it the least distance that frees it.
  if (!fitsAt(ctx, item, pose, others)) {
    const best = gridPoses(model, item, 0.05).map((p) => ({ ...p, rotation: rotationFacing({ x: at!.x - p.x, y: at!.y - p.y }) }))
      .filter((p) => dist(p, item) < 0.8).sort((a, b) => dist(a, item) - dist(b, item)).find((p) => fitsAt(ctx, item, p, others));
    pose = best ?? null;
  }
  if (!pose) return cannot('No room to turn it', 'Move it first');
  return { furniture: setPose(furniture, item.id, pose), label: words3(`Faces ${tgt.kind === 'item' ? stripArticle(tgt.text) : tgt.kind}`), notes: [], focus: [item.id] };
};

// "swap the bed and the wardrobe": two pieces trade places. Each one takes the other's wall and facing, with
// its back where the other's back was, so a deep bed does not end up sticking out of the wardrobe's wall.
const EXCHANGE_RE = /^(?:swap|switch|exchange|trade|byt plats på|byt|vaihda)\s+(?:places of\s+|the places of\s+)?(.+?)\s+(?:and|with|och|ja)\s+(.+?)(?:\s+(?:around|round|places|plats|paikkaa))?$/;
const exchangeHandler: Handler = (model, clause, furniture, mem) => {
  const m = EXCHANGE_RE.exec(clause);
  if (!m) return null;
  // "with an armchair" names something new to buy, not a piece already in the room.
  if (/^(?:a|an|another|a new|some|en|ett|ny|nytt|uusi)\s/.test(norm(m[2]))) return null;
  const a = resolveSubject(furniture, m[1], mem)[0];
  const b = resolveSubject(furniture.filter((f) => f.id !== a?.id), m[2], mem)[0];
  if (!a || !b) return null; // not two pieces in the room: maybe "swap the sofa with an armchair"
  if (a.locked || b.locked || isMounted(a) || isMounted(b)) return cannot('One of them is fixed', 'Unlock it first');
  const ctx = ctxOf(model);
  const rest = furniture.filter((f) => f.id !== a.id && f.id !== b.id);
  const into = (x: FurnitureItem, y: FurnitureItem): Pose => {
    const f = forwardOf(y.rotation);
    const back = { x: y.x - f.x * (y.d / 2), y: y.y - f.y * (y.d / 2) };
    return { x: back.x + f.x * (x.d / 2), y: back.y + f.y * (x.d / 2), rotation: y.rotation };
  };
  let pa: Pose | null = into(a, b), pb: Pose | null = into(b, a);
  const compromises: string[] = [];
  const fine = (x: FurnitureItem, p: Pose, others: FurnitureItem[]) => fitsAt(ctx, x, p, others) && !coversGlass(ctx, x, p);
  const nearest = (x: FurnitureItem, t: Pose, others: FurnitureItem[]) => searchPose(ctx, x, others, (p) => dist(p, t) + Math.abs(p.rotation - t.rotation) * 0.1, { grid: true, extra: (p) => !coversGlass(ctx, x, p) });
  if (!fine(a, pa, rest)) { pa = nearest(a, pa, rest); compromises.push(`${a.category} shifted to fit`); }
  if (!pa) return cannot(`${a.name} does not fit there`, 'Move one first');
  const restA = [...rest, { ...a, ...pa }];
  if (!fine(b, pb, restA)) { pb = nearest(b, pb, restA); compromises.push(`${b.category} shifted to fit`); }
  if (!pb) return cannot(`${b.name} does not fit there`, 'Move one first');
  return { furniture: setPose(setPose(furniture, a.id, pa), b.id, pb), label: 'Swapped places', notes: compromises, focus: [a.id, b.id], compromises };
};

// "centre the rug": same as "move the rug to the centre".
const CENTRE_RE = /^(?:centre|center|centrera|keskitä)\s+(.+?)(?:\s+(?:in the room|i rummet|huoneeseen))?$/;
const centreHandler: Handler = (model, clause, furniture, mem) => {
  const m = CENTRE_RE.exec(clause);
  return m ? moveHandler(model, `move ${m[1]} to the centre`, furniture, mem) : null;
};

// "line up the shelves along the left wall": every matching piece goes against that wall, side by side,
// as one run centred on the longest free stretch, skipping door swings and windows they would cover.
const LINEUP_RE = /^(?:line up|align|arrange|put|place|move|set|ställ|rada upp|flytta|järjestä|laita)\s+(?:all\s+)?(.+?)\s+(?:up\s+)?(?:along|against|on|by|längs|mot|vid|pitkin|seinälle)\s+(.+?\b(?:wall|vägg|väggen|seinä|seinää)\b.*)$/;
const lineupHandler: Handler = (model, clause, furniture, mem) => {
  const m = LINEUP_RE.exec(clause);
  if (!m) return null;
  const items = resolveSubject(furniture, m[1], mem).filter((f) => !f.locked && !isMounted(f));
  const plural = /s$|ar$|or$|en$|\b(all|both)\b/.test(stripArticle(norm(m[1])));
  if (items.length < 2 || !plural) return null; // one piece: the plain move handler does it
  const tgt = classifyTarget(m[2]);
  const ctx = ctxOf(model);
  let list = furniture.filter((f) => !items.some((i) => i.id === f.id));
  const walls = model.spaces.flatMap((s) => s.polygon.map((_, i) => ({ s, i }))).filter(({ s, i }) => !tgt.compass || wallCompass(wallInwardNormal(s, i)) === tgt.compass);
  if (!walls.length) return cannot('No such wall', 'Left, right, top or bottom wall');
  const lenOf = (w: { s: Space; i: number }) => { const [p, q] = wallSegment(w.s, w.i); return dist(p, q); };
  const { s, i } = walls.sort((x, y) => lenOf(y) - lenOf(x))[0];
  const [a, b] = wallSegment(s, i);
  const L = dist(a, b), dir = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
  const total = items.reduce((t, f) => t + f.w, 0) + 0.02 * (items.length - 1);
  const along = (p: Vec2) => (p.x - a.x) * dir.x + (p.y - a.y) * dir.y;
  const ordered = [...items].sort((x, y) => along(x) - along(y));
  let cursor = L / 2 - total / 2;
  const placed: string[] = [], left: string[] = [];
  for (const f of ordered) {
    const goal = cursor + f.w / 2;
    const p = searchPose(ctx, f, list, (q) => Math.abs(along(q) - goal), { wallFilter: (ss, ii) => ss === s && ii === i, extra: (q) => !coversGlass(ctx, f, q) });
    if (!p) { list = [...list, f]; left.push(f.name); continue; }
    list = [...list, { ...f, ...p }]; placed.push(f.id);
    cursor = along(p) + f.w / 2 + 0.02;
  }
  if (!placed.length) return cannot('No free run on that wall', 'Try another wall');
  const order = new Map(furniture.map((f, k) => [f.id, k]));
  list.sort((x, y) => (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0));
  return { furniture: list, label: words3(`Lined up ${placed.length}`), notes: left.length ? [`${left.length} did not fit`] : [], focus: placed, compromises: left.map((n) => `${n} stayed put: no room on that wall`) };
};

const MOD = { smaller: /smaller|small|mindre|pienempi|pienemm|compact/, bigger: /bigger|larger|big\b|större|isompi|suurempi|wider/, cheaper: /cheaper|cheap|billigare|halvempi|edullisempi|less expensive/ };
type Mod = keyof typeof MOD;
const SWAP_RE = /^(?:swap|replace|change|switch|exchange|byt|ersätt|vaihda|korvaa)\s+(.+?)\s+(?:for|with|to|into|mot|till|på|->|-ksi)\s+(.+)$/;
const MAKE_RE = /^make\s+(.+?)\s+(smaller|bigger|larger|cheaper|wider)$/;

function applyCatalog(f: FurnitureItem, e: CatalogEntry): FurnitureItem {
  return {
    ...f, catalogId: e.id, name: e.name, category: e.category, w: e.w, d: e.d, h: e.h, clearance: { ...e.clearance }, unfoldedD: e.unfoldedD,
    priceSek: f.owned ? f.priceSek : e.priceSek, color: e.color, material: e.material,
  };
}

/**
 * The next size or price step in the same family. "Bigger" means the main dimension grows and the other does
 * not shrink; "smaller" the reverse. Among those, the closest step wins, and a variant that changes what the
 * piece is (a standing desk for a sitting one, a desk pod for one desk) ranks behind a plain size step.
 */
function pickVariant(f: FurnitureItem, mod: Mod): CatalogEntry | null {
  const cur = catalogEntry(f.catalogId);
  const siblings = CATALOG.filter((c) => c.category === f.category && c.id !== f.catalogId);
  const a = f.w * f.d, price = cur?.priceSek ?? f.priceSek;
  const kind = (c: CatalogEntry) => Math.abs(c.h - f.h) * 4 + (cur && c.material !== cur.material ? 0.05 : 0)
    + (/pod|for \d|corner|l-shape|accessible|standing|kids/i.test(`${c.id} ${c.name}`) !== /pod|for \d|corner|l-shape|accessible|standing|kids/i.test(`${f.catalogId} ${f.name}`) ? 1 : 0);
  if (mod === 'cheaper') return siblings.filter((c) => c.priceSek < price).sort((x, y) => (kind(x) - kind(y)) || (y.priceSek - x.priceSek))[0] ?? null;
  const grows = (c: CatalogEntry) => c.w > f.w + 0.04 && c.d >= f.d - 0.04 && c.w * c.d > a + 0.01;
  const shrinks = (c: CatalogEntry) => (c.w < f.w - 0.04 && c.d <= f.d + 0.04 && c.w * c.d < a - 0.01) || (c.w <= f.w + 0.01 && c.d < f.d - 0.04 && c.w * c.d < a - 0.01);
  const pool = siblings.filter(mod === 'bigger' ? grows : shrinks);
  return pool.sort((x, y) => (kind(x) - kind(y)) || (Math.abs(x.w * x.d - a) - Math.abs(y.w * y.d - a)))[0] ?? null;
}

const swapHandler: Handler = (model, clause, furniture) => {
  const sw = SWAP_RE.exec(clause);
  const mk = MAKE_RE.exec(clause);
  if (!sw && !mk) return null;
  const subj = stripArticle((sw ?? mk)![1]);
  const items = findItems(furniture, subj);
  if (!items.length) return cannot(`No ${subj} in the room`, 'Add it first');
  const item = items[0];
  const rhs = stripArticle(norm((sw ? sw[2] : mk![2])));
  const mod = (Object.keys(MOD) as Mod[]).find((k) => MOD[k].test(rhs));
  let entry: CatalogEntry | null | undefined;
  if (mod) {
    entry = pickVariant(item, mod);
    if (!entry) return cannot(`Already the ${mod === 'cheaper' ? 'cheapest' : mod === 'smaller' ? 'smallest' : 'biggest'} ${item.category}`, mod === 'cheaper' ? 'Remove it' : 'Try another piece');
  } else {
    entry = findByKeyword(rhs) ?? (nounOf(rhs) ? findByKeyword(nounOf(rhs)!.kw) : undefined);
    if (!entry) return cannot(`No catalogue match for ${rhs}`, 'Name a piece, e.g. armchair');
  }
  if (item.locked) return cannot(`${item.name} is fixed`, 'Unlock it first');
  return { furniture: furniture.map((f) => (f.id === item.id ? applyCatalog(f, entry!) : f)), label: words3(mod ?? `Now ${entry.name}`), notes: [] };
};

const REMOVE_RE = /^(?:please |can you )?(?:remove|delete|get rid of|take away|take out|clear out|clear|drop|ta bort|släng|radera|poista|ota pois)\s+(.+)$/;
const removeHandler: Handler = (_m, clause, furniture, mem) => {
  const m = REMOVE_RE.exec(clause);
  if (!m) return null;
  let phrase = m[1];
  const one = stripArticle(norm(phrase));
  if (PRONOUN.test(one) || ORD_RE.test(one)) {
    const hit = resolveSubject(furniture, one, mem)[0];
    if (!hit) return cannot(PRONOUN.test(one) ? 'Which piece?' : `No ${one} in the room`, 'Name a piece in the room');
    if (hit.locked) return cannot(`${hit.name} is fixed`, 'Unlock it first');
    return { furniture: furniture.filter((f) => f.id !== hit.id), label: words3(`Removed ${hit.category}`), notes: [] };
  }
  const all = /^(all|every|alla|kaikki)\b/.test(phrase) || /\b(everything|allt)\b/.test(phrase);
  phrase = phrase.replace(/^(all|every|alla|kaikki)\s+(of\s+)?(the\s+)?/, '');
  if (/^(everything|allt|kaikki)/.test(phrase)) {
    const gone = furniture.filter((f) => !f.locked);
    if (!gone.length) return cannot('Nothing to remove', 'Add something');
    return { furniture: furniture.filter((f) => f.locked), label: 'Cleared', notes: [] };
  }
  const hits = findItems(furniture, phrase).filter((f) => !f.locked);
  if (!hits.length) return cannot(`No ${stripArticle(phrase)} to remove`, findItems(furniture, phrase).length ? 'Unlock it first' : 'Name a piece in the room');
  const plural = all || /s$/.test(stripArticle(norm(phrase))) && hits.length > 1;
  const gone = new Set((plural ? hits : [hits[hits.length - 1]]).map((f) => f.id));
  return { furniture: furniture.filter((f) => !gone.has(f.id)), label: words3(`Removed ${gone.size > 1 ? gone.size + ' ' : ''}${hits[0].category}`), notes: [] };
};

const ROTATE_RE = /^(?:rotate|turn|spin|flip|vrid|rotera|vänd|käännä|kierrä)\s+(.+?)(?:\s+(?:by\s+)?(\d{1,3})\s*(?:°|deg(?:rees)?|grader|astetta)?|\s+(around|backwards|the other way|runt|ympäri))?$/;
const rotateHandler: Handler = (model, clause, furniture) => {
  const m = ROTATE_RE.exec(clause);
  if (!m) return null;
  const items = findItems(furniture, m[1]);
  if (!items.length) return cannot(`No ${stripArticle(m[1])} in the room`, 'Name a piece in the room');
  const item = items[0];
  if (item.locked || isMounted(item)) return cannot(`${item.name} is fixed`, 'Unlock it first');
  const deg = m[3] ? 180 : m[2] ? Number(m[2]) : 90;
  const left = /\b(left|counter|vänster|vasen)\b/.test(clause);
  const rot = item.rotation + (left ? -1 : 1) * (deg * Math.PI) / 180;
  return { furniture: moveWithChairs(model, furniture, item.id, { x: item.x, y: item.y, rotation: rot }), label: words3(`Rotated ${item.category}`), notes: [] };
};

const ADD_RE = /^(?:please |can you )?(?:add|include|put in|place|get|buy|need|want|lägg till|lägg in|sätt in|lisää|hanki)\s+(?:in\s+)?(\d+|one|two|three|four|five|six|another|a|an|some|en|ett|två|tre|fyra|yksi|kaksi|kolme|neljä)?\s*(.+)$/;
const addHandler: Handler = (model, clause, furniture) => {
  const m = ADD_RE.exec(clause);
  if (!m) return null;
  const qty = m[1] ? (Number(m[1]) || NUM_WORDS[m[1]] || 1) : 1;
  let phrase = stripArticle(m[2].replace(/\b(to the room|in the room|here|please|till rummet|huoneeseen)\b/g, '').trim());
  // "a lamp by the armchair", "a plant in the corner": the part after the relation says where.
  const rel = /\s+(?:by|next to|beside|near|close to|at|in|under|in front of|against|on|bredvid|vid|nära|intill|i|under|mot|viereen|lähelle|vieressä)\s+(.+)$/.exec(phrase);
  const where = rel ? classifyTarget(rel[1]) : null;
  if (rel) phrase = phrase.slice(0, rel.index).trim();
  const e = findByKeyword(phrase) ?? findByKeyword(phrase.replace(/s$/, '')) ?? (nounOf(phrase) ? findByKeyword(nounOf(phrase)!.kw) : undefined);
  if (!e) return cannot(`No catalogue match for ${phrase}`, 'Name a piece, e.g. a plant');
  const ctx = ctxOf(model);
  let list = furniture;
  const added: FurnitureItem[] = [];
  const compromises: string[] = [];
  let ref: FurnitureItem | undefined;
  if (where?.kind === 'item') {
    ref = findItems(furniture, where.text)[0];
    if (!ref) compromises.push(`no ${stripArticle(where.text)} in the room, placed in a free spot`);
  }
  for (let i = 0; i < Math.min(qty, 10); i++) {
    const it = makeItem(e.id);
    let p: Pose | null = null;
    if (SEATS.has(e.category)) p = placeChair(model, list, it, ref && ANCHORS.has(ref.category) ? ref : undefined);
    else if (ref) p = searchPose(ctx, it, list, besideCost(it, ref, ref), { grid: true });
    else if (where && where.kind !== 'item') {
      const pts = where.kind === 'window' || where.kind === 'door' ? openingPoints(model, where.kind)
        : where.kind === 'corner' ? model.spaces.flatMap((s) => s.polygon) : [centreOf(model)];
      if (pts.length) p = searchPose(ctx, it, list, (q) => Math.min(...pts.map((t) => dist(q, t))), { grid: where.kind !== 'corner', wallFilter: where.compass ? (s, k) => wallCompass(wallInwardNormal(s, k)) === where.compass : undefined });
    }
    if (!p) {
      if (where && !compromises.length) compromises.push(`no free spot ${where.kind === 'item' ? 'by it' : 'there'}, placed elsewhere`);
      p = findFreeSpot(model, it, list);
    }
    if (!fitsAt(ctx, it, p, list)) break;
    const placed = { ...it, ...p };
    list = [...list, placed]; added.push(placed);
  }
  if (!added.length) return cannot('No room for it', 'Try a smaller piece');
  const notes = [...(added.length < qty ? [`Only ${added.length} fit`] : []), ...compromises.slice(0, 1)];
  return { furniture: list, label: words3(`Added ${added.length > 1 ? added.length + ' ' : ''}${e.category}`), notes, focus: added.map((a) => a.id), compromises };
};

// ---- Whole-room intents ------------------------------------------------------------------------

const hasCat = (fs: FurnitureItem[], ...cats: string[]) => fs.some((f) => cats.includes(f.category));
const WALL_BOUND = new Set(['bed', 'sofa', 'sofa-bed', 'desk', 'bookshelf', 'wardrobe', 'dresser', 'tv-unit', 'storage-cabinet', 'filing-cabinet', 'nightstand', 'counter', 'crib', 'bunk-bed']);
const DECOR_ORDER = ['plant', 'lamp', 'stool', 'bench', 'coffee-table', 'armchair'];

/** Floor pieces that belong on a wall, pushed to the nearest wall they fit against. */
function pushToWalls(model: SpaceModel, furniture: FurnitureItem[]): FurnitureItem[] {
  const ctx = ctxOf(model);
  let list = furniture;
  const movers = list.filter((f) => WALL_BOUND.has(f.category) && !f.locked && !isMounted(f)).sort((a, b) => b.w * b.d - a.w * a.d);
  for (const f of movers) {
    const cur = list.find((x) => x.id === f.id)!;
    const sp = spaceAt(model, cur);
    if (sp && distPointPolygonEdges({ x: cur.x, y: cur.y }, sp.polygon) < Math.max(cur.w, cur.d) / 2 + 0.25) continue;
    const carried = new Set(followersOf(list, cur).map((c) => c.id));
    const others = list.filter((x) => x.id !== f.id && !carried.has(x.id));
    const p = searchPose(ctx, cur, others, (q) => dist(q, cur));
    if (p) list = moveWithChairs(model, list, f.id, p);
  }
  return list;
}

const spaceHandler: Handler = (model, _c, furniture) => {
  let list = furniture;
  const removed: string[] = [];
  for (const cat of DECOR_ORDER) {
    if (removed.length >= 2) break;
    const hit = [...list].reverse().find((f) => f.category === cat && !f.locked && !isMounted(f));
    if (hit) { list = list.filter((f) => f.id !== hit.id); removed.push(hit.category); }
  }
  list = pushToWalls(model, list);
  return { furniture: list, label: 'More space', notes: removed.length ? [`Removed ${removed.join(', ')}`] : [] };
};

const WARM: Record<string, string> = { sofa: '#a8754f', 'sofa-bed': '#a8754f', armchair: '#c08a5a', rug: '#c9a98a', lamp: '#e8c87a', bed: '#b9906a' };
const cozyHandler: Handler = (model, _c, furniture) => {
  const ctx = ctxOf(model);
  let list = furniture.map((f) => (f.locked || f.custom || !WARM[f.category] ? f : { ...f, color: WARM[f.category] }));
  const added: string[] = [];
  const compromises: string[] = [];
  // A cosy room gathers around the seat: the rug lies in front of it, the lamp stands at its arm, the plant
  // softens an empty corner. Without a seat, the bed or the room centre is the anchor.
  const seat = list.find((f) => ['sofa', 'sofa-bed', 'armchair'].includes(f.category)) ?? list.find((f) => f.category === 'bed');
  const c = centreOf(model);
  for (const id of ['rug-160', 'floor-lamp', 'plant']) {
    const e = catalogEntry(id)!;
    if (hasCat(list, e.category)) continue;
    const it = makeItem(id);
    let p: Pose | null = null;
    if (e.category === 'rug') {
      const f = seat ? forwardOf(seat.rotation) : { x: 0, y: 0 };
      const goal = seat ? { x: seat.x + f.x * (seat.d / 2 + it.d / 2 - 0.15), y: seat.y + f.y * (seat.d / 2 + it.d / 2 - 0.15) } : c;
      const rotation = seat?.rotation ?? 0;
      const cands = [goal, { x: (goal.x + c.x) / 2, y: (goal.y + c.y) / 2 }, c].flatMap((q) => [{ ...q, rotation }, { ...q, rotation: rotation + Math.PI / 2 }]);
      p = cands.find((q) => fitsAt(ctx, it, q, list)) ?? null;
      if (p && seat && dist(p, goal) > 0.05) compromises.push('rug off-centre from the seat');
    } else if (e.category === 'lamp' && seat) {
      p = searchPose(ctx, it, list, besideCost(it, seat, seat), { grid: true });
    } else {
      const corners = model.spaces.flatMap((s) => s.polygon);
      p = searchPose(ctx, it, list, (q) => Math.min(...corners.map((k) => dist(q, k))));
    }
    if (!p) { p = findFreeSpot(model, it, list); compromises.push(`${e.category} placed where it fits`); }
    if (!fitsAt(ctx, it, p, list)) { compromises.push(`no room for a ${e.category}`); continue; }
    list = [...list, { ...it, ...p, color: WARM[e.category] ?? it.color }]; added.push(e.category);
  }
  return { furniture: list, label: 'Cozier', notes: added.length ? [`Added ${added.join(', ')}`] : ['Warm palette'], compromises };
};

const ESSENTIAL_DECOR = new Set(['plant', 'lamp', 'rug', 'bench', 'coffee-table', 'stool']);
const minimalHandler: Handler = (_m, _c, furniture) => {
  const gone = furniture.filter((f) => ESSENTIAL_DECOR.has(f.category) && !f.locked);
  if (!gone.length) return { furniture: furniture.map((f) => (f.locked || f.custom ? f : { ...f, color: '#efece6' })), label: 'Minimal', notes: ['Already bare, lightened colours'] };
  const ids = new Set(gone.map((f) => f.id));
  return { furniture: furniture.filter((f) => !ids.has(f.id)), label: 'Minimal', notes: [`Removed ${gone.length}`] };
};

const STORAGE_PICKS = ['bookshelf-low', 'storage-cabinet', 'bookshelf', 'shoe-cabinet', 'dresser'];
const storageHandler: Handler = (model, _c, furniture) => {
  const ctx = ctxOf(model);
  let list = furniture, n = 0;
  for (const id of STORAGE_PICKS) {
    if (n >= 2) break;
    const it = makeItem(id);
    const p = searchPose(ctx, it, list, (q) => { const c = centreOf(model); return -dist(q, c); });
    if (p) { list = [...list, { ...it, ...p }]; n++; }
  }
  if (!n) return cannot('No wall space left', 'Try more space first');
  return { furniture: list, label: 'More storage', notes: [`Added ${n}`] };
};

const twoHandler: Handler = (model, _c, furniture) => {
  const ctx = ctxOf(model);
  let list = furniture;
  const done: string[] = [];
  const bed = list.find((f) => f.category === 'bed' && f.w < 1.3 && !f.locked);
  if (bed) {
    for (const id of ['bed-double', 'bed-160']) {
      const e = catalogEntry(id)!;
      const grown = applyCatalog(bed, e);
      if (fitsAt(ctx, grown, grown, list)) { list = list.map((f) => (f.id === bed.id ? grown : f)); done.push('wider bed'); break; }
    }
  }
  const tryAdd = (id: string, label: string, wall = false) => {
    const it = makeItem(id);
    const p = wall ? searchPose(ctx, it, list, (q) => dist(q, centreOf(model))) : SEATS.has(it.category) ? placeChair(model, list, it) : findFreeSpot(model, it, list);
    if (p && fitsAt(ctx, it, p, list)) { list = [...list, { ...it, ...p }]; done.push(label); return true; }
    return false;
  };
  const desks = list.filter((f) => f.category === 'desk').length, seats = list.filter((f) => ['chair', 'office-chair'].includes(f.category)).length;
  if (desks) { if (desks < 2) tryAdd('desk-120', 'second desk', true); if (seats < 2) tryAdd('desk-chair', 'second chair'); }
  else if (seats) { if (seats < 2) tryAdd('chair', 'second chair'); }
  else if (hasCat(list, 'sofa')) { const s = list.find((f) => f.category === 'sofa' && f.w < 2 && !f.locked); const e = catalogEntry('sofa-3')!; if (s) { const g = applyCatalog(s, e); if (fitsAt(ctx, g, g, list)) { list = list.map((f) => (f.id === s.id ? g : f)); done.push('bigger sofa'); } } }
  if (hasCat(list, 'bed') && !hasCat(list, 'nightstand')) tryAdd('nightstand', 'nightstand', true);
  if (!done.length) return cannot('Nothing fits', 'Try more space first');
  return { furniture: list, label: 'For two', notes: done };
};

const kidHandler: Handler = (model, _c, furniture) => {
  const ctx = ctxOf(model);
  const unsafe = furniture.filter((f) => !f.locked && (f.category === 'coffee-table' || /glass|marble|steel and glass/.test(`${f.material ?? ''} ${f.name}`.toLowerCase()) || (f.h < 0.6 && /table/.test(f.category) && f.catalogId !== 'play-table')));
  const ids = new Set(unsafe.map((f) => f.id));
  let list = furniture.filter((f) => !ids.has(f.id));
  const notes: string[] = unsafe.length ? [`Removed ${unsafe.length} hard-edged`] : [];
  if (!hasCat(list, 'rug')) {
    const it = makeItem('rug-160'); const c = centreOf(model);
    if (fitsAt(ctx, it, { x: c.x, y: c.y, rotation: 0 }, list)) { list = [...list, { ...it, x: c.x, y: c.y, rotation: 0 }]; notes.push('Added soft rug'); }
  }
  if (!notes.length) return { furniture, label: 'Kid-safe', notes: ['Nothing sharp found'] };
  return { furniture: list, label: 'Kid-safe', notes };
};

/** Largest free circle (radius r) whose centre can also be reached from a door along a corridor of width 0.9 m. */
export function turningCircle(model: SpaceModel, furniture: FurnitureItem[], r = 0.75, corridor = 0.9): Vec2 | null {
  const solid = solidOf(furniture).map((f) => ({ cx: f.x, cy: f.y, hw: f.w / 2, hd: f.d / 2, rot: f.rotation }));
  const free = (p: Vec2, rad: number) => solid.every((s) => distPointRect(p, s) >= rad);
  const doors = model.openings.filter((o) => o.kind === 'door').flatMap((o) => { const s = model.spaces.find((x) => x.id === o.spaceId); if (!s) return []; const g = openingSegment(s, o); return [{ x: g.c.x + g.inward.x * 0.6, y: g.c.y + g.inward.y * 0.6 }]; });
  let best: Vec2 | null = null, bd = Infinity;
  for (const s of model.spaces) {
    const bb = bounds(s.polygon);
    for (let x = bb.minX; x <= bb.maxX; x += 0.1) for (let y = bb.minY; y <= bb.maxY; y += 0.1) {
      const p = { x, y };
      if (!pointInPolygon(p, s.polygon) || distPointPolygonEdges(p, s.polygon) < r || !free(p, r)) continue;
      let dd = 0;
      let ok = true;
      for (const d0 of doors.length ? doors : [p]) {
        const L = dist(d0, p);
        let n = Math.max(1, Math.ceil(L / 0.1));
        for (let i = 0; i <= n && ok; i++) { const q = { x: d0.x + ((p.x - d0.x) * i) / n, y: d0.y + ((p.y - d0.y) * i) / n }; if (!free(q, corridor / 2)) ok = false; }
        dd += L; n = 0;
        if (!ok) break;
      }
      if (ok && dd < bd) { bd = dd; best = p; }
    }
  }
  return best;
}

const wheelHandler: Handler = (model, _c, furniture) => {
  if (turningCircle(model, furniture)) return { furniture, label: 'Already clear', notes: ['1.5 m turning circle and 0.9 m route are free'] };
  let list = pushToWalls(model, furniture);
  const removed: string[] = [];
  const order = [...DECOR_ORDER, 'nightstand', 'chair', 'bookshelf', 'storage-cabinet', 'wardrobe'];
  for (const cat of order) {
    while (!turningCircle(model, list)) {
      const hit = [...list].reverse().find((f) => f.category === cat && !f.locked && !isMounted(f));
      if (!hit) break;
      list = list.filter((f) => f.id !== hit.id); removed.push(hit.category);
    }
    if (turningCircle(model, list)) break;
  }
  if (!turningCircle(model, list)) return cannot('Room too tight for a 1.5 m circle', 'Remove a large piece');
  return { furniture: list, label: 'Wheelchair ready', notes: removed.length ? [`Removed ${removed.join(', ')}`] : ['Items moved to walls'] };
};

const wfhHandler: Handler = (model, _c, furniture) => {
  const ctx = ctxOf(model);
  let list = furniture;
  const done: string[] = [];
  const win = openingPoints(model, 'window');
  const nearWin = (q: Vec2) => (win.length ? Math.min(...win.map((w) => dist(q, w))) : 0);
  if (!hasCat(list, 'desk')) {
    const it = makeItem('desk-140');
    const p = searchPose(ctx, it, list, (q) => nearWin(q), { grid: false });
    if (p) { list = [...list, { ...it, ...p }]; done.push('desk'); }
  }
  if (hasCat(list, 'desk') && !hasCat(list, 'chair', 'office-chair')) {
    const d = list.find((f) => f.category === 'desk')!;
    const it = makeItem('office-chair');
    const p = placeChair(model, list, it, d);
    if (p) { list = [...list, { ...it, ...p }]; done.push('chair'); }
  }
  if (!hasCat(list, 'bookshelf', 'storage-cabinet')) {
    const it = makeItem('bookshelf-low');
    const p = searchPose(ctx, it, list, (q) => -dist(q, centreOf(model)));
    if (p) { list = [...list, { ...it, ...p }]; done.push('shelf'); }
  }
  if (!done.length) return { furniture, label: 'Home office', notes: ['Already set up'] };
  return { furniture: list, label: 'Home office', notes: done };
};

const guestHandler: Handler = (model, _c, furniture) => {
  const ctx = ctxOf(model);
  let list = furniture;
  const done: string[] = [];
  if (!hasCat(list, 'bed', 'sofa-bed', 'bunk-bed')) {
    for (const id of ['sofa-bed', 'bed-single']) {
      const it = makeItem(id);
      const p = searchPose(ctx, it, list, (q) => -dist(q, centreOf(model)));
      if (p) { list = [...list, { ...it, ...p }]; done.push(it.category); break; }
    }
  }
  if (hasCat(list, 'bed', 'sofa-bed') && !hasCat(list, 'nightstand')) {
    const it = makeItem('nightstand'); const bed = list.find((f) => f.category === 'bed' || f.category === 'sofa-bed')!;
    const p = searchPose(ctx, it, list, (q) => dist(q, bed));
    if (p) { list = [...list, { ...it, ...p }]; done.push('nightstand'); }
  }
  if (!hasCat(list, 'lamp')) {
    const it = makeItem('floor-lamp'); const p = searchPose(ctx, it, list, (q) => dist(q, centreOf(model)) * -1);
    if (p) { list = [...list, { ...it, ...p }]; done.push('lamp'); }
  }
  if (!done.length) return { furniture, label: 'Guest ready', notes: ['Already set up'] };
  return { furniture: list, label: 'Guest ready', notes: done };
};

// ---- Colour and material -----------------------------------------------------------------------

const COLOURS: Array<{ re: RegExp; color: string; material?: string; wood?: boolean }> = [
  { re: /walnut|valnöt|saksanpähkinä/, color: '#5b3a29', material: 'walnut', wood: true },
  { re: /\boak\b|ek\b|tammi/, color: '#c9a46c', material: 'oak', wood: true },
  { re: /\bpine\b|furu|mänty/, color: '#d9b97f', material: 'pine', wood: true },
  { re: /birch|björk|koivu/, color: '#e0cfa8', material: 'birch', wood: true },
  { re: /white|vit\b|vitt\b|valkoinen|valkoiset/, color: '#f2f0ea' },
  { re: /black|svart|musta/, color: '#2b2b2b' },
  { re: /gr[ae]y|grå|harmaa/, color: '#8d9196' },
  { re: /blue|blå|sininen/, color: '#4f6f95' },
  { re: /green|grön|vihreä/, color: '#5d7f5a' },
  { re: /red|röd|punainen/, color: '#a8453d' },
  { re: /beige|sand|hiekka/, color: '#cdbba0' },
  { re: /brown|brun|ruskea/, color: '#7a5a40' },
  { re: /yellow|gul|keltainen/, color: '#d9b84a' },
  { re: /pink|rosa|vaaleanpunainen/, color: '#d99aa6' },
];

function shade(hex: string, k: number): string {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  const r = ch((n >> 16) & 255), g = ch((n >> 8) & 255), b = ch(n & 255);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const colourHandler: Handler = (_m, clause, furniture) => {
  if (!furniture.length) return null;
  const darker = /darker|mörkare|tummempi/.test(clause), lighter = /lighter|brighter|ljusare|vaaleampi/.test(clause);
  const col = COLOURS.find((c) => c.re.test(clause));
  if (!col && !darker && !lighter) return null;
  if (/\b(floor|golv|lattia|wall colou?r|walls|väggar|seinät)\b/.test(clause) && !/\b(floor|golv|lattia) (lamp|plant)\b/.test(clause)) return cannot('Floor and wall colours are not in the model', 'Recolour the furniture');
  const everything = /\b(all|every|everything|alla|allt|kaikki|kaikki)\b/.test(clause);
  const noun = nounOf(clause.replace(/\b(make|paint|colou?r|change)\b/g, ''));
  let targets = noun ? findItems(furniture, noun.kw) : [];
  if (!targets.length) targets = everything || !col?.wood ? furniture : furniture.filter((f) => /oak|pine|birch|beech|walnut|wood|veneer/.test(f.material ?? ''));
  if (!targets.length) targets = furniture;
  targets = targets.filter((f) => !f.locked && f.category !== 'rug' || (noun && f.category === 'rug' && !f.locked));
  if (!targets.length) return cannot('Nothing to recolour', 'Unlock a piece first');
  const ids = new Set(targets.map((f) => f.id));
  const next = furniture.map((f) => (ids.has(f.id)
    ? { ...f, color: col ? col.color : shade(f.color, darker ? 0.75 : 1.2), ...(col?.material ? { material: col.material } : {}) } : f));
  return { furniture: next, label: words3(col ? (col.material ?? clause.match(col.re)?.[0] ?? 'Recoloured') : darker ? 'Darker' : 'Lighter'), notes: [] };
};

// ---- Dispatch ----------------------------------------------------------------------------------

interface Intent { re: RegExp; run: Handler }
// "push everything to the walls": every wall-bound piece goes to its nearest wall, chairs with their desk.
const wallsHandler: Handler = (model, clause, furniture) => {
  if (!/^(?:please )?(?:push|move|put|place|shove|slide)\s+(?:everything|all (?:the |of the )?furniture|the furniture|all)\s+(?:to|against|onto|towards)\s+the\s+walls?$/.test(clause)) return null;
  return { furniture: pushToWalls(model, furniture), label: 'To walls', notes: [] };
};
const VERBS: Handler[] = [wallsHandler, lineupHandler, nudgeHandler, exchangeHandler, centreHandler, faceHandler, moveHandler, swapHandler, removeHandler, rotateHandler];
const INTENTS: Intent[] = [
  { re: /wheelchair|accessib|step.?free|rollator|rullstol|tillgänglig|pyörätuoli|esteetön/, run: wheelHandler },
  { re: /kid.?safe|child.?safe|baby.?proof|child.?proof|toddler|kid.?friendly|barnsäker|barnvänlig|lapsiturvallinen|lapsiystävällinen/, run: kidHandler },
  { re: /room for (two|2|a partner|my partner|a couple)|for two( people)?\b|two people|2 people|för två|två personer|kahdelle|kaksi henkilöä|share (it|the room)/, run: twoHandler },
  { re: /work(ing)? from home|home office|wfh|remote work|arbeta hemma|hemmakontor|etätyö|kotitoimisto/, run: wfhHandler },
  { re: /guest.?ready|ready for guests?|for guests|guest room|guests? (are )?(coming|staying)|gästrum|gäster|vieraita|vierashuone|vieraille/, run: guestHandler },
  { re: /more storage|extra storage|need storage|storage space|mer förvaring|lisää säilytystä|enemmän säilytystä/, run: storageHandler },
  { re: /minimal|simplif|bare\b|stripped|clean look|fewer things|minimalistisk|minimalistinen|yksinkertais/, run: minimalHandler },
  { re: /more (space|room|open)|open (it |the room )?up|spacious|roomier|less cluttered|declutter|free up|make (it|the room) (bigger|larger|more open)|mer plats|öppna upp|rymligare|mindre plottrigt|lisää tilaa|väljempi|avaa tila|tilavampi/, run: spaceHandler },
  { re: /coz[yi]|cosy|warm(er)?\b|homey|homely|mysig|viihtyisä|tunnelmallinen|lämmin/, run: cozyHandler },
];
const UNDO_RE = /^(?:please )?(?:undo|revert|go back|take (?:that|it) back|never mind|ångra|kumoa|peruuta)(?:\b.*)?$/;
const SPLIT_RE = /\s*(?:[.;!]+|\band then\b|\bthen\b)\s*|\s+(?:and|och|ja)\s+(?=(?:move|put|add|remove|delete|rotate|turn|swap|replace|make|flytta|ta bort|lägg|byt|vrid|siirrä|poista|lisää|käännä)\b)/;

/** Diff two furniture lists into ops. */
export function diffToOps(before: FurnitureItem[], after: FurnitureItem[]): Op[] {
  const ops: Op[] = [];
  const b = new Map(before.map((f) => [f.id, f])), a = new Map(after.map((f) => [f.id, f]));
  for (const f of before) if (!a.has(f.id)) ops.push({ type: 'REMOVE_OBJECT', id: f.id });
  for (const f of after) {
    const o = b.get(f.id);
    if (!o) { ops.push({ type: 'PLACE_OBJECT', item: f }); continue; }
    const patch: Record<string, unknown> = {};
    for (const k of Object.keys(f) as Array<keyof FurnitureItem>) if (JSON.stringify(f[k]) !== JSON.stringify(o[k])) patch[k] = f[k];
    if (Object.keys(patch).length) ops.push({ type: 'UPDATE_OBJECT', id: f.id, patch: patch as Partial<FurnitureItem> });
  }
  return ops;
}

const FRIENDLY = 'Try "move the sofa to the window", "more space" or "add a plant"';

// ---- Validation --------------------------------------------------------------------------------

export interface Validated { ops: Op[]; dropped: string[] }

/**
 * Check every furniture op against the room: ids exist, positions are inside a room, no overlap beyond
 * tolerance, no door swing blocked. An invalid pose is repaired (nudged, then moved to a free spot nearby);
 * if that fails the op is dropped.
 */
export function validateRoomOps(model: SpaceModel, ops: Op[]): Validated {
  const ctx = ctxOf(model);
  let work = model.furniture.map(clone);
  const out: Op[] = [];
  const dropped: string[] = [];
  const touched = new Set<string>();
  const finite = (...n: unknown[]) => n.every((v) => v === undefined || (typeof v === 'number' && Number.isFinite(v)));
  // Ops in one batch describe one end state: when two pieces trade places, the first is checked against where
  // the second is going, not where it still stands. Pieces the batch removes later do not block anything.
  const pendingPose = new Map<string, Partial<FurnitureItem>>();
  const pendingGone = new Set<string>();
  for (const op of ops) {
    if (op.type === 'UPDATE_OBJECT' && op.patch && ['x', 'y', 'rotation', 'w', 'd'].some((k) => k in op.patch)) pendingPose.set(op.id, op.patch);
    if (op.type === 'REMOVE_OBJECT') pendingGone.add(op.id);
  }
  const endState = (list: FurnitureItem[]) => list.filter((x) => !pendingGone.has(x.id)).map((x) => (pendingPose.has(x.id) ? { ...x, ...pendingPose.get(x.id) } : x));

  const repair = (item: FurnitureItem, others: FurnitureItem[]): FurnitureItem | null => {
    if (fitsAt(ctx, item, item, others)) return item;
    const nudged = resolveOverlap(model, item, others);
    let cand = nudged ? { ...item, ...nudged } : item;
    cand = { ...cand, ...clampInside(model, cand) };
    if (fitsAt(ctx, cand, cand, others)) return cand;
    const near = searchPose(ctx, item, others, (p) => dist(p, item), { grid: true });
    return near ? { ...item, ...near } : null;
  };

  for (const op of ops) {
    if (op.type === 'REMOVE_OBJECT') {
      const f = work.find((x) => x.id === op.id);
      if (!f) { dropped.push(`unknown id ${op.id}`); continue; }
      if (f.locked) { dropped.push(`${f.name} is fixed`); continue; }
      work = work.filter((x) => x.id !== op.id); out.push(op); touched.add(op.id); pendingGone.delete(op.id);
    } else if (op.type === 'UPDATE_OBJECT') {
      const f = work.find((x) => x.id === op.id);
      if (!f) { dropped.push(`unknown id ${op.id}`); continue; }
      const p = op.patch;
      if (!finite(p.x, p.y, p.rotation, p.w, p.d, p.h)) { dropped.push(`bad numbers for ${f.name}`); continue; }
      const geometry = ['x', 'y', 'rotation', 'w', 'd'].some((k) => k in p);
      if (geometry && (f.locked || isMounted(f))) { dropped.push(`${f.name} is fixed`); continue; }
      let merged: FurnitureItem = { ...f, ...p, clearance: { ...f.clearance, ...(p.clearance ?? {}) } };
      if (geometry) {
        pendingPose.delete(f.id);
        const fixed = repair(merged, endState(work.filter((x) => x.id !== f.id)));
        if (!fixed) { dropped.push(`${f.name} has no free spot there`); continue; }
        merged = fixed;
      }
      work = work.map((x) => (x.id === f.id ? merged : x));
      out.push({ type: 'UPDATE_OBJECT', id: f.id, patch: diffToOps([f], [merged]).flatMap((o) => (o.type === 'UPDATE_OBJECT' ? [o.patch] : []))[0] ?? p }); touched.add(f.id);
    } else if (op.type === 'PLACE_OBJECT') {
      const it = op.item;
      if (!it || work.some((x) => x.id === it.id) || !finite(it.x, it.y, it.rotation, it.w, it.d)) { dropped.push('bad new item'); continue; }
      const fixed = repair(it, endState(work));
      if (!fixed) { dropped.push(`${it.name} does not fit`); continue; }
      work = [...work, fixed]; out.push({ type: 'PLACE_OBJECT', item: fixed }); touched.add(fixed.id);
    } else {
      dropped.push(`op ${op.type} not allowed here`);
    }
  }

  // Layout checks: anything that newly breaks a door, window or boundary rule because of a touched item is reverted.
  const before = validateLayout(model, model.furniture);
  const after = validateLayout(model, work);
  const was = new Set(before.filter((r) => r.result === 'fail').map((r) => r.id));
  const blockers = new Set<string>();
  for (const r of after) {
    if (r.result !== 'fail' || was.has(r.id) || !/^(swing|approach|inside|window)/.test(r.id)) continue;
    for (const id of r.subjectIds) if (touched.has(id)) blockers.add(id);
  }
  if (blockers.size) {
    const kept = out.filter((o) => {
      const id = o.type === 'PLACE_OBJECT' ? o.item.id : 'id' in o ? o.id : '';
      const bad = o.type !== 'REMOVE_OBJECT' && blockers.has(id);
      if (bad) dropped.push(`kept clear of a door or window: ${id}`);
      return !bad;
    });
    return { ops: kept, dropped };
  }
  return { ops: out, dropped };
}

function finish(model: SpaceModel, ops: Op[], label: string, notes: string[], by: 'rules' | 'ai', text: string): RoomEdit {
  const v = validateRoomOps(model, ops);
  if (!v.ops.length) return cannot(v.dropped[0] ?? 'No valid change', nearestTo(text));
  return { ok: true, ops: v.ops, label: words3(label), by, notes: [...notes, ...v.dropped.slice(0, 2)] };
}

function nearestTo(text: string): string {
  const n = nounOf(text);
  if (n) return `Move the ${n.kw}`;
  return 'More space';
}


// ---- Room size by sentence ----------------------------------------------------------------------

const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const ROOM_KW = String.raw`(?:room|rummet|rum|huoneen|huone)`;
const DIMS_RE = new RegExp(String.raw`^(?:please |can you |could you )?(?:(?:make|set|resize|gör|ändra|tee|muuta)\s+)?(?:(?:the|my|it|det|den|rummet|huoneen)\s+)?(?:${ROOM_KW}\s+)?(?:(?:to|till|be|är|on|ksi)\s+)?${NUM}\s*(?:x|×|\*|by|gånger|på|kertaa)\s*${NUM}\s*(?:m|meter|metres|meters|metriä)?$`);
const CEIL_RE = new RegExp(String.raw`^(?:please |can you )?(?:(?:make|set|gör|ändra|tee|aseta)\s+)?(?:(?:the|my|taket|katto)\s+)?(?:ceiling|ceiling height|room height|takhöjd|takhöjden|taket|tak|kattokorkeus|katto)\s*(?:to|till|at|på|on|ksi)?\s*${NUM}\s*(?:m|meter|metres|meters|metriä)?$`);
const GROW_RE = new RegExp(String.raw`^(?:please |can you )?(?:(?:make|gör|tee)\s+)?(?:(?:the|my|rummet|huonetta)\s+)?(?:${ROOM_KW}\s+)?(wider|bredare|leveämpi|leveämmäksi|deeper|djupare|syvempi|syvemmäksi|longer|längre|pidempi|pidemmäksi|taller|higher|högre|korkeampi|korkeammaksi)\s*(?:by|med|with)?\s*${NUM}\s*(cm|m)?$`);
const SCALE_RE = new RegExp(String.raw`^(?:please |can you |could you )?(?:(?:make|gör|tee)\s+)?(?:(?:the|my|rummet|huonetta)\s+)?(?:(?:room|rummet|rum|huone|huonetta|it|det|den)\s+)?(bigger|larger|större|suurempi|suuremmaksi|isompi|isommaksi|smaller|mindre|pienempi|pienemmäksi)$`);

const numOf = (s: string) => parseFloat(s.replace(',', '.'));
const fmt = (n: number) => String(+n.toFixed(2));

/** Room-size sentences ("make the room 5 by 6", "ceiling 2.7", "wider by 1 m", "bigger"). Null when the text is not one. */
export function roomSizeEdit(model: SpaceModel, text: string): RoomEdit | null {
  const t = norm(text).replace(/[?!.]+$/, '');
  const space = model.spaces[0];
  if (!space || !t) return null;
  const bb = bounds(space.polygon);
  const done = (op: Op, label: string): RoomEdit => ({ ok: true, ops: [op], label, by: 'rules', notes: [] });
  const resize = (o: { widthM?: number; depthM?: number; heightM?: number }, label: string): RoomEdit => {
    const bad = [o.widthM, o.depthM, o.heightM].some((n) => n !== undefined && !(n >= 0.5 && n <= 100));
    if (bad) return cannot('Size out of range', 'Room 5 x 6 m');
    return done({ type: 'RESIZE_SPACE', spaceId: space.id, ...o }, label);
  };

  let m = t.match(DIMS_RE);
  if (m && (ROOM_KW_TEST.test(t) || /^(?:make|set|resize|gör|ändra|tee|muuta)\b/.test(t))) {
    const w = numOf(m[1]), d = numOf(m[2]);
    return resize({ widthM: w, depthM: d }, `${fmt(w)} × ${fmt(d)} m`);
  }
  m = t.match(CEIL_RE);
  if (m) { const h = numOf(m[1]); return resize({ heightM: h }, `Ceiling ${fmt(h)} m`); }
  m = t.match(GROW_RE);
  if (m) {
    const kind = m[1];
    const by = numOf(m[2]) / (m[3] === 'cm' ? 100 : 1);
    if (/^(?:wider|bredare|leve)/.test(kind)) return resize({ widthM: bb.w + by }, `Wider ${fmt(by)} m`);
    if (/^(?:deeper|djupare|syvem|longer|längre|pidem)/.test(kind)) return resize({ depthM: bb.h + by }, `Deeper ${fmt(by)} m`);
    return resize({ heightM: model.ceilingM + by }, `Ceiling +${fmt(by)} m`);
  }
  m = t.match(SCALE_RE);
  if (m) {
    const up = /^(?:bigger|larger|större|suurem|isom)/.test(m[1]);
    const k = up ? 1.2 : 0.85;
    return resize({ widthM: bb.w * k, depthM: bb.h * k }, up ? 'Bigger +20%' : 'Smaller -15%');
  }
  return null;
}
const ROOM_KW_TEST = /\b(?:room|rummet|rum|huoneen|huone)\b/;

// ---- Public: offline ---------------------------------------------------------------------------

/**
 * Try the rule layer. Returns null when no rule understands the sentence (the caller then asks the AI layer).
 * Several clauses ("add a plant and move the sofa to the window") apply in order.
 * `previous` is the furniture before the last change; pass it so "undo that" can restore it.
 */
export function refineRoomOffline(model: SpaceModel, text: string, opts: { previous?: FurnitureItem[]; memory?: RefMemory } = {}): RoomEdit | null {
  const t = norm(text).replace(/[?!]+$/, '');
  if (!t) return null;
  let mem: RefMemory = { last: [...(opts.memory?.last ?? [])] };
  if (UNDO_RE.test(t)) {
    if (opts.previous) return { ok: true, ops: [{ type: 'SET_FURNITURE', items: opts.previous, label: 'Undo' }], label: 'Undo', by: 'rules', notes: [], undo: true, memory: mem };
    return { ok: true, ops: [], label: 'Undo', by: 'rules', notes: [], undo: true, memory: mem };
  }
  const sized = roomSizeEdit(model, t);
  if (sized) return sized.ok ? { ...sized, memory: mem } : sized;
  const clauses = t.split(SPLIT_RE).map((c) => c.trim()).filter(Boolean);
  let cur = model;
  const allOps: Op[] = [];
  const labels: string[] = [];
  const notes: string[] = [];
  const compromises: string[] = [];
  const failed: FailedClause[] = [];
  let understood = 0, failure: RoomEditCannot | null = null;
  for (const clause of clauses) {
    let d: Draft | RoomEditCannot | null = null;
    for (const h of VERBS) { d = h(cur, clause, cur.furniture, mem); if (d) break; }
    if (!d) d = addIfVerb(cur, clause, mem);
    if (!d) for (const it of INTENTS) if (it.re.test(clause)) { d = it.run(cur, clause, cur.furniture, mem); break; }
    if (!d) d = colourHandler(cur, clause, cur.furniture, mem);
    if (!d) continue;
    understood++;
    if ('cannot' in d) { failure = d; failed.push({ clause, reason: d.reason, nearest: d.nearest }); continue; }
    const ops = diffToOps(cur.furniture, d.furniture);
    if (!ops.length) { notes.push(...d.notes); labels.push(d.label); continue; }
    const v = validateRoomOps(cur, ops);
    notes.push(...d.notes, ...v.dropped.slice(0, 2));
    compromises.push(...(d.compromises ?? []), ...v.dropped);
    if (!v.ops.length) { failure = cannot(v.dropped[0] ?? 'No valid change', nearestTo(clause)); failed.push({ clause, reason: failure.reason, nearest: failure.nearest }); continue; }
    for (const o of v.ops) cur = applyOp(cur, o);
    allOps.push(...v.ops); labels.push(d.label);
    const touched = d.focus ?? v.ops.flatMap((o) => (o.type === 'PLACE_OBJECT' ? [o.item.id] : o.type === 'UPDATE_OBJECT' ? [o.id] : []));
    if (touched.length) mem = { last: [...touched, ...mem.last.filter((id) => !touched.includes(id))].slice(0, 8) };
  }
  if (!understood) return null;
  if (!allOps.length) {
    if (failure) return { ...failure, memory: mem, failed };
    return { ok: true, ops: [], label: words3(labels[0] ?? 'No change'), by: 'rules', notes, noChange: true, memory: mem, failed: failed.length ? failed : undefined };
  }
  return {
    ok: true, ops: allOps, label: labels.length > 1 ? `${labels.length} changes` : words3(labels[0]), by: 'rules', notes,
    memory: mem, report: reportOf(model.furniture, cur.furniture, compromises), failed: failed.length ? failed : undefined,
  };
}

/** What changed between two furniture lists, for panels that show it. */
export function reportOf(before: FurnitureItem[], after: FurnitureItem[], compromises: string[] = []): EditReport {
  const b = new Map(before.map((f) => [f.id, f])), a = new Map(after.map((f) => [f.id, f]));
  const moved: EditReport['moved'] = [], rotated: string[] = [];
  for (const f of after) {
    const o = b.get(f.id);
    if (!o) continue;
    const d = Math.hypot(f.x - o.x, f.y - o.y);
    if (d > 0.005) moved.push({ id: f.id, name: f.name, distM: +d.toFixed(2) });
    if (Math.abs(f.rotation - o.rotation) > 1e-3) rotated.push(f.id);
  }
  return {
    moved, rotated, compromises,
    removed: before.filter((f) => !a.has(f.id)).map((f) => ({ id: f.id, name: f.name })),
    added: after.filter((f) => !b.has(f.id)).map((f) => ({ id: f.id, name: f.name })),
  };
}

function addIfVerb(model: SpaceModel, clause: string, mem?: RefMemory): Draft | RoomEditCannot | null {
  // "add more storage" and similar are whole-room intents, handled later.
  if (INTENTS.some((i) => i.re.test(clause))) return null;
  return addHandler(model, clause, model.furniture, mem);
}

// ---- Public: AI layer --------------------------------------------------------------------------

export interface RoomPatchOp { op: 'move' | 'remove' | 'add' | 'rotate' | 'recolor' | 'swap'; id?: string | null; catalogId?: string | null; x?: number | null; y?: number | null; rotationDeg?: number | null; color?: string | null }
export interface RoomPatch { ops: RoomPatchOp[]; label?: string; reply?: string }

export const ROOM_PATCH_SCHEMA = {
  type: 'OBJECT',
  properties: {
    ops: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          op: { type: 'STRING', enum: ['move', 'remove', 'add', 'rotate', 'recolor', 'swap'] },
          id: { type: 'STRING', nullable: true }, catalogId: { type: 'STRING', nullable: true },
          x: { type: 'NUMBER', nullable: true }, y: { type: 'NUMBER', nullable: true },
          rotationDeg: { type: 'NUMBER', nullable: true }, color: { type: 'STRING', nullable: true },
        },
        required: ['op'],
      },
    },
    label: { type: 'STRING' },
    reply: { type: 'STRING' },
  },
  required: ['ops', 'label'],
};

/** Room as text for the model: items with ids, sizes and positions, plus spots where a 0.8 m square is free. */
export function describeRoom(model: SpaceModel): string {
  const lines: string[] = [];
  for (const s of model.spaces) {
    const bb = bounds(s.polygon);
    lines.push(`Room ${s.id} "${s.name}": ${area(s.polygon).toFixed(1)} m2, x 0..${bb.maxX.toFixed(2)}, y 0..${bb.maxY.toFixed(2)} m; corners ${s.polygon.map((p) => `(${p.x.toFixed(2)},${p.y.toFixed(2)})`).join(' ')}`);
  }
  for (const o of model.openings) {
    const s = model.spaces.find((x) => x.id === o.spaceId);
    const c = s ? openingSegment(s, o).c : { x: 0, y: 0 };
    lines.push(`${o.kind} ${o.id} at (${c.x.toFixed(2)},${c.y.toFixed(2)}) width ${o.widthM.toFixed(2)} m`);
  }
  for (const f of model.furniture) lines.push(`item id=${f.id} ${f.category} "${f.name}" ${f.w.toFixed(2)}x${f.d.toFixed(2)} m at (${f.x.toFixed(2)},${f.y.toFixed(2)}) rotation ${Math.round((f.rotation * 180) / Math.PI)} deg${f.locked ? ' LOCKED' : ''}`);
  const ctx = ctxOf(model);
  const probe = makeItem('rug-160');
  const test = { ...probe, category: 'probe', w: 0.8, d: 0.8, clearance: { front: 0, back: 0, left: 0, right: 0 } };
  const spots: string[] = [];
  for (const s of model.spaces) {
    const bb = bounds(s.polygon);
    for (let x = bb.minX + 0.4; x <= bb.maxX; x += 0.8) for (let y = bb.minY + 0.4; y <= bb.maxY; y += 0.8) if (spots.length < 10 && fitsAt(ctx, test, { x, y, rotation: 0 }, model.furniture)) spots.push(`(${x.toFixed(1)},${y.toFixed(1)})`);
  }
  lines.push(`Free 0.8 m squares centred at: ${spots.join(' ') || 'none'}`);
  return lines.join('\n');
}

/** Turn a model patch into ops. Unknown ids and catalogue ids are dropped here; geometry is validated after. */
export function patchToOps(model: SpaceModel, patch: RoomPatch): { ops: Op[]; dropped: string[] } {
  const ops: Op[] = [];
  const dropped: string[] = [];
  const byId = new Map(model.furniture.map((f) => [f.id, f]));
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  for (const p of Array.isArray(patch?.ops) ? patch.ops : []) {
    if (!p || typeof p.op !== 'string') continue;
    const f = p.id ? byId.get(p.id) : undefined;
    if (p.op === 'add') {
      const e = p.catalogId ? catalogEntry(p.catalogId) : undefined;
      if (!e) { dropped.push(`unknown catalogue id ${p.catalogId}`); continue; }
      const it = makeItem(e.id);
      const x = num(p.x), y = num(p.y);
      const pose = x != null && y != null ? { x, y, rotation: ((num(p.rotationDeg) ?? 0) * Math.PI) / 180 } : findFreeSpot(model, it, model.furniture);
      ops.push({ type: 'PLACE_OBJECT', item: { ...it, ...pose } });
      continue;
    }
    if (!f) { dropped.push(`unknown id ${p.id}`); continue; }
    if (p.op === 'remove') ops.push({ type: 'REMOVE_OBJECT', id: f.id });
    else if (p.op === 'move') { const x = num(p.x), y = num(p.y); if (x == null || y == null) { dropped.push('move without position'); continue; } ops.push({ type: 'UPDATE_OBJECT', id: f.id, patch: { x, y, ...(num(p.rotationDeg) != null ? { rotation: (num(p.rotationDeg)! * Math.PI) / 180 } : {}) } }); }
    else if (p.op === 'rotate') { const d = num(p.rotationDeg); if (d == null) { dropped.push('rotate without angle'); continue; } ops.push({ type: 'UPDATE_OBJECT', id: f.id, patch: { rotation: f.rotation + (d * Math.PI) / 180 } }); }
    else if (p.op === 'recolor') { if (typeof p.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(p.color)) { dropped.push('bad colour'); continue; } ops.push({ type: 'UPDATE_OBJECT', id: f.id, patch: { color: p.color } }); }
    else if (p.op === 'swap') { const e = p.catalogId ? catalogEntry(p.catalogId) : undefined; if (!e) { dropped.push(`unknown catalogue id ${p.catalogId}`); continue; } const n = applyCatalog(f, e); ops.push({ type: 'UPDATE_OBJECT', id: f.id, patch: { catalogId: n.catalogId, name: n.name, category: n.category, w: n.w, d: n.d, h: n.h, clearance: n.clearance, unfoldedD: n.unfoldedD, priceSek: n.priceSek, color: n.color, material: n.material } }); }
    else dropped.push(`unknown op ${String(p.op)}`);
  }
  return { ops, dropped };
}

export async function refineRoomAI(model: SpaceModel, text: string): Promise<RoomEdit> {
  if (!hasGemini()) return cannot('Not understood offline', nearestTo(text));
  try {
    const catalog = CATALOG.map((c) => `${c.id}: ${c.name} ${Math.round(c.w * 100)}x${Math.round(c.d * 100)} cm`).join('\n');
    const prompt = `Room (metres, x right, y down):\n${describeRoom(model)}\n\nCatalogue (use only these ids):\n${catalog}\n\nRequest: """${text}"""\n\nReturn a patch of ops that makes the room satisfy the request. Use item ids exactly as listed. Keep every item inside the room, off doors and windows, and not overlapping others. label is 1 to 3 words.`;
    const patch = await gemini<RoomPatch>([{ text: prompt }], { json: true, schema: ROOM_PATCH_SCHEMA, system: 'You are a careful interior planner editing an existing room. Output only JSON matching the schema.', timeoutMs: 30000 });
    const conv = patchToOps(model, patch);
    const done = finish(model, conv.ops, String(patch.label ?? 'Changed'), conv.dropped.slice(0, 2), 'ai', text);
    return done;
  } catch (e) {
    return cannot(`AI unavailable (${(e as Error).message.slice(0, 40)})`, nearestTo(text));
  }
}

/** Any follow-up sentence: rules first, then the AI layer, and always an answer (a change or a typed "cannot"). */
export async function refineRoom(model: SpaceModel, text: string, opts: { previous?: FurnitureItem[]; memory?: RefMemory } = {}): Promise<RoomEdit> {
  const quick = refineRoomOffline(model, text, opts);
  if (quick) return quick;
  const ai = await refineRoomAI(model, text);
  if (!ai.ok && !hasGemini()) return cannot('Not understood', FRIENDLY.slice(0, 60));
  return ai;
}
