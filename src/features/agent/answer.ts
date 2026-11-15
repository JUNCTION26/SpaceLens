// Instant answers about the current room, computed straight from the model: no key, no network.
// Answers are short and lead with the number. Unknown questions return null and fall through.
import { bounds, perimeter, signedArea } from '../../core/geometry';
import type { FurnitureItem, LayoutCandidate, Requirements, SpaceModel } from '../../core/types';
import { answerBuilding, detectLang, P, TEMPLATES, tr, type Answer, type Lang } from './buildingAnswers';

export type { Answer, Highlight, Lang } from './buildingAnswers';
export { detectLang } from './buildingAnswers';

const ORDER_RE = /^(please )?(add|put|place|move|remove|delete|make|build|create|rotate|turn|lägg|flytta|ta bort|lisää|siirrä|poista)(?![\p{L}])/u;

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

Object.assign(TEMPLATES, {
  noDoorRoom: { en: 'No door in this room.', sv: 'Ingen dörr i det här rummet.', fi: 'Tässä huoneessa ei ole ovea.' },
  fitsYes: { en: 'Yes, {side} m side, door {door} m', sv: 'Ja, {side} m sida, dörr {door} m', fi: 'Kyllä, {side} m sivu, ovi {door} m' },
  fitsNo: { en: 'No, {side} m side, door {door} m', sv: 'Nej, {side} m sida, dörr {door} m', fi: 'Ei, {side} m sivu, ovi {door} m' },
  distance: { en: '{c} m centre to centre, {g} m gap', sv: '{c} m mitt till mitt, {g} m mellanrum', fi: '{c} m keskeltä keskelle, {g} m väli' },
  facing: { en: '{dir}, the {item}', sv: '{dir}, {item}', fi: '{dir}, {item}' },
  dir_north: { en: 'North', sv: 'Norr', fi: 'Pohjoiseen' }, dir_south: { en: 'South', sv: 'Söder', fi: 'Etelään' },
  dir_east: { en: 'East', sv: 'Öster', fi: 'Itään' }, dir_west: { en: 'West', sv: 'Väster', fi: 'Länteen' },
  nothingElse: { en: 'Nothing else in the room.', sv: 'Inget annat i rummet.', fi: 'Huoneessa ei ole muuta.' },
  nextTo: { en: '{item}, {g} m away', sv: '{item}, {g} m bort', fi: '{item}, {g} m päässä' },
  noChecks: { en: 'No checks run yet.', sv: 'Inga kontroller körda än.', fi: 'Tarkistuksia ei ole vielä ajettu.' },
  checksFail: { en: '{f} of {n} checks fail', sv: '{f} av {n} kontroller underkända', fi: '{f} / {n} tarkistusta epäonnistuu' },
  freeFloor: { en: '{p}% free floor', sv: '{p}% ledig golvyta', fi: '{p} % vapaata lattiaa' },
  noFurniture: { en: 'No furniture yet.', sv: 'Inga möbler än.', fi: 'Ei vielä kalusteita.' },
  largest: { en: '{item}, {a} m²', sv: '{item}, {a} m²', fi: '{item}, {a} m²' },
  noBudget: { en: 'No budget set, spent {spent}', sv: 'Ingen budget satt, spenderat {spent}', fi: 'Budjettia ei ole asetettu, käytetty {spent}' },
  budgetLeft: { en: '{left} left of {b}', sv: '{left} kvar av {b}', fi: '{left} jäljellä, budjetti {b}' },
  priceTotal: { en: '{t} in total', sv: '{t} totalt', fi: '{t} yhteensä' },
  emptyRoom: { en: '0 items, the room is empty', sv: '0 saker, rummet är tomt', fi: '0 esinettä, huone on tyhjä' },
  openings: { en: '{n}, {w} m wide', sv: '{n}, {w} m breda', fi: '{n}, {w} m leveä' },
  and: { en: 'and', sv: 'och', fi: 'ja' },
  ceiling: { en: '{h} m ceiling', sv: '{h} m takhöjd', fi: '{h} m katto' },
  perimeter: { en: '{l} m around', sv: '{l} m runt om', fi: '{l} m ympäri' },
  size: { en: '{a} m², {s} by {l}', sv: '{a} m², {s} x {l}', fi: '{a} m², {s} x {l}' },
});

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

/** Answer a question about the room or the whole plan, with what to light up; null when it is not one. */
export function answerWithHighlight(question: string, state: AnswerState, lang?: Lang): Answer | null {
  const t = question.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t || ORDER_RE.test(t)) return null;
  const l = lang ?? detectLang(t);
  const plan = answerBuilding(t, state.model, l);
  if (plan) return plan;
  const text = answerFromRoom(question, state, l);
  return text == null ? null : { text };
}

/** Text-only version of answerWithHighlight, for callers that do not draw highlights. */
export function answerFromModel(question: string, state: AnswerState, lang?: Lang): string | null {
  return answerWithHighlight(question, state, lang)?.text ?? null;
}

