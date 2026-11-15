// Offline quality scorecard for furnished rooms: runs the same pipeline the intent panel uses
// (compile the sentence with rules, design, auto-pick) and measures the result as a specialist would.
import { distPointSegment, doorSwingPolygon, convexOverlap, itemCorners, pointInPolygon, wallSegment } from '../core/geometry';
import type { FurnitureItem, Infeasibility, Opening, SpaceModel, Vec2 } from '../core/types';
import { compileIntent } from '../features/intent/compile';
import { designRoom, type DesignResult } from '../features/design/pipeline';
import { isFinalResult, pickAuto } from '../features/layout/progress';
import { opening, rect, room } from '../features/referee/fixtures';

export interface RoomCase { name: string; sentence: string; w: number; d: number; theme?: string; impossible?: boolean; normal?: boolean }

export interface Scorecard {
  name: string; sentence: string; roomM: string;
  items: number; categories: number; overlaps: string[]; outside: string[]; doorBlocked: boolean;
  /** Narrowest passage on the widest route from the door to any seat or bed, metres; null when nothing to reach. */
  walkwayM: number | null; unreachable: string[];
  wallFraction: number | null; headboardFraction: number | null; chairFacing: number | null; seatTableHit: number | null; themeHit: boolean | null;
  infeasibility: Infeasibility | null; requested: number; score: number; ms: number; notes: string[];
}

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
export const scorecardOn = env.SCORECARD === '1';

export const CASES: RoomCase[] = [
  { name: 'cat', sentence: 'a room for my cat named Gerard', w: 3.5, d: 3, theme: 'gerard', normal: true },
  { name: 'office2', sentence: 'home office for two', w: 4, d: 3.5, normal: true },
  { name: 'studio', sentence: 'tiny studio', w: 5, d: 4, normal: true },
  { name: 'teen', sentence: 'bedroom for a teenager who games', w: 3.2, d: 3, normal: true },
  { name: 'cafe', sentence: 'cafe with 20 seats', w: 8, d: 6, normal: true },
  { name: 'living', sentence: 'family living room with a dog', w: 5.5, d: 4.2, normal: true },
  { name: 'nook', sentence: 'reading nook', w: 2.4, d: 2.2 },
  { name: 'meeting', sentence: 'meeting room for 8', w: 6, d: 4, normal: true },
  { name: 'double', sentence: 'double bedroom', w: 3.8, d: 3.6, normal: true },
  { name: 'impossible', sentence: 'living room for a family of four with a dog', w: 2, d: 2, impossible: true },
];

export function caseModel(c: RoomCase): SpaceModel {
  const doors: Opening[] = [opening('door', 'door', 0, Math.min(0.8, c.w / 2), 0.9, 'in'), opening('win', 'window', 2, c.w / 2, 1.2)];
  return room(rect(c.w, c.d), doors);
}

const floorItems = (fs: FurnitureItem[]) => fs.filter((f) => f.mount !== 'wall' && f.mount !== 'ceiling' && f.category !== 'rug');
const SEAT = new Set(['bed', 'sofa', 'armchair', 'chair', 'office-chair', 'stool', 'bench']);
const CHAIRS = new Set(['chair', 'office-chair', 'stool']);
const WALLISH = /bed|desk|wardrobe|shelf|bookshelf|dresser|tv|filing/i;
const isTable = (f: FurnitureItem) => f.category === 'table' || f.category === 'coffee-table' || /desk|table|counter/i.test(f.catalogId);
const isWallish = (f: FurnitureItem) => !/nightstand/i.test(f.catalogId) && (WALLISH.test(f.catalogId) || WALLISH.test(f.category) || (f.category === 'storage-cabinet' && /ward/i.test(f.name)));

const polyDist = (a: Vec2[], b: Vec2[]): number => {
  if (convexOverlap(a, b) > 0) return 0;
  let m = Infinity;
  for (const p of a) for (let i = 0; i < b.length; i++) m = Math.min(m, distPointSegment(p, b[i], b[(i + 1) % b.length]));
  for (const p of b) for (let i = 0; i < a.length; i++) m = Math.min(m, distPointSegment(p, a[i], a[(i + 1) % a.length]));
  return m;
};

