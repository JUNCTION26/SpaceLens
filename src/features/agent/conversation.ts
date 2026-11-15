// What the assistant remembers between turns, as plain data that survives a save and a reload:
// what was just talked about, the last thing it did, and what the person has said they need
// ("budget 15000", "I work from home", "no rugs", "I use a wheelchair"). The helpers here are pure
// so every rule can be tested without a room, a model or a voice.
import type { Requirements } from '../../core/types';
import { canonicalItem } from './answer';
import { TEMPLATES, tr, type Lang } from './buildingAnswers';

export type { Lang } from './buildingAnswers';

export interface Goals {
  budgetSek?: number;
  workFromHome?: boolean;
  wheelchair?: boolean;
  /** English furniture categories the person does not want ("rug"). */
  avoid: string[];
}

export interface PendingChoice {
  /** The concrete either-or the assistant asked. */
  options: Array<{ id: string; name: string }>;
  /** The actions that wait for the answer, with the item left open. */
  actions: Array<{ type: string; [k: string]: unknown }>;
}

export interface Conversation {
  lang: Lang;
  goals: Goals;
  /** Item ids last referred to, most recent first. */
  items: string[];
  /** Room ids last referred to, most recent first. */
  rooms: string[];
  /** The last thing done and how to take it back. */
  last: { type: string; label: string; undo: 'undo' | null } | null;
  pending: PendingChoice | null;
  /** The assumption stated with the last action, in a few words. */
  assumed: string | null;
}

export const emptyConversation = (): Conversation => ({
  lang: 'en', goals: { avoid: [] }, items: [], rooms: [], last: null, pending: null, assumed: null,
});

// ---------- goals ----------

const num = (raw: string): number => Number(raw.replace(/[\s ]/g, '').replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));

