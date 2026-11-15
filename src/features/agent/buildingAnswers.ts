// Instant answers about a whole plan (several rooms), computed from the model: no key, no network.
// Each answer is a short line with the number first plus a highlight the plan can light up.
import { area as polyArea, bounds, centroid, convexOverlap, dist, distPointPolygonEdges, itemCorners, perimeter, pointInPolygon, polygonInside } from '../../core/geometry';
import type { FurnitureItem, SpaceModel, Vec2 } from '../../core/types';
import { describeDoors, type DoorInfo } from '../safety/field';

/** What to light up on the plan for an answer. Route is a polyline in plan metres. */
export interface Highlight { spaceIds?: string[]; openingIds?: string[]; route?: Vec2[] }
export interface Answer { text: string; highlight?: Highlight }

export function has(t: string, alts: string): boolean {
  return new RegExp(`(?<![\\p{L}])(?:${alts})`, 'u').test(t);
}

const n1 = (v: number) => (Math.round(v * 10) / 10).toString();
const n2 = (v: number) => (Math.round(v * 100) / 100).toString();
const pct = (v: number) => `${Math.round(v * 100)}%`;
const list = (names: string[], max = 3) => (names.length > max ? `${names.slice(0, max).join(', ')}, +${names.length - max}` : names.join(', '));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Room kinds people name in three languages, matched against the room's own name.
const ROOM_WORDS: string[] = [
  'kitchen|kök|keittiö', 'bedroom|sovrum|makuuhuone', 'bathroom|badrum|kylpyhuone', 'living|vardagsrum|olohuone',
  'hall|hallway|entré|eteinen', 'office|kontor|työhuone', 'toilet|wc|vessa', 'balcony|balkong|parveke', 'dining|matsal|ruokailu',
];

function roomsNamed(t: string, model: SpaceModel) {
  const hits: Array<{ at: number; idx: number }> = [];
  const seen = new Set<number>();
  model.spaces.forEach((s, idx) => {
    const name = s.name.toLowerCase();
    const at = name.length > 1 ? t.indexOf(name) : -1;
    if (at >= 0) { seen.add(idx); hits.push({ at, idx }); }
  });
  for (const alts of ROOM_WORDS) {
    const m = new RegExp(`(?<![\\p{L}])(?:${alts})`, 'u').exec(t);
    if (!m) continue;
    const idx = model.spaces.findIndex((s, i) => !seen.has(i) && new RegExp(`(?:${alts})`, 'u').test(s.name.toLowerCase()));
    if (idx >= 0) { seen.add(idx); hits.push({ at: m.index, idx }); }
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => model.spaces[h.idx]);
}

const spaceArea = (s: { polygon: Vec2[] }) => polyArea(s.polygon);

/** Largest circle that fits in the room walls, as a diameter. */
function inscribedDiameter(poly: Vec2[]): number {
  const b = bounds(poly);
  const step = Math.max(0.05, Math.min(b.w, b.h) / 40);
  let best = 0;
  for (let x = b.minX + step / 2; x <= b.minX + b.w; x += step) {
    for (let y = b.minY + step / 2; y <= b.minY + b.h; y += step) {
      const p = { x, y };
      if (!pointInPolygon(p, poly)) continue;
      best = Math.max(best, distPointPolygonEdges(p, poly));
    }
  }
  return best * 2;
}

/** Can a w by d box (either way round) stand in the room, clear of walls and furniture? */
function boxFits(poly: Vec2[], furniture: FurnitureItem[], w: number, d: number): boolean {
  const b = bounds(poly);
  const step = 0.1;
  const blockers = furniture.filter((f) => pointInPolygon({ x: f.x, y: f.y }, poly)).map((f) => itemCorners(f));
  for (const [bw, bd] of [[w, d], [d, w]]) {
    if (bw > b.w + 1e-6 || bd > b.h + 1e-6) continue;
    for (let x = b.minX + bw / 2; x <= b.minX + b.w - bw / 2 + 1e-6; x += step) {
      for (let y = b.minY + bd / 2; y <= b.minY + b.h - bd / 2 + 1e-6; y += step) {
        const hw = bw / 2 - 0.002, hd = bd / 2 - 0.002;
        const c = [{ x: x - hw, y: y - hd }, { x: x + hw, y: y - hd }, { x: x + hw, y: y + hd }, { x: x - hw, y: y + hd }];
        if (!polygonInside(c, poly)) continue;
        if (blockers.some((o) => convexOverlap(c, o) > 0.001)) continue;
        return true;
      }
    }
  }
  return false;
}

