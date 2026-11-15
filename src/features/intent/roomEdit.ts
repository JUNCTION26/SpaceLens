// Follow-up sentences that change a room that already exists. An offline rule layer answers the common
// phrases at once (English, Swedish, Finnish); everything else goes to the AI layer. Both end in the
// same validator, so no change leaves furniture outside the room, overlapping, or blocking a door.
import { gemini, hasGemini } from '../../core/gemini';
import { applyOp } from '../../core/ops';
import {
  area, centroid, convexOverlap, dist, doorSwingPolygon, itemCorners, openingSegment, pointInPolygon, polygonInside, wallSegment,
  wallInwardNormal, distPointPolygonEdges, bounds,
} from '../../core/geometry';
import type { FurnitureItem, Op, Space, SpaceModel, Vec2 } from '../../core/types';
import { CATALOG, catalogEntry, findByKeyword, makeItem, type CatalogEntry } from '../furniture/catalog';
import { clampInside, findFreeSpot, resolveOverlap, rotationFacing, wallCompass } from '../objects/placement';
import { isMounted } from '../layout/wallItems';
import { distPointRect } from '../referee/geom';
import { validateLayout } from '../referee/validate';

// ---- Result types ------------------------------------------------------------------------------

export interface RoomEditOk { ok: true; ops: Op[]; label: string; by: 'rules' | 'ai'; notes: string[]; undo?: boolean; noChange?: boolean }
export interface RoomEditCannot { ok: false; cannot: true; reason: string; nearest: string }
export type RoomEdit = RoomEditOk | RoomEditCannot;

const cannot = (reason: string, nearest: string): RoomEditCannot => ({ ok: false, cannot: true, reason, nearest });

/** What a handler produces: the whole new furniture list plus a short label. */
interface Draft { furniture: FurnitureItem[]; label: string; notes: string[] }
type Handler = (model: SpaceModel, clause: string, furniture: FurnitureItem[]) => Draft | RoomEditCannot | null;

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
  { re: /coffee ?table|soffbord|sohvapöytä/, cats: ['coffee-table'], kw: 'coffee table' },
  { re: /tv ?(unit|stand|bench)|tv-bänk|tv-taso|television/, cats: ['tv-unit'], kw: 'tv unit' },
  { re: /night ?stand|bedside|sängbord|yöpöytä/, cats: ['nightstand'], kw: 'nightstand' },
  { re: /armchair|fåtölj|nojatuoli|lounge chair/, cats: ['armchair'], kw: 'armchair' },
  { re: /sofa ?bed|sleeper/, cats: ['sofa-bed'], kw: 'sofa bed' },
  { re: /sofa|couch|soffa|sohva/, cats: ['sofa', 'sofa-bed'], kw: 'sofa' },
  { re: /desk chair|office chair|kontorsstol|työtuoli/, cats: ['chair', 'office-chair'], kw: 'desk chair' },
  { re: /desk|skrivbord|työpöytä|kirjoituspöytä/, cats: ['desk'], kw: 'desk' },
  { re: /bunk/, cats: ['bunk-bed'], kw: 'bunk bed' },
  { re: /\bbeds?\b|säng|sänky|sängyn/, cats: ['bed', 'bunk-bed', 'crib'], kw: 'bed' },
  { re: /stool|pall|jakkara/, cats: ['stool'], kw: 'stool' },
  { re: /bench|bänk|penkki/, cats: ['bench'], kw: 'bench' },
  { re: /chair|stol|tuoli/, cats: ['chair', 'office-chair', 'stool'], kw: 'chair' },
  { re: /dining|table|bord|pöytä/, cats: ['table', 'cafe-table'], kw: 'table' },
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

interface Ctx { model: SpaceModel; zones: Vec2[][] }
const ctxOf = (model: SpaceModel): Ctx => ({
  model,
  zones: model.openings.flatMap((o) => { const s = model.spaces.find((x) => x.id === o.spaceId); const z = s && doorSwingPolygon(s, o); return z ? [z] : []; }),
});
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