const pointPolyDist = (p: Vec2, poly: Vec2[]): number =>
  pointInPolygon(p, poly) ? 0 : Math.min(...poly.map((q, i) => distPointSegment(p, q, poly[(i + 1) % poly.length])));

function doorInside(model: SpaceModel, o: Opening) {
  const [p, q] = wallSegment(model.spaces[0], o.wallIndex);
  const len = Math.hypot(q.x - p.x, q.y - p.y), dir = { x: (q.x - p.x) / len, y: (q.y - p.y) / len };
  const c = { x: p.x + dir.x * o.offsetM, y: p.y + dir.y * o.offsetM };
  const n = { x: -dir.y, y: dir.x };
  const inward = pointInPolygon({ x: c.x + n.x * 0.2, y: c.y + n.y * 0.2 }, model.spaces[0].polygon) ? n : { x: -n.x, y: -n.y };
  return { c, inward };
}

/** Widest-route search on a 10 cm grid: each cell's width is twice its distance to the nearest wall or piece. */
function walkway(model: SpaceModel, items: FurnitureItem[], targets: FurnitureItem[], door: Opening | undefined) {
  const poly = model.spaces[0].polygon;
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), cols = Math.ceil((Math.max(...xs) - x0) / 0.1), rows = Math.ceil((Math.max(...ys) - y0) / 0.1);
  const polys = floorItems(items).map((f) => itemCorners(f));
  const walls = poly.map((_, i) => wallSegment(model.spaces[0], i));
  const clear = new Float32Array(cols * rows).fill(-1);
  const at = (c: number, r: number): Vec2 => ({ x: x0 + (c + 0.5) * 0.1, y: y0 + (r + 0.5) * 0.1 });
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const p = at(c, r);
    if (!pointInPolygon(p, poly) || polys.some((q) => pointInPolygon(p, q))) continue;
    let m = Infinity;
    for (const [a, b] of walls) m = Math.min(m, distPointSegment(p, a, b));
    for (const q of polys) for (let i = 0; i < q.length; i++) m = Math.min(m, distPointSegment(p, q[i], q[(i + 1) % q.length]));
    clear[r * cols + c] = m;
  }
  const widths = new Map<string, number>(); const unreachable: string[] = [];
  if (!door) return { widths, unreachable };
  const seg = doorInside(model, door);
  let sc = Math.min(cols - 1, Math.max(0, Math.floor((seg.c.x + seg.inward.x * 0.45 - x0) / 0.1)));
  let sr = Math.min(rows - 1, Math.max(0, Math.floor((seg.c.y + seg.inward.y * 0.45 - y0) / 0.1)));
  if (clear[sr * cols + sc] < 0) {
    let bd = Infinity;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (clear[r * cols + c] >= 0) { const d = Math.hypot(c - sc, r - sr); if (d < bd) { bd = d; sc = c; sr = r; } }
  }
  const best = new Float32Array(cols * rows).fill(-1);
  const start = sr * cols + sc;
  best[start] = 2;
  const heap: Array<[number, number]> = [[best[start], start]];
  while (heap.length) {
    let k = 0; for (let i = 1; i < heap.length; i++) if (heap[i][0] > heap[k][0]) k = i;
    const [w, id] = heap.splice(k, 1)[0];
    if (w < best[id]) continue;
    const c = id % cols, r = (id - c) / cols;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const n = nr * cols + nc; if (clear[n] < 0) continue;
      const nw = Math.min(w, 2 * clear[n] + 0.05); // +5 cm: cell centres sit up to half a cell off the true middle
      if (nw > best[n]) { best[n] = nw; heap.push([nw, n]); }
    }
  }
  for (const t of targets) {
    const tc = itemCorners(t); let w = -1;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const v = best[r * cols + c];
      if (v > w && pointPolyDist(at(c, r), tc) <= 0.45) w = v;
    }
    if (w < 0) unreachable.push(t.name); else widths.set(t.id, w);
  }
  return { widths, unreachable };
}

export async function runCase(c: RoomCase): Promise<{ card: Scorecard; furniture: FurnitureItem[]; model: SpaceModel; res: DesignResult }> {
  const model = caseModel(c);
  const t0 = Date.now();
  const req = await compileIntent(c.sentence, model);
  const res = await designRoom(model, req, { variants: 1, brief: c.sentence });
  const best = isFinalResult(res) ? pickAuto(res.candidates, res.reports) : (res.candidates[0] ?? null);
  const furniture = best?.furniture ?? [];
  const card = scoreLayout(c, model, furniture, res.infeasibility, req.items.reduce((s, i) => s + Math.max(1, i.qty), 0), Date.now() - t0);
  return { card, furniture, model, res };
}