interface Edge { to: number; w: number; pts: Vec2[]; doorId: string }
const OUT = -1;

/** Rooms as nodes, passages as edges (centre to door to centre), plus one node for outside. */
function graph(model: SpaceModel) {
  const n = model.spaces.length;
  const centres = model.spaces.map((s) => centroid(s.polygon));
  const adj: Edge[][] = Array.from({ length: n + 1 }, () => []);
  const doors = describeDoors(model);
  for (const d of doors) {
    const a = d.spaceIdx;
    if (d.neighbour >= 0) {
      const b = d.neighbour;
      const pts = [centres[a], d.c, centres[b]];
      const w = dist(centres[a], d.c) + dist(d.c, centres[b]);
      adj[a].push({ to: b, w, pts, doorId: d.id });
      adj[b].push({ to: a, w, pts: [...pts].reverse(), doorId: d.id });
    } else if (d.exit) {
      const w = dist(centres[a], d.c);
      adj[a].push({ to: n, w, pts: [centres[a], d.c], doorId: d.id });
      adj[n].push({ to: a, w, pts: [d.c, centres[a]], doorId: d.id });
    }
  }
  return { n, centres, adj, doors };
}

/** Shortest walk from one node to every node. */
function shortest(adj: Edge[][], src: number) {
  const N = adj.length;
  const d = new Array<number>(N).fill(Infinity), prev = new Array<number>(N).fill(-1), via = new Array<Edge | null>(N).fill(null);
  const done = new Array<boolean>(N).fill(false);
  d[src] = 0;
  for (let k = 0; k < N; k++) {
    let u = -1;
    for (let i = 0; i < N; i++) if (!done[i] && (u < 0 || d[i] < d[u])) u = i;
    if (u < 0 || d[u] === Infinity) break;
    done[u] = true;
    for (const e of adj[u]) if (d[u] + e.w < d[e.to]) { d[e.to] = d[u] + e.w; prev[e.to] = u; via[e.to] = e; }
  }
  return { d, prev, via };
}

function pathTo(sp: ReturnType<typeof shortest>, src: number, dst: number) {
  const pts: Vec2[] = [], doorIds: string[] = [], rooms: number[] = [dst];
  let cur = dst;
  const edges: Edge[] = [];
  while (cur !== src && sp.via[cur]) { edges.unshift(sp.via[cur]!); cur = sp.prev[cur]; rooms.unshift(cur); }
  for (const e of edges) { pts.push(...(pts.length ? e.pts.slice(1) : e.pts)); doorIds.push(e.doorId); }
  return { pts, doorIds, rooms };
}

const fmtName = (m: SpaceModel, i: number) => m.spaces[i].name;

function openingArea(model: SpaceModel, doors: DoorInfo[], spaceId: string, kinds: string[]): number {
  return model.openings.filter((o) => o.spaceId === spaceId && kinds.includes(o.kind)).reduce((s, o) => {
    const both = doors.find((d) => d.id === o.id && d.neighbour >= 0) ? 2 : 1;
    return s + o.widthM * o.heightM * both;
  }, 0);
}

function wallAreaOf(model: SpaceModel, doors: DoorInfo[], spaceId: string): number {
  const s = model.spaces.find((x) => x.id === spaceId)!;
  const gross = perimeter(s.polygon) * model.ceilingM;
  const idx = model.spaces.indexOf(s);
  const cutOf = (o: { widthM: number; heightM: number }) => o.widthM * Math.min(o.heightM, model.ceilingM);
  const cut = model.openings.filter((o) => o.spaceId === spaceId).reduce((a, o) => a + cutOf(o), 0)
    + doors.filter((d) => d.neighbour === idx).reduce((a, d) => a + cutOf(d.opening), 0);
  return Math.max(0, gross - cut);
}

