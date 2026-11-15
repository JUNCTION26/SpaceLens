// Furnish a whole floor with the single-room designer: each room is cut out as its own model,
// laid out from a brief that follows its purpose (rooms run side by side), and the furniture is
// moved back into building coordinates. With a model key each room goes through the full design
// pipeline (planner, solver, rules); without one, through the rule-based layout solver.
import { aiReady } from '../../core/ai';
import { area, bounds, centroid, convexOverlap, itemCorners, norm, openingSegment, pointInPolygon, rotate, uid, wallInwardNormal, wallLength, wallSegment } from '../../core/geometry';
import type { FurnitureItem, Opening, Requirements, Space, SpaceModel, Vec2 } from '../../core/types';
import { makeItem, type Variant } from '../furniture/catalog';
import { roomGraph, type RoomGraph } from './connectivity';
import { compileIntent } from '../intent/compile';
import { purposeOf } from '../drawings/purpose';
import { buildDesignItems } from '../design/pipeline';
import { planProgram } from '../design/planner';
import { solveRoomAsync } from './solveAsync';
import { mergeFurniture, subModelFor, type SubModel } from './submodel';

export { mergeFurniture, subModelFor, type SubModel } from './submodel';

const KNOWN = new Set(['bedroom', 'living', 'kitchen', 'dining', 'workspace', 'office', 'meeting', 'reception', 'cafe', 'clinic', 'staff',
  'hall', 'hallway', 'entrance', 'study', 'phone', 'counter', 'storage', 'utility', 'balcony', 'bathroom', 'wc', 'stair']);

/**
 * What a room is for: its stated purpose when it is one we furnish, else read from its printed
 * name in any of the plan languages (Stanza, Zimmer, Chambre, Cucina, Küche, Bagno, Bad, Corridoio,
 * Soggiorno...). Trailing room numbers such as "5.02" are ignored.
 */
export function roomPurpose(space: Pick<Space, 'name' | 'purpose'>): string {
  const p = (space.purpose ?? '').toLowerCase();
  if (KNOWN.has(p)) return p;
  const name = space.name.replace(/[\s\d.,/-]+$/, '').trim();
  return purposeOf(name)?.purpose ?? purposeOf(space.name)?.purpose ?? p;
}

/** Why a room gets no furniture, in a few plain words (null when it gets a brief). */
export function skipReason(space: Space): string | null {
  if (defaultBrief(space)) return null;
  const p = roomPurpose(space);
  if (p === 'stair') return 'Stairs';
  if (isCirculation(p)) return 'Circulation';
  if (area(space.polygon) < Math.max(4, MIN_AREA[p] ?? 0)) return 'Too small';
  return 'Nothing to furnish';
}

/** Smallest floor area, m², in which a room of this use gets its main piece. */
const MIN_AREA: Record<string, number> = { bedroom: 6, living: 8, kitchen: 4, dining: 5, office: 4, study: 4, meeting: 6, workspace: 8 };
const isCirculation = (p: string) => p === 'hall' || p === 'hallway' || p === 'entrance';
const bathBrief = (a: number) => (a >= 6 ? 'toilet, washbasin, shower and bathtub' : a >= 4.5 ? 'toilet, washbasin, shower and washing machine' : 'toilet, washbasin and shower');

/** Wet and utility rooms are furnished from fixed catalogue pieces: a brief in words cannot name them reliably. */
function fixtureSets(space: Space): string[][] {
  const p = roomPurpose(space);
  const a = area(space.polygon);
  if (a < 1.2) return [];
  if (p === 'wc') return [['toilet', 'washbasin'], ['toilet']];
  if (p === 'utility') return [['washing-machine', 'storage-cabinet'], ['washing-machine']];
  // Halls and corridors: only slim wall pieces (depth at most 0.4 m) so the way through stays open.
  if (isCirculation(p)) return [['shoe-bench', 'bookshelf-low'], ['shoe-bench'], ['bookshelf-low']];
  if (p !== 'bathroom') return [];
  // Largest set first; a narrow bathroom falls back to fewer pieces rather than being left empty.
  return [
    ...(a >= 6 ? [['toilet', 'washbasin', 'shower', 'bathtub']] : []),
    ...(a >= 4.5 ? [['toilet', 'washbasin', 'shower', 'washing-machine']] : []),
    ['toilet', 'washbasin', 'shower'], ['toilet', 'washbasin'],
  ];
}
/** Catalogue pieces that fit a room of this size, largest set first. Used when the brief route finds no layout. */
function fallbackSets(space: Space): string[][] {
  const p = roomPurpose(space);
  const a = area(space.polygon);
  const x = (id: string, k: number) => Array<string>(k).fill(id);
  const nd = Math.max(1, Math.min(4, Math.floor(a / 8)));
  switch (p) {
    case 'bedroom': return [
      ...(a >= 16 ? [['bed-160', 'wardrobe-150', 'nightstand', 'nightstand', 'desk-120', 'desk-chair']] : []),
      ...(a >= 12 ? [['bed-160', 'wardrobe-100', 'nightstand', 'nightstand']] : []),
      ['bed-double', 'wardrobe-100', 'nightstand'], ['bed-single', 'wardrobe-100'], ['bed-single']];
    case 'living': return [['sofa-3', 'armchair', 'coffee-table', 'rug-160'], ['sofa-2', 'coffee-table'], ['sofa-2']];
    case 'kitchen': case 'dining': case 'staff': return [['dining-6', ...x('chair', 6)], ['dining-4', ...x('chair', 4)], ['dining-4', 'chair', 'chair'], ['dining-4']];
    case 'workspace': case 'office': case 'study': return [[...x('desk-140', nd), ...x('desk-chair', nd)], ['desk-120', 'desk-chair'], ['desk-120']];
    case 'meeting': return [['dining-6', ...x('chair', 6)], ['dining-4', ...x('chair', 4)], ['dining-4']];
    case 'reception': return [['reception-desk', 'armchair'], ['reception-desk']];
    case 'cafe': return [[...x('cafe-4', 3), ...x('chair', 12)], ['cafe-4', ...x('chair', 4)], ['cafe-2', 'chair', 'chair']];
    case 'clinic': return [['treatment-bed', 'desk-120', 'chair', 'chair'], ['treatment-bed', 'desk-120'], ['treatment-bed']];
    case 'balcony': return [['cafe-2', 'chair', 'chair'], ['cafe-2']];
    case 'phone': return [['desk-120', 'desk-chair'], ['desk-120']];
    case 'counter': return [['counter', 'bar-stool', 'bar-stool'], ['counter']];
    case 'storage': return [['storage-cabinet'], ['shoe-bench']];
    default: return [];
  }
}
const requirementsFor = (purpose: string, ids: string[]): Requirements => {
  const qty = new Map<string, number>();
  for (const id of ids) qty.set(id, (qty.get(id) ?? 0) + 1);
  return { purpose, people: 1, budgetSek: null, items: [...qty].map(([catalogId, q]) => ({ catalogId, qty: q })), routeTargets: [], minRouteWidthM: 0.7, style: '', lockedIds: [], notes: [], questions: [], compiledBy: 'rules' };
};