export function scoreLayout(c: RoomCase, model: SpaceModel, furniture: FurnitureItem[], infeasibility: Infeasibility | null, requested: number, ms = 0): Scorecard {
  const poly = model.spaces[0].polygon;
  const fl = floorItems(furniture);
  const notes: string[] = [];
  const overlaps: string[] = [];
  for (let i = 0; i < fl.length; i++) for (let j = i + 1; j < fl.length; j++) {
    if (convexOverlap(itemCorners(fl[i]), itemCorners(fl[j])) > 0.01) overlaps.push(`${fl[i].name} / ${fl[j].name}`);
  }
  const outside = fl.filter((f) => !itemCorners({ ...f, w: f.w - 0.02, d: f.d - 0.02 }).every((p) => pointInPolygon(p, poly))).map((f) => f.name);
  const door = model.openings.find((o) => o.kind === 'door');
  const swing = door && doorSwingPolygon(model.spaces[0], door);
  const doorBlocked = !!swing && fl.some((f) => convexOverlap(itemCorners(f), swing) > 0.01);
  const targets = fl.filter((f) => SEAT.has(f.category));
  const wk = walkway(model, furniture, targets, door);
  const walkwayM = targets.length ? (wk.unreachable.length ? 0 : Math.min(...wk.widths.values())) : null;
  const wallish = fl.filter(isWallish);
  const against = (f: FurnitureItem) => {
    const cs = itemCorners(f);
    return poly.some((_, i) => { const [a, b] = wallSegment(model.spaces[0], i); return cs.some((p) => distPointSegment(p, a, b) <= 0.12); });
  };
  const wallFraction = wallish.length ? wallish.filter(against).length / wallish.length : null;
  const chairs = fl.filter((f) => CHAIRS.has(f.category)), tables = fl.filter(isTable);
  const seatTableHit = chairs.length && tables.length ? chairs.filter((ch) => tables.some((t) => polyDist(itemCorners(ch), itemCorners(t)) <= 0.6)).length / chairs.length : (chairs.length ? 0 : null);
  const front = (f: FurnitureItem): Vec2 => ({ x: -Math.sin(f.rotation), y: Math.cos(f.rotation) });
  const beds = fl.filter((f) => f.category === 'bed');
  const headboardFraction = beds.length ? beds.filter((f) => {
    const fr = front(f), back = { x: f.x - fr.x * f.d / 2, y: f.y - fr.y * f.d / 2 };
    return poly.some((_, i) => { const [a, b] = wallSegment(model.spaces[0], i); return distPointSegment(back, a, b) <= 0.12; });
  }).length / beds.length : null;
  const facesTable = (ch: FurnitureItem) => tables.some((t) => {
    const tc = itemCorners(t);
    if (polyDist(itemCorners(ch), tc) > 0.7) return false;
    let best = { x: t.x, y: t.y }, bd = Infinity;
    for (let i = 0; i < tc.length; i++) for (let k = 0; k <= 10; k++) {
      const a = tc[i], b = tc[(i + 1) % tc.length], p = { x: a.x + (b.x - a.x) * k / 10, y: a.y + (b.y - a.y) * k / 10 };
      const d = Math.hypot(p.x - ch.x, p.y - ch.y); if (d < bd) { bd = d; best = p; }
    }
    const fr = front(ch), vx = best.x - ch.x, vy = best.y - ch.y, vl = Math.hypot(vx, vy) || 1;
    return Math.acos(Math.max(-1, Math.min(1, (fr.x * vx + fr.y * vy) / vl))) <= (20 * Math.PI) / 180;
  });
  const chairFacing = chairs.length && tables.length ? chairs.filter(facesTable).length / chairs.length : (chairs.length ? 0 : null);
  const themeHit = c.theme ? furniture.some((f) => f.name.toLowerCase().includes(c.theme!)) : null;
  const categories = new Set(furniture.map((f) => f.category)).size;

  // Score: 100 minus a penalty for every defect a specialist would flag.
  let score = 100;
  score -= Math.min(30, overlaps.length * 10);
  score -= Math.min(30, outside.length * 10);
  if (doorBlocked) score -= 15;
  if (walkwayM !== null && walkwayM < 0.6) score -= Math.min(25, Math.round((0.6 - walkwayM) * 50));
  if (wallFraction !== null) score -= Math.round((1 - wallFraction) * 10);
  if (seatTableHit !== null) score -= Math.round((1 - seatTableHit) * 5);
  if (chairFacing !== null) score -= Math.round((1 - chairFacing) * 8);
  if (headboardFraction !== null) score -= Math.round((1 - headboardFraction) * 8);
  if (themeHit === false) score -= 10;
  if (!c.impossible && furniture.length < 6) score -= (6 - furniture.length) * 4;
  if (requested > 0 && furniture.length < requested && !infeasibility) { score -= 10; notes.push(`placed ${furniture.length} of ${requested} asked for, no compromise reported`); }
  if (c.impossible && !infeasibility) { score -= 20; notes.push('no infeasibility reported'); }
  score = Math.max(0, Math.min(100, score));

  if (overlaps.length) notes.push(`overlaps: ${overlaps.slice(0, 3).join('; ')}`);
  if (outside.length) notes.push(`outside: ${outside.slice(0, 3).join(', ')}`);
  if (doorBlocked) notes.push('door swing blocked');
  if (walkwayM !== null && walkwayM < 0.6) notes.push(`walkway ${Math.round(walkwayM * 100)} cm${wk.unreachable.length ? `, unreachable: ${wk.unreachable.slice(0, 3).join(', ')}` : ''}`);
  if (wallFraction !== null && wallFraction < 1) notes.push(`${Math.round((1 - wallFraction) * 100)}% of wall pieces float`);
  if (seatTableHit !== null && seatTableHit < 1) notes.push('chairs away from tables');
  if (chairFacing !== null && chairFacing < 1) notes.push(`${Math.round((1 - chairFacing) * 100)}% of chairs not within 70 cm of a table facing it`);
  if (headboardFraction !== null && headboardFraction < 1) notes.push('bed headboard not on a wall');
  if (themeHit === false) notes.push(`theme word "${c.theme}" absent from names`);
  if (furniture.length < 6 && !c.impossible) notes.push(`only ${furniture.length} items`);

  return { name: c.name, sentence: c.sentence, roomM: `${c.w}x${c.d}`, items: furniture.length, categories, overlaps, outside, doorBlocked, walkwayM, unreachable: wk.unreachable, wallFraction, headboardFraction, chairFacing, seatTableHit, themeHit, infeasibility, requested, score, ms, notes };
}

