// Instant answers about the current room, computed straight from the model: no key, no network.
// Answers are short and lead with the number. Unknown questions return null and fall through.
import { bounds, perimeter, signedArea } from '../../core/geometry';
import type { FurnitureItem, LayoutCandidate, Requirements, SpaceModel } from '../../core/types';

export interface AnswerState {
  model: SpaceModel;
  requirements?: Requirements | null;
  candidates?: LayoutCandidate[];
  activeCandidateId?: string | null;
}

/** Does the text contain a word starting with any of the alternatives (works with å ä ö). */
function has(t: string, alts: string): boolean {
  return new RegExp(`(?<![\\p{L}])(?:${alts})`, 'u').test(t);
}

const n1 = (v: number) => (Math.round(v * 10) / 10).toString();
const n2 = (v: number) => (Math.round(v * 100) / 100).toString();
const sek = (v: number) => `${Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} SEK`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Words people use for furniture, mapped to the English name or category used in the room.
const ITEM_WORDS: Array<[string, string]> = [
  ['sofa|couch|soffa|sohva', 'sofa'], ['desk|skrivbord|työpöytä|kirjoituspöytä', 'desk'],
  ['bed|säng|sänky', 'bed'], ['chair|stol|tuoli', 'chair'], ['table|bord|pöytä', 'table'],
  ['shelf|shelves|bookcase|hylla|bokhylla|hylly|kirjahylly', 'shelf'], ['wardrobe|closet|garderob|vaatekaappi', 'wardrobe'],
  ['lamp|lampa|lamppu|valaisin', 'lamp'], ['rug|carpet|matta|matto', 'rug'], ['tv|television', 'tv'],
  ['plant|växt|kasvi', 'plant'], ['nightstand|sängbord|yöpöytä', 'nightstand'], ['dresser|byrå|lipasto', 'dresser'],
  ['armchair|fåtölj|nojatuoli', 'armchair'], ['stool|pall|jakkara', 'stool'], ['cabinet|skåp|kaappi', 'cabinet'],
];

/** Items named in the question, in the order they were mentioned. */
function itemsNamed(t: string, items: FurnitureItem[]): FurnitureItem[] {
  const hits: Array<{ at: number; item: FurnitureItem }> = [];
  const used = new Set<string>();
  const add = (at: number, item: FurnitureItem) => { if (!used.has(item.id)) { used.add(item.id); hits.push({ at, item }); } };
  for (const item of items) {
    const name = item.name.toLowerCase();
    const at = name.length > 2 ? t.indexOf(name) : -1;
    if (at >= 0) add(at, item);
  }
  for (const [alts, canon] of ITEM_WORDS) {
    const m = new RegExp(`(?<![\\p{L}])(?:${alts})`, 'u').exec(t);
    if (!m) continue;
    const pool = items.filter((i) => `${i.name} ${i.category} ${i.catalogId}`.toLowerCase().includes(canon));
    const pick = pool.find((i) => !used.has(i.id));
    if (pick) add(m.index, pick);
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.item);
}

const footprint = (i: FurnitureItem) => i.w * i.d;
const onFloor = (i: FurnitureItem) => (i.mount ?? 'floor') === 'floor' && !(i.elevationM && i.elevationM > 0.5);
const label = (i: FurnitureItem) => i.name.toLowerCase();

function facingWord(i: FurnitureItem): string {
  const dx = -Math.sin(i.rotation), dy = Math.cos(i.rotation);
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : (dy > 0 ? 'south' : 'north');
}

/** Edge-to-edge distance, treating each footprint as an axis-aligned box. */
function gap(a: FurnitureItem, b: FurnitureItem): number {
  const ext = (i: FurnitureItem) => (Math.abs(Math.sin(i.rotation)) > 0.7 ? { w: i.d, d: i.w } : { w: i.w, d: i.d });
  const ea = ext(a), eb = ext(b);
  const dx = Math.max(0, Math.abs(a.x - b.x) - (ea.w + eb.w) / 2);
  const dy = Math.max(0, Math.abs(a.y - b.y) - (ea.d + eb.d) / 2);
  return Math.hypot(dx, dy);
}

const COUNT_Q = 'how many|number of|count|antal|hur många|montako|kuinka monta';