/** A furnishing brief from a room's purpose and size; null for rooms left empty. */
export function defaultBrief(space: Space): string | null {
  const a = area(space.polygon);
  const p = roomPurpose(space);
  // rooms too small for the brief's main piece stay empty rather than failing to fit
  if (a < (MIN_AREA[p] ?? 0)) return null;
  const n = (per: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(a / per)));
  switch (p) {
    case 'bedroom': return a >= 16 ? 'bedroom with a double bed, wardrobe, two nightstands, a desk and a desk chair' : a >= 12 ? 'bedroom with a double bed, wardrobe and two nightstands' : a >= 9 ? 'bedroom with a bed, wardrobe and a nightstand' : 'bedroom with a single bed and a wardrobe';
    case 'living': return a >= 20 ? 'living room with a sofa, armchair, coffee table, rug and a floor lamp' : a >= 14 ? 'living room with a sofa, armchair, coffee table and rug' : 'living room with a sofa and a coffee table';
    case 'kitchen': return `dining table for ${n(3.5, 2, 8)} people`;
    case 'dining': return `dining table for ${n(2.5, 4, 10)} people`;
    case 'workspace': return `office with ${n(6, 2, 12)} desks and chairs`;
    case 'office': return `office with ${n(8, 1, 3)} desk${a >= 16 ? 's' : ''} and a bookshelf`;
    case 'meeting': return `meeting room with a table for ${n(2.2, 4, 14)} people`;
    case 'reception': return 'reception with a desk and a sofa for waiting';
    case 'cafe': return `cafe with tables for ${n(1.5, 4, 60)} people`;
    case 'clinic': return 'clinic treatment room with a treatment bed, desk and two chairs';
    case 'staff': return `dining table for ${n(2.5, 2, 8)} people`;
    case 'hall': case 'hallway': case 'entrance': return a >= 3 ? 'shoe cabinet with seat' : null;
    case 'balcony': return a >= 3 ? 'small cafe table and two chairs' : null;
    case 'study': return 'office with a desk, an office chair and a bookshelf';
    case 'phone': return 'small desk and a desk chair';
    case 'counter': return 'counter and two bar stools';
    case 'bathroom': return a >= 3 ? bathBrief(a) : null;
    case 'wc': return a >= 1.2 ? 'toilet and washbasin' : null;
    case 'utility': return a >= 2.5 ? 'washing machine and a storage cabinet' : null;
    case 'storage': return a >= 3 ? 'storage cabinet' : null;
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Building-level planning: briefs from a room's neighbours, hand-built layouts for the pieces a
// designer places by rule (office clusters, meeting tables, reception, kitchenette, window desk),
// one palette, clear doors, a reachability check and a summary.
// ---------------------------------------------------------------------------------------------

interface BuildingContext { graph: RoomGraph; purposeById: Map<string, string>; openToKitchen: Set<string>; offices: boolean }

function buildContext(model: SpaceModel): BuildingContext {
  const graph = roomGraph(model);
  const purposeById = new Map(model.spaces.map((s) => [s.id, roomPurpose(s)]));
  const openToKitchen = new Set<string>();
  for (const l of graph.links) {
    const open = l.openingIds.some((id) => { const o = model.openings.find((x) => x.id === id); return o && (o.kind === 'opening' || o.widthM >= 1.6); });
    if (!open) continue;
    const pa = purposeById.get(l.a), pb = purposeById.get(l.b);
    const food = (p?: string) => p === 'kitchen' || p === 'dining';
    if (pa === 'living' && food(pb)) { openToKitchen.add(l.a); openToKitchen.add(l.b); }
    if (pb === 'living' && food(pa)) { openToKitchen.add(l.a); openToKitchen.add(l.b); }
  }
  const ps = [...purposeById.values()];
  const offices = ps.some((p) => p === 'workspace' || p === 'office' || p === 'meeting' || p === 'reception') && !ps.includes('bedroom');
  return { graph, purposeById, openToKitchen, offices };
}

const linkedTo = (ctx: BuildingContext, id: string, pred: (p: string) => boolean) => (ctx.graph.neighbours.get(id) ?? []).some((n) => pred(ctx.purposeById.get(n) ?? ''));

/** The brief for a room given what surrounds it: en-suite or kids bedroom, living open to the kitchen, office floors. */
export function contextBrief(model: SpaceModel, space: Space, ctx: BuildingContext = buildContext(model)): string | null {
  const base = defaultBrief(space);
  if (!base) return null;
  const p = roomPurpose(space);
  const a = area(space.polygon);
  const xs = space.polygon.map((q) => q.x), ys = space.polygon.map((q) => q.y);
  const narrow = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < 2.6;
  if (p === 'bedroom') {
    const ensuite = linkedTo(ctx, space.id, (q) => q === 'bathroom' || q === 'wc');
    const bedrooms = [...ctx.purposeById.values()].filter((q) => q === 'bedroom').length;
    if (narrow) return 'bedroom with a single bed and a wardrobe';
    if (ensuite && a >= 11) return 'bedroom with a double bed, wardrobe and two nightstands';
    if (!ensuite && bedrooms >= 3 && a >= 8 && a < 13) return 'bedroom with a single bed, wardrobe, a desk and a desk chair';
  }
  if (p === 'living' && ctx.openToKitchen.has(space.id)) return a >= 16 ? 'living room with a sofa, armchair and coffee table' : 'living room with a sofa and a coffee table';
  if ((p === 'kitchen' || p === 'dining') && ctx.openToKitchen.has(space.id)) return `dining table for ${Math.max(2, Math.min(4, Math.floor(a / 3.5)))} people`;
  return base;
}

// ---- geometry helpers for hand-built layouts ----
const PI = Math.PI;
const faceAngle = (front: Vec2) => Math.atan2(-front.x, front.y);
const ptAdd = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const ptMul = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
interface Rect { x0: number; y0: number; x1: number; y1: number }
const rectPoly = (r: Rect): Vec2[] => [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
const grow = (r: Rect, m: number): Rect => ({ x0: r.x0 - m, y0: r.y0 - m, x1: r.x1 + m, y1: r.y1 + m });
const rectsOverlap = (a: Rect, b: Rect) => a.x0 < b.x1 - 1e-6 && b.x0 < a.x1 - 1e-6 && a.y0 < b.y1 - 1e-6 && b.y0 < a.y1 - 1e-6;
function extentOf(items: FurnitureItem[], withClearance = false): Rect {
  const pts = items.flatMap((f) => itemCorners(f, withClearance));
  return { x0: Math.min(...pts.map((q) => q.x)), y0: Math.min(...pts.map((q) => q.y)), x1: Math.max(...pts.map((q) => q.x)), y1: Math.max(...pts.map((q) => q.y)) };
}
const at = (catalogId: string, x: number, y: number, rotation = 0): FurnitureItem => makeItem(catalogId, { x, y, rotation });

/** Clear zones in front of every door and opening: its width plus a hand, 0.9 m (or the leaf width) deep on both sides. */
function doorZones(spaces: Space[], openings: Opening[]): Vec2[][] {
  const out: Vec2[][] = [];
  for (const o of openings) {
    if (o.kind === 'window') continue;
    const s = spaces.find((x) => x.id === o.spaceId);
    if (!s || o.wallIndex >= s.polygon.length) continue;
    const { a, b, dir, inward } = openingSegment(s, o);
    const D = Math.max(0.9, o.widthM);
    const a2 = ptAdd(a, ptMul(dir, -0.05)), b2 = ptAdd(b, ptMul(dir, 0.05));
    out.push([ptAdd(a2, ptMul(inward, D)), ptAdd(b2, ptMul(inward, D)), ptAdd(b2, ptMul(inward, -D)), ptAdd(a2, ptMul(inward, -D))]);
  }
  return out;
}
const hitsZone = (f: FurnitureItem, zones: Vec2[][]) => f.category !== 'rug' && zones.some((z) => convexOverlap(itemCorners(f), z) > 0.02);

interface PlaceOpts { gap: number; wall: number; centre?: boolean; rotations?: number[]; avoid?: Rect[] }
/** Shift a block of items (around the origin) to the first or most central spot where it fits; null when none does. */
function placeBlock(sub: SpaceModel, block: FurnitureItem[], placed: Rect[], o: PlaceOpts): FurnitureItem[] | null {
  const poly = sub.spaces[0].polygon;
  const zones = doorZones(sub.spaces, sub.openings);
  const bb = bounds(poly);
  const c0 = centroid(poly);
  for (const wall of o.wall > 0.1 ? [o.wall, 0.1] : [o.wall]) {
    let best: { dx: number; dy: number; rot: number; score: number } | null = null;
    for (const rot of o.rotations ?? [0, PI / 2]) {
      const items = block.map((f) => { const p = rotate({ x: f.x, y: f.y }, rot); return { ...f, x: p.x, y: p.y, rotation: f.rotation + rot }; });
      const e = extentOf(items);
      const w = e.x1 - e.x0, h = e.y1 - e.y0;
      for (let y = bb.minY - e.y0; y <= bb.maxY - e.y1 + 1e-6; y += 0.1) {
        for (let x = bb.minX - e.x0; x <= bb.maxX - e.x1 + 1e-6; x += 0.1) {
          const r: Rect = { x0: e.x0 + x, y0: e.y0 + y, x1: e.x1 + x, y1: e.y1 + y };
          const wr = grow(r, wall);
          const probe = [...rectPoly(wr), { x: (wr.x0 + wr.x1) / 2, y: wr.y0 }, { x: (wr.x0 + wr.x1) / 2, y: wr.y1 }, { x: wr.x0, y: (wr.y0 + wr.y1) / 2 }, { x: wr.x1, y: (wr.y0 + wr.y1) / 2 }];
          if (!probe.every((q) => pointInPolygon(q, poly))) continue;
          const gr = grow(r, o.gap / 2);
          if (placed.some((p) => rectsOverlap(gr, grow(p, o.gap / 2))) || (o.avoid ?? []).some((p) => rectsOverlap(r, p))) continue;
          const moved = items.map((f) => ({ ...f, x: f.x + x, y: f.y + y }));
          if (!moved.every((f) => itemCorners(f).every((q) => pointInPolygon(q, poly))) || moved.some((f) => hitsZone(f, zones))) continue;
          if (o.centre) {
            const sc = Math.hypot((r.x0 + r.x1) / 2 - c0.x, (r.y0 + r.y1) / 2 - c0.y) + (w < h ? 0.05 : 0);
            if (!best || sc < best.score) best = { dx: x, dy: y, rot, score: sc };
          } else {
            const moved2 = moved;
            placed.push(r);
            return moved2;
          }
        }
      }
    }
    if (best) {
      const items = block.map((f) => { const p = rotate({ x: f.x, y: f.y }, best!.rot); return { ...f, x: p.x + best!.dx, y: p.y + best!.dy, rotation: f.rotation + best!.rot }; });
      placed.push(extentOf(items));
      return items;
    }
  }
  return null;
}

/** Clusters of 2, 4 or 6 desks facing each other, chairs on the outer sides, 1.2 m aisles between clusters. */
function officeClusters(sub: SpaceModel, people: number): FurnitureItem[] {
  const out: FurnitureItem[] = [];
  const placed: Rect[] = [];
  const sizes: number[] = [];
  let left = people;
  while (left > 0) { const k = left >= 6 ? 6 : left >= 4 ? 4 : left >= 2 ? 2 : 1; sizes.push(k); left -= k; }
  // 8 people: 4+4 reads better than 6+2
  if (people === 8) sizes.splice(0, sizes.length, 4, 4);
  const poly = sub.spaces[0].polygon;
  const roomArea = area(poly);
  for (const desk of roomArea / Math.max(1, people) >= 7 ? ['desk-140', 'desk-120'] : ['desk-120']) {
    out.length = 0; placed.length = 0;
    const dw = desk === 'desk-140' ? 1.4 : 1.2, dd = desk === 'desk-140' ? 0.7 : 0.6;
    // a cluster that does not fit is split in two smaller ones (6 to 4 + 2, 4 to 2 + 2, 2 to 1 + 1)
    const queue = [...sizes].sort((a, b) => b - a);
    while (queue.length) {
      const k = queue.shift()!;
      const cols = Math.max(1, Math.ceil(k / 2));
      const block: FurnitureItem[] = [];
      for (let i = 0; i < k; i++) {
        const row = i < cols ? 0 : 1, col = row === 0 ? i : i - cols;
        const x = (col - (cols - 1) / 2) * dw;
        if (row === 0) { block.push(at(desk, x, -dd / 2, PI), at('desk-chair', x, -dd - 0.3, 0)); }
        else { block.push(at(desk, x, dd / 2, 0), at('desk-chair', x, dd + 0.3, PI)); }
      }
      const got = placeBlock(sub, block, placed, { gap: 1.2, wall: 0.6 }) ?? placeBlock(sub, block, placed, { gap: 0.9, wall: 0.3 });
      if (got) out.push(...got);
      else if (k > 1) { const a = k === 2 ? 1 : k - 2; queue.push(a, k - a); queue.sort((x, y) => y - x); }
    }
    if (out.filter((f) => f.category === 'desk').length >= people) break;
  }
  return out;
}

/** A meeting table built from joined 6- and 4-person tables: 0.6 m of edge per seat, chairs on both long sides. */
function meetingTable(sub: SpaceModel, seats: number): FurnitureItem[] {
  for (let s = seats % 2 ? seats + 1 : seats; s >= 4; s -= 2) {
    const parts: Array<'dining-6' | 'dining-4'> = [];
    for (let left = s; left > 0;) { if (left >= 6 && left !== 8) { parts.push('dining-6'); left -= 6; } else { parts.push('dining-4'); left -= 4; } }
    const widths = parts.map((p) => (p === 'dining-6' ? 1.8 : 1.2));
    const total = widths.reduce((q, w) => q + w, 0);
    const block: FurnitureItem[] = [];
    let x = -total / 2;
    parts.forEach((p, i) => {
      const w = widths[i], d = p === 'dining-6' ? 0.9 : 0.8, per = Math.round(w / 0.6);
      block.push(at(p, x + w / 2, 0, 0));
      for (let c = 0; c < per; c++) {
        const cx = x + (c + 0.5) * (w / per);
        block.push(at('chair', cx, -d / 2 - 0.2, 0), at('chair', cx, d / 2 + 0.2, PI));
      }
      x += w;
    });
    const got = placeBlock(sub, block, [], { gap: 0, wall: 0.9, centre: true });
    if (got) return got;
  }
  return [];
}

/** The widest door of a room, as the way in. */
function mainDoor(sub: SpaceModel): { c: Vec2; inward: Vec2 } | null {
  const s = sub.spaces[0];
  const doors = sub.openings.filter((o) => o.kind === 'door' || o.kind === 'opening').sort((a, b) => b.widthM - a.widthM);
  if (!doors[0] || doors[0].wallIndex >= s.polygon.length) return null;
  const g = openingSegment(s, doors[0]);
  return { c: g.c, inward: g.inward };
}

/** A reception desk straight in front of the entrance, its visitor side toward the door, with waiting chairs beside it. */
function reception(sub: SpaceModel): FurnitureItem[] {
  const door = mainDoor(sub);
  if (!door) return [];
  const poly = sub.spaces[0].polygon;
  const zones = doorZones(sub.spaces, sub.openings);
  const rot = faceAngle(ptMul(door.inward, -1));
  for (const dist of [2.6, 2.3, 2.0, 1.7]) {
    const p = ptAdd(door.c, ptMul(door.inward, dist));
    const desk = at('reception-desk', p.x, p.y, rot);
    if (!itemCorners(desk).every((q) => pointInPolygon(q, poly)) || hitsZone(desk, zones)) continue;
    const placed = [extentOf([desk], true)];
    const out = [desk];
    const seats = placeBlock(sub, [at('waiting-chair', -0.35, 0), at('waiting-chair', 0.35, 0)], placed, { gap: 0.3, wall: 0.1, rotations: [0, PI / 2, PI, -PI / 2], avoid: [extentOf([desk], true)] });
    if (seats) out.push(...seats.map((f) => ({ ...f, rotation: faceAngle({ x: desk.x - f.x, y: desk.y - f.y }) })));
    return out;
  }
  return [];
}

/** Counters in a row along one wall, plus a small table in the middle when there is room. */
function kitchenette(sub: SpaceModel): FurnitureItem[] {
  const s = sub.spaces[0];
  const zones = doorZones(sub.spaces, sub.openings);
  const edges = s.polygon.map((_, i) => ({ i, len: wallLength(s, i) })).sort((a, b) => b.len - a.len);
  for (const { i, len } of edges) {
    if (len < 1.9) continue;
    const [p, q] = wallSegment(s, i);
    const dir = norm(sub2(q, p)), n = wallInwardNormal(s, i);
    const k = Math.min(2, Math.floor(len / 1.9));
    const rot = faceAngle(n);
    for (let t = 0.1; t + 1.8 * k <= len - 0.1 + 1e-6; t += 0.2) {
      const row = Array.from({ length: k }, (_, j) => { const c = ptAdd(ptAdd(p, ptMul(dir, t + 0.9 + 1.8 * j)), ptMul(n, 0.3)); return at('counter', c.x, c.y, rot); });
      if (!row.every((f) => itemCorners(f).every((v) => pointInPolygon(v, s.polygon))) || row.some((f) => hitsZone(f, zones))) continue;
      const placed = [extentOf(row, true)];
      const table: FurnitureItem[] = [at('dining-4', 0, 0), at('chair', -0.3, -0.65), at('chair', 0.3, -0.65), at('chair', -0.3, 0.65, PI), at('chair', 0.3, 0.65, PI)];
      const got = placeBlock(sub, table, placed, { gap: 0.2, wall: 0.7, centre: true });
      return got ? [...row, ...got] : row;
    }
  }
  return [];
}
const sub2 = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });

/**
 * One desk centred under the largest window, its chair on the room side. Without a window that
 * takes it (or in a windowless booth) the desk goes against the longest wall where it fits.
 */
function deskAtWindow(sub: SpaceModel, withShelf = true): FurnitureItem[] {
  const s = sub.spaces[0];
  const zones = doorZones(sub.spaces, sub.openings);
  const wins = sub.openings.filter((o) => o.kind === 'window' && o.wallIndex < s.polygon.length).sort((a, b) => b.widthM - a.widthM);
  // candidate spots: window centres first, then points along every wall, longest wall first
  const spots: Array<{ c: Vec2; inward: Vec2 }> = wins.map((w) => { const g = openingSegment(s, w); return { c: g.c, inward: g.inward }; });
  const walls = s.polygon.map((_, i) => ({ i, len: wallLength(s, i) })).sort((a, b) => b.len - a.len);
  for (const { i, len } of walls) {
    const [p, q] = wallSegment(s, i);
    const dir = norm(sub2(q, p)), n = wallInwardNormal(s, i);
    const ts: number[] = [];
    for (let t = 0.6; t <= len - 0.6 + 1e-6; t += 0.1) ts.push(t);
    ts.sort((a, b) => Math.abs(a - len / 2) - Math.abs(b - len / 2));
    for (const t of ts) spots.push({ c: ptAdd(p, ptMul(dir, t)), inward: n });
  }
  for (const desk of ['desk-140', 'desk-120']) {
    const d = desk === 'desk-140' ? 0.7 : 0.6;
    for (const g of spots) {
      const rot = faceAngle(g.inward);
      const dc = ptAdd(g.c, ptMul(g.inward, d / 2 + 0.02));
      const cc = ptAdd(g.c, ptMul(g.inward, d + 0.3));
      const items = [at(desk, dc.x, dc.y, rot), at('desk-chair', cc.x, cc.y, faceAngle(ptMul(g.inward, -1)))];
      if (items.every((f) => itemCorners(f).every((v) => pointInPolygon(v, s.polygon))) && !items.some((f) => hitsZone(f, zones))) {
        if (!withShelf) return items;
        // a shelf on the wall beside the desk when it fits
        const placed = [extentOf(items, true)];
        const shelf = placeBlock(sub, [at('bookshelf', 0, 0)], placed, { gap: 0.5, wall: 0.02, rotations: [0, PI / 2, PI, -PI / 2] });
        return shelf ? [...items, ...shelf] : items;
      }
    }
    // the larger desk is tried at every spot before the smaller one
  }
  return [];
}