const pct = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);
export function scorecardMarkdown(cards: Scorecard[]): string {
  const rows = cards.map((s) => `| ${s.name} | ${s.roomM} | ${s.items}/${s.requested} | ${s.categories} | ${s.overlaps.length} | ${s.outside.length} | ${s.doorBlocked ? 'yes' : 'no'} | ${s.walkwayM === null ? 'n/a' : Math.round(s.walkwayM * 100)} | ${pct(s.wallFraction)} | ${pct(s.headboardFraction)} | ${pct(s.chairFacing)} | ${pct(s.seatTableHit)} | ${s.themeHit === null ? 'n/a' : s.themeHit ? 'yes' : 'no'} | ${s.infeasibility ? 'yes' : 'no'} | **${s.score}** |`);
  const worst = [...cards].sort((a, b) => a.score - b.score).slice(0, 3);
  const avg = Math.round(cards.reduce((a, s) => a + s.score, 0) / Math.max(1, cards.length));
  return ['# Furnishing scorecard (offline, no key)', '', `Average score ${avg}/100 over ${cards.length} rooms.`, '',
    '| case | room m | items/asked | categories | overlaps | outside | door blocked | walkway cm | wall fraction | headboard | chair facing | seat-table | theme | infeasibility | score |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|', ...rows, '', '## Weakest three', '',
    ...worst.map((s) => `- **${s.name}** ("${s.sentence}", ${s.roomM}) score ${s.score}: ${s.notes.join(' | ') || 'small penalties add up'}`), ''].join('\n');
}
