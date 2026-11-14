/**
 * Answers questions about a plan from the geometry built out of it (rooms, doors, windows),
 * with the matching rooms highlighted on the sheet. No model calls.
 */
import type { SpaceModel, Vec2 } from '../../core/types';
import type { Answer, Region } from './answer';
import type { BuildReport, RoomReport } from './toBuilding';

let seq = 0;
const mk = (question: string, a: Omit<Answer, 'id' | 'question'>): Answer => ({ id: `g${seq++}`, question, ...a });
const fmt = (v: number, d = 1) => v.toFixed(d);
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

function regionOf(r: RoomReport, page: number): Region {
  const xs = r.outline.map((p) => p.x), ys = r.outline.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { page, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

const PURPOSE_WORDS: Array<[RegExp, string]> = [
  [/bath|bad\b|badezimmer|bagno|salle de bain|kylpy|badrum/, 'bathroom'],
  [/kitchen|küche|kuche|cucina|cuisine|keittiö|kök/, 'kitchen'],
  [/bedroom|schlafzimmer|zimmer|chambre|camera|stanza|makuuhuone|sovrum/, 'bedroom'],
  [/living|wohnen|séjour|soggiorno|olohuone|vardagsrum/, 'living'],
  [/hall|corridor|korridor|flur|couloir|corridoio|eteinen/, 'hallway'],
  [/stair|treppe|escalier|scala|porras/, 'stair'],
  [/storage|reduit|réduit|ripostiglio|abstell|varasto|förråd/, 'storage'],
  [/balcon|balkon|loggia|terrace|terrasse|terrazza|parveke/, 'balcony'],
  [/\bwc\b|toilet/, 'wc'],
];

function findRoomsByWord(rep: BuildReport, q: string): RoomReport[] {
  const no = q.match(/\b([A-Z]{0,2}\d{1,2}\.\d{2,3})\b/i)?.[1];
  if (no) { const r = rep.rooms.filter((x) => x.no === no); if (r.length) return r; }
  for (const [re, purpose] of PURPOSE_WORDS) if (re.test(q)) return rep.rooms.filter((r) => r.purpose === purpose || (purpose === 'bathroom' && r.purpose === 'wc'));
  return [];
}

/** Door graph between rooms: edges through the doors both rooms carry. */
function doorGraph(model: SpaceModel) {
  const byDoor = new Map<string, Array<{ spaceId: string; at: Vec2 }>>();
  for (const o of model.openings) {
    if (o.kind === 'window') continue;
    const sp = model.spaces.find((s) => s.id === o.spaceId); if (!sp) continue;
    const a = sp.polygon[o.wallIndex], b = sp.polygon[(o.wallIndex + 1) % sp.polygon.length];
    const L = dist(a, b) || 1;
    const at = { x: a.x + ((b.x - a.x) / L) * o.offsetM, y: a.y + ((b.y - a.y) / L) * o.offsetM };
    const key = o.id.split('~')[0];
    byDoor.set(key, [...(byDoor.get(key) ?? []), { spaceId: o.spaceId, at }]);
  }
  return byDoor;
}

const centreOf = (model: SpaceModel, id: string) => {
  const sp = model.spaces.find((s) => s.id === id)!;
  return sp.polygon.reduce((s, p) => ({ x: s.x + p.x / sp.polygon.length, y: s.y + p.y / sp.polygon.length }), { x: 0, y: 0 });
};

/** Shortest walk from room centre to room centre through door midpoints (Dijkstra over doors). */
export function walkDistance(model: SpaceModel, from: string, to: string): { metres: number; rooms: string[] } | null {
  const doors = doorGraph(model);
  type Node = { key: string; space: string; at: Vec2 };
  const start: Node = { key: 'start', space: from, at: centreOf(model, from) };
  const goal = centreOf(model, to);
  const distMap = new Map<string, number>([['start', 0]]);
  const prev = new Map<string, string>();
  const nodeOf = new Map<string, Node>([['start', start]]);
  const open: Node[] = [start];
  const done = new Set<string>();
  let best: { metres: number; last: string } | null = null;
  while (open.length) {
    open.sort((a, b) => distMap.get(a.key)! - distMap.get(b.key)!);
    const cur = open.shift()!;
    if (done.has(cur.key)) continue;
    done.add(cur.key);
    const d0 = distMap.get(cur.key)!;
    if (cur.space === to) { const m = d0 + dist(cur.at, goal); if (!best || m < best.metres) best = { metres: m, last: cur.key }; continue; }
    for (const [key, sides] of doors) {
      const here = sides.find((s) => s.spaceId === cur.space);
      if (!here) continue;
      for (const other of sides) {
        if (other.spaceId === cur.space) continue;
        const nk = `${key}>${other.spaceId}`;
        const nd = d0 + dist(cur.at, here.at) + dist(here.at, other.at);
        if (nd < (distMap.get(nk) ?? Infinity)) { distMap.set(nk, nd); prev.set(nk, cur.key); const n = { key: nk, space: other.spaceId, at: other.at }; nodeOf.set(nk, n); open.push(n); }
      }
    }
  }
  if (!best) return null;
  const rooms: string[] = [];
  for (let k: string | undefined = best.last; k; k = prev.get(k)) rooms.unshift(nodeOf.get(k)!.space);
  return { metres: best.metres, rooms };
}

/** The room where the flat is entered: a hallway with a door to the stairs or to outside. */
function entranceRoom(rep: BuildReport, model: SpaceModel, near?: string): RoomReport | null {
  const doors = doorGraph(model);
  const purpose = new Map(rep.rooms.map((r) => [r.spaceId, r.purpose]));
  const cands = new Set<string>();
  for (const sides of doors.values()) {
    if (sides.length === 1) cands.add(sides[0].spaceId); // a door to outside
    for (const s of sides) if (sides.some((o) => o !== s && purpose.get(o.spaceId) === 'stair') && purpose.get(s.spaceId) !== 'stair') cands.add(s.spaceId);
  }
  let list = rep.rooms.filter((r) => cands.has(r.spaceId));
  if (!list.length) list = rep.rooms.filter((r) => r.purpose === 'hallway');
  if (!list.length) return null;
  if (near) { const c = centreOf(model, near); list.sort((a, b) => dist(a.centre, c) - dist(b.centre, c)); }
  return list[0];
}

export function answerFromGeometry(rep: BuildReport, model: SpaceModel, question: string): Answer | null {
  if (!rep.ok || !rep.rooms.length) return null;
  const q = question.toLowerCase();
  const page = rep.page;
  const reg = (rs: RoomReport[]) => rs.slice(0, 30).map((r) => regionOf(r, page));
  const many = /how many|count|number of|wie viele|anzahl|combien|quant[ie]|kuinka monta|hur många/.test(q);

  if (many && /window|fenster|fenêtre|fenetre|finestr|ikkun|fönster/.test(q) && /room|zimmer|räume|pièce|stanz|huone|rum/.test(q)) {
    const rs = rep.rooms.filter((r) => r.windows > 0);
    return mk(question, { answer: `${rs.length} of ${rep.rooms.length} rooms have a window: ${rs.map((r) => r.name).join(', ')}`, value: rs.length, kind: 'calculated', method: 'index', regions: reg(rs) });
  }
  if (many && /window|fenster|fenêtre|fenetre|finestr|ikkun|fönster/.test(q)) {
    return mk(question, { answer: `${rep.windows} windows found in the wall lines`, value: rep.windows, kind: 'calculated', method: 'index', regions: reg(rep.rooms.filter((r) => r.windows > 0)) });
  }
  if (many && /door|tür|tur\b|porte|porta|ovi|dörr/.test(q)) {
    return mk(question, { answer: `${rep.doorSwings} door swings drawn on the sheet`, value: rep.doorSwings, kind: 'calculated', method: 'index', regions: reg(rep.rooms.filter((r) => r.doors > 0)) });
  }
  if (/largest|biggest|grösste|größte|plus grand|più grand|suurin|största/.test(q) || /smallest|kleinste|plus petit|più piccol|pienin|minsta/.test(q)) {
    const small = /smallest|kleinste|plus petit|più piccol|pienin|minsta/.test(q);
    const pool = rep.rooms.filter((r) => r.no || r.printedArea != null);
    const list = (pool.length ? pool : rep.rooms).slice().sort((a, b) => (small ? a.computedArea - b.computedArea : b.computedArea - a.computedArea));
    const r = list[0];
    const printed = r.printedArea != null ? ` (printed ${fmt(r.printedArea, 2)} m²)` : '';
    return mk(question, { answer: `${r.name}: ${fmt(r.computedArea, 2)} m²${printed}`, value: r.computedArea, unit: 'm²', kind: 'calculated', method: 'index', regions: reg([r]) });
  }
  if (/distance|how far|wie weit|entfernung|distanza|quanto dista|matka|avstånd/.test(q)) {
    const parts = q.split(/\bto\b|\bzu[mr]?\b|\bnach\b|\bà\b|\bal(?:la)?\b|\bjusqu/);
    const target = findRoomsByWord(rep, parts[parts.length - 1] ?? q);
    const fromRooms =parts.length > 1 ? findRoomsByWord(rep, parts[0]) : [];
    const fromEntrance = /entrance|entry|front door|eingang|entrée|entree|ingresso|sisäänkäynti|entré/.test(parts[0] ?? q);
    if (!target.length) return null;
    const results: Array<{ from: RoomReport; to: RoomReport; w: { metres: number; rooms: string[] } }> = [];
    for (const t of target.slice(0, 12)) {
      const f = fromEntrance ? entranceRoom(rep, model, t.spaceId) : fromRooms[0];
      if (!f) continue;
      const w = walkDistance(model, f.spaceId, t.spaceId);
      if (w) results.push({ from: f, to: t, w });
    }
    if (!results.length) return null;
    results.sort((a, b) => a.w.metres - b.w.metres);
    const best = results[0];
    const via = best.w.rooms.map((id) => rep.rooms.find((r) => r.spaceId === id)!).filter(Boolean);
    return mk(question, {
      answer: `About ${fmt(best.w.metres)} m walking from ${best.from.name} to ${best.to.name}, through ${Math.max(0, via.length - 1)} door${via.length === 2 ? '' : 's'} (room centre to room centre, via door midpoints)`,
      value: Math.round(best.w.metres * 10) / 10, unit: 'm', kind: 'calculated', method: 'index', regions: reg(via),
    });
  }
  if (many && /room|zimmer|räume|pièce|stanz|huone|rum/.test(q) && !/label|bezeichnung|«|'|"/.test(q)) {
    return mk(question, { answer: `${rep.rooms.length} rooms built from the plan`, value: rep.rooms.length, kind: 'calculated', method: 'index', regions: reg(rep.rooms) });
  }
  return null;
}