/** Pieces chairs are drawn up to, and the seats that belong to them. */
const ANCHORS = new Set(['desk', 'table', 'reception-desk', 'counter']);
const SEATS = new Set(['chair', 'office-chair', 'bar-stool']);

/**
 * Move a group of pieces (the first is the pivot) to the nearest spot in its room, as it is or turned
 * a quarter about the pivot, keeping every piece's pose relative to the pivot. Every piece must stay
 * inside the room, overlap no other piece and pass `ok`; null when no spot within 2.5 m does.
 */
function relocate(group: FurnitureItem[], poly: Vec2[], others: FurnitureItem[], ok: (g: FurnitureItem) => boolean): FurnitureItem[] | null {
  const ids = new Set(group.map((f) => f.id));
  const solid = others.filter((o) => !ids.has(o.id) && o.category !== 'rug').map((o) => itemCorners(o));
  const p0 = group[0];
  const turned = (q: number) => group.map((f) => {
    const v = rotate({ x: f.x - p0.x, y: f.y - p0.y }, q);
    return { ...f, x: p0.x + v.x, y: p0.y + v.y, rotation: f.rotation + q };
  });
  const poses = [turned(0), turned(PI / 2), turned(-PI / 2)];
  for (let r = 1; r <= 25; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      for (const pose of poses) {
        const g = pose.map((f) => ({ ...f, x: f.x + dx * 0.1, y: f.y + dy * 0.1 }));
        const fits = g.every((f) => {
          const cs = itemCorners(f);
          return cs.every((q) => pointInPolygon(q, poly)) && (f.category === 'rug' || !solid.some((o) => convexOverlap(cs, o) > 0.005)) && ok(f);
        });
        if (fits) return g;
      }
    }
  }
  return null;
}

// ---- palette ----
const WOOD_TONES: Variant[] = [{ color: '#b08a5a', material: 'oak' }, { color: '#d8c7a8', material: 'birch' }, { color: '#6e4f36', material: 'walnut' }];
const FABRIC_TONES: Variant[] = [{ color: '#6d7f8f', material: 'fabric' }, { color: '#b7a58f', material: 'linen' }, { color: '#4f6b55', material: 'velvet' }];
const WOOD_WORDS = /oak|birch|pine|walnut|beech|wood/;
const SOFT_CATEGORIES = new Set(['sofa', 'sofa-bed', 'armchair']);
const hashOf = (s: string) => { let h = 7; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };

/** One wood tone and one fabric tone for every new piece of the plan; the same product always gets the same finish. */
function applyPalette(items: FurnitureItem[], index: number): FurnitureItem[] {
  const wood = WOOD_TONES[index % WOOD_TONES.length], fabric = FABRIC_TONES[index % FABRIC_TONES.length];
  return items.map((f) => {
    if (f.locked || f.owned || f.custom) return f;
    if (SOFT_CATEGORIES.has(f.category) && f.catalogId !== 'waiting-chair') return { ...f, color: fabric.color, material: fabric.material };
    if (f.material && WOOD_WORDS.test(f.material) && !/white|black/.test(f.material) && f.category !== 'rug') return { ...f, color: wood.color, material: wood.material };
    return f;
  });
}