/** Width of the passages cut into a room's walls, counting doors that open into it from next door. */
function passageWidth(model: SpaceModel, doors: DoorInfo[], spaceId: string): number {
  const idx = model.spaces.findIndex((s) => s.id === spaceId);
  return model.openings.filter((o) => o.spaceId === spaceId && o.kind !== 'window').reduce((a, o) => a + o.widthM, 0)
    + doors.filter((d) => d.neighbour === idx).reduce((a, d) => a + d.widthM, 0);
}

function parseSize(t: string): { w: number; d: number } | null {
  const num = '(\\d+(?:[.,]\\d+)?)';
  const f = (s: string) => Number(s.replace(',', '.'));
  const two = new RegExp(`${num}\\s*(?:m|cm)?\\s*(?:x|×|by|\\*)\\s*${num}\\s*(m|cm)?`, 'u').exec(t);
  if (two) {
    let w = f(two[1]), d = f(two[2]);
    if (two[3] === 'cm' || (!two[3] && Math.max(w, d) > 10)) { w /= 100; d /= 100; }
    return { w, d };
  }
  const one = new RegExp(`${num}\\s*(m(?![a-zåäö²2])|metre|meter|metr|cm)`, 'u').exec(t);
  if (one) {
    const v = one[2] === 'cm' ? f(one[1]) / 100 : f(one[1]);
    return { w: v, d: 0.9 };
  }
  return null;
}