/** What the words state as a lasting goal; empty when they state none. */
export function parseGoals(text: string): Partial<Goals> {
  const t = text.toLowerCase();
  const out: Partial<Goals> = {};
  const m = /(?:budget|budjett\p{L}*|under|below|max(?:imum)?|at most|up to|alle|enintään|högst|upp till|kostar högst)\D{0,12}?(\d[\d\s .,]*\d|\d)\s*(k\b|tusen|tuhatta|sek|kr\b|kronor|euro|€)?/u.exec(t);
  if (m) {
    let v = num(m[1]);
    if (m[2] === 'k' || m[2] === 'tusen' || m[2] === 'tuhatta') v *= 1000;
    if (Number.isFinite(v) && (v >= 500 || m[2])) out.budgetSek = Math.round(v);
  }
  if (/work(?:ing)? from home|home office|jobbar hemifrån|arbetar hemifrån|hemmakontor|työskentelen kotoa|etätyö|kotitoimisto/.test(t)) out.workFromHome = true;
  if (/\bi (?:use|am in|'m in|have|need) (?:a )?wheelchair|jag (?:använder|sitter i|behöver) (?:en )?rullstol|(?:käytän|olen|tarvitsen) pyörätuol/.test(t)) out.wheelchair = true;
  const avoid: string[] = [];
  for (const x of t.matchAll(/(?<![\p{L}])(?:no|without|avoid|don't want|do not want|inga|inget|utan|undvik|ei|ilman)\s+(?:any\s+)?([\p{L}]+)/gu)) {
    const c = canonicalItem(x[1]);
    if (c && !avoid.includes(c)) avoid.push(c);
  }
  if (avoid.length) out.avoid = avoid;
  return out;
}

export function mergeGoals(cur: Goals, p: Partial<Goals>): Goals {
  return {
    budgetSek: p.budgetSek ?? cur.budgetSek,
    workFromHome: p.workFromHome ?? cur.workFromHome,
    wheelchair: p.wheelchair ?? cur.wheelchair,
    avoid: [...new Set([...cur.avoid, ...(p.avoid ?? [])])],
  };
}

export const hasGoals = (g: Goals) => g.budgetSek != null || !!g.workFromHome || !!g.wheelchair || g.avoid.length > 0;

/** The goals as words a design brief can carry. */
export function goalsBrief(g: Goals): string {
  const bits: string[] = [];
  if (g.budgetSek != null) bits.push(`budget ${g.budgetSek} SEK`);
  if (g.workFromHome) bits.push('needs a desk to work from home');
  if (g.wheelchair) bits.push('wheelchair user, keep 1.5 m turning space and wide routes');
  for (const a of g.avoid) bits.push(`no ${a}`);
  return bits.join('. ');
}

/** The requirements with the person's lasting goals applied, never loosening what they already say. */
export function applyGoals(req: Requirements, g: Goals): Requirements {
  const next: Requirements = { ...req, items: [...req.items], notes: [...req.notes] };
  if (g.budgetSek != null) next.budgetSek = next.budgetSek == null ? g.budgetSek : Math.min(next.budgetSek, g.budgetSek);
  if (g.wheelchair) next.minRouteWidthM = Math.max(next.minRouteWidthM, 0.9);
  if (g.avoid.length) {
    next.items = next.items.filter((i) => !g.avoid.some((a) => i.catalogId.toLowerCase().includes(a) && !i.keepExistingId));
    next.notes.push(...g.avoid.map((a) => `No ${a}.`));
  }
  if (g.workFromHome && !next.items.some((i) => /desk/.test(i.catalogId)) && !g.avoid.includes('desk')) next.notes.push('Needs a work desk.');
  if (g.wheelchair) next.notes.push('Keep a 1.5 m wheelchair turning circle free.');
  return next;
}

// ---------- referred things ----------

/** Fold what the turn talked about into the conversation, most recent first. */
export function remember(conv: Conversation, ids: { items?: string[]; rooms?: string[] }): Conversation {
  const front = (cur: string[], add?: string[]) => (add?.length ? [...new Set([...add, ...cur])].slice(0, 6) : cur);
  return { ...conv, items: front(conv.items, ids.items), rooms: front(conv.rooms, ids.rooms) };
}

// ---------- short, spoken replies ----------

const words = (s: string) => s.split(/\s+/).filter(Boolean);

/** One spoken reply: no lists, no bullets, at most `max` words, cut at a sentence or a comma. */
export function tidy(text: string, max = 20): string {
  const flat = text
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/(^|[\s.])[-•*]\s+/g, '$1')
    .replace(/(^|[\s.])\d+[.)]\s+(?=\p{L})/gu, '$1')
    .replace(/\.\s*\./g, '.')
    .replace(/\s+/g, ' ')
    .trim();
  if (words(flat).length <= max) return flat;
  const sentences = flat.split(/(?<=[.!?])\s+(?=[\p{Lu}\d])/u);
  let out = '';
  for (const s of sentences) {
    if (words(`${out} ${s}`).length > max) break;
    out = `${out} ${s}`.trim();
  }
  if (out) return out;
  const cut = words(flat).slice(0, max).join(' ');
  const comma = Math.max(cut.lastIndexOf(','), cut.lastIndexOf(';'));
  return `${(comma > cut.length / 2 ? cut.slice(0, comma) : cut).replace(/[,;:\s]+$/, '')}.`;
}

/** Join spoken parts into one reply of at most `max` words; later parts are dropped whole, never cut. */
export function sayParts(parts: Array<string | null | undefined>, max = 20): string {
  let out = '';
  for (const p of parts) {
    if (!p) continue;
    const next = out ? `${out} ${/[.!?]$/.test(p) ? p : `${p}.`}` : tidy(p, max);
    if (!out) { out = next; continue; }
    if (words(next).length > max) break;
    out = next;
  }
  return out;
}

// ---------- requests with more than one step ----------

const DESIGN_RE = /(?<![\p{L}])(design|furnish|set up|fit out|lay ?out|arrange|inred|möbler|sisusta|kalusta)/u;
const CHECK_RE = /(?<![\p{L}])(check|make sure|verify|ensure|test|kolla|kontrollera|se till|tarkista|varmista)(?![\p{L}])|wheelchair|rullstol|pyörätuol|(?<![\p{L}])can (?:a|the) (?:\w+ )?(?:turn|fit|get)|(?<![\p{L}])(?:kan|voiko|mahtuuko)/u;

export interface Plan {
  /** The clause that asks for the design, with the goals added. */
  brief: string;
  purpose: string;
  checks: Array<'turn' | 'safety' | 'budget'>;
}

/** "Furnish this as a guest room under 10000 and check a wheelchair can turn" becomes a plan; anything simpler does not. */
export function planFor(text: string, goals: Goals): Plan | null {
  const clauses = text.split(/\s*(?:,|;|(?<![\p{L}])(?:and then|and|then|och sedan|och|sedan|ja sitten|ja|sitten)(?![\p{L}]))\s*/u).filter((c) => c.trim());
  if (clauses.length < 2) return null;
  const di = clauses.findIndex((c) => DESIGN_RE.test(c.toLowerCase()));
  if (di < 0) return null;
  const rest = clauses.filter((_, i) => i !== di).join(' ').toLowerCase();
  if (!CHECK_RE.test(rest)) return null;
  const checks: Plan['checks'] = [];
  if (/wheelchair|rullstol|pyörätuol|turn|vänd|käänty/.test(rest)) checks.push('turn');
  if (/safe|safety|fire|hazard|check|säker|turvall|kolla|tarkista/.test(rest) && !checks.length) checks.push('safety');
  if (/budget|cost|price|under|pris|hinta|budjett/.test(rest)) checks.push('budget');
  const d = clauses[di];
  const kind = /(?:as|som|ia?)\s+(?:an?\s+)?((?:\p{L}+\s)?(?:room|office|bedroom|study|nursery|studio|rum|kontor|sovrum|huone|toimisto|työhuone|makuuhuone))/iu.exec(d)?.[1]
    ?? /((?:guest|gäst|vieras)\p{L}*\s*(?:room|rum|huone)?)/iu.exec(d)?.[1] ?? 'room';
  const g = goalsBrief(goals);
  return { brief: `${d.trim()}${g ? `. ${g}` : ''}`, purpose: kind.trim().toLowerCase(), checks: checks.length ? checks : ['safety'] };
}

/** The plan for a turn: a multi-step request, or a design request that states a budget to be checked afterwards. */
export function planTurn(text: string, goals: Goals): Plan | null {
  const merged = mergeGoals(goals, parseGoals(text));
  const p = planFor(text, merged);
  if (p) return merged.budgetSek != null && !p.checks.includes('budget') ? { ...p, checks: [...p.checks, 'budget'] } : p;
  if (!DESIGN_RE.test(text.toLowerCase()) || merged.budgetSek == null) return null;
  const g = goalsBrief(merged);
  return { brief: `${text.trim()}${g ? `. ${g}` : ''}`, purpose: 'room', checks: ['budget'] };
}

/** One spoken sentence: the cost against the budget, or the cost alone. */
export function budgetVerdict(lang: Lang, cost: number, budget?: number): string {
  const c = Math.round(cost);
  if (budget == null) return tr(lang, 'costPart', { cost: c, budget: '' });
  if (c > budget) return tr(lang, 'overBudget', { cost: c, x: c - budget });
  return tr(lang, 'costPart', { cost: c, budget: tr(lang, 'ofBudget', { b: budget }) });
}

// ---------- changing the room on a copy ----------

export interface WhatIf { axis: 'x' | 'y'; deltaM: number }

/** "What if the room were 1 m wider": which way and by how much, or null. */
export function parseWhatIf(text: string): WhatIf | null {
  const t = text.toLowerCase();
  if (!/what if|what would|how about|tänk om|vad händer om|vad om|entä jos|mitä jos|jos huone/.test(t)) return null;
  const m = /(\d+(?:[.,]\d+)?)\s*(m(?![a-zåäö])|metr\p{L}*|meter|cm)?\s*(wider|broader|bredare|leveämpi|longer|deeper|längre|djupare|pidempi|syvempi)/u.exec(t);
  if (!m) return null;
  let v = Number(m[1].replace(',', '.'));
  if (m[2] === 'cm' || (!m[2] && v > 10)) v /= 100;
  const wide = /wider|broader|bredare|leveämpi/.test(m[3]);
  return v > 0 && v <= 10 ? { axis: wide ? 'x' : 'y', deltaM: v } : null;
}

/** The polygon with everything past its middle on one axis moved outward: the room made longer on that axis. */
export function stretchPolygon<P extends { x: number; y: number }>(poly: P[], axis: 'x' | 'y', deltaM: number): P[] {
  const vals = poly.map((p) => p[axis]);
  const mid = (Math.min(...vals) + Math.max(...vals)) / 2;
  return poly.map((p) => (p[axis] > mid ? { ...p, [axis]: p[axis] + deltaM } : p));
}

// ---------- spoken words in three languages ----------

Object.assign(TEMPLATES, {
  askEither: { en: '{a} or {b}?', sv: '{a} eller {b}?', fi: '{a} vai {b}?' },
  assume: { en: 'Assuming {x}.', sv: 'Antar {x}.', fi: 'Oletan {x}.' },
  assumeSel: { en: 'the one you picked', sv: 'den du valde', fi: 'valitsemasi' },
  assumeNamed: { en: 'the {x}', sv: '{x}', fi: '{x}' },
  undone: { en: 'Undone.', sv: 'Ångrat.', fi: 'Peruttu.' },
  designing: { en: 'Designing it now.', sv: 'Jag inreder nu.', fi: 'Sisustan nyt.' },
  checking: { en: 'Let me check.', sv: 'Jag kollar.', fi: 'Tarkistan.' },
  applied: { en: 'Applied.', sv: 'Använt.', fi: 'Otettu käyttöön.' },
  noChoice: { en: 'Which one, the first or the second?', sv: 'Vilken, den första eller andra?', fi: 'Kumpi, ensimmäinen vai toinen?' },
  costPart: { en: '{cost} SEK{budget}', sv: '{cost} SEK{budget}', fi: '{cost} SEK{budget}' },
  ofBudget: { en: ' of {b}', sv: ' av {b}', fi: ' budjetista {b}' },
  overBudget: { en: '{cost} SEK, over budget by {x}', sv: '{cost} SEK, {x} över budget', fi: '{cost} SEK, budjetti ylittyy {x}:llä' },
  turnYes: { en: '1.5 m wheelchair turn fits', sv: 'vändcirkel 1,5 m för rullstol ryms', fi: '1,5 m pyörätuolin käännös mahtuu' },
  turnNo: { en: 'no room for a 1.5 m wheelchair turn', sv: 'ingen plats för rullstolsvändning 1,5 m', fi: 'ei tilaa 1,5 m pyörätuolin käännölle' },
  failsN: { en: '{n} checks fail', sv: '{n} kontroller underkända', fi: '{n} tarkistusta epäonnistuu' },
  noLayout: { en: 'Nothing fits: {why}', sv: 'Inget ryms: {why}', fi: 'Mikään ei mahdu: {why}' },
  moreOpen: { en: '{a} m² more open floor', sv: '{a} m² mer fri golvyta', fi: '{a} m² enemmän vapaata lattiaa' },
  lessOpen: { en: '{a} m² less open floor', sv: '{a} m² mindre fri golvyta', fi: '{a} m² vähemmän vapaata lattiaa' },
  sameOpen: { en: 'same open floor', sv: 'samma fria golvyta', fi: 'sama vapaa lattiatila' },
  failsDiff: { en: '{n} checks fail instead of {m}', sv: '{n} kontroller underkända i stället för {m}', fi: '{n} tarkistusta epäonnistuu, nyt {m}' },
  unchanged: { en: 'your room is unchanged', sv: 'ditt rum är oförändrat', fi: 'huoneesi pysyy ennallaan' },
  nextFix: { en: 'Fix it?', sv: 'Ska jag laga det?', fi: 'Korjaanko sen?' },
  nextWalk: { en: 'Check the walkways next?', sv: 'Kolla gångvägarna härnäst?', fi: 'Tarkistetaanko kulkureitit seuraavaksi?' },
  next3d: { en: 'Want a 3D look?', sv: 'Vill du se det i 3D?', fi: 'Katsotaanko 3D:nä?' },
  nextApply: { en: 'Apply it?', sv: 'Ska jag använda det?', fi: 'Otetaanko se käyttöön?' },
  whyNone: { en: 'The {item} sits by the {wall} wall, {door} m from the door.', sv: '{item} står vid {wall}väggen, {door} m från dörren.', fi: '{item} on {wall}seinällä, {door} m:n päässä ovesta.' },
  nothingNamed: { en: 'Which piece do you mean?', sv: 'Vilken sak menar du?', fi: 'Mitä kalustetta tarkoitat?' },
  goalSaved: { en: 'Noted.', sv: 'Uppfattat.', fi: 'Selvä.' },
  wall_north: { en: 'north', sv: 'norra', fi: 'pohjois' }, wall_south: { en: 'south', sv: 'södra', fi: 'etelä' },
  wall_east: { en: 'east', sv: 'östra', fi: 'itä' }, wall_west: { en: 'west', sv: 'västra', fi: 'länsi' },
});

export const D = tr;

// ---------- comparing a room with its changed copy ----------

export interface RoomFacts { openM2: number; fails: number }

/** One sentence that compares the changed copy with the room as it is. */
export function compareFacts(lang: Lang, before: RoomFacts, after: RoomFacts): string {
  const d = Math.round((after.openM2 - before.openM2) * 10) / 10;
  const open = Math.abs(d) < 0.1 ? tr(lang, 'sameOpen') : tr(lang, d > 0 ? 'moreOpen' : 'lessOpen', { a: Math.abs(d) });
  const fails = after.fails !== before.fails ? tr(lang, 'failsDiff', { n: after.fails, m: before.fails }) : null;
  return sayParts([open.replace(/^./, (c) => c.toUpperCase()), fails, tr(lang, 'unchanged').replace(/^./, (c) => c.toUpperCase())]);
}