// ---- same room twice: solve once, reuse (mirrored when it is the mirror image) ----
function roomSignature(sub: SpaceModel, mirror: boolean): string {
  const s = sub.spaces[0];
  const bb = bounds(s.polygon);
  const W = bb.maxX - bb.minX;
  const mx = (x: number) => (mirror ? W - x : x);
  const r = (n: number) => Math.round(n * 20) / 20;
  const poly = s.polygon.map((p) => `${r(mx(p.x))},${r(p.y)}`).sort().join(';');
  const ops = sub.openings.filter((o) => o.wallIndex < s.polygon.length).map((o) => {
    const g = openingSegment(s, o);
    const h = o.hinge === 'start' ? g.a : g.b;
    return `${o.kind}:${r(mx(g.c.x))},${r(g.c.y)}:${r(o.widthM)}:${o.swing}:${r(mx(h.x))},${r(h.y)}:${Math.round(mirror ? -g.inward.x : g.inward.x)},${Math.round(g.inward.y)}`;
  }).sort().join('|');
  return `${poly}#${ops}`;
}
function mirrorItems(items: FurnitureItem[], width: number): FurnitureItem[] {
  return items.map((f) => ({ ...f, id: uid('f'), x: Math.round((width - f.x) * 1000) / 1000, rotation: -f.rotation }));
}

export type RoomStatus = 'waiting' | 'running' | 'done' | 'skipped' | 'failed';
export interface RoomProgress {
  spaceId: string; name: string; status: RoomStatus; items?: number; message?: string;
  /** What was given up in this room, in plain words (machine-readable list; empty when nothing was). */
  compromises?: string[];
  /** Milliseconds spent on the room (0 when reused from an identical room). */
  ms?: number;
  /** Id of the identical room whose layout was reused. */
  reusedFrom?: string;
}

export interface FurnishOptions {
  onRoom?: (p: RoomProgress) => void;
  /** Count only: rooms finished so far (done, skipped or failed) and the total. */
  onProgress?: (finished: number, total: number) => void;
  /** Rooms laid out at the same time (default 3). */
  parallel?: number;
  signal?: AbortSignal;
  seed?: number;
  /** Upper bound for one room's search, ms (the share of the total budget can make it shorter). */
  timeBudgetMs?: number;
  /** Time for the whole building, ms (default 10000). After it, rooms take the catalogue fallback list. */
  totalBudgetMs?: number;
  /** Head count per room id (offices); otherwise estimated from the area. */
  people?: Record<string, number>;
  /** Palette number (wood and fabric tone); otherwise picked from the model id. */
  palette?: number;
  /** Walkway width for the reachability check, metres (default 0.8). */
  walkwayM?: number;
  /** Override the brief reader (defaults to compileIntent). */
  compile?: (brief: string, sub: SpaceModel) => Promise<Requirements>;
  /** Override the layout solver (defaults to generateLayouts). */
  solve?: (sub: SpaceModel, req: Requirements, brief?: string) => Promise<FurnitureItem[] | null>;
}

export interface BuildingCheck {
  ok: boolean;
  /** Rooms that cannot be reached from the entrance at walkway width with the furniture in place. */
  unreachable: string[];
  /** Doors whose centre cannot be reached. */
  blockedDoors: string[];
  walkwayM: number;
}

export interface FurnishSummary {
  items: number;
  totalSek: number;
  roomsDone: number;
  roomsSkipped: number;
  roomsFailed: number;
  roomsCompromised: Array<{ spaceId: string; name: string; reasons: string[] }>;
  /** Footprint share of floor area per furnished room. */
  density: Record<string, number>;
  /** Rooms laid out by reusing an identical room. */
  reused: number;
  palette: { wood: string; fabric: string };
  ms: number;
  /** True when the total time budget ran out and later rooms took the fallback list. */
  overBudget: boolean;
}

export interface FurnishResult {
  furniture: FurnitureItem[];
  rooms: RoomProgress[];
  /** Furniture id to the id of its room (FurnitureItem itself has no room field). */
  roomByItem: Record<string, string>;
  summary: FurnishSummary;
  check: BuildingCheck;
}

/** Room of an item by position, for furniture not placed through furnishBuilding. */
export function roomIdOf(model: SpaceModel, f: Pick<FurnitureItem, 'x' | 'y'>): string | null {
  return model.spaces.find((s) => pointInPolygon(f, s.polygon))?.id ?? null;
}

const FIXED_ASIDE = new Set(['rug']);

/**
 * Can every room be reached from the entrance walking at `walkwayM` width, with these pieces in
 * place? Pieces are grown by half the walkway; doors count as open floor.
 */