/** Answer a question about the whole plan, or null when it is not one. `t` is lower-cased text. */
export function answerBuilding(t: string, model: SpaceModel): Answer | null {
  const spaces = model.spaces;
  if (spaces.length < 2) return null;
  const named = roomsNamed(t, model);
  const roomWord = has(t, 'room|rooms|rum(?![a-zåäö]*et?s)|rummen|rummet|huone|tila');
  const roomsPlural = has(t, 'rooms|rum(?![a-zåäö])|rummen|huonet|huoneita|huoneessa');
  const areaQ = has(t, 'area|square|m2|m²|sq|yta|ytan|kvadrat|pinta|neliö');
  const doorWord = has(t, 'door|dörr|ove|ovi|oven');
  const windowWord = has(t, 'window|fönster|ikkun');
  const g = graph(model);
  const total = spaces.reduce((s, x) => s + spaceArea(x), 0);
  const all = spaces.map((s) => s.id);

  // Longest escape and nearest exit.
  const exitQ = has(t, 'exit|way out|escape|fire|nödutg|utgång|utgången|rymning|brand|uloskäyn|ulos|pako|poistu');
  if (exitQ) {
    const sp = shortest(g.adj, g.n);
    if (has(t, 'longest|farthest|furthest|worst|längsta|längst|pisin|kaukaisin')) {
      let worst = -1;
      spaces.forEach((_, i) => { if (sp.d[i] < Infinity && (worst < 0 || sp.d[i] > sp.d[worst])) worst = i; });
      if (worst < 0) return { text: 'No exit found in this plan.' };
      const p = pathTo(sp, g.n, worst);
      return { text: `${n1(sp.d[worst])} m from ${fmtName(model, worst)} to the exit`, highlight: { spaceIds: [spaces[worst].id], openingIds: [...p.doorIds].reverse(), route: [...p.pts].reverse() } };
    }
    if (named.length) {
      const i = spaces.indexOf(named[0]);
      if (!(sp.d[i] < Infinity)) return { text: `No exit reachable from ${named[0].name}.`, highlight: { spaceIds: [named[0].id] } };
      const p = pathTo(sp, g.n, i);
      return { text: `${n1(sp.d[i])} m from ${named[0].name} to the nearest exit`, highlight: { spaceIds: [named[0].id], openingIds: [...p.doorIds].reverse(), route: [...p.pts].reverse() } };
    }
  }

  // Walking route between two rooms.
  if (named.length >= 2 && has(t, 'route|way|walk|path|distance|how far|get from|go from|väg|vägen|gå|avstånd|hur långt|reitti|kävel|etäisyys|matka|kuinka kaukana')) {
    const a = spaces.indexOf(named[0]), b = spaces.indexOf(named[1]);
    const sp = shortest(g.adj, a);
    if (!(sp.d[b] < Infinity)) return { text: `No walking route from ${named[0].name} to ${named[1].name}.`, highlight: { spaceIds: [named[0].id, named[1].id] } };
    const p = pathTo(sp, a, b);
    const ids = p.rooms.filter((r) => r >= 0 && r < g.n).map((r) => spaces[r].id);
    return { text: `${n1(sp.d[b])} m, ${named[0].name} to ${named[1].name}, ${plural(p.doorIds.length, 'door')}`, highlight: { spaceIds: ids, openingIds: p.doorIds, route: p.pts } };
  }

  // Which rooms connect to a named room.
  if (named.length === 1 && has(t, 'connect|adjacent|next to|door to|doors? lead|lead|access|neighbou?r|leads|ansluter|gränsar|angränsar|leder|grann|bredvid|yhdisty|viereis|naapuri|johtaa|vieressä')) {
    const i = spaces.indexOf(named[0]);
    const ds = g.adj[i].filter((e) => e.to < g.n);
    const ids = [...new Set(ds.map((e) => e.to))];
    if (!ids.length) return { text: `0 rooms connect to ${named[0].name}.`, highlight: { spaceIds: [named[0].id] } };
    return { text: `${ids.length}: ${list(ids.map((k) => spaces[k].name))} connect to ${named[0].name}`, highlight: { spaceIds: [named[0].id, ...ids.map((k) => spaces[k].id)], openingIds: ds.filter((e) => e.to < g.n).map((e) => e.doorId) } };
  }

  // Rooms without a window.
  if (windowWord && (has(t, 'no |without|lack|windowless|utan|saknar|ilman|ei ') || has(t, 'windowless')) && (roomWord || has(t, 'which|what|vilka|vilket|mitkä|missä'))) {
    const dark = spaces.filter((s) => !model.openings.some((o) => o.spaceId === s.id && o.kind === 'window'));
    if (!dark.length) return { text: '0 rooms without a window.' };
    return { text: `${plural(dark.length, 'room')} without a window: ${list(dark.map((s) => s.name))}`, highlight: { spaceIds: dark.map((s) => s.id) } };
  }

  // Doors: narrowest, wheelchair width.
  const turnQ = has(t, 'turning|turn|vändcirkel|vänd|käänty|kääntö');
  if (!turnQ && (has(t, 'wheelchair|rullstol|pyörätuol|accessib|tillgänglig|esteet') || (doorWord && has(t, 'under|below|less than|smaller|mindre|alle|0[.,]8'))) && (doorWord || has(t, 'wheelchair|rullstol|pyörätuol'))) {
    const ds = model.openings.filter((o) => o.kind === 'door' && o.widthM < 0.8);
    if (!ds.length) return { text: '0 doors under 0.8 m, wheelchair friendly.' };
    const names = ds.map((o) => spaces.find((s) => s.id === o.spaceId)?.name ?? o.id);
    return { text: `${plural(ds.length, 'door')} under 0.8 m: ${list(names)}`, highlight: { openingIds: ds.map((o) => o.id) } };
  }
  if (doorWord && !turnQ && has(t, 'narrow|smallest|thinnest|smalaste|smal|kapein|ahtain')) {
    const ds = model.openings.filter((o) => o.kind === 'door');
    if (!ds.length) return { text: '0 doors in this plan.' };
    const nar = [...ds].sort((a, b) => a.widthM - b.widthM)[0];
    const host = spaces.find((s) => s.id === nar.spaceId)!;
    return { text: `${n2(nar.widthM)} m, the ${host.name} door`, highlight: { openingIds: [nar.id], spaceIds: [host.id] } };
  }
  // Rooms too small for a 1.5 m turning circle.
  if (turnQ && (roomWord || has(t, 'circle|cirkel|ympyrä|wheelchair|rullstol|pyörätuol|1[.,]5'))) {
    const small = spaces.filter((s) => inscribedDiameter(s.polygon) < 1.5);
    if (!small.length) return { text: '0 rooms too small for a 1.5 m turning circle.' };
    return { text: `${plural(small.length, 'room')} too small for 1.5 m turning: ${list(small.map((s) => s.name))}`, highlight: { spaceIds: small.map((s) => s.id) } };
  }

  // Daylight: window area to floor area.
  if (has(t, 'daylight|dagsljus|dagsljuset|päivänvalo|ljus|light|valoisa|window to floor|window area|fönsteryta|ikkunapinta')) {
    const ratio = (s: (typeof spaces)[number]) => openingArea(model, g.doors, s.id, ['window']) / spaceArea(s);
    if (named.length) {
      const s = named[0];
      return { text: `${pct(ratio(s))} window to floor, ${s.name}`, highlight: { spaceIds: [s.id], openingIds: model.openings.filter((o) => o.spaceId === s.id && o.kind === 'window').map((o) => o.id) } };
    }
    const worst = [...spaces].sort((a, b) => ratio(a) - ratio(b))[0];
    return { text: `${pct(ratio(worst))} window to floor, lowest daylight: ${worst.name}`, highlight: { spaceIds: [worst.id] } };
  }

  // How many people the plan suits.
  if (has(t, 'people|persons|person|sleep|live|suit|accommodate|bor|boende|sova|ihmistä|henkilöä|asua|nukkua|asukasta')) {
    const beds = model.furniture.filter((f) => /\bbed\b|säng|sänky/.test(`${f.name} ${f.category}`.toLowerCase()) && !/side|night|bedroom/.test(f.name.toLowerCase()));
    const sleeps = beds.reduce((s, f) => s + (Math.min(f.w, f.d) >= 1.3 ? 2 : 1), 0);
    const desks = model.furniture.filter((f) => /desk|skrivbord|työpöytä|kirjoituspöytä/.test(`${f.name} ${f.category}`.toLowerCase())).length;
    const host = (f: FurnitureItem) => spaces.find((s) => pointInPolygon({ x: f.x, y: f.y }, s.polygon))?.id;
    const ids = [...new Set(beds.map(host).filter((x): x is string => !!x))];
    return { text: `${plural(sleeps, 'person')} sleep, ${plural(desks, 'desk')}`, highlight: { spaceIds: ids } };
  }

  // Paint: wall area and wall length.
  const paintQ = has(t, 'paint|måla|målning|färg|maalat|maalaus|maali');
  if (paintQ || has(t, 'wall area|wall length|walls|väggyta|väggarna|väggar|seinäpinta|seinät|seinien')) {
    const sel = named.length ? [named[0]] : spaces;
    if (paintQ || has(t, 'wall area|väggyta|seinäpinta')) {
      const a = sel.reduce((s, x) => s + wallAreaOf(model, g.doors, x.id), 0);
      return { text: `${n1(a)} m² of wall to paint, openings removed`, highlight: { spaceIds: sel.map((s) => s.id) } };
    }
    const l = sel.reduce((s, x) => s + perimeter(x.polygon), 0);
    return { text: `${n1(l)} m of wall${named.length ? ` in ${named[0].name}` : ' in total'}`, highlight: { spaceIds: sel.map((s) => s.id) } };
  }

  // Skirting boards: room perimeter minus doors.
  if (has(t, 'skirting|baseboard|golvlist|jalkalist')) {
    const sel = named.length ? [named[0]] : spaces;
    const doorsW = sel.reduce((s, x) => s + passageWidth(model, g.doors, x.id), 0);
    const l = sel.reduce((s, x) => s + perimeter(x.polygon), 0) - doorsW;
    return { text: `${n1(l)} m of skirting${named.length ? ` for ${named[0].name}` : ''}, doors removed`, highlight: { spaceIds: sel.map((s) => s.id) } };
  }

  // Flooring to buy with 10 percent waste.
  if (has(t, 'flooring|floor|golv|golvet|lattia|laminate|parquet|tiles?') && has(t, 'buy|order|need|waste|köpa|köp|beställ|behöver|spill|ostaa|tarvit|hukka')) {
    const sel = named.length ? [named[0]] : spaces;
    const a = sel.reduce((s, x) => s + spaceArea(x), 0);
    return { text: `${n1(a * 1.1)} m² of flooring, with 10% waste`, highlight: { spaceIds: sel.map((s) => s.id) } };
  }

  // Which room fits an item of a given size.
  if (has(t, 'fit|fits|passar|får|mahtuu|mahdu') && has(t, 'where|which|what|vilket|vilka|var |missä|mihin|mikä|mikä')) {
    const size = parseSize(t);
    if (size) {
      const ok = spaces.filter((s) => boxFits(s.polygon, model.furniture, size.w, size.d));
      const what = `${n1(size.w)}${size.d === 0.9 && !/x|×|by|\*/.test(t) ? ' m' : ` by ${n1(size.d)} m`}`;
      if (!ok.length) return { text: `0 rooms fit ${what}.` };
      return { text: `${plural(ok.length, 'room')} fit ${what}: ${list(ok.map((s) => s.name))}`, highlight: { spaceIds: ok.map((s) => s.id) } };
    }
  }

  // Compare two rooms.
  if (named.length >= 2 && has(t, 'compare|bigger|larger|versus|vs|difference|jämför|större|skillnad|vertaa|suurempi|ero')) {
    const [a, b] = named;
    const aa = spaceArea(a), ab = spaceArea(b);
    return { text: `${a.name} ${n1(aa)} m² vs ${b.name} ${n1(ab)} m², ${n1(Math.abs(aa - ab))} m² difference`, highlight: { spaceIds: [a.id, b.id] } };
  }

  // Biggest and smallest room.
  const bigQ = has(t, 'biggest|largest|bigger|största|störst|suurin|isoin');
  const smallQ = has(t, 'smallest|tiniest|minsta|minst|pienin');
  if ((bigQ || smallQ) && !has(t, 'item|furniture|möbel|möbler|huonekalu') && (roomWord || !has(t, 'door|window'))) {
    const sorted = [...spaces].sort((a, b) => spaceArea(a) - spaceArea(b));
    const s = bigQ && !smallQ ? sorted[sorted.length - 1] : sorted[0];
    return { text: `${n1(spaceArea(s))} m², ${s.name} is the ${bigQ && !smallQ ? 'biggest' : 'smallest'} room`, highlight: { spaceIds: [s.id] } };
  }

  // Perimeter of a named room.
  if (named.length && has(t, 'perimeter|omkrets|ympärys|around')) {
    return { text: `${n1(perimeter(named[0].polygon))} m around ${named[0].name}`, highlight: { spaceIds: [named[0].id] } };
  }

  // Area of a named room.
  if (named.length && (areaQ || has(t, 'size|big|large|storlek|stor(?![a-zåäö])|koko|iso|suuri'))) {
    const b = bounds(named[0].polygon);
    return { text: `${n1(spaceArea(named[0]))} m², ${named[0].name}, ${n1(Math.min(b.w, b.h))} by ${n1(Math.max(b.w, b.h))}`, highlight: { spaceIds: [named[0].id] } };
  }

  // Count and list of rooms.
  if (roomsPlural || roomWord) {
    if (has(t, 'how many|number of|count|antal|hur många|montako|kuinka monta') && roomWord) {
      return { text: `${plural(spaces.length, 'room')}`, highlight: { spaceIds: all } };
    }
    if (has(t, 'list|which|what|name|vilka|luettele|mitkä|visa|show') && roomsPlural) {
      const parts = spaces.slice(0, 3).map((s) => `${s.name} ${n1(spaceArea(s))}`);
      return { text: `${plural(spaces.length, 'room')}: ${parts.join(', ')}${spaces.length > 3 ? `, +${spaces.length - 3}` : ''} m²`, highlight: { spaceIds: all } };
    }
  }

  // Total area of the plan.
  if (areaQ || has(t, 'total size|apartment|whole|hela|koko asunto|asunto|lägenhet')) {
    if (areaQ || has(t, 'size|storlek|koko')) return { text: `${n1(total)} m² in total, ${plural(spaces.length, 'room')}`, highlight: { spaceIds: all } };
  }
  return null;
}