/** Answer a simple question about the room, or null when it is not one. */
export function answerFromModel(question: string, state: AnswerState): string | null {
  const t = question.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return null;
  // Orders are for the command path, not questions.
  if (/^(please )?(add|put|place|move|remove|delete|make|build|create|rotate|turn|lägg|flytta|ta bort|lisää|siirrä|poista)(?![\p{L}])/u.test(t)) return null;
  const { model } = state;
  const space = model.spaces[0];
  if (!space) return null;
  const items = model.furniture;
  const named = itemsNamed(t, items);
  const doors = model.openings.filter((o) => o.kind === 'door');
  const windows = model.openings.filter((o) => o.kind === 'window');
  const area = Math.abs(signedArea(space.polygon));
  const total = items.filter((i) => !i.owned).reduce((s, i) => s + (i.priceSek || 0), 0);

  // Does it fit through the door? Compare its smallest footprint side with the widest door.
  if (named.length && has(t, 'fit|through|get in|get it in|passar|igenom|mahtuu|mahdu|läpi') && has(t, 'door|dörr|ove|ovi')) {
    if (!doors.length) return 'No door in this room.';
    const door = Math.max(...doors.map((d) => d.widthM));
    const side = Math.min(named[0].w, named[0].d);
    return `${side <= door ? 'Yes' : 'No'}, ${n2(side)} m side, door ${n2(door)} m`;
  }
  if (named.length >= 2 && has(t, 'distance|how far|between|avstånd|hur långt|mellan|etäisyys|kuinka kaukana|välimatka|välillä')) {
    const [a, b] = named;
    return `${n1(Math.hypot(a.x - b.x, a.y - b.y))} m centre to centre, ${n1(gap(a, b))} m gap`;
  }
  if (named.length && has(t, 'facing|faces|pointing|direction|vänd|tittar|osoittaa|katsoo|suuntaan')) {
    return `${cap(facingWord(named[0]))}, the ${label(named[0])}`;
  }
  if (named.length && has(t, 'next to|beside|near|close to|by the|bredvid|nära|intill|vieressä|lähellä')) {
    const others = items.filter((i) => i.id !== named[0].id).sort((x, y) => gap(named[0], x) - gap(named[0], y));
    if (!others.length) return 'Nothing else in the room.';
    return `${cap(label(others[0]))}, ${n1(gap(named[0], others[0]))} m away`;
  }
  if (has(t, 'check|fail|problem|issue|rule|kontroll|fel|underkänd|tarkist|virhe|ongelma')) {
    const c = state.candidates?.find((x) => x.id === state.activeCandidateId) ?? state.candidates?.[0];
    if (!c) return 'No checks run yet.';
    const fails = c.checks.filter((k) => k.result === 'fail').length;
    return `${fails} of ${c.checks.length} checks fail`;
  }
  if (has(t, 'free|open|empty|spare|ledig|fri(?![a-zåäö])|vapaa|tyhjä|tilaa') && has(t, 'floor|space|area|golv|yta|lattia|tila|pinta')) {
    const used = items.filter(onFloor).reduce((s, i) => s + footprint(i), 0);
    return `${Math.round(Math.max(0, 1 - used / area) * 100)}% free floor`;
  }
  if (has(t, 'largest|biggest|största|störst|suurin|isoin')) {
    if (!items.length) return 'No furniture yet.';
    const big = [...items].sort((a, b) => footprint(b) - footprint(a))[0];
    return `${cap(label(big))}, ${n1(footprint(big))} m²`;
  }
  if (has(t, 'budget|budjett')) {
    const b = state.requirements?.budgetSek;
    if (b == null) return `No budget set, spent ${sek(total)}`;
    return `${sek(b - total)} left of ${sek(b)}`;
  }
  if (has(t, 'price|cost|total|spent|pris|kostar|kostnad|summa|hinta|maksaa|yhteensä|paljonko') && !named.length) {
    return `${sek(total)} in total`;
  }
  if (has(t, COUNT_Q) && has(t, 'item|furniture|piece|thing|möbel|möbler|sak|huonekalu|kalust|esine')) {
    return `${items.length} item${items.length === 1 ? '' : 's'}`;
  }
  if (has(t, 'list|which|what|vilka|vad|mitä|luettele') && has(t, 'furniture|items|pieces|möbel|möbler|huonekalu|kalust|in the room|i rummet|huoneessa')) {
    if (!items.length) return '0 items, the room is empty';
    const names = items.slice(0, 5).map(label).join(', ');
    return `${items.length} item${items.length === 1 ? '' : 's'}: ${names}${items.length > 5 ? `, +${items.length - 5}` : ''}`;
  }
  const doorQ = has(t, 'door|dörr|ove|ovi'), winQ = has(t, 'window|fönster|ikkun');
  if ((doorQ || winQ) && !named.length) {
    const list = doorQ ? doors : windows;
    const word = doorQ ? 'door' : 'window';
    if (!list.length) return `0 ${word}s`;
    return `${list.length} ${word}${list.length === 1 ? '' : 's'}, ${list.map((o) => n2(o.widthM)).join(' and ')} m wide`;
  }
  if (!named.length && has(t, 'ceiling|taket|takhöjd|tak höjd|katto|katon|how high|how tall')) {
    return `${n2(model.ceilingM)} m ceiling`;
  }
  if (has(t, 'perimeter|omkrets|ympärys|walls? length|around the room|runt rummet')) {
    return `${n1(perimeter(space.polygon))} m around`;
  }
  const roomQ = has(t, 'room|space|rum|huone|tila|floor|golv|lattia|apartment|bedroom|office');
  const areaQ = has(t, 'area|square|m2|m²|sq|yta|kvadrat|pinta|neliö');
  const sizeQ = has(t, 'size|big|large|dimension|how wide|how long|storlek|stor(?![a-zåäö])|mått|koko|iso|mitat|suuri');
  if (!named.length && (areaQ || (sizeQ && roomQ))) {
    const b = bounds(space.polygon);
    return areaQ && !sizeQ ? `${n1(area)} m²` : `${n1(area)} m², ${n1(Math.min(b.w, b.h))} by ${n1(Math.max(b.w, b.h))}`;
  }
  return null;
}