export function checkBuilding(model: SpaceModel, furniture: FurnitureItem[] = model.furniture, walkwayM = 0.8): BuildingCheck {
  const spaces = model.spaces;
  if (!spaces.length) return { ok: true, unreachable: [], blockedDoors: [], walkwayM };
  const cell = 0.1;
  const bb = bounds(spaces.flatMap((s) => s.polygon));
  const nx = Math.ceil((bb.maxX - bb.minX) / cell) + 1, ny = Math.ceil((bb.maxY - bb.minY) / cell) + 1;
  const owner = new Int16Array(nx * ny).fill(-1);
  const free = new Uint8Array(nx * ny);
  const centre = (ix: number, iy: number): Vec2 => ({ x: bb.minX + (ix + 0.5) * cell, y: bb.minY + (iy + 0.5) * cell });
  const idx = (ix: number, iy: number) => iy * nx + ix;
  spaces.forEach((s, si) => {
    const b = bounds(s.polygon);
    for (let iy = Math.max(0, Math.floor((b.minY - bb.minY) / cell)); iy <= Math.min(ny - 1, Math.ceil((b.maxY - bb.minY) / cell)); iy++)
      for (let ix = Math.max(0, Math.floor((b.minX - bb.minX) / cell)); ix <= Math.min(nx - 1, Math.ceil((b.maxX - bb.minX) / cell)); ix++)
        if (pointInPolygon(centre(ix, iy), s.polygon)) { free[idx(ix, iy)] = 1; if (owner[idx(ix, iy)] < 0) owner[idx(ix, iy)] = si; }
  });
  const doors = model.openings.filter((o) => o.kind !== 'window').map((o) => {
    const s = spaces.find((x) => x.id === o.spaceId);
    if (!s || o.wallIndex >= s.polygon.length) return null;
    const g = openingSegment(s, o);
    return { o, g };
  }).filter((x): x is NonNullable<typeof x> => !!x);
  // doors are open floor across the wall's thickness, and the only cells where a walk may pass from one room into the next
  const doorCell = new Uint8Array(nx * ny);
  for (const { o, g } of doors) {
    const hw = o.widthM / 2 - 0.02;
    for (let t = -hw; t <= hw; t += cell / 2) for (let u = -0.45; u <= 0.45; u += cell / 2) {
      const p = ptAdd(ptAdd(g.c, ptMul(g.dir, t)), ptMul(g.inward, u));
      const ix = Math.floor((p.x - bb.minX) / cell), iy = Math.floor((p.y - bb.minY) / cell);
      if (ix >= 0 && iy >= 0 && ix < nx && iy < ny) { free[idx(ix, iy)] = 1; doorCell[idx(ix, iy)] = 1; }
    }
  }
  const r = walkwayM / 2;
  for (const f of furniture) {
    if (FIXED_ASIDE.has(f.category)) continue;
    const half = Math.hypot(f.w / 2 + r, f.d / 2 + r);
    const cs = Math.cos(-f.rotation), sn = Math.sin(-f.rotation);
    for (let iy = Math.max(0, Math.floor((f.y - half - bb.minY) / cell)); iy <= Math.min(ny - 1, Math.ceil((f.y + half - bb.minY) / cell)); iy++)
      for (let ix = Math.max(0, Math.floor((f.x - half - bb.minX) / cell)); ix <= Math.min(nx - 1, Math.ceil((f.x + half - bb.minX) / cell)); ix++) {
        const p = centre(ix, iy);
        const dx = p.x - f.x, dy = p.y - f.y;
        const lx = dx * cs - dy * sn, ly = dx * sn + dy * cs;
        if (Math.abs(lx) <= f.w / 2 + r && Math.abs(ly) <= f.d / 2 + r) free[idx(ix, iy)] = 0;
      }
  }
  const graph = roomGraph(model);
  const entrance = graph.exits[0]?.at ?? doors[0]?.g.c ?? centroid(spaces[0].polygon);
  const cellOf = (p: Vec2) => ({ ix: Math.min(nx - 1, Math.max(0, Math.floor((p.x - bb.minX) / cell))), iy: Math.min(ny - 1, Math.max(0, Math.floor((p.y - bb.minY) / cell))) });
  const seen = new Uint8Array(nx * ny);
  const st = cellOf(entrance);
  // the entrance door's own cells may sit just inside an obstacle's reach: start from the nearest open cell
  let start = -1;
  for (let rr = 0; rr <= 8 && start < 0; rr++)
    for (let dy = -rr; dy <= rr && start < 0; dy++) for (let dx = -rr; dx <= rr; dx++) {
      const ix = st.ix + dx, iy = st.iy + dy;
      if (ix >= 0 && iy >= 0 && ix < nx && iy < ny && free[idx(ix, iy)]) { start = idx(ix, iy); break; }
    }
  const stack: number[] = start >= 0 ? [start] : [];
  if (start >= 0) seen[start] = 1;
  while (stack.length) {
    const c = stack.pop()!;
    const ix = c % nx, iy = (c - ix) / nx;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const jx = ix + dx, jy = iy + dy;
      if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
      const j = idx(jx, jy);
      // a shared wall is not a way through: crossing between rooms only happens in a doorway
      if (owner[j] !== owner[c] && !doorCell[c] && !doorCell[j]) continue;
      if (free[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
    }
  }
  const reached = new Set<number>();
  for (let i = 0; i < owner.length; i++) if (seen[i] && owner[i] >= 0) reached.add(owner[i]);
  const unreachable = spaces.filter((_, si) => !reached.has(si)).map((s) => s.id);
  const blockedDoors = doors.filter(({ g }) => { const c = cellOf(g.c); return !seen[idx(c.ix, c.iy)]; }).map(({ o }) => o.id);
  return { ok: unreachable.length === 0 && blockedDoors.length === 0 && start >= 0, unreachable, blockedDoors, walkwayM };
}

/** What a room of this use must contain to count as furnished; the reasons it falls short, in plain words. */
function missingEssentials(purpose: string, items: FurnitureItem[], people: number): string[] {
  const has = (...cats: string[]) => items.some((f) => cats.includes(f.category));
  const out: string[] = [];
  if (purpose === 'bedroom') {
    if (!has('bed', 'bunk-bed')) out.push('No bed fits');
    else if (!has('wardrobe', 'dresser', 'storage-cabinet')) out.push('No storage fits');
  }
  if (purpose === 'living' && !has('sofa', 'sofa-bed')) out.push('No seating group fits');
  if (purpose === 'workspace' || purpose === 'office' || purpose === 'study') {
    const desks = items.filter((f) => f.category === 'desk').length;
    const chairs = items.filter((f) => f.category === 'chair' || f.category === 'office-chair').length;
    if (desks < people) out.push(`${desks} of ${people} desks fit`);
    else if (chairs < desks) out.push('A desk has no chair');
  }
  if (purpose === 'meeting' && !has('table')) out.push('No table fits');
  if (purpose === 'reception' && !has('reception-desk')) out.push('No reception desk fits');
  return out;
}

/** Lay out every room that has a brief. Returns the whole building's furniture, a summary and a reachability check. */
export async function furnishBuilding(model: SpaceModel, briefByRoom: Record<string, string> = {}, opts: FurnishOptions = {}): Promise<FurnishResult> {
  const t0 = Date.now();
  const compile = opts.compile ?? ((b: string, sub: SpaceModel) => compileIntent(b, sub));
  const online = aiReady();
  const seed = opts.seed ?? 1;
  const ctx = buildContext(model);
  const totalBudget = opts.totalBudgetMs ?? 10000;
  const roomCap = opts.timeBudgetMs ?? 1200;
  const palette = opts.palette ?? hashOf(model.id) % WOOD_TONES.length;
  const handmade = !opts.solve && !opts.compile;
  let todo = model.spaces.length;
  let overBudget = false;
  // Time left per room still to start, never above the cap and never below a quick pass.
  const budgetNow = () => {
    const left = totalBudget - (Date.now() - t0);
    if (left <= 0) overBudget = true;
    return Math.max(250, Math.min(roomCap, left / Math.max(1, todo)));
  };
  // The solving runs in a worker, so the page keeps responding while a whole floor is furnished.
  const solveWith = async (sub: SpaceModel, req: Requirements, brief: string | undefined, budget: number) => {
    if (opts.solve) return opts.solve(sub, req, brief);
    if (online && !overBudget) {
      // the planner (a model call) decides the intent here; the exact solve happens in the worker
      const items = buildDesignItems(sub, req);
      if (items.length) {
        const program = await planProgram(sub, items, req, { brief, signal: opts.signal });
        const best = await solveRoomAsync({ kind: 'program', sub, req, seed, items, program });
        if (best?.length) return best;
      }
    }
    return solveRoomAsync({ kind: 'layout', sub, req, seed, timeBudgetMs: budget });
  };
  const progress: RoomProgress[] = model.spaces.map((s) => ({ spaceId: s.id, name: s.name, status: 'waiting' }));
  let finished = 0;
  const emit = (i: number, patch: Partial<RoomProgress>) => {
    progress[i] = { ...progress[i], ...patch };
    opts.onRoom?.({ ...progress[i] });
    if (patch.status === 'done' || patch.status === 'skipped' || patch.status === 'failed') opts.onProgress?.(++finished, progress.length);
  };
  const results = new Map<string, { items: FurnitureItem[]; offset: Vec2 }>();
  const peopleOf = (s: Space, brief: string): number => {
    const given = opts.people?.[s.id];
    if (given) return given;
    const m = /(\d+)\s+desk/.exec(brief);
    return m ? Number(m[1]) : roomPurpose(s) === 'study' ? 1 : 0;
  };
  const peopleByRoom = new Map<string, number>();
  const cache = new Map<string, Promise<FurnitureItem[] | null>>();
  let reused = 0;

  const solveRoom = async (s: Space, i: number, sub: SubModel, brief: string, custom: boolean): Promise<{ items: FurnitureItem[] | null; notes: string[] }> => {
    const p = roomPurpose(s);
    const notes: string[] = [];
    const budget = budgetNow();
    const late = overBudget;
    if (late) notes.push('Time budget used up, standard set only');
    // the room's own deadline: once spent, only the smallest set is still tried, briefly
    const deadline = Date.now() + budget * 2;
    const runSets = async (sets: string[][]) => {
      for (let k = 0; k < sets.length; k++) {
        const past = Date.now() > deadline;
        if (past && k < sets.length - 1) continue;
        const req = requirementsFor(p, sets[k]);
        const ms = late || past ? 250 : Math.max(200, Math.min(budget, deadline - Date.now()));
        const got = opts.solve ? await opts.solve(sub.model, req, brief) : await solveRoomAsync({ kind: 'layout', sub: sub.model, req, seed, timeBudgetMs: ms });
        if (got?.length) {
          if (k > 0 && sets.length > 1) notes.push('Smaller set: the full set did not fit');
          return got;
        }
      }
      return null;
    };
    const sets = custom ? [] : fixtureSets(s);
    if (sets.length) return { items: await runSets(sets), notes };
    if (handmade && !custom) {
      const n = peopleByRoom.get(s.id) ?? 0;
      let built: FurnitureItem[] = [];
      if ((p === 'workspace' || p === 'office') && n >= 2) built = officeClusters(sub.model, n);
      else if (p === 'study' || ((p === 'office' || p === 'workspace') && n === 1)) built = deskAtWindow(sub.model);
      else if (p === 'phone') built = deskAtWindow(sub.model, false);
      else if (p === 'meeting') built = meetingTable(sub.model, Math.max(4, Number((/for (\d+)/.exec(brief) ?? [])[1] ?? 6)));
      else if (p === 'reception') built = reception(sub.model);
      else if ((p === 'kitchen' || p === 'staff' || p === 'dining') && ctx.offices) built = kitchenette(sub.model);
      if (built.length) {
        const wantDesks = p === 'workspace' || p === 'office' ? Math.max(n, 1) : 0;
        if (!wantDesks || built.filter((f) => f.category === 'desk').length >= Math.min(wantDesks, 2)) return { items: built, notes };
      }
    }
    let items: FurnitureItem[] | null = null;
    if (!late) {
      try {
        const req = await compile(brief, sub.model);
        if (handmade && !custom && !req.routeTargets.length && ctx.graph.neighbours.get(s.id)?.length) {
          // keep the way through: living rooms open to the kitchen keep a wider route to the opening
          const openLiving = p === 'living' && ctx.openToKitchen.has(s.id);
          req.routeTargets = [{ kind: openLiving ? 'opening' : 'door' }];
          req.minRouteWidthM = Math.max(req.minRouteWidthM, openLiving ? 0.9 : 0.8);
        }
        items = await solveWith(sub.model, req, brief, budget);
      } catch (e) { if (custom) throw e; }
    }
    if (!items?.length && !custom) {
      items = await runSets(fallbackSets(s));
      if (items?.length && !late) notes.push('Standard set: the planned layout did not fit');
    }
    return { items, notes };
  };

  const jobs = model.spaces.map((s, i) => async () => { try { await job(s, i); } finally { todo--; } });
  const job = async (s: Space, i: number) => {
    if (opts.signal?.aborted) return;
    const started = Date.now();
    try {
      const custom = !!briefByRoom[s.id];
      const brief = briefByRoom[s.id] ?? contextBrief(model, s, ctx);
      if (!brief) { emit(i, { status: 'skipped', message: skipReason(s) ?? 'Nothing to furnish' }); return; }
      const sub = subModelFor(model, s.id);
      if (!sub) { emit(i, { status: 'failed', message: 'Room not found' }); return; }
      emit(i, { status: 'running', message: brief });
      const p = roomPurpose(s);
      peopleByRoom.set(s.id, peopleOf(s, brief));
      // identical or mirror-image rooms are solved once
      const w = bounds(sub.model.spaces[0].polygon);
      const width = w.maxX - w.minX;
      const keyBase = `${p}|${brief}|${peopleByRoom.get(s.id)}|`;
      const sigA = keyBase + roomSignature(sub.model, false), sigM = keyBase + roomSignature(sub.model, true);
      let items: FurnitureItem[] | null = null;
      let notes: string[] = [];
      let reusedFrom: string | undefined;
      const hit = !custom && (cache.get(sigA) ?? cache.get(sigM));
      if (hit) {
        const got = await hit;
        if (got?.length) {
          items = cache.get(sigA) ? got.map((f) => ({ ...f, id: uid('f') })) : mirrorItems(got, width);
          reusedFrom = 'identical room';
          reused++;
        }
      }
      if (!items) {
        const run = solveRoom(s, i, sub, brief, custom);
        if (!custom) cache.set(sigA, run.then((r) => r.items));
        const r = await run;
        items = r.items; notes = r.notes;
      }
      if (!items?.length) {
        if (isCirculation(p)) { emit(i, { status: 'skipped', message: 'Circulation', ms: Date.now() - started }); return; }
        emit(i, { status: 'failed', message: 'No layout fits this room', compromises: ['No layout fits this room'], ms: Date.now() - started });
        return;
      }
      // halls: only slim pieces
      if (handmade && isCirculation(p)) items = items.filter((f) => Math.min(f.w, f.d) <= 0.4);
      if (!items.length) { emit(i, { status: 'skipped', message: 'Circulation', ms: Date.now() - started }); return; }
      results.set(s.id, { items: applyPalette(items, palette), offset: sub.offset });
      emit(i, { status: 'done', items: items.length, compromises: notes, ms: reusedFrom ? 0 : Date.now() - started, reusedFrom });
    } catch (e) {
      emit(i, { status: 'failed', message: (e as Error).message.slice(0, 80), compromises: [(e as Error).message.slice(0, 80)], ms: Date.now() - started });
    }
  };
  // largest rooms first: the long jobs start early and the budget share of the small ones stays honest
  const order = model.spaces.map((s, i) => ({ i, a: area(s.polygon) })).sort((x, y) => y.a - x.a).map((x) => x.i);
  const width = Math.max(1, opts.parallel ?? 3);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => { while (next < order.length) await jobs[order[next++]](); }));

  let furniture = model.furniture;
  const roomByItem: Record<string, string> = {};
  for (const f of model.furniture) { const id = roomIdOf(model, f); if (id) roomByItem[f.id] = id; }
  for (const s of model.spaces) {
    const r = results.get(s.id);
    if (!r) continue;
    furniture = mergeFurniture({ ...model, furniture }, s.id, r.items, r.offset);
    // merged items are appended after the ones kept from other rooms
    for (const f of furniture.slice(furniture.length - r.items.length)) roomByItem[f.id] = s.id;
  }
  const reasonsBy = new Map<string, string[]>();
  const note = (spaceId: string, text: string) => { const l = reasonsBy.get(spaceId) ?? []; if (!l.includes(text)) l.push(text); reasonsBy.set(spaceId, l); };
  for (const r of progress) for (const c of r.compromises ?? []) note(r.spaceId, c);
  const drop = (f: FurnitureItem, why: string) => { furniture = furniture.filter((x) => x.id !== f.id); const rid = roomByItem[f.id]; if (rid) note(rid, why); delete roomByItem[f.id]; };
  const placedIds = new Set(Object.keys(roomByItem).filter((id) => results.has(roomByItem[id]) && !model.furniture.some((m) => m.id === id)));
  const mine = () => furniture.filter((f) => placedIds.has(f.id));

  const spaceOf = (f: FurnitureItem) => model.spaces.find((s) => s.id === roomByItem[f.id]);
  const roomMates = (f: FurnitureItem) => furniture.filter((x) => roomByItem[x.id] === roomByItem[f.id]);
  // A desk or table and the chairs drawn up to it are one group: they move together, keeping their
  // relative pose, and go together. A chair is never moved away from its desk on its own.
  const anchorOf = (f: FurnitureItem): FurnitureItem | null => {
    if (ANCHORS.has(f.category)) return f;
    if (!SEATS.has(f.category)) return null;
    const near = roomMates(f).filter((a) => ANCHORS.has(a.category)).map((a) => ({ a, d: Math.hypot(a.x - f.x, a.y - f.y) - Math.max(a.w, a.d) / 2 }));
    near.sort((x, y) => x.d - y.d);
    return near[0] && near[0].d <= 0.8 ? near[0].a : null;
  };
  const groupOf = (f: FurnitureItem): FurnitureItem[] => {
    const a = anchorOf(f);
    if (!a) return [f];
    return [a, ...roomMates(a).filter((c) => c.id !== a.id && SEATS.has(c.category) && anchorOf(c)?.id === a.id)];
  };
  /** Move the piece (with its whole group) to the nearest spot that passes `ok`, else remove the group. */
  const settle = (f: FurnitureItem, ok: (g: FurnitureItem) => boolean, moved: string, removed: string) => {
    const group = groupOf(f);
    const s = spaceOf(f);
    const lead = group[0];
    const g = s ? relocate(group, s.polygon, roomMates(f), ok) : null;
    const rid = roomByItem[f.id];
    if (g) {
      const byId = new Map(g.map((x) => [x.id, x]));
      furniture = furniture.map((x) => byId.get(x.id) ?? x);
      if (rid) note(rid, `${lead.name} ${moved}`);
    } else if (lead.id !== f.id) drop(f, `${f.name} ${removed}`); // a seat in the way goes; its desk stays
    else for (const x of group) drop(x, `${x.name} ${removed}`); // a desk or table goes with its seats
  };
  // nothing in front of any door, on either side: a piece there moves to the nearest clear spot, else goes
  const zones = doorZones(model.spaces, model.openings);
  for (const f0 of mine()) {
    const f = furniture.find((x) => x.id === f0.id);
    if (!f || !hitsZone(f, zones)) continue;
    settle(f, (c) => !hitsZone(c, zones), 'moved clear of a door', 'removed: it stood in front of a door');
  }
  // density: a room much fuller than the building average gives up its decorations
  const dens = () => {
    const d: Record<string, number> = {};
    for (const s of model.spaces) {
      const foot = furniture.filter((f) => roomByItem[f.id] === s.id && f.category !== 'rug').reduce((q, f) => q + f.w * f.d, 0);
      if (foot > 0) d[s.id] = Math.round((foot / area(s.polygon)) * 1000) / 1000;
    }
    return d;
  };
  const d0 = dens();
  const vals = Object.values(d0).sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)] ?? 0;
  for (const s of model.spaces) if ((d0[s.id] ?? 0) > Math.max(0.3, median * 1.8)) for (const f of mine()) if (roomByItem[f.id] === s.id && (f.category === 'plant' || f.category === 'lamp')) drop(f, `${f.name} left out: the room is crowded`);
  // the building check: every room reachable at walkway width; remove the piece that blocks a door until it is
  const walk = opts.walkwayM ?? 0.8;
  let check = checkBuilding(model, furniture, walk);
  for (let guard = 0; guard < 12 && !check.ok; guard++) {
    const targets = new Set([...check.unreachable, ...check.blockedDoors.map((id) => model.openings.find((o) => o.id === id)?.spaceId).filter((x): x is string => !!x)]);
    const spots = model.openings.filter((o) => o.kind !== 'window').map((o) => { const sp = model.spaces.find((x) => x.id === o.spaceId); return sp ? { o, c: openingSegment(sp, o).c } : null; }).filter((x): x is NonNullable<typeof x> => !!x);
    const near = spots.filter(({ o }) => targets.has(o.spaceId) || check.blockedDoors.includes(o.id)).map((x) => x.c);
    // also the doors on the other side of a blocked room
    const cand = mine().filter((f) => near.some((c) => Math.hypot(f.x - c.x, f.y - c.y) < 1.6 + Math.max(f.w, f.d) / 2)).sort((a, b) => b.w * b.d - a.w * a.d);
    if (!cand.length) break;
    const clearOf = (c: FurnitureItem) => !hitsZone(c, zones) && near.every((q) => Math.hypot(c.x - q.x, c.y - q.y) >= 1.6 + Math.max(c.w, c.d) / 2);
    settle(cand[0], clearOf, 'moved: it blocked the way into a room', 'removed: it blocked the way into a room');
    check = checkBuilding(model, furniture, walk);
  }
  // what each purpose must still contain
  for (const s of model.spaces) {
    const r = results.get(s.id);
    if (!r) continue;
    for (const why of missingEssentials(roomPurpose(s), furniture.filter((f) => roomByItem[f.id] === s.id), peopleByRoom.get(s.id) ?? 0)) note(s.id, why);
  }
  const rooms = progress.map((r) => ({ ...r, compromises: reasonsBy.get(r.spaceId) ?? [] }));
  const bill = buildingBill(model, furniture);
  const done = rooms.filter((r) => r.status === 'done').length;
  const summary: FurnishSummary = {
    items: furniture.length, totalSek: bill.totalSek, roomsDone: done,
    roomsSkipped: rooms.filter((r) => r.status === 'skipped').length, roomsFailed: rooms.filter((r) => r.status === 'failed').length,
    roomsCompromised: rooms.filter((r) => r.compromises.length && r.status !== 'skipped').map((r) => ({ spaceId: r.spaceId, name: r.name, reasons: r.compromises })),
    density: dens(), reused,
    palette: { wood: WOOD_TONES[palette].material, fabric: FABRIC_TONES[palette].material },
    ms: Date.now() - t0, overBudget,
  };
  return { furniture, rooms, roomByItem, summary, check };
}