/** Answer a simple question about the room, or null when it is not one. */
function answerFromRoom(question: string, state: AnswerState, lang: Lang = 'en'): string | null {
  const T = (key: string, v: Record<string, string | number> = {}) => tr(lang, key, v);
  const t = question.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return null;
  // Orders are for the command path, not questions.
  if (ORDER_RE.test(t)) return null;
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
    if (!doors.length) return T('noDoorRoom');
    const door = Math.max(...doors.map((d) => d.widthM));
    const side = Math.min(named[0].w, named[0].d);
    return T(side <= door ? 'fitsYes' : 'fitsNo', { side: n2(side), door: n2(door) });
  }
  if (named.length >= 2 && has(t, 'distance|how far|between|avstånd|hur långt|mellan|etäisyys|kuinka kaukana|välimatka|välillä')) {
    const [a, b] = named;
    return T('distance', { c: n1(Math.hypot(a.x - b.x, a.y - b.y)), g: n1(gap(a, b)) });
  }
  if (named.length && has(t, 'facing|faces|pointing|direction|vänd|tittar|osoittaa|katsoo|suuntaan')) {
    return T('facing', { dir: T(`dir_${facingWord(named[0])}`), item: label(named[0]) });
  }
  if (named.length && has(t, 'next to|beside|near|close to|by the|bredvid|nära|intill|vieressä|lähellä')) {
    const others = items.filter((i) => i.id !== named[0].id).sort((x, y) => gap(named[0], x) - gap(named[0], y));
    if (!others.length) return T('nothingElse');
    return T('nextTo', { item: cap(label(others[0])), g: n1(gap(named[0], others[0])) });
  }
  if (has(t, 'check|fail|problem|issue|rule|kontroll|fel|underkänd|tarkist|virhe|ongelma')) {
    const c = state.candidates?.find((x) => x.id === state.activeCandidateId) ?? state.candidates?.[0];
    if (!c) return T('noChecks');
    const fails = c.checks.filter((k) => k.result === 'fail').length;
    return T('checksFail', { f: fails, n: c.checks.length });
  }
  if (has(t, 'free|open|empty|spare|ledig|fri(?![a-zåäö])|vapaa|tyhjä|tilaa') && has(t, 'floor|space|area|golv|yta|lattia|tila|pinta')) {
    const used = items.filter(onFloor).reduce((s, i) => s + footprint(i), 0);
    return T('freeFloor', { p: Math.round(Math.max(0, 1 - used / area) * 100) });
  }
  if (has(t, 'largest|biggest|största|störst|suurin|isoin')) {
    if (!items.length) return T('noFurniture');
    const big = [...items].sort((a, b) => footprint(b) - footprint(a))[0];
    return T('largest', { item: cap(label(big)), a: n1(footprint(big)) });
  }
  if (has(t, 'budget|budjett')) {
    const b = state.requirements?.budgetSek;
    if (b == null) return T('noBudget', { spent: sek(total) });
    return T('budgetLeft', { left: sek(b - total), b: sek(b) });
  }
  if (has(t, 'price|cost|total|spent|pris|kostar|kostnad|summa|hinta|maksaa|yhteensä|paljonko') && !named.length) {
    return T('priceTotal', { t: sek(total) });
  }
  if (has(t, COUNT_Q) && has(t, 'item|furniture|piece|thing|möbel|möbler|sak|huonekalu|kalust|esine')) {
    return P(lang, items.length, 'item');
  }
  if (has(t, 'list|which|what|vilka|vad|mitä|luettele') && has(t, 'furniture|items|pieces|möbel|möbler|huonekalu|kalust|in the room|i rummet|huoneessa')) {
    if (!items.length) return T('emptyRoom');
    const names = items.slice(0, 5).map(label).join(', ');
    return `${P(lang, items.length, 'item')}: ${names}${items.length > 5 ? `, +${items.length - 5}` : ''}`;
  }
  const doorQ = has(t, 'door|dörr|ove|ovi'), winQ = has(t, 'window|fönster|ikkun');
  if ((doorQ || winQ) && !named.length) {
    const list = doorQ ? doors : windows;
    const word = doorQ ? 'door' : 'window';
    const cnt = (n: number) => P(lang, n, word);
    if (!list.length) return cnt(0);
    return T('openings', { n: cnt(list.length), w: list.map((o) => n2(o.widthM)).join(` ${T('and')} `) });
  }
  if (!named.length && has(t, 'ceiling|taket|takhöjd|tak höjd|katto|katon|how high|how tall')) {
    return T('ceiling', { h: n2(model.ceilingM) });
  }
  if (has(t, 'perimeter|omkrets|ympärys|walls? length|around the room|runt rummet')) {
    return T('perimeter', { l: n1(perimeter(space.polygon)) });
  }
  const roomQ = has(t, 'room|space|rum|huone|tila|floor|golv|lattia|apartment|bedroom|office');
  const areaQ = has(t, 'area|square|m2|m²|sq|yta|kvadrat|pinta|neliö');
  const sizeQ = has(t, 'size|big|large|dimension|how wide|how long|storlek|stor(?![a-zåäö])|mått|koko|iso|mitat|suuri');
  if (!named.length && (areaQ || (sizeQ && roomQ))) {
    const b = bounds(space.polygon);
    return areaQ && !sizeQ ? `${n1(area)} m²` : T('size', { a: n1(area), s: n1(Math.min(b.w, b.h)), l: n1(Math.max(b.w, b.h)) });
  }
  return null;
}