interface SearchOpts { walls?: boolean; grid?: boolean; wallFilter?: (space: Space, i: number) => boolean }
function searchPose(ctx: Ctx, item: FurnitureItem, others: FurnitureItem[], cost: (p: Pose) => number, o: SearchOpts = {}): Pose | null {
  const cands: Pose[] = [];
  if (o.walls !== false) for (const s of ctx.model.spaces) for (let i = 0; i < s.polygon.length; i++) if (!o.wallFilter || o.wallFilter(s, i)) cands.push(...wallPoses(s, i, item));
  if (o.grid) cands.push(...gridPoses(ctx.model, item));
  let best: Pose | null = null, bc = Infinity;
  for (const p of cands) {
    const c = cost(p);
    if (c < bc && fitsAt(ctx, item, p, others)) { best = p; bc = c; }
  }
  return best;
}

const centreOf = (m: SpaceModel): Vec2 => centroid((m.spaces[0] ?? { polygon: [{ x: 0, y: 0 }] }).polygon);
const setPose = (list: FurnitureItem[], id: string, p: Partial<FurnitureItem>) => list.map((f) => (f.id === id ? { ...f, ...p } : f));

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
const moveHandler: Handler = (model, clause, furniture) => {
  const fi = MOVE_FI.exec(clause);
  const m = MOVE_RE.exec(clause) ?? (fi ? [fi[0], fi[1], fi[3], fi[2]] as unknown as RegExpExecArray : null);
  if (!m) return null;
  const subjects = findItems(furniture, m[1]);
  if (!subjects.length) return cannot(`No ${stripArticle(m[1])} in the room`, 'Add it first');
  const item = subjects[0];
  if (item.locked || isMounted(item)) return cannot(`${item.name} is fixed`, 'Unlock it first');
  const away = /away|further|farther|far from|bort|längre|långt|kauemmas|kauas|poispäin/.test(m[2]);
  const tgt = classifyTarget(m[3]);
  const ctx = ctxOf(model);
  const others = furniture.filter((f) => f.id !== item.id);
  const here = { x: item.x, y: item.y };
  let pose: Pose | null = null;
  let label = 'Moved';
  if (tgt.kind === 'window' || tgt.kind === 'door') {
    const pts = openingPoints(model, tgt.kind);
    if (!pts.length) return cannot(`No ${tgt.kind} in the room`, 'Move to a wall');
    const near = (p: Vec2) => Math.min(...pts.map((q) => dist(p, q)));
    pose = away ? searchPose(ctx, item, others, (p) => -near(p) + 0.2 * dist(p, here), { grid: true }) : searchPose(ctx, item, others, (p) => near(p), { grid: true });
    label = `${away ? 'Away from' : 'By'} ${tgt.kind}`;
  } else if (tgt.kind === 'corner') {
    const cs = model.spaces.flatMap((s) => s.polygon);
    const pick = (p: Vec2) => Math.min(...cs.map((q) => dist(p, q)));
    pose = searchPose(ctx, item, others, (p) => pick(p) * 3 + dist(p, here) * 0.1);
    label = 'To corner';
  } else if (tgt.kind === 'centre') {
    const c = centreOf(model);
    pose = searchPose(ctx, item, others, (p) => dist(p, c), { grid: true, walls: false });
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
    const want = r.w / 2 + item.w / 2 + 0.25;
    pose = away
      ? searchPose(ctx, item, others, (p) => -dist(p, r) + 0.2 * dist(p, here), { grid: true })
      : searchPose(ctx, item, others, (p) => Math.abs(dist(p, r) - want) + 0.05 * dist(p, here), { grid: true });
    label = `${away ? 'Away from' : 'Next to'} ${r.category}`;
  }
  if (!pose) return cannot('No free spot there', 'Try another wall');
  return { furniture: setPose(furniture, item.id, pose), label: words3(label), notes: [] };
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

function pickVariant(f: FurnitureItem, mod: Mod): CatalogEntry | null {
  const cur = catalogEntry(f.catalogId);
  const siblings = CATALOG.filter((c) => c.category === f.category && c.id !== f.catalogId);
  const a = f.w * f.d, price = cur?.priceSek ?? f.priceSek;
  const pool = mod === 'smaller' ? siblings.filter((c) => c.w * c.d < a - 0.01).sort((x, y) => y.w * y.d - x.w * x.d)
    : mod === 'bigger' ? siblings.filter((c) => c.w * c.d > a + 0.01).sort((x, y) => x.w * x.d - y.w * y.d)
      : siblings.filter((c) => c.priceSek < price).sort((x, y) => y.priceSek - x.priceSek);
  return pool[0] ?? null;
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
const removeHandler: Handler = (_m, clause, furniture) => {
  const m = REMOVE_RE.exec(clause);
  if (!m) return null;
  let phrase = m[1];
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
const rotateHandler: Handler = (_m, clause, furniture) => {
  const m = ROTATE_RE.exec(clause);
  if (!m) return null;
  const items = findItems(furniture, m[1]);
  if (!items.length) return cannot(`No ${stripArticle(m[1])} in the room`, 'Name a piece in the room');
  const item = items[0];
  if (item.locked || isMounted(item)) return cannot(`${item.name} is fixed`, 'Unlock it first');
  const deg = m[3] ? 180 : m[2] ? Number(m[2]) : 90;
  const left = /\b(left|counter|vänster|vasen)\b/.test(clause);
  const rot = item.rotation + (left ? -1 : 1) * (deg * Math.PI) / 180;
  return { furniture: setPose(furniture, item.id, { rotation: rot }), label: words3(`Rotated ${item.category}`), notes: [] };
};

const ADD_RE = /^(?:please |can you )?(?:add|include|put in|place|get|buy|need|want|lägg till|lägg in|sätt in|lisää|hanki)\s+(?:in\s+)?(\d+|one|two|three|four|five|six|another|a|an|some|en|ett|två|tre|fyra|yksi|kaksi|kolme|neljä)?\s*(.+)$/;
const addHandler: Handler = (model, clause, furniture) => {
  const m = ADD_RE.exec(clause);
  if (!m) return null;
  const qty = m[1] ? (Number(m[1]) || NUM_WORDS[m[1]] || 1) : 1;
  const phrase = stripArticle(m[2].replace(/\b(to the room|in the room|here|please|till rummet|huoneeseen)\b/g, '').trim());
  const e = findByKeyword(phrase) ?? findByKeyword(phrase.replace(/s$/, '')) ?? (nounOf(phrase) ? findByKeyword(nounOf(phrase)!.kw) : undefined);
  if (!e) return cannot(`No catalogue match for ${phrase}`, 'Name a piece, e.g. a plant');
  const ctx = ctxOf(model);
  let list = furniture;
  const added: FurnitureItem[] = [];
  for (let i = 0; i < Math.min(qty, 10); i++) {
    const it = makeItem(e.id);
    const p = findFreeSpot(model, it, list);
    if (!fitsAt(ctx, it, p, list)) break;
    const placed = { ...it, ...p };
    list = [...list, placed]; added.push(placed);
  }
  if (!added.length) return cannot('No room for it', 'Try a smaller piece');
  return { furniture: list, label: words3(`Added ${added.length > 1 ? added.length + ' ' : ''}${e.category}`), notes: added.length < qty ? [`Only ${added.length} fit`] : [] };
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
    const others = list.filter((x) => x.id !== f.id);
    const p = searchPose(ctx, cur, others, (q) => dist(q, cur));
    if (p) list = setPose(list, f.id, p);
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
  for (const id of ['rug-160', 'floor-lamp', 'plant']) {
    const e = catalogEntry(id)!;
    if (hasCat(list, e.category)) continue;
    const it = makeItem(id);
    let p = findFreeSpot(model, it, list);
    if (e.category === 'rug') {
      const c = centreOf(model);
      p = { x: c.x, y: c.y, rotation: 0 };
    }
    if (!fitsAt(ctx, it, p, list)) continue;
    list = [...list, { ...it, ...p, color: WARM[e.category] ?? it.color }]; added.push(e.category);
  }
  return { furniture: list, label: 'Cozier', notes: added.length ? [`Added ${added.join(', ')}`] : ['Warm palette'] };
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
    const p = wall ? searchPose(ctx, it, list, (q) => dist(q, centreOf(model))) : findFreeSpot(model, it, list);
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
    const p = searchPose(ctx, it, list, (q) => Math.abs(dist(q, d) - 0.9), { grid: true, walls: false });
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
const VERBS: Handler[] = [moveHandler, swapHandler, removeHandler, rotateHandler];
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
      work = work.filter((x) => x.id !== op.id); out.push(op); touched.add(op.id);
    } else if (op.type === 'UPDATE_OBJECT') {
      const f = work.find((x) => x.id === op.id);
      if (!f) { dropped.push(`unknown id ${op.id}`); continue; }
      const p = op.patch;
      if (!finite(p.x, p.y, p.rotation, p.w, p.d, p.h)) { dropped.push(`bad numbers for ${f.name}`); continue; }
      const geometry = ['x', 'y', 'rotation', 'w', 'd'].some((k) => k in p);
      if (geometry && (f.locked || isMounted(f))) { dropped.push(`${f.name} is fixed`); continue; }
      let merged: FurnitureItem = { ...f, ...p, clearance: { ...f.clearance, ...(p.clearance ?? {}) } };
      if (geometry) {
        const fixed = repair(merged, work.filter((x) => x.id !== f.id));
        if (!fixed) { dropped.push(`${f.name} has no free spot there`); continue; }
        merged = fixed;
      }
      work = work.map((x) => (x.id === f.id ? merged : x));
      out.push({ type: 'UPDATE_OBJECT', id: f.id, patch: diffToOps([f], [merged]).flatMap((o) => (o.type === 'UPDATE_OBJECT' ? [o.patch] : []))[0] ?? p }); touched.add(f.id);
    } else if (op.type === 'PLACE_OBJECT') {
      const it = op.item;
      if (!it || work.some((x) => x.id === it.id) || !finite(it.x, it.y, it.rotation, it.w, it.d)) { dropped.push('bad new item'); continue; }
      const fixed = repair(it, work);
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
      if (bad) dropped.push(`kept clear of door: ${id}`);
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
export function refineRoomOffline(model: SpaceModel, text: string, opts: { previous?: FurnitureItem[] } = {}): RoomEdit | null {
  const t = norm(text).replace(/[?!]+$/, '');
  if (!t) return null;
  if (UNDO_RE.test(t)) {
    if (opts.previous) return { ok: true, ops: [{ type: 'SET_FURNITURE', items: opts.previous, label: 'Undo' }], label: 'Undo', by: 'rules', notes: [], undo: true };
    return { ok: true, ops: [], label: 'Undo', by: 'rules', notes: [], undo: true };
  }
  const sized = roomSizeEdit(model, t);
  if (sized) return sized;
  const clauses = t.split(SPLIT_RE).map((c) => c.trim()).filter(Boolean);
  let cur = model;
  const allOps: Op[] = [];
  const labels: string[] = [];
  const notes: string[] = [];
  let understood = 0, failure: RoomEditCannot | null = null, same = 0;
  for (const clause of clauses) {
    let d: Draft | RoomEditCannot | null = null;
    for (const h of VERBS) { d = h(cur, clause, cur.furniture); if (d) break; }
    if (!d) d = addIfVerb(cur, clause);
    if (!d) for (const it of INTENTS) if (it.re.test(clause)) { d = it.run(cur, clause, cur.furniture); break; }
    if (!d) d = colourHandler(cur, clause, cur.furniture);
    if (!d) continue;
    understood++;
    if ('cannot' in d) { failure = d; continue; }
    const ops = diffToOps(cur.furniture, d.furniture);
    if (!ops.length) { same++; notes.push(...d.notes); labels.push(d.label); continue; }
    const v = validateRoomOps(cur, ops);
    notes.push(...d.notes, ...v.dropped.slice(0, 2));
    if (!v.ops.length) { failure = cannot(v.dropped[0] ?? 'No valid change', nearestTo(clause)); continue; }
    for (const o of v.ops) cur = applyOp(cur, o);
    allOps.push(...v.ops); labels.push(d.label);
  }
  if (!understood) return null;
  if (!allOps.length) {
    if (failure) return failure;
    return { ok: true, ops: [], label: words3(labels[0] ?? 'No change'), by: 'rules', notes, noChange: true };
  }
  return { ok: true, ops: allOps, label: labels.length > 1 ? `${labels.length} changes` : words3(labels[0]), by: 'rules', notes };
}

function addIfVerb(model: SpaceModel, clause: string): Draft | RoomEditCannot | null {
  // "add more storage" and similar are whole-room intents, handled later.
  if (INTENTS.some((i) => i.re.test(clause))) return null;
  return addHandler(model, clause, model.furniture);
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
export async function refineRoom(model: SpaceModel, text: string, opts: { previous?: FurnitureItem[] } = {}): Promise<RoomEdit> {
  const quick = refineRoomOffline(model, text, opts);
  if (quick) return quick;
  const ai = await refineRoomAI(model, text);
  if (!ai.ok && !hasGemini()) return cannot('Not understood', FRIENDLY.slice(0, 60));
  return ai;
}