export interface BillLine { catalogId: string; name: string; category: string; qty: number; unitSek: number; totalSek: number; rooms: string[] }
export interface Bill { lines: BillLine[]; items: number; totalSek: number; byRoom: Array<{ spaceId: string; name: string; items: number; totalSek: number }> }

/** Whole-building bill of furniture: one line per product with quantities, rooms and totals. */
export function buildingBill(model: SpaceModel, furniture: FurnitureItem[] = model.furniture): Bill {
  const roomOf = (f: FurnitureItem) => model.spaces.find((s) => pointInPolygon(f, s.polygon));
  const lines = new Map<string, BillLine>();
  const byRoom = new Map<string, { spaceId: string; name: string; items: number; totalSek: number }>();
  for (const f of furniture) {
    const key = `${f.catalogId}|${f.name}`;
    const room = roomOf(f);
    const price = f.owned ? 0 : f.priceSek || 0;
    const l = lines.get(key) ?? { catalogId: f.catalogId, name: f.name, category: f.category, qty: 0, unitSek: price, totalSek: 0, rooms: [] };
    l.qty++; l.totalSek += price;
    if (room && !l.rooms.includes(room.name)) l.rooms.push(room.name);
    lines.set(key, l);
    if (room) {
      const r = byRoom.get(room.id) ?? { spaceId: room.id, name: room.name, items: 0, totalSek: 0 };
      r.items++; r.totalSek += price;
      byRoom.set(room.id, r);
    }
  }
  const sorted = [...lines.values()].sort((a, b) => b.totalSek - a.totalSek || a.name.localeCompare(b.name));
  return {
    lines: sorted, items: furniture.length, totalSek: sorted.reduce((s, l) => s + l.totalSek, 0),
    byRoom: model.spaces.map((s) => byRoom.get(s.id)).filter((x): x is NonNullable<typeof x> => !!x),
  };
}

/** Centre of a room in building coordinates (for labels and camera targets). */
export const roomCentre = (s: Space) => centroid(s.polygon);
